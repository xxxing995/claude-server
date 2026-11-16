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

// ---- 加解密：API 密钥加密后再存进数据库 ----
async function aesKey(env) {
  const raw = Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(plain)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}
async function decrypt(env, b64) {
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12) },
    await aesKey(env),
    data.slice(12),
  );
  return new TextDecoder().decode(plain);
}

// ---- 模型管理 ----
const MODEL_COLS = 'id,provider_id,model_key,label,description,upstream_model,sort,is_default';

async function listModels(env, json) {
  try {
    const rows = await sb(env, 'GET', `models?select=${MODEL_COLS}&order=sort.asc,id.asc`);
    return json(rows || []); // 不返回密钥
  } catch (e) {
    console.log('list models error', e.message);
    return json({ error: '读取模型失败' }, 500);
  }
}

// 会话列表：侧栏用，按最近更新排序
async function listSessions(env, json) {
  try {
    const rows = await sb(
      env,
      'GET',
      'sessions?select=id,name,created_at,updated_at&order=updated_at.desc&limit=200',
    );
    return json(rows || []);
  } catch (e) {
    console.log('list sessions error', e.message);
    return json({ error: '读取会话列表失败' }, 500);
  }
}

// 某个会话的历史消息：只读可见的 user/assistant 消息，按时间正序；
// 顺带用同一次请求取回会话的 updated_at（由 touch_session 触发器维护），给前端显示“上次更新”
async function listMessages(env, sessionId, json) {
  try {
    const rows = await sb(
      env,
      'GET',
      `messages?session_id=eq.${sessionId}&visible=eq.true&role=in.(user,assistant)` +
        '&select=id,role,content,reasoning_content,model,first_token_ms,total_ms,prompt_tokens,completion_tokens,total_tokens,finish_reason,sessions(updated_at)' +
        '&order=id.asc',
    );
    const list = rows || [];
    const rel = list[0]?.sessions;
    const updated_at = (Array.isArray(rel) ? rel[0]?.updated_at : rel?.updated_at) || null;
    return json({ updated_at, messages: list.map(({ sessions, ...m }) => m) });
  } catch (e) {
    console.log('list messages error', e.message);
    return json({ error: '读取历史消息失败' }, 500);
  }
}

// 清理接口地址：必须 https，去掉结尾的 / 和 /v1
function cleanBaseUrl(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 200).replace(/\/+$/, '').replace(/\/v1$/, '') : '';
  return /^https:\/\/\S+$/.test(s) ? s : '';
}

// 为模型生成固定的标识，如 gpt-4o-3fa2
function makeKey(up) {
  const base = up.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 22) || 'model';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)), (x) => x.toString(16).padStart(2, '0')).join('');
  return `${base}-${rand}`;
}

async function listProviders(env, json) {
  try {
    const rows = await sb(env, 'GET', 'providers?select=id,name,base_url&order=id.asc');
    return json(rows || []); // 不返回密钥
  } catch (e) {
    console.log('list providers error', e.message);
    return json({ error: '读取接口列表失败' }, 500);
  }
}

// 步骤 3：短连接，读取这个接口有哪些模型。不保存任何东西
async function discoverModels(request, env, json) {
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }
  const baseUrl = cleanBaseUrl(b.base_url);
  if (!baseUrl) return json({ error: 'API 地址需要以 https:// 开头' }, 400);

  let apiKey = typeof b.api_key === 'string' ? b.api_key.trim() : '';
  if (!apiKey) {
    // 没输入密钥：编辑已有接口时，使用已保存的密钥（但地址不能变，否则会把密钥发到新地址）
    const pid = Number(b.provider_id);
    if (!Number.isInteger(pid) || pid <= 0) return json({ error: '请先输入密钥' }, 400);
    try {
      const rows = await sb(env, 'GET', `providers?id=eq.${pid}&select=base_url,api_key_enc&limit=1`);
      if (!rows?.length) return json({ error: '没有找到这个接口' }, 404);
      if (rows[0].base_url !== baseUrl) return json({ error: '更换 API 地址后，需要重新输入密钥' }, 400);
      apiKey = await decrypt(env, rows[0].api_key_enc);
    } catch (e) {
      console.log('read key error', e.message);
      return json({ error: '读取已保存的密钥失败' }, 500);
    }
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return json({ error: '连接失败或超时，请检查 API 地址' }, 502);
  }
  if (res.status === 401 || res.status === 403) return json({ error: '密钥不正确或没有权限' }, 400);
  if (!res.ok) return json({ error: `接口返回 ${res.status}` }, 502);

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: '接口返回的不是有效的模型列表' }, 502);
  }
  const ids = (Array.isArray(data?.data) ? data.data : [])
    .map((x) => x?.id)
    .filter((x) => typeof x === 'string' && x)
    .slice(0, 300);
  if (!ids.length) return json({ error: '没有读取到模型列表（这个接口可能不支持列出模型）' }, 502);
  return json({ models: [...new Set(ids)].sort() });
}

// 步骤 4：保存接口 + 勾选的模型。id 为 null 表示新增
async function saveProvider(request, env, json, id) {
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }
  const isNew = id === null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  const name = str(b.name, 30);
  if (!name) return json({ error: '名称不能为空' }, 400);
  const baseUrl = cleanBaseUrl(b.base_url);
  if (!baseUrl) return json({ error: 'API 地址需要以 https:// 开头' }, 400);
  const apiKey = str(b.api_key, 500);
  if (isNew && !apiKey) return json({ error: '密钥不能为空' }, 400);

  const desired = new Map(); // 真实模型名 → 显示名
  for (const x of (Array.isArray(b.models) ? b.models : []).slice(0, 200)) {
    const up = str(x?.upstream_model, 100);
    if (up) desired.set(up, str(x?.label, 30) || up.slice(0, 30));
  }
  const defaultUp = str(b.default_upstream, 100);

  try {
    let providerId;
    if (isNew) {
      const created = await sb(env, 'POST', 'providers', {
        name,
        base_url: baseUrl,
        api_key_enc: await encrypt(env, apiKey),
      });
      providerId = created[0].id;
    } else {
      providerId = Number(id);
      const cur = await sb(env, 'GET', `providers?id=eq.${providerId}&select=base_url&limit=1`);
      if (!cur?.length) return json({ error: '没有找到这个接口' }, 404);
      if (cur[0].base_url !== baseUrl && !apiKey) {
        return json({ error: '更换 API 地址后，需要重新输入密钥' }, 400);
      }
      const patch = { name, base_url: baseUrl };
      if (apiKey) patch.api_key_enc = await encrypt(env, apiKey);
      await sb(env, 'PATCH', `providers?id=eq.${providerId}`, patch);
    }

    // 同步模型：取消勾选的删除，已有的更新显示名，新勾选的添加
    const existing = (await sb(env, 'GET', `models?provider_id=eq.${providerId}&select=id,upstream_model,label`)) || [];
    const idByUp = new Map(existing.map((r) => [r.upstream_model, r.id]));

    const removeIds = existing.filter((r) => !desired.has(r.upstream_model)).map((r) => r.id);
    if (removeIds.length) await sb(env, 'DELETE', `models?id=in.(${removeIds.join(',')})`);

    for (const r of existing) {
      const label = desired.get(r.upstream_model);
      if (label !== undefined && label !== r.label) {
        await sb(env, 'PATCH', `models?id=eq.${r.id}`, { label });
      }
    }

    const toInsert = [...desired]
      .filter(([up]) => !idByUp.has(up))
      .map(([up, label]) => ({ provider_id: providerId, model_key: makeKey(up), label, upstream_model: up }));
    if (toInsert.length) {
      const inserted = await sb(env, 'POST', 'models', toInsert);
      for (const r of inserted) idByUp.set(r.upstream_model, r.id);
    }

    // 默认模型（全局只有一个）
    if (defaultUp && desired.has(defaultUp) && idByUp.has(defaultUp)) {
      await sb(env, 'PATCH', 'models?is_default=eq.true', { is_default: false });
      await sb(env, 'PATCH', `models?id=eq.${idByUp.get(defaultUp)}`, { is_default: true });
    } else {
      // 全局还没有默认时，把这个接口的第一个设为默认
      const hasDefault = await sb(env, 'GET', 'models?is_default=eq.true&select=id&limit=1');
      const first = [...desired.keys()].find((up) => idByUp.has(up));
      if (!hasDefault?.length && first) {
        await sb(env, 'PATCH', `models?id=eq.${idByUp.get(first)}`, { is_default: true });
      }
    }

    return json({ ok: true, id: providerId });
  } catch (e) {
    console.log('save provider error', e.message);
    return json({ error: '保存失败' }, 500);
  }
}


const DEFAULT_SETTINGS = { temperature: 0.7, max_context_rounds: 20, max_reply_tokens: 2000 };

// 入口：跨域 + 访问口令 + 路由
async function handleApi(request, env, ctx, url) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const cors = {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
	'Access-Control-Max-Age': '86400',
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
  if (path === '/api/sessions' && request.method === 'GET') {
	return listSessions(env, json);
  }
  let m = path.match(/^\/api\/sessions\/(\d+)\/messages$/);
  if (m && request.method === 'GET') {
	return listMessages(env, m[1], json);
  }
  m = path.match(/^\/api\/messages\/(\d+)$/);
  if (m && request.method === 'DELETE') return removeRow(env, 'messages', m[1], json);
  if (path === '/api/models') {
	if (request.method === 'GET') return listModels(env, json);

	m = path.match(/^\/api\/models\/(\d+)$/);
	if (m) {
		if (request.method === 'DELETE') return removeRow(env, 'models', m[1], json);
	}
  }
  m = path.match(/^\/api\/sessions\/(\d+)$/);
  if (m && request.method === 'DELETE') return deleteSession(env, m[1], json);
	if (path === '/api/providers') {
	if (request.method === 'GET') return listProviders(env, json);
	if (request.method === 'POST') return saveProvider(request, env, json, null);
  }
  if (path === '/api/providers/discover' && request.method === 'POST') {
	return discoverModels(request, env, json);
  }
  m = path.match(/^\/api\/providers\/(\d+)$/);
  if (m) {
	if (request.method === 'PATCH') return saveProvider(request, env, json, m[1]);
	if (request.method === 'DELETE') return removeRow(env, 'providers', m[1], json); // 会连带删除它下面的模型
  }

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

// 删除会话：先显式删掉它的消息，再删会话本身。
// 数据库里 messages.session_id 虽然声明了级联删除，但仓库里没有 SQL 可以核实，
// 这里显式清理一次，避免留下孤儿消息。
async function deleteSession(env, id, json) {
  try {
    await sb(env, 'DELETE', `messages?session_id=eq.${id}`);
  } catch (e) {
    console.log('delete session messages error', e.message);
    return json({ error: '数据库删除失败' }, 500);
  }
  return removeRow(env, 'sessions', id, json);
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

  if (typeof body.model !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(body.model)) {
	return json({ error: '不支持的模型' }, 400);
  }
  let cfg, apiKey;
  try {
	const mrows = await sb(
		env,
		'GET',
		`models?model_key=eq.${body.model}&select=upstream_model,providers(base_url,api_key_enc)&limit=1`,
	);
	if (!mrows?.length || !mrows[0].providers) return json({ error: '不支持的模型，请在设置里添加' }, 400);
	cfg = {
		upstream_model: mrows[0].upstream_model,
		base_url: mrows[0].providers.base_url,
		api_key_enc: mrows[0].providers.api_key_enc,
	};
	apiKey = await decrypt(env, cfg.api_key_enc);
  } catch (e) {
	console.log('model config error', e.message);
	return json({ error: '读取模型配置失败' }, 500);
  }
  const upstreamModel = cfg.upstream_model;

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
    upstream = await fetch(`${cfg.base_url}/v1/chat/completions`, {
	  method: 'POST',
	  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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