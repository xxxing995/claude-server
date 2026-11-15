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

// 访问 Supabase（REST 接口，不需要装依赖）
async function sb(env, method, path, body) {
  const key = env.SUPABASE_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // 旧版 JWT 格式的 key 需要
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const DEFAULT_SETTINGS = { temperature: 0.7, max_context_rounds: 20, max_reply_tokens: 2000 };

// 入口：跨域 + 访问口令 + 路由
async function handleApi(request, env, ctx, url) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const cors = {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
    Vary: 'Origin',
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
    });

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const code = request.headers.get('X-Access-Code') || '';
  if (!env.ACCESS_CODE || !(await safeEqual(code, env.ACCESS_CODE))) {
    return json({ error: '访问口令不正确，请在设置里填写' }, 401);
  }

  const path = url.pathname;
  if (path === '/api/chat' && request.method === 'POST') {
    return handleChat(request, env, ctx, cors, json);
  }
  if (path === '/api/chat/retract' && request.method === 'POST') {
	return handleRetract(request, env, json);
  }

  let m = path.match(/^\/api\/messages\/(\d+)$/);
  if (m && request.method === 'DELETE') return removeRow(env, 'messages', m[1], json);

  m = path.match(/^\/api\/sessions\/(\d+)$/);
  if (m && request.method === 'DELETE') return removeRow(env, 'sessions', m[1], json);

  return json({ error: 'Not found' }, 404);
}

// 删除一行（id 已经被正则限定为纯数字，可以安全拼接）
async function removeRow(env, table, id, json) {
  try {
    const rows = await sb(env, 'DELETE', `${table}?id=eq.${id}`); // 返回被删掉的行
    if (!rows || rows.length === 0) return json({ error: '没有找到要删除的内容' }, 404);
    return json({ ok: true });
  } catch (e) {
    console.log('delete error', e.message);
    return json({ error: '数据库删除失败' }, 500);
  }
}

// 撤回一轮：删掉这条用户消息，以及它之后的所有消息（即它的回复）；会话空了就一并删掉
async function handleRetract(request, env, json) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }
  const sid = Number(body.session_id);
  const uid = Number(body.user_message_id);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(uid) || uid <= 0) {
    return json({ error: '参数不合法' }, 400);
  }
  try {
    await sb(env, 'DELETE', `messages?session_id=eq.${sid}&id=gte.${uid}`);
    const left = await sb(env, 'GET', `messages?session_id=eq.${sid}&select=id&limit=1`);
    let sessionDeleted = false;
    if (!left?.length) {
      await sb(env, 'DELETE', `sessions?id=eq.${sid}`);
      sessionDeleted = true;
    }
    return json({ ok: true, session_deleted: sessionDeleted });
  } catch (e) {
    console.log('retract error', e.message);
    return json({ error: '数据库撤回失败' }, 500);
  }
}

// 聊天：普通发送 或 重新生成（带 regenerate_message_id）
async function handleChat(request, env, ctx, cors, json) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }

  const upstreamModel = MODEL_MAP[body.model];
  if (!upstreamModel) return json({ error: '不支持的模型' }, 400);

  let sessionId = body.session_id == null ? null : Number(body.session_id);
  if (sessionId !== null && !(Number.isInteger(sessionId) && sessionId > 0)) {
    return json({ error: '会话 id 不合法' }, 400);
  }
  const regenId = body.regenerate_message_id == null ? null : Number(body.regenerate_message_id);
  if (regenId !== null && !(Number.isInteger(regenId) && regenId > 0)) {
    return json({ error: '消息 id 不合法' }, 400);
  }
  if (regenId !== null && sessionId === null) return json({ error: '缺少会话 id' }, 400);

  const content = typeof body.content === 'string' ? body.content.trim().slice(0, 8000) : '';
  if (regenId === null && !content) return json({ error: '消息不能为空' }, 400);

  // 1. 读设置、（建会话、存用户消息 | 校验要重新生成的消息）、取历史
  let st, history;
  let userMessageId = null;
  try {
    const rows = await sb(env, 'GET', 'settings?session_id=eq.0&select=*&limit=1');
    st = { ...DEFAULT_SETTINGS, ...(rows?.[0] || {}) };

    if (regenId !== null) {
      // 只允许重新生成"最后一条"回复
      const last = await sb(env, 'GET', `messages?session_id=eq.${sessionId}&select=id,role&order=id.desc&limit=1`);
      if (!last?.length || last[0].id !== regenId || last[0].role !== 'assistant') {
        return json({ error: '只能重新生成最后一条回复' }, 400);
      }
    } else {
      if (sessionId === null) {
        const created = await sb(env, 'POST', 'sessions', { name: content.slice(0, 16) });
        sessionId = created[0].id;
      }
      const u = await sb(env, 'POST', 'messages', { session_id: sessionId, role: 'user', content });
      userMessageId = u[0].id;
    }

    const rounds = Math.max(1, Number(st.max_context_rounds) || 20);
    const before = regenId !== null ? `&id=lt.${regenId}` : ''; // 重新生成时，历史不包含旧回复
    const recent = await sb(
      env,
      'GET',
      `messages?session_id=eq.${sessionId}&visible=eq.true&role=in.(user,assistant)${before}&select=role,content&order=id.desc&limit=${rounds * 2}`,
    );
    history = recent.reverse();
  } catch (e) {
    console.log('db error', e.message);
    return json({ error: '数据库读写失败' }, 500);
  }

  // 2. 请求第三方接口（流式）
  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(`${env.API_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.API_KEY}` },
      body: JSON.stringify({
        model: upstreamModel,
        stream: true,
        stream_options: { include_usage: true },
        temperature: Number(st.temperature),
        max_tokens: Number(st.max_reply_tokens),
        messages: [{ role: 'system', content: st.system_prompt || SYSTEM_PROMPT }, ...history],
      }),
    });
  } catch {
    return json({ error: '连接第三方接口失败' }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    console.log('upstream error', upstream.status, await upstream.text());
    return json({ error: `第三方接口返回 ${upstream.status}` }, 502);
  }

  // 3. 边转发边累计
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let clientGone = false; // 前端已断开（点了停止，或关了页面）
  const send = async (event, data) => {
	if (clientGone) return;
	try {
		await writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
	} catch {
		clientGone = true;
	}
  };

  ctx.waitUntil(
    (async () => {
      let text = '';
      let reasoning = '';
      let firstTokenMs = null;
      let usage = null;
      let finish = null;
      try {
        await send('meta', { session_id: sessionId, user_message_id: userMessageId });
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          if (clientGone) {
          	await reader.cancel().catch(() => {}); // 通知第三方停止生成，省额度
          	break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let j;
            try {
              j = JSON.parse(payload);
            } catch {
              continue;
            }
            if (j.usage) usage = j.usage;
            const choice = j.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finish = choice.finish_reason;
            const d = choice.delta || {};
            if (d.reasoning_content) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              reasoning += d.reasoning_content;
              await send('reasoning', { text: d.reasoning_content });
            }
            if (d.content) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              text += d.content;
              await send('delta', { text: d.content });
            }
          }
        }
		if (clientGone) return; // 前端已断开：不保存回复
		if (userMessageId !== null) {
			// 双保险：用户消息如果已被撤回删掉了，就不保存回复
			const still = await sb(env, 'GET', `messages?id=eq.${userMessageId}&select=id`);
			if (!still?.length) return;
		}

        const stats = {
          model: upstreamModel,
          first_token_ms: firstTokenMs,
          total_ms: Date.now() - t0,
          prompt_tokens: usage?.prompt_tokens ?? null,
          completion_tokens: usage?.completion_tokens ?? null,
          total_tokens: usage?.total_tokens ?? null,
          finish_reason: finish,
        };
        let savedId = null;
        if (text || reasoning) {
          try {
            const saved = await sb(env, 'POST', 'messages', {
              session_id: sessionId,
              role: 'assistant',
              content: text,
              reasoning_content: reasoning || null,
              ...stats,
            });
            savedId = saved?.[0]?.id ?? null;
            // 重新生成：新回复保存成功后，才删除旧回复（失败时旧回复不会丢）
            if (regenId !== null && savedId !== null) {
              await sb(env, 'DELETE', `messages?id=eq.${regenId}`);
            }
          } catch (e) {
            console.log('save error', e.message);
          }
        }
        await send('done', { id: savedId, ...stats });
      } catch (e) {
        console.log('stream error', e.message);
        await send('error', { message: '生成中断' });
      } finally {
        try {
          await writer.close();
        } catch {}
      }
    })(),
  );

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors },
  });
}

export default {
  async fetch(request, env, ctx) {
	const url = new URL(request.url);

	if (url.pathname.startsWith('/api/')) {
		return handleApi(request, env, ctx, url);
	}
	// 下面 /health 和 / 不变

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