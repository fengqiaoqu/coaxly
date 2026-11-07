// 模拟一个 OpenAI 兼容的 /v1/chat/completions，用来在没有真实 Key 时自测代理和界面。
// 用法：node dev/mock-upstream.js [port]   （默认 9901）
// 然后把 proxy/config.json 的 baseUrl 改成 http://127.0.0.1:9901/v1，apiKey 随便填。
//
// 可触发的特殊行为：
//   model 含 "nojson"    → 带 response_format 时返回 400（测 Call 1 去掉 JSON 模式重试）
//   model 含 "novision"  → 带图片时返回 400（测视觉失败回落纯文本）
//   model 含 "badjson"   → 路由返回非 JSON（测 2-gram 兜底）
//   问题里含 "超长"       → Call 2 在 temperature 0.4 时返回超过 120 字（测降温重试）
//   追问里含 "天气"/"游戏" → 路由判为 off_topic；含 "先修"/"高中" → related_general
'use strict';
const http = require('http');

const port = Number(process.argv[2]) || 9901;
let last = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (content) => (Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('') : String(content || ''));
const hasImage = (content) => Array.isArray(content) && content.some((c) => c.type === 'image_url');

function route(question) {
  if (/天气|游戏|吃什么/.test(question)) return { route: 'off_topic', redirect: '先回到视频内容吧' };
  if (/先修|高中|基础/.test(question)) return { route: 'related_general', redirect: null };
  return { route: 'in_video', redirect: null };
}

function explain(question, temperature, system) {
  if (/超长/.test(question) && temperature > 0.3) {
    return '**第一段：** 老师说的“线性无关”，意思是这几个向量谁也不能由其他几个拼出来，每一个都带来了一个全新的方向，少了谁整个空间都会塌掉一块，这一点非常非常关键，一定要记住它。\n\n'
      + '第二段：就像三个人各自只会往东、往北、往上走，谁也替代不了谁，缺一个就去不了某些地方了，这就是独立的意思，非常形象吧。\n\n'
      + '第三段：如果第三个向量正好等于前两个相加，它们还算线性无关吗？请你仔细想一想再告诉我。';
  }
  if (/没有可用的字幕上下文/.test(system)) {
    return '画面上是一页写着向量组的板书，老师应该在比较几个向量能不能互相表示。\n\n像三根筷子指向不同方向，少一根就有方向够不着。\n\n你卡住的是“能不能互相表示”这一句吗？';
  }
  return '线性无关就是：这几个向量谁也不能用其他几个拼出来，各自贡献一个新方向。\n\n像东、北、上三个方向，缺哪个都到不了某些地方；“东北”就不算新方向。\n\n如果第三个向量等于前两个之和，它们还线性无关吗？';
}

function followup(q, system) {
  if (/带我想/.test(system)) return '你现在缺的是“拼出来”这一环。先想一个小的：东和北两个方向，能拼出“东北”吗？';
  if (/懂了/.test(q)) return '好，那就继续往下看吧！';
  if (/展开/.test(q)) return '展开说：一组向量线性无关，是指只有全部系数取 0 时，它们的线性组合才等于零向量。换句话说，没有哪个向量是“多余的”。比如 (1,0) 和 (0,1)：想让 a(1,0)+b(0,1)=0，只能 a=b=0，所以无关；而 (1,0)、(2,0) 就相关，因为第二个是第一个的两倍。';
  return '不算。第三个能由前两个拼出来，就是“多余的”，这组向量就线性相关了。比如东、北、东北，东北=东+北。';
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__last') return send(res, 200, last || {});
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return send(res, 404, { error: { message: 'not found' } });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  last = body;
  const system = textOf(body.messages[0].content);
  const userContent = body.messages[1].content;
  const user = textOf(userContent);
  const image = hasImage(userContent);
  const unresolved = (system.match(/\{\{\w+\}\}/g) || []);
  const kind = /query router/.test(system) ? 'call1' : body.stream ? 'call3' : 'call2';
  console.log(`[mock] ${kind} model=${body.model} t=${body.temperature} stream=${!!body.stream} json=${!!body.response_format} image=${image} auth=${(req.headers.authorization || '').slice(0, 12)}… unresolved=${unresolved.join(',') || 'none'} user=${user.slice(0, 30)}`);

  if (body.response_format && /nojson/.test(body.model)) return send(res, 400, { error: { message: 'response_format is not supported' } });
  if (image && /novision/.test(body.model)) return send(res, 400, { error: { message: 'model does not support image input' } });

  let content;
  if (kind === 'call1') content = /badjson/.test(body.model) ? '我觉得这是视频内的问题' : '```json\n' + JSON.stringify(route(user)) + '\n```';
  else if (kind === 'call2') content = explain(user, body.temperature, system);
  else content = followup(user, system);

  if (!body.stream) {
    await sleep(kind === 'call1' ? 120 : 600);
    return send(res, 200, { id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  await sleep(350);
  const chars = Array.from(content);
  for (let i = 0; i < chars.length; i += 3) {
    const delta = chars.slice(i, i + 3).join('');
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
    await sleep(45);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}).listen(port, '127.0.0.1', () => console.log(`[mock] OpenAI-compatible mock on http://127.0.0.1:${port}/v1`));
