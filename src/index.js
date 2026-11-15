// 前端的模型 id → 第三方接口里真实的模型名（按你的服务商填写）
const MODEL_MAP = {
  fable: 'deepseek-ai/DeepSeek-V4-Flash',
  opus: '第三方的模型名B',
  sonnet: '第三方的模型名C',
  haiku: '第三方的模型名D',
};

const SYSTEM_PROMPT = '你是“我们的家”里温柔、简洁的陪伴助手，用中文回答一句话。';

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const ax = new Uint8Array(x);
  const by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ by[i];
  return diff === 0;
}

async function handleChat(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const cors = {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
    Vary: 'Origin',
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
    });

  // 浏览器发正式请求前的预检
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // 访问口令
  const code = request.headers.get('X-Access-Code') || '';
  if (!env.ACCESS_CODE || !(await safeEqual(code, env.ACCESS_CODE))) {
    return json({ error: '访问口令不正确，请在设置里填写' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }

  const upstreamModel = MODEL_MAP[body.model];
  if (!upstreamModel) return json({ error: '不支持的模型' }, 400);

  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return json({ error: '消息数量不合法' }, 400);
  }
  const clean = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? '').slice(0, 8000),
  }));

  let upstream;
  try {
    // 如果第三方的路径或格式不同，改这里
    upstream = await fetch(`${env.API_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({
        model: upstreamModel,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...clean],
      }),
    });
  } catch {
    return json({ error: '连接第三方接口失败' }, 502);
  }

  if (!upstream.ok) {
    console.log('upstream error', upstream.status, await upstream.text());
    return json({ error: `第三方接口返回 ${upstream.status}` }, 502);
  }

  const data = await upstream.json();
  const reply = data?.choices?.[0]?.message?.content; // 回复内容的位置，格式不同时改这里
  if (!reply) return json({ error: '第三方接口没有返回内容' }, 502);

  return json({ reply });
}

export default {
  async fetch(request, env) { // 注意：这里多了 env 参数
    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      return handleChat(request, env);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        message: '访问正常',
        time: new Date().toISOString()
        // uptime 删掉，Workers 没有常驻进程
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/') {
      return new Response('Hello, Workers!');
    }

    return new Response('Not Found', { status: 404 });
  }
};