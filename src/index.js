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


const DEFAULT_SETTINGS = {
  temperature: 0.7,
  max_context_rounds: 20,
  max_reply_tokens: 2000,
  // 记忆默认关闭；SQL 还没执行时这些列不存在，走这里的默认值，行为与旧版一致
  memory_enabled: false,
  memory_identity: '',
  memory_digest: '',
  // pinned 注入条数上限（约定 / 未决合计取最近 N 条）；不建列时用这个默认值
  memory_pinned_limit: 10,
  // 人格层默认空；没执行 SQL 时不会读到这一列
  persona: '',
  // 历史条数默认 6；自定义需要执行 alter table 加 max_context_messages
  max_context_messages: 6,
};

// 记忆注入的字符预算（不是 token；中文大约 1 字 ≈ 1~2 token），分两段各自裁剪：
//   常驻段：身份锚点 + 事件摘要 + 语气样本 + pinned，上限 4200；
//   命中段：关键词命中的普通条目，上限 3000。
// 两段互不挤占；persona 属于人格层，不计入这两段预算。
const MEMORY_RESIDENT_MAX = 4200;
const MEMORY_HITS_MAX = 3000;
// pinned 中已完成 / 已取消默认只取最近 10 条；可用 settings.memory_pinned_limit 覆盖
const MEMORY_PINNED_LIMIT = 10;
const PINNED_STATUSES = ['pending', 'agreed', 'done', 'cancelled'];
const PINNED_STATUS_LABEL = { pending: '未决', agreed: '约定', done: '已完成', cancelled: '已取消' };
const MEMORY_HEADER =
  '以下是你和她之间真实发生过的事，属于你自己的经历，用来保持连续，不需要逐条复述。它们不是这一轮要回答的问题，也不要因为看到了就主动提起。';
// 记忆消息的最后一行：贴住历史与本轮消息，避免指令离得太远
const MEMORY_TAIL = '直接以他的身份和口吻回应，不要跳出角色解释自己是谁。';
// 记账指令说明：不进两段预算，只在记忆开启时随记忆消息一起注入
const MEMORY_WRITE_GUIDE = `【想要的方向 · 记账】
你可以自己维护「想要的方向」，共四种状态：
- pending（未决）：提过、动过念头，但还没说定。
- agreed（约定）：双方明确同意，要一起做或一直遵守。
- done（已完成）：约定的事确实已经发生并完成。只有「已经做完」才从约定改成已完成，只是聊到、计划中或答应过都不算。
- cancelled（已取消）：明确放弃、反悔或约定失效。只是暂时没提、犹豫、没做到，都不算取消。
需要新建或改状态时，在回复末尾追加指令，每条单独一行：
<mem>{"op":"create","content":"一句话写清这件事","status":"pending"}</mem>
<mem>{"op":"status","id":"上方方括号里的 id","status":"done"}</mem>
规则：id 必须来自【想要的方向】每条开头的方括号；只在确实有变化时写，不要因为一句话就新建；没有变化就不要输出任何 <mem>；这些标记用户看不到，不要解释、复述或提及。`;
// 历史消息的字符兜底：条数由 settings.max_context_messages 控制，超长时从更早的开始丢
const HISTORY_MAX_CHARS = 6000;

// 把 jsonb 字段安全地当数组用；类型不对或 JSON 坏了都当空数组
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  return [];
}

// 关键词命中：用户消息原样、大小写不敏感、子串即算；priority 降序，同优先级保持原顺序
function pickEntries(entries, text) {
  const lower = (text || '').toLowerCase();
  const out = [];
  entries.forEach((e, i) => {
    if (!e || typeof e.content !== 'string' || !e.content.trim()) return;
    const kws = Array.isArray(e.keywords) ? e.keywords : [];
    const hit = kws.some((k) => typeof k === 'string' && k.length > 0 && lower.includes(k.toLowerCase()));
    if (hit) out.push({ entry: e, index: i });
  });
  out.sort((a, b) => (Number(b.entry.priority) || 0) - (Number(a.entry.priority) || 0) || a.index - b.index);
  return out;
}

// pinned 的识别：新表以 is_pinned 为准；兼容旧结构里的 pinned=true 或仅有 status 的条目。
// 布尔标记明确为 false 时直接判为非 pinned，避免把普通条目的 status 误当成 pinned。
function isPinnedEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.pinned === true || e.is_pinned === true) return true;
  if (e.pinned === false || e.is_pinned === false) return false;
  return typeof e.status === 'string' && e.status.trim().length > 0;
}

// pinned 的稳定标识：新表用数值 id；兼容旧数据的字符串 id / key；都没有时用数组下标兜底
function pinnedKey(e, i) {
  if (typeof e.id === 'number' && Number.isFinite(e.id)) return String(e.id);
  if (typeof e.id === 'string' && e.id.trim()) return e.id.trim();
  if (typeof e.key === 'string' && e.key.trim()) return e.key.trim();
  return `pinned-${i}`;
}

function pinnedStatus(e) {
  return PINNED_STATUSES.includes(e?.status) ? e.status : 'pending';
}

function pinnedTime(e) {
  const t = Date.parse(typeof e?.updated_at === 'string' ? e.updated_at : '');
  return Number.isFinite(t) ? t : 0;
}

// 常驻注入用的 pinned：
//   pending / agreed 全量注入，不受 N 约束；
//   done / cancelled 按 updated_at 倒序只取最近 N 条（N = memory_pinned_limit）。
// 两类合并后再统一按 updated_at 倒序，不按状态分组，顺序与 We 页一致。
function pickPinned(entries, limit) {
  const all = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isPinnedEntry(entry));
  const byTime = (a, b) => pinnedTime(b.entry) - pinnedTime(a.entry) || b.index - a.index;
  const active = all.filter(({ entry }) => {
    const status = pinnedStatus(entry);
    return status === 'pending' || status === 'agreed';
  });
  const finished = all
    .filter(({ entry }) => {
      const status = pinnedStatus(entry);
      return status === 'done' || status === 'cancelled';
    })
    .sort(byTime)
    .slice(0, limit);
  return [...active, ...finished].sort(byTime);
}

// 按 weight 降序贪心保留整段；都放不下时只截断优先级最高的一段
function fitSections(sections, max) {
  const ordered = [...sections].sort((a, b) => b.weight - a.weight || a.index - b.index);
  const chosen = new Map();
  let used = 0;
  for (const s of ordered) {
    const add = s.text.length + (chosen.size ? 2 : 0);
    if (used + add <= max) {
      chosen.set(s.index, s.text);
      used += add;
    }
  }
  if (!chosen.size && ordered.length) {
    const top = ordered[0];
    const text = top.text.slice(0, max);
    if (text) {
      chosen.set(top.index, text);
      used = text.length;
    }
  }
  const kept = sections.filter((s) => chosen.has(s.index)).map((s) => chosen.get(s.index));
  return { text: kept.join('\n\n'), used, keptIndexes: new Set(chosen.keys()) };
}

// pinned 块：注入顺序与 We 页一致（updated_at 倒序），不按状态分组；
// 超出预算时保留最近的一段（时间倒序截断），锚点 / 摘要 / 语气已经先占位。
function buildPinnedBlock(pinned, budget) {
  if (!pinned.length || budget <= 0) {
    return { text: '', used: 0, count: 0, total: pinned.length, truncated: pinned.length > 0 };
  }
  const header = '【想要的方向】';
  const display = [...pinned].sort(
    (a, b) => pinnedTime(b.entry) - pinnedTime(a.entry) || b.index - a.index,
  );
  const lines = [];
  let used = header.length;
  for (const { entry, index } of display) {
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content) continue;
    const line = `- [${pinnedKey(entry, index)}]（${PINNED_STATUS_LABEL[pinnedStatus(entry)]}）${content}`;
    const add = line.length + 1;
    if (used + add > budget) break; // 保留最近的连续一段，更早的让出去
    lines.push(line);
    used += add;
  }
  if (!lines.length) {
    return { text: '', used: 0, count: 0, total: pinned.length, truncated: true };
  }
  return {
    text: `${header}\n${lines.join('\n')}`,
    used: used - 1,
    count: lines.length,
    total: pinned.length,
    truncated: lines.length < pinned.length,
  };
}

// 命中段：priority 降序放，超出 3000 的条目跳过（让更多高优先级的小条目留下）
function buildHitsBlock(hits, max) {
  const lines = [];
  const kept = [];
  let used = 0;
  for (const h of hits) {
    const content = typeof h.entry.content === 'string' ? h.entry.content.trim() : '';
    if (!content) continue;
    const line = `- ${content}`;
    const add = line.length + (lines.length ? 1 : 0);
    if (used + add > max) continue;
    lines.push(line);
    kept.push(h);
    used += add;
  }
  return { text: lines.join('\n'), used, kept };
}

// 从 memory_documents 取当前 active 版本；缺行、空内容、坏 JSON 都静默降级
async function loadMemoryDocs(env) {
  const rows = await sb(env, 'GET', 'memory_documents?select=kind,content&is_active=eq.true');
  const docs = {};
  for (const r of rows || []) {
    if (r && typeof r.kind === 'string' && typeof r.content === 'string') docs[r.kind] = r.content;
  }
  return docs;
}

// 从 memory_entries 取条目；keywords 统一成数组，is_pinned 映射成 pinned 供现有注入逻辑复用
async function loadMemoryEntries(env) {
  const rows = await sb(
    env,
    'GET',
    'memory_entries?select=id,content,keywords,priority,status,is_pinned,updated_at&order=updated_at.desc',
  );
  return (rows || [])
    .filter((r) => r && typeof r.content === 'string')
    .map((r) => ({
      ...r,
      keywords: Array.isArray(r.keywords) ? r.keywords : [],
      priority: Number(r.priority) || 0,
      pinned: r.is_pinned === true,
      status: PINNED_STATUSES.includes(r.status) ? r.status : 'pending',
    }));
}

// 组装人格层与记忆消息。只读，不抛错：字段缺失、类型不对、JSON 解析失败都静默降级。
// memory_enabled 只管记忆；persona 是人格层，不受这个开关控制（见 docs/backend.md）。
async function buildContext(env, st, userText) {
  const enabled = st.memory_enabled === true;
  const [docs, entries] = await Promise.all([
    loadMemoryDocs(env),
    enabled ? loadMemoryEntries(env) : Promise.resolve([]),
  ]);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const persona = str(docs.persona);
  const pinnedLimit = Math.min(
    50,
    Math.max(1, Number(st.memory_pinned_limit) || MEMORY_PINNED_LIMIT),
  );
  if (!enabled) {
    return {
      persona,
      memory: null,
      debug: {
        enabled: false,
        persona_chars: persona.length,
        resident_chars: 0,
        resident_limit: MEMORY_RESIDENT_MAX,
        hits_chars: 0,
        hits_limit: MEMORY_HITS_MAX,
        hit_count: 0,
        pinned_count: 0,
        pinned_total: 0,
        pinned_truncated: false,
        tone_chars: 0,
        entries_chars: 0,
        hits: [],
      },
    };
  }

  const identity = str(docs.identity);
  const digest = str(docs.digest);
  const toneText = asArray(docs.tone)
    .map((x) => (x && typeof x.text === 'string' ? x.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
  const pinned = pickPinned(entries, pinnedLimit);
  const hits = pickEntries(entries.filter((e) => !isPinnedEntry(e)), userText);

  // 常驻段：身份锚点 > 摘要 > 语气样本 > pinned，超预算时按这个顺序让位
  const sections = [];
  if (identity) sections.push({ index: 0, text: `【身份锚点】\n${identity}`, weight: 400 });
  if (digest) sections.push({ index: 1, text: `【事件摘要】\n${digest}`, weight: 300 });
  if (toneText) {
    sections.push({ index: 2, text: `以下是你说过的话，是你的说话方式：\n${toneText}`, weight: 200 });
  }
  const core = fitSections(sections, MEMORY_RESIDENT_MAX);
  const pinnedBudget = Math.max(0, MEMORY_RESIDENT_MAX - core.used - (core.text ? 2 : 0));
  const pinnedBlock = buildPinnedBlock(pinned, pinnedBudget);
  const residentText = [core.text, pinnedBlock.text].filter(Boolean).join('\n\n');
  const hitsBlock = buildHitsBlock(hits, MEMORY_HITS_MAX);

  // 两段各自独立裁剪后再拼成一条记忆消息，命中段不会挤掉常驻段；
  // 记账说明不计入两段预算，记忆开启时始终附带，保证模型有写入通道。
  let memory = MEMORY_HEADER;
  if (residentText) memory += `\n\n${residentText}`;
  if (hitsBlock.text) memory += `\n\n【相关记忆】\n${hitsBlock.text}`;
  memory += `\n\n${MEMORY_WRITE_GUIDE}\n\n${MEMORY_TAIL}`;

  return {
    persona,
    memory,
    debug: {
      enabled: true,
      persona_chars: persona.length,
      resident_chars: residentText.length,
      resident_limit: MEMORY_RESIDENT_MAX,
      hits_chars: hitsBlock.used,
      hits_limit: MEMORY_HITS_MAX,
      hit_count: hitsBlock.kept.length,
      pinned_count: pinnedBlock.count,
      pinned_total: pinnedBlock.total,
      pinned_truncated: pinnedBlock.truncated,
      tone_chars: core.keptIndexes.has(2) ? toneText.length : 0,
      entries_chars: hitsBlock.used, // 兼容旧字段名
      hits: hitsBlock.kept
        .map((h) => (h.entry.id != null ? String(h.entry.id) : ''))
        .filter(Boolean),
    },
  };
}

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
  if (path === '/api/pinned') {
    if (request.method === 'GET') return listPinned(env, json);
    if (request.method === 'POST') return createPinned(request, env, json);
    if (request.method === 'PATCH') return updatePinnedStatus(request, env, json);
  }
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

// ---- pinned：想要的方向。行级读写 memory_entries，不开放通用 settings 写入 ----
const PINNED_CONTENT_MAX = 500;

// pinned 的条数上限：settings.memory_pinned_limit 可覆盖，默认 10
function pinnedLimitOf(settingsRow) {
  return Math.min(50, Math.max(1, Number(settingsRow?.memory_pinned_limit) || MEMORY_PINNED_LIMIT));
}

// 对外展示用的 pinned：包含四种状态，按最近更新倒序
function pinnedList(rows) {
  return (rows || [])
    .filter((r) => r && r.is_pinned === true)
    .map((r) => ({
      id: r.id == null ? '' : String(r.id),
      content: typeof r.content === 'string' ? r.content.trim() : '',
      status: pinnedStatus(r),
      priority: Number(r.priority) || 0,
      updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
    }))
    .filter((x) => x.id && x.content)
    .sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));
}

async function listPinned(env, json) {
  try {
    const [stRows, rows] = await Promise.all([
      sb(env, 'GET', 'settings?session_id=eq.0&select=memory_pinned_limit&limit=1'),
      sb(
        env,
        'GET',
        'memory_entries?is_pinned=eq.true&select=id,content,status,priority,updated_at&order=updated_at.desc',
      ),
    ]);
    return json({ limit: pinnedLimitOf(stRows?.[0]), entries: pinnedList(rows) });
  } catch (e) {
    console.log('list pinned error', e.message);
    return json({ error: '读取想要的方向失败' }, 500);
  }
}

// 新增一条 pinned：只有 content 由前端提供，状态固定从 pending 开始
async function createPinned(request, env, json) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }
  const content = typeof body.content === 'string' ? body.content.trim().slice(0, PINNED_CONTENT_MAX) : '';
  if (!content) return json({ error: '内容不能为空' }, 400);
  const priority = Math.min(5, Math.max(1, Number(body.priority) || 3));
  const now = new Date().toISOString();
  try {
    const rows = await sb(env, 'POST', 'memory_entries', {
      content,
      keywords: [],
      priority,
      status: 'pending',
      is_pinned: true,
      is_summary: false,
      source: 'user',
      created_at: now,
      updated_at: now,
    });
    return json({ ok: true, entry: pinnedList(rows)[0] || null });
  } catch (e) {
    console.log('create pinned error', e.message);
    return json({ error: '保存想要的方向失败' }, 500);
  }
}

// 只改状态：id 是 memory_entries.id；不允许改内容
async function updatePinnedStatus(request, env, json) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式不正确' }, 400);
  }
  const idNum = Number(body.id);
  const status = typeof body.status === 'string' ? body.status : '';
  if (!Number.isInteger(idNum) || idNum <= 0) return json({ error: '缺少 pinned id' }, 400);
  if (!PINNED_STATUSES.includes(status)) {
    return json({ error: '状态只能是 pending / agreed / done / cancelled' }, 400);
  }
  try {
    const rows = await sb(env, 'PATCH', `memory_entries?id=eq.${idNum}&is_pinned=eq.true`, {
      status,
      updated_at: new Date().toISOString(),
    });
    if (!rows?.length) return json({ error: '没有找到这条 pinned' }, 404);
    return json({ ok: true, entry: pinnedList(rows)[0] || null });
  } catch (e) {
    console.log('update pinned error', e.message);
    return json({ error: '更新想要的方向失败' }, 500);
  }
}

// ---- 模型记账：回复里的 <mem>{...}</mem> 指令，流式摘除、静默解析 ----
const MEM_DIRECTIVE_OPEN = '<mem>';
const MEM_DIRECTIVE_CLOSE = '</mem>';
const MEM_DIRECTIVE_MAX = 10;

// buf 末尾有多少个字符是 marker 的前缀：分片可能把 "<mem" 切成 "<me"，这些先扣住不输出
function partialPrefixLen(buf, marker) {
  const max = Math.min(buf.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

// 流式过滤器：push 返回可以安全展示的文本；完整指令交给 onDirective 后丢弃；
// 流结束时未闭合的指令整段丢弃（解析失败静默，不影响正常回复）。
function createDirectiveFilter(onDirective) {
  let buf = '';
  let collecting = false;
  return {
    push(chunk) {
      let out = '';
      buf += chunk;
      while (buf) {
        if (!collecting) {
          const i = buf.indexOf(MEM_DIRECTIVE_OPEN);
          if (i === -1) {
            const hold = partialPrefixLen(buf, MEM_DIRECTIVE_OPEN);
            out += buf.slice(0, buf.length - hold);
            buf = buf.slice(buf.length - hold);
            break;
          }
          out += buf.slice(0, i);
          buf = buf.slice(i + MEM_DIRECTIVE_OPEN.length);
          collecting = true;
          continue;
        }
        const j = buf.indexOf(MEM_DIRECTIVE_CLOSE);
        if (j === -1) break; // 等下一片
        const raw = buf.slice(0, j);
        buf = buf.slice(j + MEM_DIRECTIVE_CLOSE.length);
        collecting = false;
        try {
          onDirective(JSON.parse(raw));
        } catch {
          // 指令坏了就丢掉，不影响正文
        }
      }
      return out;
    },
    end() {
      if (collecting) {
        buf = '';
        return '';
      }
      const rest = buf;
      buf = '';
      return rest;
    },
  };
}

// 把指令逐条落到 memory_entries：create 单行插入，status 单行更新；失败只记日志
async function applyPinnedOps(env, ops) {
  if (!ops.length) return;
  try {
    // 只查未决 / 约定的内容用于去重，避免同一件事重复建
    const active = await sb(
      env,
      'GET',
      'memory_entries?is_pinned=eq.true&status=in.(pending,agreed)&select=content',
    );
    const activeContents = new Set(
      (active || [])
        .map((r) => (typeof r.content === 'string' ? r.content.trim() : ''))
        .filter(Boolean),
    );
    for (const op of ops.slice(0, MEM_DIRECTIVE_MAX)) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'create') {
        const content = typeof op.content === 'string' ? op.content.trim().slice(0, PINNED_CONTENT_MAX) : '';
        if (!content || activeContents.has(content)) continue;
        const status = typeof op.status === 'string' && op.status ? op.status : 'pending';
        if (!PINNED_STATUSES.includes(status)) continue;
        const now = new Date().toISOString();
        await sb(env, 'POST', 'memory_entries', {
          content,
          keywords: [],
          priority: 3,
          status,
          is_pinned: true,
          is_summary: false,
          source: 'model',
          created_at: now,
          updated_at: now,
        });
        activeContents.add(content);
      } else if (op.op === 'status') {
        const idNum = Number(op.id);
        const status = typeof op.status === 'string' ? op.status : '';
        if (!Number.isInteger(idNum) || idNum <= 0 || !PINNED_STATUSES.includes(status)) continue;
        await sb(env, 'PATCH', `memory_entries?id=eq.${idNum}&is_pinned=eq.true`, {
          status,
          updated_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) {
    console.log('apply pinned ops error', e.message);
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

    // 历史按“最近 N 条消息”取，不再按轮数乘二；缺列或为空时默认 6
    const maxMessages = Math.max(1, Number(st.max_context_messages) || 6);
    // 历史要排除"刚刚插入的这条用户消息"，否则它会占掉一个名额；
    // 组装上下文时再把它作为最后一条补回去。重新生成时排除的是旧回复。
    const before =
      regenId !== null ? `&id=lt.${regenId}` : userMessageId !== null ? `&id=lt.${userMessageId}` : '';
    const recent = await sb(
      env,
      'GET',
      `messages?session_id=eq.${sessionId}&visible=eq.true&role=in.(user,assistant)${before}&select=role,content&order=id.desc&limit=${maxMessages}`,
    );
    // 字符上限兜底：从最新往回保留，超过 HISTORY_MAX_CHARS 就丢掉更早的
    const kept = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const len = typeof recent[i].content === 'string' ? recent[i].content.length : 0;
      if (kept.length > 0 && used + len > HISTORY_MAX_CHARS) break;
      kept.push(recent[i]);
      used += len;
    }
    history = kept.reverse();
    // 单条就超上限时，至少保留这一条，但把它裁到上限，避免把请求撑爆
    if (history.length === 1 && typeof history[0].content === 'string' && history[0].content.length > HISTORY_MAX_CHARS) {
      history[0] = { ...history[0], content: history[0].content.slice(0, HISTORY_MAX_CHARS) };
    }
  } catch (e) {
    console.log('db error', e.message);
    return json({ error: '数据库读写失败' }, 500);
  }

  // 上下文顺序：persona → system prompt → 记忆消息（开关决定）→ 历史 → 新用户消息
  let mem;
  try {
    mem = await buildContext(env, st, content);
  } catch (e) {
    console.log('memory load error', e.message);
    return json({ error: '记忆读取失败' }, 500);
  }
  const systemPrompt = st.system_prompt || SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: mem.persona ? `${mem.persona}\n\n${systemPrompt}` : systemPrompt },
  ];
  if (mem.memory) messages.push({ role: 'system', content: mem.memory });
  messages.push(...history);
  if (regenId === null) messages.push({ role: 'user', content });

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
        messages,
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
      // 每条记账指令先收集，等回复正常结束、确认要保存后再落到数据库
      const pinnedOps = [];
      const collectOp = (d) => {
        if (d && typeof d === 'object') pinnedOps.push(d);
      };
      // 正文和思考过程都过滤，避免指令从任何一个通道露出来；
      // 只从正文执行指令：思考过程里可能复述提示词示例，不能当成真实记账。
      const directiveFilter = createDirectiveFilter(collectOp);
      const reasoningFilter = createDirectiveFilter(() => {});
      try {
        await send('meta', { session_id: sessionId, user_message_id: userMessageId, memory: mem.debug });
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
              const safeReasoning = reasoningFilter.push(d.reasoning_content);
              if (safeReasoning) {
                reasoning += safeReasoning;
                await send('reasoning', { text: safeReasoning });
              }
            }
            if (d.content) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              // 指令在流式阶段就摘掉，气泡里不会闪现；分片切断标记时过滤器会先扣住
              const safe = directiveFilter.push(d.content);
              if (safe) {
                text += safe;
                await send('delta', { text: safe });
              }
            }
          }
        }
        // 收尾：扣住的普通文本补发；没收完的指令整段丢弃
        const safeTail = directiveFilter.end();
        if (safeTail) {
          text += safeTail;
          await send('delta', { text: safeTail });
        }
        const reasoningTail = reasoningFilter.end();
        if (reasoningTail) {
          reasoning += reasoningTail;
          await send('reasoning', { text: reasoningTail });
        }
		if (clientGone) return; // 前端已断开：不保存回复
		if (userMessageId !== null) {
			// 双保险：用户消息如果已被撤回删掉了，就不保存回复
			const still = await sb(env, 'GET', `messages?id=eq.${userMessageId}&select=id`);
			if (!still?.length) return;
		}
        // 记账在确认回复要保存之后执行；失败只记日志，不影响回复
        if (pinnedOps.length) await applyPinnedOps(env, pinnedOps);

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
        let saveFailed = false;
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
            if (savedId === null) saveFailed = true;
            // 重新生成：新回复保存成功后，才删除旧回复（失败时旧回复不会丢）
            if (regenId !== null && savedId !== null) {
              await sb(env, 'DELETE', `messages?id=eq.${regenId}`);
            }
          } catch (e) {
            console.log('save error', e.message);
            saveFailed = true;
          }
        }
        if (saveFailed) {
          // 前端不改：把提示作为最后一段 delta 追加到界面，避免看起来像保存成功了
          await send('delta', { text: '\n\n（这条回复没有保存到数据库，刷新后会消失）' });
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