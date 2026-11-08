#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模拟一个 OpenAI 兼容的 /v1/chat/completions，用来在没有真实 Key 时自测代理和界面。

dev/mock-upstream.js 的 Python 移植（本机没有 Node 也能自测）。用法：
  python3 dev/mock-upstream.py [端口]     （默认 9901）
然后把测试代理指过来（dev/mock-config.json 已配好 http://127.0.0.1:9901/v1）。

可触发的特殊行为（与 node 版一致）：
  model 含 "nojson"    → 带 response_format 时返回 400（测 Call 1 去掉 JSON 模式重试）
  model 含 "novision"  → 带图片时返回 400（测视觉失败回落纯文本）
  model 含 "badjson"   → 路由返回非 JSON（测 2-gram 兜底）
  问题里含 "超长"       → Call 2 在 temperature 0.4 时返回超过 120 字（测降温重试）
  追问里含 "天气"/"游戏" → 路由判为 off_topic；含 "先修"/"高中" → related_general
  Call 4（system 里含「一句话说明」）→ 按追问里有没有「懂了」返回一句话说明
  Call 5（system 里含「标注课程重点」）→ 按关键词从字幕里挑重点，返回 JSON；字幕里含「乱码测试」→ 返回非 JSON
  POST /v1/audio/transcriptions → 云端语音识别；model 含 "fail" 返回 500
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def text_of(content):
    if isinstance(content, list):
        return ''.join(c.get('text', '') for c in content if c.get('type') == 'text')
    return str(content or '')


def has_image(content):
    return isinstance(content, list) and any(c.get('type') == 'image_url' for c in content)


def route(question):
    if re.search(r'天气|游戏|吃什么', question):
        return {'route': 'off_topic', 'redirect': '先回到视频内容吧'}
    if re.search(r'先修|高中|基础', question):
        return {'route': 'related_general', 'redirect': None}
    return {'route': 'in_video', 'redirect': None}


def explain(question, temperature, system):
    if '超长' in question and temperature > 0.3:
        return ('**第一段：** 老师说的“线性无关”，意思是这几个向量谁也不能由其他几个拼出来，每一个都带来了一个全新的方向，'
                '少了谁整个空间都会塌掉一块，这一点非常非常关键，一定要记住它。\n\n'
                '第二段：就像三个人各自只会往东、往北、往上走，谁也替代不了谁，缺一个就去不了某些地方了，'
                '这就是独立的意思，非常形象吧。\n\n'
                '第三段：如果第三个向量正好等于前两个相加，它们还算线性无关吗？请你仔细想一想再告诉我。')
    if '没有可用的字幕上下文' in system:
        return ('画面上是一页写着向量组的板书，老师应该在比较几个向量能不能互相表示。\n\n'
                '像三根筷子指向不同方向，少一根就有方向够不着。\n\n'
                '你卡住的是“能不能互相表示”这一句吗？')
    return ('线性无关就是：这几个向量谁也不能用其他几个拼出来，各自贡献一个新方向。\n\n'
            '像东、北、上三个方向，缺哪个都到不了某些地方；“东北”就不算新方向。\n\n'
            '如果第三个向量等于前两个之和，它们还线性无关吗？')


def followup(q, system):
    if '带我想' in system:
        return '你现在缺的是“拼出来”这一环。先想一个小的：东和北两个方向，能拼出“东北”吗？'
    if '懂了' in q:
        return '好，那就继续往下看吧！'
    if '展开' in q:
        return ('展开说：一组向量线性无关，是指只有全部系数取 0 时，它们的线性组合才等于零向量。'
                '换句话说，没有哪个向量是“多余的”。比如 (1,0) 和 (0,1)：想让 a(1,0)+b(0,1)=0，只能 a=b=0，'
                '所以无关；而 (1,0)、(2,0) 就相关，因为第二个是第一个的两倍。')
    return '不算。第三个能由前两个拼出来，就是“多余的”，这组向量就线性相关了。比如东、北、东北，东北=东+北。'


def keypoints(system):
    m = re.search(r'最多 (\d+) 个重点', system)
    max_points = int(m.group(1)) if m else 3
    if '乱码测试' in system:
        return '这一段讲得很好，重点很多。'
    lines = [(mm.group(1), mm.group(2)) for mm in re.finditer(r'^\[(\d{1,3}:\d{2})\] (.+)$', system, re.M)]
    rules = ((r'容易|混淆|误区|千万别', '易错'), (r'重点|记住|考试|注意', '强调'),
             (r'叫做|称为|定义', '定义'), (r'定理|结论|公式|总结|也就是说', '结论'), (r'步骤|方法|第一步', '方法'))
    points = []
    for t, text in lines:
        hit = next((kind for rx, kind in rules if re.search(rx, text)), None)
        if hit is None:
            continue
        title = re.sub(r'^(那么|所以|好|大家|同学们|这里)[，,]?', '', text).split('。')[0]
        title = re.split(r'[，,！？?]', title)[0][:14]
        points.append({'t': t, 'title': title, 'note': text[:36], 'kind': hit,
                       'level': 2 if re.search(r'重点|记住|考试', text) else 1})
        if len(points) >= max_points:
            break
    return json.dumps({'points': points}, ensure_ascii=False)


def summary(system):
    asked = '\n'.join(re.findall(r'问：[^\n]*', system))
    last = asked.split('\n')[-1] if asked else ''
    if '还是不懂' in last:
        return '线性无关：仍卡在“拼出来”是什么意思'
    if '懂了' in asked and '不懂' not in last:
        return '线性无关：谁都不能由别的向量拼出来，追问后已懂'
    return '“线性无关”就是每个向量都带来一个新方向'


class Mock(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        print('[mock] ' + (fmt % args), flush=True)

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length)
        if self.path.endswith('/audio/transcriptions'):
            model_m = re.search(rb'name="model"\r\n\r\n([^\r]*)', body)
            model = model_m.group(1).decode() if model_m else ''
            has_wav = b'RIFF' in body and b'WAVE' in body
            auth = (self.headers.get('Authorization') or '')[:12]
            print('[mock] asr model=%s bytes=%d wav=%s auth=%s…' % (model, len(body), has_wav, auth), flush=True)
            if 'fail' in model:
                return self.send_json(500, {'error': {'message': 'mock asr failure'}})
            if not has_wav:
                return self.send_json(400, {'error': {'message': 'no wav file'}})
            time.sleep(0.15)
            return self.send_json(200, {'text': '线性无关到底是什么意思（云端识别）'})
        if not self.path.endswith('/chat/completions'):
            return self.send_json(404, {'error': {'message': 'not found'}})
        req = json.loads(body.decode('utf-8', 'replace'))
        system = text_of(req['messages'][0]['content'])
        user_content = req['messages'][1]['content']
        user = text_of(user_content)
        image = has_image(user_content)
        unresolved = re.findall(r'\{\{\w+\}\}', system)
        if '标注课程重点' in system:
            kind = 'call5'
        elif 'query router' in system:
            kind = 'call1'
        elif '一句话说明' in system:
            kind = 'call4'
        elif req.get('stream'):
            kind = 'call3'
        else:
            kind = 'call2'
        print('[mock] %s model=%s t=%s stream=%s json=%s image=%s auth=%s… unresolved=%s user=%s'
              % (kind, req.get('model'), req.get('temperature'), bool(req.get('stream')),
                 bool(req.get('response_format')), image, (self.headers.get('Authorization') or '')[:12],
                 ','.join(unresolved) or 'none', user[:30]), flush=True)

        if req.get('response_format') and 'nojson' in str(req.get('model')):
            return self.send_json(400, {'error': {'message': 'response_format is not supported'}})
        if image and 'novision' in str(req.get('model')):
            return self.send_json(400, {'error': {'message': 'model does not support image input'}})

        if kind == 'call1':
            content = '我觉得这是视频内的问题' if 'badjson' in str(req.get('model')) \
                else '```json\n' + json.dumps(route(user), ensure_ascii=False) + '\n```'
        elif kind == 'call2':
            content = explain(user, req.get('temperature') or 0, system)
        elif kind == 'call4':
            content = '“' + summary(system) + '”'
        elif kind == 'call5':
            content = keypoints(system)
        else:
            content = followup(user, system)

        if not req.get('stream'):
            time.sleep({'call1': 0.12, 'call4': 0.12, 'call5': 0.4}.get(kind, 0.6))
            return self.send_json(200, {'id': 'mock', 'object': 'chat.completion',
                                        'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content},
                                                     'finish_reason': 'stop'}]})

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        def write_chunk(data: bytes):
            self.wfile.write(('%x\r\n' % len(data)).encode() + data + b'\r\n')
            self.wfile.flush()

        time.sleep(0.35)
        chars = list(content)
        for i in range(0, len(chars), 3):
            delta = ''.join(chars[i:i + 3])
            ev = 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': delta}}]},
                                       ensure_ascii=False, separators=(',', ':')) + '\n\n'
            write_chunk(ev.encode('utf-8'))
            time.sleep(0.045)
        write_chunk(('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
                                           separators=(',', ':')) + '\n\n').encode())
        self.wfile.write(b'0\r\n\r\n')
        self.wfile.flush()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9901
    server = ThreadingHTTPServer(('127.0.0.1', port), Mock)
    print('[mock] OpenAI-compatible mock on http://127.0.0.1:%d/v1' % port, flush=True)
    server.serve_forever()
