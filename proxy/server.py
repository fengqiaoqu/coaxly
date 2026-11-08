#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""哄着学 Coaxly · 本地代理（macOS 版，Python 3 标准库，无需安装任何依赖）

  proxy/server.ps1 的 macOS 移植，接口与字段完全一致（扩展无需改动即可连上）：

  - 监听 http://localhost:<port>/（默认 8787，IPv4 + IPv6 双栈）
  - 每次请求都实时读取 ../prompts/*.md，注入占位符后调用 OpenAI 兼容的 /chat/completions
  - 每次调用追加一行到 ../data/calls.jsonl
  - API Key 只存在 proxy/config.json，扩展永远不接触 Key
  - 画面识字：macOS 自带的 Vision 框架（proxy/mac/lb-ocr，本机跑、不联网）
  - 语音识别：macOS 自带的 Speech 框架（proxy/mac/lb-asr，本机识别；首次使用会弹一次授权）
  - 两个 CLI 用 proxy/build-mac.sh 编译；没有它们时代理照常工作，只是少了画面文字和语音

  端点：
    GET  /health    连通性与配置检查
    POST /explain   Call 2 即时解释（非流式；超 120 字降温重试；视觉失败回落纯文本；无字幕走降级 prompt）
    POST /route     Call 1 上下文路由（JSON 模式，失败走 2-gram 规则兜底）
    POST /followup  Call 3 追问续接（SSE 流式；首轮追问时先在内部跑 Call 1）
    POST /log       客户端事件（例如关闭抽屉 → user_closed_without_followup）
    POST /ocr       画面识字（macOS Vision 本地识别）
    POST /asr       语音识别（macOS Speech 本机识别，可选云端 /audio/transcriptions）
    POST /summarize Call 4：历史节点的一句话说明
    POST /keypoints Call 5：按段读字幕标注课程重点（JSON 模式，失败走关键词规则兜底）

  用法：python3 proxy/server.py [--config 路径] [--port 8787] [--log 路径]
"""

import argparse
import base64
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROXY_DIR = os.path.dirname(os.path.realpath(__file__))
ROOT = os.path.dirname(PROXY_DIR)
PROMPT_DIR = os.path.join(ROOT, 'prompts')
DATA_DIR = os.path.join(ROOT, 'data')
MAC_DIR = os.path.join(PROXY_DIR, 'mac')
OCR_BIN = os.path.join(MAC_DIR, 'lb-ocr')
ASR_BIN = os.path.join(MAC_DIR, 'lb-asr')
LOG_FILE = os.path.join(DATA_DIR, 'calls.jsonl')
CONFIG_PATH = os.path.join(PROXY_DIR, 'config.json')

VERSION = '1.4.1'

# ---------------------------------------------------------------- 文案常量
T_UNKNOWN_SUBJECT = '未知课程'
T_FIRST_HELP = '（这是本视频第一次求助）'
T_NO_TRANSCRIPT = '（本次没有可用字幕）'
T_NO_HISTORY = '（这是第一轮追问）'
T_DEFAULT_QUESTION = '这里没听懂，帮我讲讲刚才这一段'
T_DEFAULT_REDIRECT = '先回到视频内容吧'
T_DEFAULT_CONCEPT = '刚才那一段'
T_NO_KEY = '代理还没配置 API Key：请编辑 proxy/config.json 里的 apiKey（保存即生效，不用重启代理）。'

ROUTES = ('in_video', 'related_general', 'off_topic')
CALL2_LIMIT = 120

_locks = {'log': threading.Lock(), 'ocr': threading.Lock(), 'asr': threading.Lock()}


# ---------------------------------------------------------------- 小工具
def limit_text(s, n):
    s = '' if s is None else str(s)
    return s if len(s) <= n else s[:n] + '…'


def now_iso():
    return datetime.now().astimezone().isoformat(timespec='milliseconds')


def is_false(v):
    """PowerShell 里 `$cfg.ocr -eq $false` 的语义：显式为假才算关（None/0/'' 也算）"""
    return v is None or v is False or v == 0 or v == ''


def get_field(obj, name, default=None):
    if not isinstance(obj, dict):
        return default
    v = obj.get(name, default)
    return default if v is None else v


def get_non_empty(obj, name, default):
    v = get_field(obj, name, '')
    v = '' if v is None else str(v)
    return v.strip() if v.strip() else default


def transcript_body_length(transcript):
    """字幕「正文」长度：去掉 [mm:ss] 前缀和空白后再数，避免只有时间戳也被当成有字幕"""
    if not transcript:
        return 0
    t = re.sub(r'\[\d{1,3}:\d{2}\]', '', str(transcript))
    return len(re.sub(r'\s', '', t))


# ---------------------------------------------------------------- 配置
def get_config():
    cfg = {
        'baseUrl': 'https://api.openai.com/v1',
        'apiKey': '',
        'model': 'gpt-4o-mini',
        'visionModel': '',
        'port': 8787,
        'httpProxy': '',
        'timeoutSec': 60,
        'sendImage': True,
        'ocr': True,
        'asr': None,
    }
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            raw = f.read()
        try:
            obj = json.loads(raw)
        except ValueError as e:
            raise RuntimeError('config.json 不是合法 JSON：%s' % e)
        if isinstance(obj, dict):
            for k in obj:
                cfg[k] = obj[k]
    if is_false(cfg.get('visionModel')) or not str(cfg.get('visionModel') or '').strip():
        cfg['visionModel'] = cfg['model']
    engine = str(get_field(cfg.get('asr'), 'engine', 'local') or 'local')
    if engine not in ('local', 'cloud', 'off'):
        engine = 'local'
    cfg['asrEngine'] = engine
    return cfg


def has_key(cfg):
    return bool(str(cfg.get('apiKey') or '').strip())


# ---------------------------------------------------------------- 提示词
def read_prompt(name):
    path = os.path.join(PROMPT_DIR, name)
    if not os.path.exists(path):
        raise RuntimeError('缺少提示词文件 prompts/%s' % name)
    with open(path, 'r', encoding='utf-8') as f:
        t = f.read()
    t = re.sub(r'<!--[\s\S]*?-->', '', t)
    return t.replace('\r\n', '\n').strip()


def fill_template(tpl, variables):
    def repl(m):
        k = m.group(1)
        if k in variables:
            return str(variables[k])
        return m.group(0)
    return re.sub(r'\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}', repl, tpl)


def read_mode(mode):
    file = 'call3_mode_socratic.md' if mode == 'socratic' else 'call3_mode_direct.md'
    lines = read_prompt(file).split('\n')
    label = lines[0].strip()
    rules = '\n'.join(lines[1:]).strip()
    return {'label': label, 'rules': rules}


def format_past(past):
    items = [p for p in (past or []) if p]
    if not items:
        return T_FIRST_HELP
    lines = []
    for p in items[-3:]:
        if isinstance(p, str):
            lines.append('- ' + p)
        else:
            lines.append('- 问过：%s → 当时核心：%s' % (get_field(p, 'question', ''), get_field(p, 'core', '')))
    return '\n' + '\n'.join(lines)


def format_history(history):
    items = [h for h in (history or []) if h]
    if not items:
        return T_NO_HISTORY
    lines = []
    for i, h in enumerate(items[-2:], 1):
        q = limit_text(str(get_field(h, 'q', '')), 40)
        a = limit_text(re.sub(r'\s+', ' ', str(get_field(h, 'a', ''))), 60)
        lines.append('第%d轮 问：%s → 答：%s' % (i, q, a))
    return '\n' + '\n'.join(lines)


# ---------------------------------------------------------------- Call 2 输出整理与校验（规格 4.4）
def remove_markdown(t):
    if t is None:
        return ''
    t = t.replace('\r', '')
    t = re.sub(r'<think>[\s\S]*?</think>', '', t)
    t = re.sub(r'(?m)^[ \t]*```.*$', '', t)
    t = re.sub(r'(?m)^[ \t]*#{1,6}[ \t]*', '', t)
    t = re.sub(r'(?m)^[ \t]*>[ \t]?', '', t)
    t = re.sub(r'(?m)^[ \t]*[-*+•][ \t]+', '', t)
    t = re.sub(r'(?m)^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$', '', t)
    t = re.sub(r'(?m)^[ \t]*\|.*$', lambda m: m.group(0).replace('|', ' ').strip(), t)
    t = re.sub(r'\*\*|__|`', '', t)
    t = re.sub(r'(?m)^[ \t]*<第[一二三]段[^>\n]*>[ \t]*$', '', t)
    t = re.sub(r'(?m)^[ \t]*[<【\[（(]?第[一二三123]段[^：:\n]{0,8}?[>】\]）)]?[ \t]*[：:][ \t]*', '', t)
    t = re.sub(r'(?m)^[ \t]+|[ \t]+$', '', t)
    return t.strip()


def measure_explain(raw):
    clean = remove_markdown(raw)
    segs = [s.strip() for s in re.split(r'\n[ \t]*\n', clean) if s.strip()]
    if len(segs) < 3 and '\n' in clean:
        alt = [s.strip() for s in clean.split('\n') if s.strip()]
        if len(alt) == 3 or (len(segs) == 1 and len(alt) > 1):
            segs = alt
    lens = [len(re.sub(r'\s', '', s)) for s in segs]
    return {
        'text': '\n\n'.join(segs),
        'segments': segs,
        'seg_lengths': lens,
        'seg_count': len(segs),
        'chars': len(re.sub(r'\s', '', clean)),
    }


# ---------------------------------------------------------------- 上游调用
def make_opener(cfg):
    proxy = str(cfg.get('httpProxy') or '').strip()
    if proxy:
        handler = urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
    else:
        handler = urllib.request.ProxyHandler({})  # 与 Windows 版一致：不走系统代理
    return urllib.request.build_opener(handler)


def send_upstream(cfg, payload, stream=False):
    url = str(cfg['baseUrl']).strip().rstrip('/') + '/chat/completions'
    headers = {
        'Authorization': 'Bearer ' + str(cfg.get('apiKey') or '').strip(),
        'Content-Type': 'application/json; charset=utf-8',
    }
    if stream:
        headers['Accept'] = 'text/event-stream'
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    timeout = float(cfg.get('timeoutSec') or 60)
    try:
        resp = make_opener(cfg).open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode('utf-8', 'replace')
        except Exception:
            text = ''
        return {'ok': False, 'status': e.code, 'error': '上游返回 HTTP %d：%s' % (e.code, limit_text(text, 600))}
    except Exception as e:
        msg = str(getattr(e, 'reason', None) or e)
        if isinstance(e, urllib.error.URLError) and isinstance(getattr(e, 'reason', None), TimeoutError):
            return {'ok': False, 'status': 0, 'error': '上游超时（超过 %s 秒没有响应）' % timeout}
        if isinstance(e, TimeoutError):
            return {'ok': False, 'status': 0, 'error': '上游超时（超过 %s 秒没有响应）' % timeout}
        return {'ok': False, 'status': 0, 'error': '请求上游失败：' + msg}
    return {'ok': True, 'status': resp.status if hasattr(resp, 'status') else 200, 'response': resp}


def invoke_chat(cfg, model, system, user_content, temperature, max_tokens, extra=None):
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user_content},
        ],
        'temperature': temperature,
        'max_tokens': max_tokens,
        'stream': False,
    }
    if extra:
        payload.update(extra)
    r = send_upstream(cfg, payload, False)
    if not r['ok']:
        return r
    try:
        raw = r['response'].read().decode('utf-8', 'replace')
    finally:
        r['response'].close()
    try:
        obj = json.loads(raw)
    except ValueError:
        return {'ok': False, 'status': 200, 'error': '上游返回的不是 JSON：' + limit_text(raw, 300)}
    text = None
    try:
        text = obj['choices'][0]['message']['content']
    except Exception:
        pass
    if not text:
        return {'ok': False, 'status': 200, 'error': '上游没有返回内容：' + limit_text(raw, 300)}
    return {'ok': True, 'status': 200, 'text': str(text)}


# ---------------------------------------------------------------- 日志
def write_call_log(rec):
    o = {'ts': now_iso()}
    o.update(rec)
    line = json.dumps(o, ensure_ascii=False, separators=(',', ':'))
    with _locks['log']:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')


# ---------------------------------------------------------------- 画面识字（macOS Vision 本地识别）
_ocr_state = {'checked': False, 'ok': False, 'error': None, 'lang': ''}

def _run_helper(binary, args, timeout=30):
    return subprocess.run([binary] + args, capture_output=True, timeout=timeout)

def init_ocr():
    with _locks['ocr']:
        if _ocr_state['checked']:
            return _ocr_state
        _ocr_state['checked'] = True
        if not os.path.exists(OCR_BIN):
            _ocr_state['error'] = '缺少画面识字工具 %s（在项目目录运行 bash proxy/build-mac.sh 生成）' % OCR_BIN
            return _ocr_state
        try:
            p = _run_helper(OCR_BIN, ['--check'], timeout=15)
            out = json.loads(p.stdout.decode('utf-8', 'replace') or '{}')
            if out.get('ok'):
                _ocr_state['ok'] = True
                _ocr_state['lang'] = ','.join(out.get('langs') or [])
            else:
                _ocr_state['error'] = out.get('error') or 'Vision 文字识别不可用'
        except Exception as e:
            _ocr_state['error'] = '画面识字工具启动失败：' + str(e)
        return _ocr_state


def ocr_line_useful(s):
    """过滤明显的乱码行（公式、图案常被识别成一串符号）"""
    length = len(re.sub(r'\s', '', s))
    if length < 3:
        return False
    good = len(re.findall(r'[一-鿿A-Za-z0-9]', s))
    return good >= 3 and good / max(1, length) >= 0.6


def invoke_ocr(data_url):
    """返回 {ok, code, error, width, height, ms, lines:[{text,x,y,w,h}]}，行按从上到下排序"""
    st = init_ocr()
    if not st['ok']:
        return {'ok': False, 'code': 'ocr_unavailable', 'error': st['error']}
    comma = data_url.find(',')
    if not data_url.startswith('data:image/') or comma < 0:
        return {'ok': False, 'code': 'bad_image', 'error': '不是图片'}
    t0 = time.time()
    try:
        raw = base64.b64decode(data_url[comma + 1:])
        suffix = '.png'
        head = data_url[5:data_url.find(';')]
        if 'jpeg' in head or 'jpg' in head:
            suffix = '.jpg'
        elif 'webp' in head:
            suffix = '.webp'
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
            tf.write(raw)
            tmp = tf.name
        try:
            p = _run_helper(OCR_BIN, [tmp], timeout=25)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        out = json.loads(p.stdout.decode('utf-8', 'replace') or '{}')
        if not out.get('ok'):
            return {'ok': False, 'code': out.get('code') or 'ocr_failed', 'error': out.get('error') or '文字识别失败'}
        lines = []
        for l in out.get('lines') or []:
            text = str(l.get('text') or '')
            if not ocr_line_useful(text):
                continue
            lines.append({'text': text, 'x': float(l.get('x') or 0), 'y': float(l.get('y') or 0),
                          'w': float(l.get('w') or 0), 'h': float(l.get('h') or 0)})
        lines.sort(key=lambda l: l['y'])
        return {'ok': True, 'width': int(out.get('width') or 0), 'height': int(out.get('height') or 0),
                'lines': lines, 'ms': int((time.time() - t0) * 1000)}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'code': 'ocr_failed', 'error': '文字识别超时'}
    except Exception as e:
        return {'ok': False, 'code': 'ocr_failed', 'error': '文字识别失败：' + str(e)}


def split_ocr_text(ocr, region):
    """region='subtitle'：图本身就是画面底部条带；'full'：整帧，底部 28% 当字幕带。
    字幕 = 字幕带里、水平居中的行；其余是画面上的其他文字（板书、标题等）"""
    W = float(ocr['width'] or 1)
    H = float(ocr['height'] or 1)
    band_top = 0 if region == 'subtitle' else H * 0.72
    sub, other = [], []
    for l in ocr['lines']:
        cx = l['x'] + l['w'] / 2
        if l['y'] >= band_top and abs(cx - W / 2) <= W * 0.22:
            sub.append(l['text'])
        else:
            other.append(l['text'])
    return {'subtitle': ' '.join(sub), 'other': other}


def get_frame_text(cfg, image):
    if is_false(cfg.get('ocr')) or not str(image or '').startswith('data:image/'):
        return None
    o = invoke_ocr(image)
    if not o['ok']:
        return {'ok': False, 'error': o['error'], 'subtitle': '', 'other': [], 'ms': 0}
    s = split_ocr_text(o, 'full')
    return {'ok': True, 'error': None, 'subtitle': s['subtitle'], 'other': s['other'], 'ms': o['ms']}


def format_screen_text(ft):
    """拼到发给模型的用户消息末尾（不改动规格里的提示词原文）"""
    if not ft or not ft.get('ok'):
        return ''
    parts = []
    if ft['subtitle']:
        parts.append('画面字幕：' + ft['subtitle'])
    other = ft['other'][:12]
    if other:
        parts.append('画面上的其他文字：')
        parts.extend('- ' + t for t in other)
    if not parts:
        return ''
    return limit_text('【当前画面上的文字（本地文字识别自动读出，可能有错字或乱码，看不懂的直接忽略；你看不到画面本身）】\n'
                      + '\n'.join(parts), 800)


_NORM_RE = re.compile(r'[\s，。、,\.!?！？：:；;“”"\'()（）\[\]【】]')

def norm_text(s):
    return _NORM_RE.sub('', str(s or ''))


def add_subtitle_to_transcript(transcript, timestamp, sub):
    n = norm_text(sub)
    if len(n) < 2:
        return transcript
    if n in norm_text(transcript):
        return transcript
    line = '[%s] %s' % (timestamp, sub)
    if transcript.strip():
        return transcript.rstrip() + '\n' + line
    return line


# ---------------------------------------------------------------- Call 1：路由
def fallback_route(question, transcript):
    """规格 3.4：问题里的中文与字母连续串 → 2 字滑窗；命中字幕中任意 2 个片段 → in_video"""
    grams = set()
    for m in re.finditer(r'[一-鿿a-z]+', str(question or '').lower()):
        s = m.group(0)
        for i in range(len(s) - 1):
            grams.add(s[i:i + 2])
    tl = str(transcript or '').lower()
    hits = sum(1 for g in grams if g in tl)
    route = 'in_video' if hits >= 2 else 'related_general'
    return {'route': route, 'redirect': None, 'fallback': True, 'hits': hits}


def parse_router_json(text):
    t = re.sub(r'<think>[\s\S]*?</think>', '', str(text or ''))
    t = re.sub(r'```(?:json)?', '', t, flags=re.IGNORECASE)
    m = re.search(r'\{[\s\S]*\}', t)
    if not m:
        return None
    try:
        o = json.loads(m.group(0))
    except ValueError:
        return None
    route = str(get_field(o, 'route', '') or '')
    if route not in ROUTES:
        return None
    redirect = None
    if route == 'off_topic':
        redirect = str(get_field(o, 'redirect', '') or '')
        if not redirect.strip() or redirect == 'null':
            redirect = T_DEFAULT_REDIRECT
    return {'route': route, 'redirect': redirect, 'fallback': False}


def invoke_router(cfg, variables, meta):
    t0 = time.time()
    result = None
    err = None
    json_mode = None
    if not has_key(cfg):
        err = 'no_api_key'
    else:
        sys_prompt = fill_template(read_prompt('call1_router.md'), variables)
        json_mode = True
        r = invoke_chat(cfg, str(cfg['model']), sys_prompt, variables['question'], 0, 120,
                        {'response_format': {'type': 'json_object'}})
        if not r['ok'] and r.get('status', 0) >= 400 and r.get('status') not in (401, 403, 429):
            # 规格 3.3：上游不支持 JSON 模式 → 去掉 response_format 重试一次
            json_mode = False
            r = invoke_chat(cfg, str(cfg['model']), sys_prompt, variables['question'], 0, 120, None)
        if r['ok']:
            result = parse_router_json(r['text'])
            if not result:
                err = 'parse_failed: ' + limit_text(r['text'], 120)
        else:
            err = r.get('error')
    if not result:
        result = fallback_route(variables['question'], variables['transcript'])
        result['error'] = err
    result['ms'] = int((time.time() - t0) * 1000)
    write_call_log({
        'type': 'call1', 'session_id': meta.get('session_id'), 'video_id': meta.get('video_id'),
        'timestamp': variables['timestamp'], 'user_question': variables['question'],
        'route': result['route'], 'redirect': result['redirect'], 'fallback': bool(result['fallback']),
        'json_mode': json_mode, 'error': result.get('error'), 'total_ms': result['ms'],
    })
    return result


# ---------------------------------------------------------------- 语音识别（macOS Speech 本机识别）
_asr_state = {'checked': False, 'ok': False, 'error': None, 'lang': '', 'on_device': False, 'engine': ''}

def init_asr():
    with _locks['asr']:
        if _asr_state['checked']:
            return _asr_state
        _asr_state['checked'] = True
        if not os.path.exists(ASR_BIN):
            _asr_state['error'] = '缺少语音识别工具 %s（在项目目录运行 bash proxy/build-mac.sh 生成）' % ASR_BIN
            return _asr_state
        try:
            p = _run_helper(ASR_BIN, ['--check'], timeout=15)
            out = json.loads(p.stdout.decode('utf-8', 'replace') or '{}')
            _asr_state['lang'] = str(out.get('locale') or '')
            _asr_state['on_device'] = bool(out.get('onDevice'))
            _asr_state['engine'] = str(out.get('engine') or 'sf-speech')
            if out.get('ok'):
                _asr_state['ok'] = True
            else:
                _asr_state['error'] = out.get('error') or '本机语音识别不可用'
        except Exception as e:
            _asr_state['error'] = '语音识别工具启动失败：' + str(e)
        return _asr_state


def parse_wav_data_url(data_url):
    comma = data_url.find(',')
    if not data_url.startswith('data:audio/') or comma < 0:
        return None
    try:
        b = base64.b64decode(data_url[comma + 1:])
    except Exception:
        return None
    if len(b) < 44 or b[0:4] != b'RIFF' or b[8:12] != b'WAVE':
        return None
    return b


def wav_seconds(wav):
    try:
        import struct
        ch = struct.unpack('<h', wav[22:24])[0]
        rate = struct.unpack('<i', wav[24:28])[0]
        bits = struct.unpack('<h', wav[34:36])[0]
        bps = float(rate) * ch * (bits / 8)
        if bps <= 0:
            return 0
        return round((len(wav) - 44) / bps, 1)
    except Exception:
        return 0


def local_asr(wav):
    st = init_asr()
    if not st['ok']:
        return {'ok': False, 'code': 'asr_unavailable', 'error': st['error'], 'engine': 'local'}
    t0 = time.time()
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tf:
        tf.write(wav)
        tmp = tf.name
    try:
        p = _run_helper(ASR_BIN, [tmp], timeout=120)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'code': 'asr_failed', 'error': '语音识别超时', 'engine': 'local'}
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    try:
        out = json.loads(p.stdout.decode('utf-8', 'replace') or '{}')
    except ValueError:
        return {'ok': False, 'code': 'asr_failed', 'error': '语音识别输出异常', 'engine': 'local'}
    if not out.get('ok'):
        return {'ok': False, 'code': out.get('code') or 'asr_failed',
                'error': out.get('error') or '语音识别失败', 'engine': 'local'}
    # 中文听写结果里偶尔夹的空格去掉（只在英文/数字之间保留）
    text = re.sub(r'(?<=[^A-Za-z0-9])\s+|\s+(?=[^A-Za-z0-9])', '', str(out.get('text') or ''))
    return {'ok': True, 'text': text, 'engine': 'local', 'ms': int((time.time() - t0) * 1000)}


def cloud_asr(cfg, wav):
    a = cfg.get('asr') or {}
    base = str(get_field(a, 'baseUrl', '') or '').strip() or str(cfg.get('baseUrl') or '')
    key = str(get_field(a, 'apiKey', '') or '').strip() or str(cfg.get('apiKey') or '').strip()
    model = str(get_field(a, 'model', '') or '').strip()
    if not model:
        return {'ok': False, 'error': 'config.json 里 asr.model 没填'}
    t0 = time.time()
    url = base.strip().rstrip('/') + '/audio/transcriptions'
    boundary = '----CoaxlyBoundary7MA4YWxkTrZu0gW'
    parts = []
    for name, value in (('model', model), ('language', 'zh'), ('response_format', 'json')):
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, name, value)).encode('utf-8'))
    parts.append(('--%s\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n' % boundary).encode('utf-8'))
    parts.append(wav)
    parts.append(('\r\n--%s--\r\n' % boundary).encode('utf-8'))
    body = b''.join(parts)
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
    })
    try:
        resp = make_opener(cfg).open(req, timeout=float(cfg.get('timeoutSec') or 60))
        raw = resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return {'ok': False, 'error': '云端语音识别返回 HTTP %d：%s' % (e.code, limit_text(e.read().decode('utf-8', 'replace'), 300))}
    except Exception as e:
        return {'ok': False, 'error': '云端语音识别请求失败：' + str(getattr(e, 'reason', None) or e)}
    try:
        obj = json.loads(raw)
    except ValueError:
        return {'ok': False, 'error': '云端语音识别返回的不是 JSON：' + limit_text(raw, 200)}
    return {'ok': True, 'text': str(obj.get('text') or '').strip(), 'engine': 'cloud', 'model': model,
            'ms': int((time.time() - t0) * 1000)}


# ---------------------------------------------------------------- Call 4：一句话说明
def format_turns(turns):
    items = [t for t in (turns or []) if t]
    if not items:
        return '（没有追问）'
    lines = []
    for i, t in enumerate(items[-6:], 1):
        q = limit_text(str(get_field(t, 'q', '')), 40)
        a = limit_text(re.sub(r'\s+', ' ', str(get_field(t, 'a', ''))), 60)
        lines.append('%d. 问：%s → 答：%s' % (i, q, a))
    return '\n'.join(lines)


def to_one_line(text):
    t = remove_markdown(text)
    line = next((l.strip() for l in t.split('\n') if l.strip()), '')
    line = re.sub(r'^(一句话说明|说明|总结)[：:]\s*', '', line).strip()
    # 只剥「整句外面的一对引号」：“线性无关”就是…… 这种开头的引号属于内容，不能剥
    for o, c in (('"', '"'), ('\u201C', '\u201D'), ('\u300C', '\u300D'), ("'", "'")):
        if len(line) >= 2 and line[0] == o and line[-1] == c:
            inner = line[1:-1]
            if o == c or inner.count(o) == inner.count(c):
                line = inner.strip()
            break
    line = line.rstrip('。.．')
    return limit_text(line, 40)


# ---------------------------------------------------------------- Call 5：课程重点
KP_KINDS = ('定义', '结论', '方法', '强调', '易错')
KP_RULES = (
    ('易错', re.compile(r'容易(犯|错|混|搞混|弄错|忽略)|误区|混淆|千万别|千万不要|别搞错|常见错误|易错')),
    ('强调', re.compile(r'重点|关键|核心|记住|考试|常考|必考|注意')),
    ('定义', re.compile(r'叫做|称为|称作|定义')),
    ('结论', re.compile(r'定理|结论|公式|总结|也就是说|本质上')),
)


def format_clock(sec):
    s = int(max(0, sec))
    return '%02d:%02d' % (s // 60, s % 60)


def parse_clock(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v).strip().strip('[]')
    m = re.match(r'^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$', s)
    if m:
        if m.group(3) is not None:
            return float(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)))
        return float(int(m.group(1)) * 60 + int(m.group(2)))
    try:
        return float(s)
    except ValueError:
        return None


def parse_keypoints_json(text):
    t = re.sub(r'<think>[\s\S]*?</think>', '', str(text or ''))
    t = re.sub(r'```(?:json)?', '', t, flags=re.IGNORECASE)
    m = re.search(r'\{[\s\S]*\}', t)
    if m:
        try:
            o = json.loads(m.group(0))
            if isinstance(o, dict) and 'points' in o:
                return {'points': [p for p in (o['points'] or []) if p]}
        except ValueError:
            pass
    m = re.search(r'\[[\s\S]*\]', t)
    if m:
        try:
            a = json.loads(m.group(0))
            return {'points': [p for p in a if p]}
        except ValueError:
            pass
    return None


def resolve_keypoints(cands, lines, frm, to, known, cap):
    """把候选重点整理成最终结果：时间落在本段内（对齐到最近一句字幕的开头）、截断长度、类别归一、去重、限量"""
    known_set = {norm_text(k) for k in (known or []) if norm_text(k)}
    out = []
    for c in cands or []:
        if not isinstance(c, dict):
            continue
        t = parse_clock(get_field(c, 't'))
        if t is None or t < frm - 5 or t > to + 5:
            continue
        best = None
        for l in lines:
            if best is None or abs(l['t'] - t) < abs(best['t'] - t):
                best = l
        if best and abs(best['t'] - t) <= 20:
            t = best['t']
        t = min(max(t, frm), to)
        title = re.sub(r'[\r\n]+', ' ', str(get_field(c, 'title', '') or '')).strip().strip('"“”「」')
        if not title:
            continue
        if norm_text(title) in known_set:
            continue
        kind = str(get_field(c, 'kind', '') or '')
        if kind not in KP_KINDS:
            kind = '强调'
        level = 1
        try:
            if int(get_field(c, 'level', 1)) == 2:
                level = 2
        except (TypeError, ValueError):
            pass
        out.append({'t': round(t, 1), 'timestamp': format_clock(t), 'title': limit_text(title, 16),
                    'note': limit_text(re.sub(r'[\r\n]+', ' ', str(get_field(c, 'note', '') or '')).strip(), 40),
                    'kind': kind, 'level': level})
    # 15 秒内的两个合并（留 level 高的）
    merged = []
    for p in sorted(out, key=lambda x: x['t']):
        prev = merged[-1] if merged else None
        if prev and p['t'] - prev['t'] < 15:
            if p['level'] > prev['level']:
                merged[-1] = p
            continue
        merged.append(p)
    # level 2（核心）每 5 分钟最多 1 个：多出来的降成 1
    l2_cap = max(1, math.ceil(cap / 3))
    l2 = 0
    for p in merged:
        if p['level'] == 2:
            l2 += 1
            if l2 > l2_cap:
                p['level'] = 1
    res = merged
    if len(res) > cap:
        res = sorted(res, key=lambda x: (-x['level'], x['t']))[:cap]
        res = sorted(res, key=lambda x: x['t'])
    return res


def rule_keypoints(lines, frm, to, known, cap):
    """规则兜底：含「重点 / 容易错 / 叫做 / 定理」等词的句子，每 5 分钟最多 2 个"""
    cands = []
    per_seg = {}
    last_t = None
    for l in lines:
        hit = None
        for kind, rx in KP_RULES:
            if rx.search(l['text']):
                hit = kind
                break
        if hit is None:
            continue
        if last_t is not None and l['t'] - last_t < 15:
            continue  # 紧挨着的几句（「这是重点」「大家记住」）算同一个
        seg = str(int((l['t'] - frm) // 300))
        if per_seg.get(seg, 0) >= 2:
            continue
        last_t = l['t']
        title = re.sub(r'^(那么|所以|好|好的|这个|我们|大家|同学们|然后|接下来|嗯|啊)[，,、\s]*', '', l['text'])
        title = re.split(r'[，,。；;！!？?]', title)[0].strip()
        if len(title) < 4:
            title = l['text'].strip()
        per_seg[seg] = per_seg.get(seg, 0) + 1
        cands.append({'t': l['t'], 'title': limit_text(title, 14), 'note': l['text'], 'kind': hit, 'level': 1})
    return resolve_keypoints(cands, lines, frm, to, known, cap)


# ---------------------------------------------------------------- 字幕记忆分层（v1.4）
# 目标：AI 读完整部视频的全部字幕，既能模糊把握整体方向，又能精确把握暂停点前后那一段。
#
# 生成（扩展拿到整片字幕后 POST /memory/build，后台异步完成，结果存 data/memory/<视频>.json）：
#   L0 原文层 cues    整片字幕逐句（扩展从 B 站字幕接口拉取；拉不到时用播放中边看边抓的字幕）
#   L1 小节层 chunks  按时间切成 2–4 分钟的小节；map：一次读一批小节原文，每节写 ≤60 字摘要 + 术语
#   L2 全局层 global  reduce：读全部小节摘要，写主题 + 主线 + 3–10 个章节 + 关键术语表
#
# 使用（每次 /explain、/followup 按暂停点 t 现场拼装，越往下越精确）：
#   全局层  整片大纲，标出「用户现在在这一章」——只用来校准方向
#   章节层  上一 / 当前 / 下一小节的摘要——这一段从哪来、往哪去
#   焦点层  t-30 ~ t+30 秒原文，▶ 标出暂停那一句，分「已听过 / 还没看到」——解释对象
#   回溯层  焦点里的术语在前文第一次出现的原文；追问时再按问题检索最相关的小节
#
# Windows 版由主事件循环每 250ms 步进异步 HttpClient 任务；macOS 版代理本身是多线程的，
# 这里每个生成任务开一个后台线程（内部再按 parallel 并行 map 批次），对外行为一致：
# 生成期间 /explain、/followup 照常响应，缺的层写「还在生成」。
MEM_DIR = os.path.join(DATA_DIR, 'memory')
MEM_VERSION = 1
MEM_BATCH_CHARS = 6000   # map 一次最多读多少字
MEM_BATCH_MAX = 8        # map 一次最多几个小节

_mem_lock = threading.RLock()
_mem_cache = {}   # video_id → 记忆对象（正在生成的也在这里，查询能看到进度）
_mem_jobs = {}    # video_id → 生成任务
_mem_index = {}   # 记忆 hash → 小节二字词索引（追问检索用）
_mem_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix='mem')


def mem_settings(cfg):
    s = {'enabled': True, 'chunkSec': 150.0, 'chunkChars': 900.0, 'focusBefore': 30.0, 'focusAfter': 30.0, 'parallel': 3}
    m = cfg.get('memory')
    if isinstance(m, dict):
        for k in list(s):
            if m.get(k) is not None:
                s[k] = m[k]
    s['enabled'] = s['enabled'] is not False
    for k in ('chunkSec', 'chunkChars', 'focusBefore', 'focusAfter', 'parallel'):
        s[k] = max(1.0, float(s[k]))
    return s


def short_hash(s):
    return hashlib.sha1(str(s).encode('utf-8')).hexdigest()[:16]


def mem_path(video_id):
    safe = re.sub(r'[^A-Za-z0-9_\-]', '_', str(video_id))
    if len(safe) > 80:
        safe = safe[:60] + '_' + short_hash(video_id)
    return os.path.join(MEM_DIR, safe + '.json')


def to_mem_cues(raw):
    """接受 [[from, to, text], ...]（扩展发的紧凑格式）或 B 站原始格式 [{from, to, content}]"""
    items = []
    for c in (raw or []):
        if c is None:
            continue
        if isinstance(c, (list, tuple)):
            if len(c) < 3:
                continue
            s, e, text = float(c[0]), float(c[1]), str(c[2])
        elif isinstance(c, dict):
            s = float(get_field(c, 'from', get_field(c, 's', 0)) or 0)
            e = float(get_field(c, 'to', get_field(c, 'e', s)) or s)
            text = str(get_field(c, 'content', get_field(c, 'text', '')) or '')
        else:
            continue
        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            continue
        if e < s:
            e = s
        items.append({'s': round(s, 2), 'e': round(e, 2), 'text': text})
    items.sort(key=lambda c: c['s'])
    out = []
    for c in items:
        if out:
            p = out[-1]
            if p['text'] == c['text'] and c['s'] - p['s'] < 6:  # 倒回重看时抓到两遍
                if c['e'] > p['e']:
                    p['e'] = c['e']
                continue
        out.append(c)
    return out


def chunk_text(cues, a, b):
    """小节原文：每隔 30 秒插一个 [mm:ss]，让模型知道大概的时间位置，又不至于每句都带时间戳浪费字数"""
    parts = []
    next_mark = -1.0
    for i in range(a, b + 1):
        c = cues[i]
        if c['s'] >= next_mark:
            if parts:
                parts.append('\n')
            parts.append('[%s] ' % format_clock(c['s']))
            next_mark = c['s'] + 30
        else:
            parts.append(' ')
        parts.append(c['text'])
    return ''.join(parts)


def chunk_plain(cues, a, b):
    return ' '.join(cues[i]['text'] for i in range(a, b + 1))


def split_mem_chunks(cues, ms):
    """切小节：到了目标时长 / 字数，就在下一个停顿或句末切开；最长不超过目标的 1.6 倍"""
    n = len(cues)
    ranges = []
    a = 0
    while a < n:
        s0 = cues[a]['s']
        chars = 0
        b = a
        for i in range(a, n):
            b = i
            chars += len(cues[i]['text'])
            if i + 1 >= n:
                break
            dur = cues[i]['e'] - s0
            gap = cues[i + 1]['s'] - cues[i]['e']
            hard = dur >= ms['chunkSec'] * 1.6 or chars >= ms['chunkChars'] * 1.6
            soft = ((dur >= ms['chunkSec'] or chars >= ms['chunkChars'])
                    and (gap >= 0.6 or re.search(r'[。！？!?；;]$', cues[i]['text'])))
            if hard or soft:
                break
        ranges.append((a, b))
        a = b + 1
    if len(ranges) >= 2:
        last = ranges[-1]
        chars = len(chunk_plain(cues, last[0], last[1]))
        if cues[last[1]]['e'] - cues[last[0]]['s'] < ms['chunkSec'] * 0.4 and chars < ms['chunkChars'] * 0.4:
            ranges[-2] = (ranges[-2][0], last[1])
            ranges.pop()
    out = []
    for (a, b) in ranges:
        plain = chunk_plain(cues, a, b)
        out.append({
            'i': len(out), 's': cues[a]['s'], 'e': cues[b]['e'], 'a': a, 'b': b,
            'hash': short_hash(plain),
            'title': limit_text(cues[a]['text'], 12),   # 规则兜底：模型摘要出来之前先用原文开头
            'summary': limit_text(plain, 60),
            'terms': [], 'src': 'rule',
        })
    return out


def cues_hash(cues, ms):
    sb = ''.join('%d|%s\n' % (int(c['s']), c['text']) for c in cues)
    sb += 'chunk=%s/%s' % (ms['chunkSec'], ms['chunkChars'])
    return short_hash(sb)


def save_memory(mem):
    os.makedirs(MEM_DIR, exist_ok=True)
    with _mem_lock:
        mem['updated'] = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        with open(mem_path(mem['video_id']), 'w', encoding='utf-8') as f:
            json.dump(mem, f, ensure_ascii=False, separators=(',', ':'))


def get_memory(video_id):
    if not video_id:
        return None
    with _mem_lock:
        if video_id in _mem_cache:
            return _mem_cache[video_id]
    p = mem_path(video_id)
    if not os.path.exists(p):
        return None
    try:
        with open(p, 'r', encoding='utf-8') as f:
            m = json.load(f)
    except ValueError:
        return None
    if int(get_field(m, 'version', 0) or 0) != MEM_VERSION:
        return None
    if m.get('status') == 'building':
        m['status'] = 'partial'  # 上次没生成完代理就关了
    with _mem_lock:
        _mem_cache[video_id] = m
    return m


def parse_loose_json(text):
    t = re.sub(r'<think>[\s\S]*?</think>', '', str(text or ''))
    t = re.sub(r'```(?:json)?', '', t, flags=re.IGNORECASE).strip()
    for pat in (r'^[\s\S]*$', r'\{[\s\S]*\}', r'\[[\s\S]*\]'):
        m = re.match(pat, t)
        if not m:
            continue
        try:
            return json.loads(m.group(0))
        except ValueError:
            continue
    return None


# ---------------- 生成：map（小节摘要）→ reduce（全局）
def map_batches(mem):
    batches = []
    cur, chars = [], 0
    for c in mem['chunks']:
        if c['src'] == 'llm':
            continue  # 原文没变的小节沿用上次的摘要
        ln = len(chunk_text(mem['cues'], c['a'], c['b']))
        if cur and (chars + ln > MEM_BATCH_CHARS or len(cur) >= MEM_BATCH_MAX):
            batches.append({'ids': cur, 'tries': 0})
            cur, chars = [], 0
        cur.append(int(c['i']))
        chars += ln
    if cur:
        batches.append({'ids': cur, 'tries': 0})
    return batches


def format_chunk_digest(mem):
    lines = []
    for c in mem['chunks']:
        head = '[%d] [%s-%s] ' % (c['i'], format_clock(c['s']), format_clock(c['e']))
        if c['src'] == 'llm':
            line = head + c['title'] + '：' + c['summary']
            if c['terms']:
                line += '（术语：%s）' % '、'.join(c['terms'])
            lines.append(line)
        else:
            lines.append(head + '（这一节没有摘要，原文开头）' + c['summary'])
    return '\n'.join(lines)


def _mem_chat_call(job, kind, system, user, max_tokens):
    """一次同步上游调用（整片字幕比即时解释慢得多，超时单独放宽）"""
    cfg = job['cfg']
    payload = {
        'model': str(cfg['model']),
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0.2, 'max_tokens': max_tokens, 'stream': False,
    }
    if not job['no_json']:
        payload['response_format'] = {'type': 'json_object'}
    t0 = time.time()
    url = str(cfg['baseUrl']).strip().rstrip('/') + '/chat/completions'
    req = urllib.request.Request(url, method='POST', headers={
        'Authorization': 'Bearer ' + str(cfg.get('apiKey') or '').strip(),
        'Content-Type': 'application/json; charset=utf-8',
    }, data=json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    timeout = max(180.0, float(cfg.get('timeoutSec') or 60))
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': p, 'https': p} if (p := str(cfg.get('httpProxy') or '').strip()) else {}))
    with _mem_lock:
        job['calls'] += 1
        job['json_mode'] = not job['no_json']
    try:
        resp = opener.open(req, timeout=timeout)
        raw = resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return {'ok': False, 'status': e.code, 'error': '上游返回 HTTP %d：%s' % (e.code, limit_text(e.read().decode('utf-8', 'replace'), 300)), 'ms': int((time.time() - t0) * 1000)}
    except Exception as e:
        msg = str(getattr(e, 'reason', None) or e)
        timed_out = isinstance(e, TimeoutError) or (isinstance(e, urllib.error.URLError) and isinstance(getattr(e, 'reason', None), TimeoutError))
        return {'ok': False, 'status': 0, 'error': ('上游超时' if timed_out else '请求上游失败：') + msg, 'ms': int((time.time() - t0) * 1000)}
    try:
        obj = json.loads(raw)
        text = obj['choices'][0]['message']['content']
    except Exception:
        return {'ok': False, 'status': 200, 'error': '上游没有返回内容：' + limit_text(raw, 200), 'ms': int((time.time() - t0) * 1000)}
    return {'ok': True, 'status': 200, 'text': str(text), 'ms': int((time.time() - t0) * 1000)}


def _mem_call_payload(job, kind, batch):
    mem = job['mem']
    variables = {
        'subject': str(mem.get('subject') or ''),
        'desc': str(mem.get('desc') or '') or '（无）',
        'duration': format_clock(mem['duration']),
        'chunk_count': str(len(mem['chunks'])),
    }
    if kind == 'map':
        system = fill_template(read_prompt('memory_map.md'), variables)
        parts = []
        for cid in batch['ids']:
            c = mem['chunks'][cid]
            parts.append('### 小节 %d [%s-%s]\n%s' % (cid, format_clock(c['s']), format_clock(c['e']),
                                                      chunk_text(mem['cues'], c['a'], c['b'])))
        return system, '\n\n'.join(parts), 200 + 260 * len(batch['ids'])
    system = fill_template(read_prompt('memory_reduce.md'), variables)
    return system, format_chunk_digest(mem), 2000


def set_map_result(mem, ids, obj):
    if obj is None:
        return 0
    items = obj if isinstance(obj, list) else (get_field(obj, 'chunks') or [])
    applied = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            i = int(get_field(it, 'i', -1))
        except (TypeError, ValueError):
            continue
        if i not in ids:
            continue
        summary = str(get_field(it, 'summary', '') or '').strip()
        if not summary:
            continue
        title = str(get_field(it, 'title', '') or '').strip()
        terms = [str(t).strip() for t in (get_field(it, 'terms') or []) if str(t).strip() and len(str(t).strip()) <= 16][:6]
        c = mem['chunks'][i]
        if title:
            c['title'] = limit_text(title, 16)
        c['summary'] = limit_text(summary, 90)
        c['terms'] = terms
        c['src'] = 'llm'
        applied += 1
    return applied


def set_reduce_result(mem, obj):
    if obj is None or isinstance(obj, list):
        return False
    chunks = mem['chunks']
    n = len(chunks)
    topic = str(get_field(obj, 'topic', '') or '').strip()
    summary = str(get_field(obj, 'summary', '') or '').strip()
    if not summary and not topic:
        return False
    # 章节：按 from 排序、去重叠、补空隙，保证按顺序覆盖全部小节
    raw = []
    for ch in (get_field(obj, 'chapters') or []):
        if not isinstance(ch, dict):
            continue
        try:
            f = int(get_field(ch, 'from', -1))
            t = int(get_field(ch, 'to', -1))
        except (TypeError, ValueError):
            continue
        if f < 0 or f >= n:
            continue
        if t < f:
            t = f
        if t >= n:
            t = n - 1
        raw.append({'from': f, 'to': t, 'title': str(get_field(ch, 'title', '') or '').strip()})
    chapters = []
    nxt = 0
    for ch in sorted(raw, key=lambda x: x['from']):
        if ch['to'] < nxt:
            continue
        title = limit_text(ch['title'], 18) if ch['title'] else str(chunks[nxt]['title'])
        chapters.append({'from': nxt, 'to': ch['to'], 'title': title,
                         's': chunks[nxt]['s'], 'e': chunks[ch['to']]['e']})
        nxt = ch['to'] + 1
    if nxt < n:
        if chapters:
            chapters[-1]['to'] = n - 1
            chapters[-1]['e'] = chunks[n - 1]['e']
        else:
            chapters.append({'from': 0, 'to': n - 1,
                             'title': limit_text(topic, 18) if topic else '全片',
                             's': chunks[0]['s'], 'e': chunks[n - 1]['e']})
    terms = []
    seen = set()
    for tm in (get_field(obj, 'terms') or []):
        if not isinstance(tm, dict):
            continue
        term = str(get_field(tm, 'term', '') or '').strip()
        if not term or len(term) > 16 or term in seen:
            continue
        seen.add(term)
        try:
            ci = int(get_field(tm, 'chunk', -1))
        except (TypeError, ValueError):
            ci = -1
        terms.append({'term': term, 'def': limit_text(str(get_field(tm, 'def', '') or '').strip(), 30), 'chunk': ci})
        if len(terms) >= 15:
            break
    mem['global'] = {'topic': limit_text(topic, 30), 'summary': limit_text(summary, 220),
                     'chapters': chapters, 'terms': terms}
    return True


def _run_one_map(job, batch):
    """跑一批 map（带 noJson 回退），返回是否成功处理"""
    system, user, max_tokens = _mem_call_payload(job, 'map', batch)
    res = _mem_chat_call(job, 'map', system, user, max_tokens)
    if not res['ok'] and res['status'] >= 400 and res['status'] not in (401, 403, 429) and not job['no_json']:
        with _mem_lock:
            job['no_json'] = True  # 上游不支持 JSON 模式：去掉 response_format 重发
        system, user, max_tokens = _mem_call_payload(job, 'map', batch)
        res = _mem_chat_call(job, 'map', system, user, max_tokens)
    return res


def _memory_job_main(job):
    mem = job['mem']
    parallel = max(1, int(job['parallel']))
    # ---- map 阶段：按 parallel 并行跑批次
    while (job['queue'] or job['futures']) and job['phase'] == 'map':
        while job['queue'] and len(job['futures']) < parallel:
            batch = job['queue'].pop(0)
            fut = _mem_pool.submit(_run_one_map, job, batch)
            job['futures'].append((batch, fut))
        # 等任意一个完成（轮询其它已完成的不阻塞）
        done_now = [(b, f) for (b, f) in job['futures'] if f.done()]
        if not done_now:
            time.sleep(0.2)
            continue
        for batch, fut in done_now:
            job['futures'].remove((batch, fut))
            res = fut.result()
            if job['phase'] != 'map':
                continue
            if not res['ok'] and res['status'] in (401, 403):
                # Key 有问题，别的批次也不用试了
                job['errors'].append(res['error'])
                job['queue'] = []
                job['phase'] = 'done'
                continue
            applied = 0
            if res['ok']:
                applied = set_map_result(mem, batch['ids'], parse_loose_json(res['text']))
            if applied > 0:
                job['done'] += 1
                continue
            batch['tries'] += 1
            err = ('map 输出解析失败：' + limit_text(res['text'], 120)) if res['ok'] else str(res['error'])
            if batch['tries'] < 2 and job['phase'] == 'map':
                job['queue'].insert(0, batch)
            else:
                job['done'] += 1
                job['failed'] += 1
                job['errors'].append(err)
        with _mem_lock:
            mem['progress'] = {'phase': job['phase'], 'done': job['done'], 'total': job['total']}
    if job['phase'] == 'map':
        job['phase'] = 'reduce'
    # ---- reduce 阶段：最多试 2 次
    if job['phase'] == 'reduce':
        while job['reduce_tries'] < 2 and job['phase'] == 'reduce':
            system, user, max_tokens = _mem_call_payload(job, 'reduce', None)
            res = _mem_chat_call(job, 'reduce', system, user, max_tokens)
            if not res['ok'] and res['status'] >= 400 and res['status'] not in (401, 403, 429) and not job['no_json']:
                with _mem_lock:
                    job['no_json'] = True
                system, user, max_tokens = _mem_call_payload(job, 'reduce', None)
                res = _mem_chat_call(job, 'reduce', system, user, max_tokens)
            ok = False
            if res['ok']:
                ok = set_reduce_result(mem, parse_loose_json(res['text']))
            if ok:
                job['phase'] = 'done'
                break
            job['reduce_tries'] += 1
            job['errors'].append(('reduce 输出解析失败：' + limit_text(res['text'], 120)) if res['ok'] else str(res['error']))
            if res['ok'] is False and res['status'] in (401, 403):
                break
        if job['phase'] == 'reduce':
            job['phase'] = 'done'
    with _mem_lock:
        mem['progress'] = {'phase': job['phase'], 'done': job['done'], 'total': job['total']}


def start_memory_job(mem, cfg):
    queue = map_batches(mem)
    job = {
        'mem': mem, 'cfg': cfg, 'queue': queue, 'futures': [],
        'phase': 'map', 'total': len(queue), 'done': 0, 'failed': 0, 'calls': 0,
        'reduce_tries': 0, 'no_json': False, 'json_mode': None,
        'parallel': int(mem_settings(cfg)['parallel']),
        'errors': [], 't0': time.time(),
    }
    mem['model'] = str(cfg['model'])
    mem['progress'] = {'phase': 'map', 'done': 0, 'total': len(queue)}
    with _mem_lock:
        _mem_jobs[str(mem['video_id'])] = job

    def runner():
        try:
            _memory_job_main(job)
        except Exception as e:
            job['errors'].insert(0, '生成记忆时代理内部错误：%s' % e)
            job['phase'] = 'done'
        finally:
            complete_memory_job(job)

    threading.Thread(target=runner, daemon=True, name='mem-%s' % mem['video_id']).start()
    return job


def complete_memory_job(job):
    mem = job['mem']
    vid = str(mem['video_id'])
    with _mem_lock:
        if _mem_jobs.get(vid) is job:
            _mem_jobs.pop(vid, None)
        total = len(mem['chunks'])
        llm = sum(1 for c in mem['chunks'] if c['src'] == 'llm')
        if mem.get('global') and llm == total:
            mem['status'] = 'ready'
        elif mem.get('global') or llm > 0:
            mem['status'] = 'partial'
        else:
            mem['status'] = 'raw'
        mem['error'] = limit_text(str(job['errors'][0]), 300) if job['errors'] else None
        mem['built_ms'] = int((time.time() - job['t0']) * 1000)
        mem['progress'] = {'phase': 'done', 'done': job['done'], 'total': job['total']}
        chapters = len(mem['global']['chapters']) if mem.get('global') else 0
    save_memory(mem)
    write_call_log({
        'type': 'memory', 'video_id': vid, 'source': mem['source'], 'status': mem['status'],
        'cues': len(mem['cues']), 'chunks': total, 'chunks_llm': llm, 'chapters': chapters,
        'calls': job['calls'], 'failed': job['failed'], 'model': mem.get('model'),
        'error': mem['error'], 'total_ms': mem['built_ms'],
    })
    print('[%s] 整片记忆 %s：%d 句 → %d 小节（模型摘要 %d）→ %d 章，调用 %d 次，%.1fs%s'
          % (datetime.now().strftime('%H:%M:%S'), vid, len(mem['cues']), total, llm, chapters,
             job['calls'], mem['built_ms'] / 1000, '  ' + limit_text(str(mem['error']), 80) if mem['error'] else ''),
          flush=True)


# ---------------- 使用：按暂停点拼装四层上下文
def bigrams(s):
    out = set()
    for m in re.finditer(r'[一-鿿a-z0-9]+', str(s or '').lower()):
        v = m.group(0)
        for i in range(len(v) - 1):
            out.add(v[i:i + 2])
    return out


def get_mem_index(mem):
    key = str(mem.get('hash')) + '|' + str(mem.get('updated'))
    with _mem_lock:
        if key in _mem_index:
            return _mem_index[key]
    sets = []
    df = {}
    for c in mem['chunks']:
        s = bigrams(chunk_plain(mem['cues'], c['a'], c['b']) + ' ' + c['title'] + ' ' + c['summary'])
        sets.append(s)
        for g in s:
            df[g] = df.get(g, 0) + 1
    with _mem_lock:
        if len(_mem_index) > 20:
            _mem_index.clear()
        idx = {'sets': sets, 'df': df, 'n': len(sets)}
        _mem_index[key] = idx
    return idx


def format_chunk_line(c, label):
    head = '%s [%s-%s] ' % (label, format_clock(c['s']), format_clock(c['e']))
    if c['src'] != 'llm':
        return head + '（摘要还没生成，原文开头）' + c['summary']
    line = head + c['title'] + '：' + c['summary']
    if c['terms']:
        line += '（术语：%s）' % '、'.join(c['terms'])
    return line


def cue_snippet(cues, k):
    a = max(0, k - 1)
    b = min(len(cues) - 1, k + 1)
    return limit_text(chunk_plain(cues, a, b), 90)


def memory_context(mem, t, question, ms):
    cues = mem['cues']
    n = len(cues)
    chunks = mem['chunks']
    g = mem.get('global')
    lo = t - ms['focusBefore']
    hi = t + ms['focusAfter']

    # ---- 焦点层：t 前后原文，▶ 标出暂停那一句
    cur = -1
    for i in range(n):
        if cues[i]['s'] <= t + 0.3:
            cur = i
        else:
            break
    pre, post = [], []
    cur_line = None
    focus_chars = 0
    focus_text = []
    focus_lo = n
    for i in range(n):
        c = cues[i]
        if c['e'] < lo and i != cur:
            continue
        if c['s'] > hi:
            break
        if i < focus_lo:
            focus_lo = i
        line = '[%s] %s' % (format_clock(c['s']), c['text'])
        focus_chars += len(c['text'])
        focus_text.append(c['text'] + ' ')
        if i < cur:
            pre.append(line)
        elif i == cur:
            cur_line = '▶ %s　← 用户在 %s 暂停，这是暂停时正在播（或刚播完）的一句' % (line, format_clock(t))
        else:
            post.append(line)
    fl = []
    if pre:
        fl.append('（暂停前，用户刚听过）')
        fl.extend(pre)
    if cur_line:
        fl.append(cur_line)
    if post:
        fl.append('（暂停后，用户还没看到）')
        fl.extend(post)
    focus = '\n'.join(fl)

    # ---- 暂停点落在哪个小节 / 哪一章
    ci = 0
    for c in chunks:
        if c['s'] <= t:
            ci = int(c['i'])
        else:
            break
    cur_chapter = None
    cur_chapter_no = 0

    # ---- 全局层
    gl, ol = [], []
    if g:
        if g.get('topic'):
            gl.append('主题：%s' % g['topic'])
        if g.get('summary'):
            gl.append('主线：%s' % g['summary'])
        gl.append('章节（全长 %s）：' % format_clock(mem['duration']))
        k = 0
        for ch in (g.get('chapters') or []):
            k += 1
            line = '  %d. [%s-%s] %s' % (k, format_clock(ch['s']), format_clock(ch['e']), ch['title'])
            if ci >= int(ch['from']) and ci <= int(ch['to']):
                line += '　← 用户现在在这一章'
                cur_chapter = ch
                cur_chapter_no = k
            gl.append(line)
            ol.append('[%s] %s' % (format_clock(ch['s']), ch['title']))
        terms = [t for t in (g.get('terms') or []) if t and t.get('term')][:12]
        if terms:
            gl.append('关键术语：%s' % '；'.join(
                ('%s（%s）' % (t['term'], t['def'])) if t.get('def') else str(t['term']) for t in terms))
    else:
        llm = [c for c in chunks if c['src'] == 'llm']
        if llm:
            gl.append('（整片总览还在生成，先给已读完的小节标题）')
            for c in llm:
                gl.append('  [%s] %s' % (format_clock(c['s']), c['title']))
                ol.append('[%s] %s' % (format_clock(c['s']), c['title']))
        else:
            gl.append('（整片记忆还在生成，暂时只有暂停点附近的字幕）')

    # ---- 章节层：上一 / 当前 / 下一小节
    sl = []
    if chunks:
        if cur_chapter:
            sl.append('所在章节：第 %d 章「%s」' % (cur_chapter_no, cur_chapter['title']))
        if ci > 0:
            sl.append(format_chunk_line(chunks[ci - 1], '上一小节'))
        sl.append(format_chunk_line(chunks[ci], '▶ 当前小节'))
        if ci + 1 < len(chunks):
            sl.append(format_chunk_line(chunks[ci + 1], '下一小节'))

    # ---- 回溯层 ①：焦点里出现的术语，在前文第一次出现的地方（老师常说「我们前面讲过的 X」）
    rl = []
    term_defs = {}
    if g:
        for tm in (g.get('terms') or []):
            if tm and tm.get('term') and str(tm['term']) not in term_defs:
                term_defs[str(tm['term'])] = str(tm.get('def') or '')
    for c in chunks:
        if c['src'] == 'llm':
            for tm in c['terms']:
                if tm and str(tm) not in term_defs:
                    term_defs[str(tm)] = ''
    probe = ''.join(focus_text) + ' ' + (question or '')
    probe_l = probe.lower()
    used_cues = set()
    for term in sorted(term_defs.keys(), key=lambda x: -len(x)):
        if len(rl) >= 2:
            break
        if len(term) < 2 or term.lower() not in probe_l:
            continue
        first = -1
        for k in range(focus_lo):
            if term.lower() in cues[k]['text'].lower():
                first = k
                break
        if first < 0 or cues[first]['s'] >= lo - 5 or first in used_cues:
            continue
        used_cues.add(first)
        line = '- 「%s」最早在 [%s] 出现：%s' % (term, format_clock(cues[first]['s']), cue_snippet(cues, first))
        if term_defs[term]:
            line += '（术语表：%s）' % term_defs[term]
        rl.append(line)

    # ---- 回溯层 ②：追问时按问题检索焦点之外最相关的小节（二字词 + 逆文档频率）
    if question and question != T_DEFAULT_QUESTION and len(chunks) >= 2:
        idx = get_mem_index(mem)
        qg = bigrams(question)
        best, best_score, best_hits = -1, 0.0, 0
        for k, c in enumerate(chunks):
            if c['e'] >= lo and c['s'] <= hi:
                continue  # 和焦点重叠的小节已经在上面了
            score, hits = 0.0, 0
            for q in qg:
                if q not in idx['sets'][k]:
                    continue
                df = idx['df'][q]
                if df >= idx['n']:
                    continue  # 每节都有的词没有区分度
                score += math.log((idx['n'] + 1.0) / (df + 0.5))
                hits += 1
            if hits >= 2 and score > best_score:
                best, best_score, best_hits = k, score, hits
        if best >= 0:
            c = chunks[best]
            rl.append('- 和这次追问最相关的另一段：' + format_chunk_line(c, ''))
            bk, bh = -1, 0
            for k in range(int(c['a']), int(c['b']) + 1):
                h = sum(1 for q in qg if q in cues[k]['text'].lower())
                if h > bh:
                    bh, bk = h, k
            if bk >= 0:
                rl.append('  原文 [%s]：%s' % (format_clock(cues[bk]['s']), cue_snippet(cues, bk)))

    return {
        'used': True,
        'status': str(mem['status']),
        'source': str(mem['source']),
        'focus': focus,
        'focus_chars': focus_chars,
        'global_layer': limit_text('\n'.join(gl), 1600),
        'section_layer': limit_text('\n'.join(sl), 700) if sl else '（无）',
        'recall_layer': limit_text('\n'.join(rl), 600) if rl else '（无）',
        'outline': limit_text(' / '.join(ol), 600) if ol else '（无）',
        'chunk_index': ci,
        'chapter': str(cur_chapter['title']) if cur_chapter else None,
        'chapters': len(g.get('chapters') or []) if g else 0,
        'recall_hits': len(rl),
    }


def memory_vars(cfg, video_id, t_sec, question, client_transcript=''):
    """给 /explain、/followup、/route 用：没有记忆时各层填说明文字，保证提示词里不留 {{占位符}}"""
    ms = mem_settings(cfg)
    empty = {
        'used': False, 'status': 'none', 'focus': None, 'focus_chars': 0, 'chapters': 0, 'recall_hits': 0,
        'global_layer': '（没有整片字幕记忆，只拿到了暂停点附近的字幕）', 'section_layer': '（无）',
        'recall_layer': '（无）', 'outline': '（无）',
        'focus_before': str(int(ms['focusBefore'])), 'focus_after': str(int(ms['focusAfter'])),
    }
    if not ms['enabled'] or not video_id or t_sec is None or str(t_sec) == '':
        return empty
    try:
        t = float(t_sec)
    except (TypeError, ValueError):
        return empty
    mem = get_memory(video_id)
    if not mem or not mem.get('cues'):
        return empty
    try:
        r = memory_context(mem, t, question, ms)
        r['focus_before'] = empty['focus_before']
        r['focus_after'] = empty['focus_after']
        # 防串台：客户端自己抓到的字幕和记忆里同一时间段的字幕几乎不重合（同一个编号换了视频、
        # 开发自测页不同课程共用一个编号……），就不用这份记忆，免得把别的视频的内容拼进提示词
        if client_transcript and r['focus_chars'] >= 10:
            cg = bigrams(re.sub(r'\[\d{1,3}:\d{2}\]', '', client_transcript))
            if len(cg) >= 12:
                fg = bigrams(r['focus'])
                hit = sum(1 for x in cg if x in fg)
                if hit / len(cg) < 0.3:
                    print('    整片记忆和这次的字幕对不上（重合 %d%%），这次不用记忆：%s'
                          % (int(hit / len(cg) * 100), video_id), flush=True)
                    empty['status'] = 'mismatch'
                    return empty
        return r
    except Exception as e:
        print('    拼装整片记忆失败：%s' % e, flush=True)
        empty['status'] = 'error'
        return empty


def mem_status_obj(mem):
    if not mem:
        return {'status': 'none'}
    chunks = mem.get('chunks') or []
    g = mem.get('global')
    return {
        'status': str(mem.get('status')), 'source': str(mem.get('source')), 'hash': str(mem.get('hash')),
        'cues': len(mem.get('cues') or []), 'chunks': len(chunks),
        'chunks_llm': sum(1 for c in chunks if c.get('src') == 'llm'),
        'chapters': len(g.get('chapters') or []) if g else 0,
        'topic': str(g.get('topic')) if g else None,
        'progress': mem.get('progress'), 'error': mem.get('error'),
        'built_ms': mem.get('built_ms'), 'updated': mem.get('updated'),
    }


# ---------------------------------------------------------------- HTTP 基础设施
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'coaxly-proxy/' + VERSION

    # ---- 由 Router 注入的日志回调
    log_summary = None

    def log_message(self, fmt, *args):  # 关掉默认的访问日志，用自己的
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self._cors()
        self.send_header('Content-Length', str(len(data)))
        # HEAD 请求只回头
        if self.command != 'HEAD':
            self.end_headers()
            self.wfile.write(data)
        else:
            self.end_headers()
        self.close_connection = True

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length > 0 else b''
        if not raw.strip():
            return {}
        try:
            obj = json.loads(raw.decode('utf-8', 'replace'))
        except ValueError as e:
            raise RuntimeError('请求体不是合法 JSON：%s' % e)
        return obj if isinstance(obj, dict) else {}

    def start_sse(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self._cors()
        self.send_header('Connection', 'close')
        self.end_headers()

    def send_sse(self, obj):
        data = ('data: ' + json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n\n').encode('utf-8')
        self.wfile.write(data)
        self.wfile.flush()

    # ---- 路由分发
    def handle_one_request(self):
        self._t0 = time.time()
        super().handle_one_request()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()
        self.note('preflight')

    def do_GET(self):
        path = self.path.split('?')[0].rstrip('/') or '/'
        if path in ('/', '/health'):
            return self.handle_health()
        if path == '/memory/status':
            return self.handle_memory_status()
        self.send_json(404, {'error': '没有这个接口：%s %s' % (self.command, path)})
        self.note('not found')

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = self.path.split('?')[0].rstrip('/')
        table = {
            '/explain': self.handle_explain,
            '/route': self.handle_route,
            '/followup': self.handle_followup,
            '/log': self.handle_client_log,
            '/ocr': self.handle_ocr,
            '/asr': self.handle_asr,
            '/summarize': self.handle_summarize,
            '/keypoints': self.handle_keypoints,
            '/memory/build': self.handle_memory_build,
            '/memory/context': self.handle_memory_context,
        }
        fn = table.get(path)
        if not fn:
            self.send_json(404, {'error': '没有这个接口：%s %s' % (self.command, path)})
            return self.note('not found')
        try:
            body = self.read_body()
        except RuntimeError as e:
            self.send_json(400, {'error': str(e)})
            return self.note('bad request')
        try:
            fn(body)
        except (BrokenPipeError, ConnectionResetError):
            self.note('client disconnected (broken pipe)')
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_json(500, {'error': '代理内部错误：%s' % e})
            except Exception:
                pass
            self.note('ERROR %s' % e)

    def note(self, summary):
        if self.log_summary:
            elapsed = int((time.time() - getattr(self, '_t0', time.time())) * 1000)
            self.log_summary('%-4s %-10s %6dms  %s' % (self.command, self.path.split('?')[0].rstrip('/') or '/', elapsed, summary))

    # ---- /health
    def handle_health(self):
        cfg = get_config()
        try:
            files = sorted(f for f in os.listdir(PROMPT_DIR) if f.endswith('.md'))
        except OSError:
            files = []
        ocr_on = not is_false(cfg.get('ocr'))
        asr_on = cfg.get('asrEngine') != 'off'
        ocr = init_ocr() if ocr_on else {'ok': False, 'error': None}
        asr = init_asr() if asr_on else {'ok': False, 'error': None}
        self.send_json(200, {
            'ok': True,
            'name': 'coaxly-proxy',
            'version': VERSION,
            'platform': 'macOS',
            'hasKey': has_key(cfg),
            'baseUrl': str(cfg.get('baseUrl')),
            'model': str(cfg.get('model')),
            'visionModel': str(cfg.get('visionModel')),
            'sendImage': not is_false(cfg.get('sendImage')),
            'ocr': ocr_on,
            'ocrReady': bool(ocr.get('ok')),
            'ocrError': ocr.get('error'),
            'asrEngine': cfg.get('asrEngine'),
            'asrReady': bool(asr.get('ok')),
            'asrError': asr.get('error'),
            'asrModel': str(get_field(cfg.get('asr'), 'model', '') or '') if cfg.get('asrEngine') == 'cloud' else None,
            'features': ['explain', 'route', 'followup', 'ocr', 'asr', 'summarize', 'keypoints', 'memory'],
            'memory': {'enabled': mem_settings(cfg)['enabled'], 'building': list(_mem_jobs.keys())},
            'prompts': files,
        })
        self.note('ok')

    # ---- /route（Call 1 单独调用）
    def handle_route(self, body):
        cfg = get_config()
        variables = {
            'subject': get_non_empty(body, 'subject', T_UNKNOWN_SUBJECT),
            'timestamp': get_non_empty(body, 'timestamp', '00:00'),
            'transcript': str(get_field(body, 'transcript', '') or ''),
            'question': get_non_empty(body, 'question', ''),
        }
        mem = memory_vars(cfg, str(get_field(body, 'video_id', '') or ''), get_field(body, 't_sec'),
                          variables['question'], variables['transcript'])
        variables['outline'] = mem['outline']
        if mem['focus'] and mem['focus_chars'] >= transcript_body_length(variables['transcript']):
            variables['transcript'] = mem['focus']
        meta = {'session_id': get_field(body, 'session_id'), 'video_id': get_field(body, 'video_id')}
        r = invoke_router(cfg, variables, meta)
        self.send_json(200, {'route': r['route'], 'redirect': r['redirect'], 'fallback': bool(r['fallback']),
                             'error': r.get('error'), 'total_ms': r['ms']})
        self.note('route=%s fallback=%s' % (r['route'], r['fallback']))

    # ---- /explain（Call 2）
    def _call2_once(self, cfg, system, question, text_question, image, use_image, temperature):
        vision_error = None
        screen_text = ''
        if use_image:
            content = [
                {'type': 'text', 'text': question},
                {'type': 'image_url', 'image_url': {'url': image}},
            ]
            r = invoke_chat(cfg, str(cfg['visionModel']), system, content, temperature, 400, None)
            if r['ok']:
                r['vision_used'] = True
                r['model_used'] = str(cfg['visionModel'])
                return r
            # 规格 2.4：视觉调用失败 → 自动回落纯文本重试一次（这时用本地文字识别补上画面里的字）
            vision_error = r.get('error')
            print('    视觉调用失败，回落纯文本：' + limit_text(vision_error, 160), file=sys.stderr)
            if text_question == question:
                screen_text = format_screen_text(get_frame_text(cfg, image))
                if screen_text:
                    text_question = question + '\n\n' + screen_text
        r = invoke_chat(cfg, str(cfg['model']), system, text_question, temperature, 400, None)
        r['vision_used'] = False
        r['model_used'] = str(cfg['model'])
        r['vision_error'] = vision_error
        r['screen_text'] = screen_text
        return r

    def handle_explain(self, body):
        t0 = time.time()
        cfg = get_config()
        question = get_non_empty(body, 'question', T_DEFAULT_QUESTION)
        timestamp = get_non_empty(body, 'timestamp', '00:00')
        transcript = str(get_field(body, 'transcript', '') or '')
        client_transcript_len = len(transcript)
        image = str(get_field(body, 'image', '') or '')
        want_image = image.startswith('data:image/') and not is_false(cfg.get('sendImage'))

        # 整片记忆（v1.4）：有记忆时，焦点层从整片字幕里按暂停点重新截取——
        # 包括用户还没播到的后 30 秒，并标出暂停那一句；另外拼上全局层、章节层、回溯层
        mem = memory_vars(cfg, str(get_field(body, 'video_id', '') or ''), get_field(body, 't_sec'), question, transcript)
        use_mem_focus = bool(mem['used'] and mem['focus'] and mem['focus_chars'] >= math.floor(0.8 * transcript_body_length(transcript)))
        prompt_transcript = mem['focus'] if use_mem_focus else transcript

        # 模型不看图时，用本地文字识别读出画面上的字（含烧在画面里的硬字幕）
        frame_text = None
        if not want_image:
            frame_text = get_frame_text(cfg, image)
        if frame_text and frame_text.get('ok'):
            transcript = add_subtitle_to_transcript(transcript, timestamp, frame_text['subtitle'])
            prompt_transcript = add_subtitle_to_transcript(prompt_transcript, timestamp, frame_text['subtitle'])
        screen_text = format_screen_text(frame_text)
        text_question = question + '\n\n' + screen_text if screen_text else question

        if use_mem_focus:
            degraded = transcript_body_length(transcript) < 10 and mem['focus_chars'] < 10
        else:
            degraded = transcript_body_length(prompt_transcript) < 10
        route = str(get_field(body, 'route', 'in_video') or 'in_video')
        if route not in ROUTES:
            route = 'in_video'
        variables = {
            'subject': get_non_empty(body, 'subject', T_UNKNOWN_SUBJECT),
            'timestamp': timestamp,
            'transcript': prompt_transcript,
            'question': question,
            'past': format_past(get_field(body, 'past')),
            'route': route,
            'global_layer': mem['global_layer'],
            'section_layer': mem['section_layer'],
            'recall_layer': mem['recall_layer'],
            'focus_before': mem['focus_before'],
            'focus_after': mem['focus_after'],
        }
        prompt_file = 'call2_degraded.md' if degraded else 'call2_explain.md'
        system = fill_template(read_prompt(prompt_file), variables)

        rec = {
            'type': 'call2', 'session_id': get_field(body, 'session_id'), 'video_id': get_field(body, 'video_id'),
            'timestamp': timestamp, 'subject': variables['subject'], 'trigger': get_field(body, 'trigger', 'button'),
            'route': route, 'degraded': degraded, 'prompt_file': prompt_file,
            'transcript_len': len(transcript), 'transcript_snippet': transcript,
            'user_question': question, 'frame_sent': want_image, 'client_transcript_len': client_transcript_len,
            'ocr_used': bool(screen_text),
            'ocr_subtitle': frame_text.get('subtitle') if frame_text else None,
            'ocr_ms': frame_text.get('ms') if frame_text else None,
            'ocr_error': frame_text.get('error') if frame_text else None,
            't_sec': get_field(body, 't_sec'),
            'memory_status': mem['status'],
            'memory_focus': use_mem_focus,
            'memory_chapter': mem.get('chapter'),
            'memory_layer_chars': {'global': len(mem['global_layer']), 'section': len(mem['section_layer']),
                                   'focus': len(prompt_transcript), 'recall': len(mem['recall_layer'])},
            'recall_hits': mem['recall_hits'],
        }
        if use_mem_focus:
            rec['prompt_transcript'] = prompt_transcript
        mem_info = {'used': bool(mem['used']), 'status': mem['status'], 'focus': use_mem_focus,
                    'chapters': mem['chapters'], 'chapter': mem.get('chapter'), 'recall_hits': mem['recall_hits']}

        if not has_key(cfg):
            rec['error'] = 'no_api_key'
            write_call_log(rec)
            self.send_json(400, {'error': T_NO_KEY, 'code': 'no_api_key'})
            return self.note('no api key')

        first = self._call2_once(cfg, system, question, text_question, image, want_image, 0.4)
        if first.get('screen_text'):
            # 视觉调用失败回落纯文本时补上的画面文字，重试和追问也沿用
            screen_text = first['screen_text']
            text_question = question + '\n\n' + screen_text
            rec['ocr_used'] = True
        if not first['ok']:
            rec['error'] = first.get('error')
            rec['vision_error'] = first.get('vision_error')
            rec['total_ms'] = int((time.time() - t0) * 1000)
            write_call_log(rec)
            self.send_json(502, {'error': first.get('error'), 'code': 'upstream_error'})
            return self.note('upstream error')

        m1 = measure_explain(first['text'])
        final = m1
        final_model = first.get('model_used')
        vision_used = bool(first.get('vision_used'))
        retried = False
        retry_chars = None
        if m1['chars'] > CALL2_LIMIT:
            # 规格 4.4：超长 → temperature 0.2 + 追加约束，重试一次，更短才采用
            retried = True
            system2 = system + '\n\n' + read_prompt('call2_retry_suffix.md')
            second = self._call2_once(cfg, system2, question, text_question, image, vision_used, 0.2)
            if second['ok']:
                m2 = measure_explain(second['text'])
                retry_chars = m2['chars']
                if m2['chars'] < m1['chars']:
                    final = m2
                    final_model = second.get('model_used')
                    vision_used = bool(second.get('vision_used'))

        violation = final['chars'] > CALL2_LIMIT
        total_ms = int((time.time() - t0) * 1000)
        rec.update({
            'model': final_model, 'vision_used': vision_used, 'vision_error': first.get('vision_error'),
            'call2_output': final['text'], 'call2_chars': final['chars'], 'seg_count': final['seg_count'],
            'seg_lengths': final['seg_lengths'], 'length_violation': violation, 'retried': retried,
            'first_chars': m1['chars'], 'retry_chars': retry_chars, 'total_ms': total_ms,
        })
        write_call_log(rec)

        self.send_json(200, {
            'text': final['text'], 'segments': final['segments'], 'chars': final['chars'],
            'seg_count': final['seg_count'], 'seg_lengths': final['seg_lengths'],
            'length_violation': violation, 'retried': retried, 'degraded': degraded,
            'frame_sent': want_image, 'vision_used': vision_used, 'ocr_used': bool(screen_text),
            'screen_text': screen_text, 'transcript': transcript, 'route': route,
            'model': final_model, 'memory': mem_info, 'total_ms': total_ms,
        })
        flag = ' 超长!' if violation else ''
        deg = ' 降级' if degraded else ''
        ocr_flag = '' if not screen_text else (' 画面文字=%dms' % frame_text['ms'] if frame_text else ' 画面文字')
        mem_flag = (' 记忆=%s%s%s' % (mem['status'], '/' + mem['chapter'] if mem.get('chapter') else '',
                                      ' 回溯%d' % mem['recall_hits'] if mem['recall_hits'] else '')) if mem['used'] else ''
        self.note('call2 %d字 段长[%s]%s%s 图=%s%s 重试=%s%s'
                  % (final['chars'], ','.join(str(n) for n in final['seg_lengths']), flag, deg, vision_used, ocr_flag, retried, mem_flag))

    # ---- /followup（Call 3，流式）
    def handle_followup(self, body):
        t0 = time.time()
        cfg = get_config()
        follow_up = get_non_empty(body, 'follow_up', '')
        if not follow_up:
            self.send_json(400, {'error': 'follow_up 不能为空'})
            return self.note('empty follow_up')

        transcript = str(get_field(body, 'transcript', '') or '')
        # 整片记忆（v1.4）：追问时回溯层额外按「这句追问」检索焦点之外最相关的小节
        mem = memory_vars(cfg, str(get_field(body, 'video_id', '') or ''), get_field(body, 't_sec'), follow_up, transcript)
        use_mem_focus = bool(mem['used'] and mem['focus'] and mem['focus_chars'] >= math.floor(0.8 * transcript_body_length(transcript)))
        if use_mem_focus:
            transcript = mem['focus']
        degraded = (mem['focus_chars'] < 10) if use_mem_focus else (transcript_body_length(transcript) < 10)
        meta = {'session_id': get_field(body, 'session_id'), 'video_id': get_field(body, 'video_id')}
        mode = 'socratic' if str(get_field(body, 'mode', 'direct')) == 'socratic' else 'direct'
        timestamp = get_non_empty(body, 'timestamp', '00:00')
        route = str(get_field(body, 'route', '') or '')
        if route not in ROUTES:
            route = ''

        rec = {
            'type': 'call3', 'session_id': meta['session_id'], 'video_id': meta['video_id'],
            'timestamp': timestamp, 'follow_up': follow_up, 'mode': mode,
            'turn_index': get_field(body, 'turn_index'), 'degraded': degraded,
            't_sec': get_field(body, 't_sec'),
            'memory_status': mem['status'],
            'memory_focus': use_mem_focus,
            'memory_chapter': mem.get('chapter'),
            'recall_hits': mem['recall_hits'],
            'recall_layer': mem['recall_layer'] if mem['recall_hits'] else None,
        }

        self.start_sse()
        client_gone = False
        text_parts = []
        first_ms = None
        stream_error = None
        try:
            # 规格 3.1：首轮追问才路由；同一浮层后续追问沿用结论（由客户端带上 route）
            if not route:
                if degraded:
                    route_info = {'route': 'in_video', 'redirect': None, 'fallback': False}
                else:
                    route_info = invoke_router(cfg, {
                        'subject': get_non_empty(body, 'subject', T_UNKNOWN_SUBJECT),
                        'timestamp': timestamp, 'transcript': transcript, 'question': follow_up,
                        'outline': mem['outline'],
                    }, meta)
                route = route_info['route']
                rec['routed_now'] = True
                self.send_sse({'type': 'route', 'route': route, 'redirect': route_info.get('redirect'),
                               'fallback': bool(route_info.get('fallback'))})
                if route == 'off_topic':
                    rec['route'] = route
                    rec['call3_output'] = route_info.get('redirect')
                    rec['skipped'] = 'off_topic'
                    self.send_sse({'type': 'done', 'off_topic': True, 'total_ms': int((time.time() - t0) * 1000)})
                    return self.note('call3 skipped (off_topic)')
            rec['route'] = route

            if not has_key(cfg):
                rec['error'] = 'no_api_key'
                self.send_sse({'type': 'error', 'message': T_NO_KEY})
                return self.note('no api key')

            mode_info = read_mode(mode)
            variables = {
                'original_concept': get_non_empty(body, 'original_concept', T_DEFAULT_CONCEPT),
                'mode_label': mode_info['label'],
                'mode_rules': mode_info['rules'],
                'call2_output': get_non_empty(body, 'call2_output', '（无）'),
                'follow_up': follow_up,
                'history_summary': format_history(get_field(body, 'history')),
                'transcript': T_NO_TRANSCRIPT if degraded else transcript,
                'global_layer': mem['global_layer'],
                'section_layer': mem['section_layer'],
                'recall_layer': mem['recall_layer'],
                'focus_before': mem['focus_before'],
                'focus_after': mem['focus_after'],
            }
            system = fill_template(read_prompt('call3_followup.md'), variables)
            # 讲解时本地文字识别读出的画面文字，追问时也带上
            user_msg = follow_up
            screen_text = limit_text(str(get_field(body, 'screen_text', '') or ''), 800)
            if screen_text.strip():
                user_msg = follow_up + '\n\n' + screen_text
                rec['screen_text_sent'] = True
            payload = {
                'model': str(cfg['model']),
                'messages': [
                    {'role': 'system', 'content': system},
                    {'role': 'user', 'content': user_msg},
                ],
                'temperature': 0.6,
                'max_tokens': 400,
                'stream': True,
            }
            r = send_upstream(cfg, payload, True)
            if not r['ok']:
                rec['error'] = r.get('error')
                self.send_sse({'type': 'error', 'message': r.get('error')})
                return self.note('upstream error')

            resp = r['response']
            non_sse = []
            try:
                for raw_line in resp:
                    line = raw_line.decode('utf-8', 'replace').rstrip('\r\n')
                    if not line.startswith('data:'):
                        if line:
                            non_sse.append(line)
                        continue
                    data = line[5:].strip()
                    if data == '[DONE]':
                        break
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    err_obj = chunk.get('error')
                    if err_obj:
                        stream_error = '上游流式报错：' + limit_text(str(get_field(err_obj, 'message', data)), 300)
                        break
                    delta = None
                    try:
                        delta = chunk['choices'][0]['delta'].get('content')
                    except (KeyError, IndexError, AttributeError, TypeError):
                        pass
                    if delta:
                        if first_ms is None:
                            first_ms = int((time.time() - t0) * 1000)
                        text_parts.append(str(delta))
                        try:
                            self.send_sse({'type': 'delta', 'text': str(delta)})
                        except (BrokenPipeError, ConnectionResetError):
                            client_gone = True
                            break
            except Exception as e:
                stream_error = '读取上游流时中断：' + str(e)
            finally:
                try:
                    resp.close()
                except Exception:
                    pass

            # 上游无视 stream=true、直接回了一整块 JSON 的情况
            if not text_parts and not stream_error and non_sse:
                try:
                    whole = json.loads('\n'.join(non_sse))
                    c = str(whole['choices'][0]['message']['content'])
                    if c:
                        first_ms = int((time.time() - t0) * 1000)
                        text_parts.append(c)
                        self.send_sse({'type': 'delta', 'text': c})
                except Exception:
                    pass

            if not client_gone:
                if stream_error:
                    self.send_sse({'type': 'error', 'message': stream_error, 'partial': True})
                out = ''.join(text_parts)
                self.send_sse({'type': 'done', 'call3_chars': len(re.sub(r'\s', '', out)),
                               'first_token_ms': first_ms, 'total_ms': int((time.time() - t0) * 1000)})
            out_len = len(re.sub(r'\s', '', ''.join(text_parts)))
            self.note('call3 %s %d字 首字=%sms%s' % (mode, out_len, first_ms, ' (客户端已断开)' if client_gone else ''))
        except (BrokenPipeError, ConnectionResetError):
            client_gone = True
        except Exception as e:
            rec['error'] = str(e)
            try:
                self.send_sse({'type': 'error', 'message': '代理内部错误：' + str(e)})
            except Exception:
                client_gone = True
            self.note('call3 failed: %s' % e)
        finally:
            if 'call3_output' not in rec:
                rec['call3_output'] = ''.join(text_parts)
            rec['call3_chars'] = len(re.sub(r'\s', '', str(rec.get('call3_output') or '')))
            rec['first_token_ms'] = first_ms
            rec['total_ms'] = int((time.time() - t0) * 1000)
            rec['aborted'] = client_gone
            if stream_error:
                rec['error'] = stream_error
            write_call_log(rec)
            try:
                self.wfile.close()
            except Exception:
                pass

    # ---- /ocr（画面识字）
    def handle_ocr(self, body):
        cfg = get_config()
        if is_false(cfg.get('ocr')):
            self.send_json(200, {'ok': False, 'code': 'ocr_disabled', 'error': '配置里关掉了画面识字（ocr: false）'})
            return self.note('quiet')
        region = 'full' if str(get_field(body, 'region', 'subtitle')) == 'full' else 'subtitle'
        o = invoke_ocr(str(get_field(body, 'image', '') or ''))
        if not o['ok']:
            self.send_json(200, {'ok': False, 'code': o.get('code'), 'error': o.get('error')})
            return self.note('quiet')
        s = split_ocr_text(o, region)
        self.send_json(200, {'ok': True, 'subtitle': s['subtitle'], 'other': s['other'],
                             'width': o['width'], 'height': o['height'], 'ms': o['ms']})
        self.note('quiet')

    # ---- /asr
    def handle_asr(self, body):
        t0 = time.time()
        cfg = get_config()
        rec = {
            'type': 'asr', 'session_id': get_field(body, 'session_id'), 'video_id': get_field(body, 'video_id'),
            'engine': cfg.get('asrEngine'), 'reason': get_field(body, 'reason'),
        }
        if cfg.get('asrEngine') == 'off':
            self.send_json(200, {'ok': False, 'code': 'asr_disabled', 'error': '配置里关掉了语音识别（asr.engine = "off"）'})
            return self.note('asr disabled')
        wav = parse_wav_data_url(str(get_field(body, 'audio', '') or ''))
        if not wav:
            self.send_json(400, {'ok': False, 'code': 'bad_audio', 'error': '收到的不是 WAV 录音'})
            return self.note('asr bad audio')
        rec['audio_sec'] = wav_seconds(wav)
        r = None
        if cfg.get('asrEngine') == 'cloud':
            r = cloud_asr(cfg, wav)
            if not r['ok']:
                rec['cloud_error'] = r['error']
                print('    云端语音识别失败，改用本机识别：' + limit_text(r['error'], 160), file=sys.stderr)
                r = None
        if not r:
            r = local_asr(wav)
        text = str(r.get('text') or '')
        rec.update({
            'engine_used': r.get('engine'), 'ok': bool(r.get('ok')), 'text': text,
            'chars': len(re.sub(r'\s', '', text)), 'error': r.get('error'),
            'total_ms': int((time.time() - t0) * 1000),
        })
        write_call_log(rec)
        self.send_json(200, {
            'ok': bool(r.get('ok')), 'text': text, 'engine': r.get('engine'), 'code': r.get('code'),
            'error': r.get('error'), 'cloud_error': rec.get('cloud_error'),
            'audio_sec': rec['audio_sec'], 'total_ms': rec['total_ms'],
        })
        if not r.get('ok'):
            return self.note('asr failed: ' + limit_text(str(r.get('error')), 80))
        self.note('asr %s 音频%s秒 → %s字「%s」' % (r.get('engine'), rec['audio_sec'], rec['chars'], limit_text(text, 20)))

    # ---- /summarize（Call 4）
    def handle_summarize(self, body):
        t0 = time.time()
        cfg = get_config()
        turns = [t for t in (get_field(body, 'turns') or []) if t]
        transcript = str(get_field(body, 'transcript', '') or '')
        if len(transcript) > 600:
            transcript = '…' + transcript[-600:]
        variables = {
            'subject': get_non_empty(body, 'subject', T_UNKNOWN_SUBJECT),
            'timestamp': get_non_empty(body, 'timestamp', '00:00'),
            'original_concept': get_non_empty(body, 'original_concept', T_DEFAULT_CONCEPT),
            'transcript': T_NO_TRANSCRIPT if transcript_body_length(transcript) < 10 else transcript,
            'call2_output': get_non_empty(body, 'call2_output', '（无）'),
            'turns': format_turns(turns),
            'turn_count': str(len(turns)),
        }
        rec = {
            'type': 'call4', 'session_id': get_field(body, 'session_id'), 'video_id': get_field(body, 'video_id'),
            'node_id': get_field(body, 'node_id'), 'timestamp': variables['timestamp'], 'turn_count': len(turns),
        }
        if not has_key(cfg):
            rec['error'] = 'no_api_key'
            write_call_log(rec)
            self.send_json(400, {'error': T_NO_KEY, 'code': 'no_api_key'})
            return self.note('no api key')
        system = fill_template(read_prompt('call4_summary.md'), variables)
        r = invoke_chat(cfg, str(cfg['model']), system, '请写这条学习记录的一句话说明。', 0.3, 80, None)
        if not r['ok']:
            rec['error'] = r.get('error')
            rec['total_ms'] = int((time.time() - t0) * 1000)
            write_call_log(rec)
            self.send_json(502, {'error': r.get('error'), 'code': 'upstream_error'})
            return self.note('call4 upstream error')
        summary = to_one_line(r['text'])
        chars = len(re.sub(r'\s', '', summary))
        rec.update({'summary': summary, 'chars': chars, 'total_ms': int((time.time() - t0) * 1000)})
        write_call_log(rec)
        self.send_json(200, {'ok': True, 'summary': summary, 'chars': chars, 'model': str(cfg['model']),
                             'total_ms': rec['total_ms']})
        self.note('call4 %d字「%s」' % (chars, summary))

    # ---- /keypoints（Call 5）
    def handle_keypoints(self, body):
        t0 = time.time()
        cfg = get_config()
        lines = []
        for l in get_field(body, 'lines') or []:
            if not isinstance(l, dict):
                continue
            t = parse_clock(get_field(l, 't'))
            text = re.sub(r'\s+', ' ', str(get_field(l, 'text', '') or '')).strip()
            if t is not None and text:
                lines.append({'t': float(t), 'text': text})
        lines.sort(key=lambda x: x['t'])
        frm = parse_clock(get_field(body, 'span_from'))
        to = parse_clock(get_field(body, 'span_to'))
        if frm is None:
            frm = lines[0]['t'] if lines else 0.0
        if to is None:
            to = lines[-1]['t'] if lines else 0.0
        if to < frm:
            to = frm
        duration = parse_clock(get_field(body, 'duration'))
        known = [str(k).strip() for k in (get_field(body, 'known') or []) if str(k).strip()][-30:]
        cap = max(1, min(6, math.ceil((to - frm) / 100)))

        # 字幕拼成「[mm:ss] 句子」，最多 6000 字
        sb = []
        chars = 0
        for l in lines:
            if sum(len(x) for x in sb) >= 6000:
                break
            sb.append('[%s] %s\n' % (format_clock(l['t']), l['text']))
            chars += len(re.sub(r'\s', '', l['text']))
        transcript = ''.join(sb).rstrip('\n')

        rec = {
            'type': 'call5', 'video_id': get_field(body, 'video_id'), 'source': get_field(body, 'source'),
            'span_from': round(frm, 1), 'span_to': round(to, 1), 'lines': len(lines), 'chars': chars,
            'known': len(known), 'max_points': cap,
        }
        points = []
        result_source = 'ai'
        reason = None
        json_mode = None
        if chars < 30:
            result_source = 'empty'
        elif not has_key(cfg):
            result_source = 'rule'
            reason = 'no_api_key'
        else:
            variables = {
                'subject': get_non_empty(body, 'subject', T_UNKNOWN_SUBJECT),
                'span': '%s–%s' % (format_clock(frm), format_clock(to)),
                'duration': format_clock(duration) if (duration or 0) > 0 else '未知',
                'known': '、'.join(known) if known else '（无）',
                'max_points': str(cap),
                'transcript': transcript,
            }
            system = fill_template(read_prompt('call5_keypoints.md'), variables)
            user = '请标出这一段字幕里的课程重点，只输出 JSON。'
            json_mode = True
            r = invoke_chat(cfg, str(cfg['model']), system, user, 0.2, 600,
                            {'response_format': {'type': 'json_object'}})
            if not r['ok'] and r.get('status', 0) >= 400 and r.get('status') not in (401, 403, 429):
                json_mode = False
                r = invoke_chat(cfg, str(cfg['model']), system, user, 0.2, 600, None)
            if not r['ok']:
                result_source = 'rule'
                reason = 'upstream_error'
                rec['error'] = r.get('error')
            else:
                parsed = parse_keypoints_json(r['text'])
                if parsed is None:
                    result_source = 'rule'
                    reason = 'parse_failed'
                    rec['error'] = 'parse_failed: ' + limit_text(r['text'], 160)
                else:
                    rec['raw_points'] = len(parsed['points'])
                    points = resolve_keypoints(parsed['points'], lines, frm, to, known, cap)
        if result_source == 'rule':
            points = rule_keypoints(lines, frm, to, known, cap)

        rec['result'] = result_source
        rec['fallback_reason'] = reason
        rec['json_mode'] = json_mode
        rec['points'] = ['%s [%s%s] %s' % (p['timestamp'], p['kind'], '·核心' if p['level'] == 2 else '', p['title']) for p in points]
        rec['total_ms'] = int((time.time() - t0) * 1000)
        write_call_log(rec)
        self.send_json(200, {
            'ok': True, 'points': points, 'source': result_source, 'fallback_reason': reason,
            'max_points': cap, 'model': str(cfg['model']) if result_source == 'ai' else None,
            'total_ms': rec['total_ms'],
        })
        span = '%s-%s' % (format_clock(frm), format_clock(to))
        if result_source == 'empty':
            self.note('call5 %s 字幕太少，跳过' % span)
        else:
            self.note('call5 %s %s%s → %d 个重点' % (span, result_source, '(%s)' % reason if reason else '', len(points)))

    # ---- /log（客户端事件）
    def handle_client_log(self, body):
        rec = {'type': 'client_event'}
        rec.update(body)
        write_call_log(rec)
        self.send_json(200, {'ok': True})
        self.note('log %s' % rec.get('type'))

    # ---- /memory/build（v1.4：整片字幕 → 后台生成分层记忆）
    # 扩展拿到整片字幕后调用。立即返回，生成在后台线程进行。
    # 同一份字幕（hash 相同）已生成好就直接返回；字幕变了（例如边看边抓的字幕变多了）只重做原文变了的小节。
    def handle_memory_build(self, body):
        cfg = get_config()
        ms = mem_settings(cfg)
        vid = str(get_field(body, 'video_id', '') or '')
        if not vid:
            self.send_json(400, {'error': 'video_id 不能为空'})
            return self.note('memory build: no video_id')
        if not ms['enabled']:
            self.send_json(200, {'status': 'disabled'})
            return self.note('memory disabled')
        source = get_non_empty(body, 'source', 'bilibili')
        cues = to_mem_cues(get_field(body, 'cues'))
        if len(cues) < 5:
            self.send_json(200, {'status': 'too_short', 'cues': len(cues)})
            return self.note('memory too short (%d)' % len(cues))
        h = cues_hash(cues, ms)
        old = get_memory(vid)
        force = get_field(body, 'force', False) is True

        with _mem_lock:
            job = _mem_jobs.get(vid)
            if job and not force:
                # 整片字幕优先于边看边抓：正在用边看边抓的字幕生成时，来了整片字幕就换掉
                if not (job['mem'].get('source') == 'live' and source != 'live'):
                    self.send_json(200, mem_status_obj(job['mem']))
                    return self.note('memory %s 生成中 %d/%d' % (vid, job['done'], job['total']))
            if old and old.get('source') != 'live' and source == 'live' and not force:
                self.send_json(200, mem_status_obj(old))
                return self.note('memory %s 已有整片字幕记忆，忽略边看边抓' % vid)
            if old and old.get('hash') == h and not force and (old.get('status') == 'ready' or not has_key(cfg)):
                self.send_json(200, mem_status_obj(old))
                return self.note('memory %s 已就绪（%s）' % (vid, old.get('status')))

        chunks = split_mem_chunks(cues, ms)
        try:
            dur = float(get_field(body, 'duration', 0) or 0)
        except (TypeError, ValueError):
            dur = 0.0
        if dur <= 0:
            dur = float(cues[-1]['e'])
        mem = {
            'version': MEM_VERSION, 'video_id': vid,
            'subject': get_non_empty(body, 'subject', T_UNKNOWN_SUBJECT),
            'desc': limit_text(str(get_field(body, 'desc', '') or ''), 300),
            'source': source, 'lan': str(get_field(body, 'lan', '') or ''),
            'hash': h, 'duration': dur, 'status': 'building',
            'error': None, 'model': None, 'progress': None, 'built_ms': None, 'updated': None,
            'global': None, 'chunks': chunks, 'cues': cues,
        }
        # 原文没变的小节沿用上次的摘要（小节按原文 hash 对应）
        reused = 0
        if old and not force:
            by_hash = {str(c['hash']): c for c in old['chunks'] if c.get('src') == 'llm'}
            for c in chunks:
                o = by_hash.get(str(c['hash']))
                if o:
                    c['title'] = str(o['title'])
                    c['summary'] = str(o['summary'])
                    c['terms'] = list(o['terms'] or [])
                    c['src'] = 'llm'
                    reused += 1
        with _mem_lock:
            _mem_cache[vid] = mem
        if not has_key(cfg):
            # 没 Key 也能用：焦点层和回溯层不需要模型，只是没有摘要和大纲
            mem['status'] = 'raw'
            mem['error'] = 'no_api_key'
            save_memory(mem)
            self.send_json(200, mem_status_obj(mem))
            return self.note('memory %s 没有 Key，只存原文 %d 句' % (vid, len(cues)))
        job = start_memory_job(mem, cfg)
        save_memory(mem)
        self.send_json(200, mem_status_obj(mem))
        self.note('memory %s 开始生成：%s %d 句 → %d 小节（沿用 %d），map %d 批'
                  % (vid, source, len(cues), len(chunks), reused, job['total']))

    # ---- /memory/status（GET ?video_id=）
    def handle_memory_status(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        vid = (qs.get('video_id') or [''])[0]
        self.send_json(200, mem_status_obj(get_memory(vid)))
        self.note('quiet')

    # ---- /memory/context（调试 / 演示：看某个时间点实际会拼给模型的四层上下文）
    def handle_memory_context(self, body):
        cfg = get_config()
        vid = str(get_field(body, 'video_id', '') or '')
        question = str(get_field(body, 'question', '') or '')
        t0 = time.time()
        r = memory_vars(cfg, vid, get_field(body, 't'), question, str(get_field(body, 'transcript', '') or ''))
        self.send_json(200, {
            'used': r['used'], 'status': r['status'], 'chapter': r.get('chapter'),
            'chunk_index': r.get('chunk_index'),
            'global_layer': r['global_layer'], 'section_layer': r['section_layer'],
            'focus': r['focus'], 'recall_layer': r['recall_layer'], 'outline': r['outline'],
            'ms': int((time.time() - t0) * 1000),
        })
        self.note('memory context %s t=%s 回溯=%s' % (vid, get_field(body, 't', '?'), r['recall_hits']))


# ---------------------------------------------------------------- 启动
def banner(cfg, port):
    print()
    print('  \033[32m哄着学 v%s · 本地代理已启动（macOS）\033[0m' % VERSION)
    print('  地址      http://localhost:%d' % port)
    print('  模型      %s   视觉模型 %s' % (cfg['model'], cfg['visionModel']))
    print('  上游      %s' % cfg['baseUrl'])
    if has_key(cfg):
        print('  API Key   已配置')
    else:
        print('  \033[33mAPI Key   未配置！请编辑 proxy/config.json 的 apiKey（保存即生效）\033[0m')
    if is_false(cfg.get('ocr')):
        print('  画面识字  已关闭（config.json 里 ocr: false）')
    else:
        ocr = init_ocr()
        if ocr['ok']:
            print('  画面识字  可用（macOS Vision 本地识别，语言 %s）' % (ocr['lang'] or 'zh-Hans'))
        else:
            print('  \033[33m画面识字  不可用：%s\033[0m' % ocr['error'])
    if cfg.get('asrEngine') == 'off':
        print('  语音识别  已关闭（config.json 里 asr.engine = "off"）')
    else:
        asr = init_asr()
        note = ('云端 %s，失败时用本机；' % get_field(cfg.get('asr'), 'model', '')) if cfg.get('asrEngine') == 'cloud' else ''
        if asr['ok']:
            auth_note = '' if asr.get('engine') == 'speech-transcriber' else '；首次语音追问会弹一次系统授权，选允许'
            print('  语音识别  可用（%smacOS 本机识别，语言 %s%s%s）'
                  % (note, asr['lang'], '，设备端离线' if asr['on_device'] else '', auth_note))
        elif cfg.get('asrEngine') == 'cloud':
            print('  \033[33m语音识别  云端 %s；本机识别不可用：%s\033[0m' % (get_field(cfg.get('asr'), 'model', ''), asr['error']))
        else:
            print('  \033[33m语音识别  不可用：%s\033[0m' % asr['error'])
    print('  提示词    %s（每次请求实时读取，改完不用重启）' % PROMPT_DIR)
    print('  日志      %s' % LOG_FILE)
    print('  关闭这个窗口 = 停止代理。按 Ctrl+C 也可以停止。')
    print()


def run_server(port):
    Handler.log_summary = staticmethod(lambda msg: print('[%s] %s' % (datetime.now().strftime('%H:%M:%S'), msg), flush=True))

    servers = []
    try:
        v4 = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        servers.append(v4)
    except OSError as e:
        raise SystemExit('无法监听端口 %d：%s（是不是已经开了一个代理？或换一个 port）' % (port, e))
    try:
        import socket
        v6 = ThreadingHTTPServer(('::1', port), Handler)
        v6.address_family = socket.AF_INET6
        servers.append(v6)
    except OSError:
        pass  # IPv6 起不来没关系，IPv4 已就绪
    for s in servers:
        s.daemon_threads = True
        threading.Thread(target=s.serve_forever, kwargs={'poll_interval': 0.25}, daemon=True).start()
    return servers


def main():
    global LOG_FILE, CONFIG_PATH
    ap = argparse.ArgumentParser(description='哄着学 Coaxly 本地代理（macOS）')
    ap.add_argument('--config', default='', help='配置文件路径（默认 proxy/config.json）')
    ap.add_argument('--port', type=int, default=0, help='监听端口（默认取 config.json 的 port）')
    ap.add_argument('--log', default='', help='日志路径（开发自测时写到别处）')
    args = ap.parse_args()

    if args.config:
        CONFIG_PATH = args.config if os.path.isabs(args.config) else os.path.join(ROOT, args.config)
    if args.log:
        LOG_FILE = args.log if os.path.isabs(args.log) else os.path.join(ROOT, args.log)

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        example = os.path.join(PROXY_DIR, 'config.example.json')
        if os.path.exists(example):
            with open(example, 'r', encoding='utf-8') as f:
                data = f.read()
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
                f.write(data)

    try:
        cfg = get_config()
    except RuntimeError as e:
        raise SystemExit(str(e))
    port = args.port or int(cfg.get('port') or 0) or 8787

    servers = run_server(port)
    banner(cfg, port)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print('\n收到 Ctrl+C，代理停止。')
        for s in servers:
            s.shutdown()


if __name__ == '__main__':
    main()
