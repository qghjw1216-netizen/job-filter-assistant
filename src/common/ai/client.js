// 多协议 AI 客户端：把统一的「消息 + 参数」翻译成各协议的 HTTP 请求，
// 并把各协议响应解析回纯文本 / JSON。运行在 background（有跨域权限）。
import { sanitizeProvider, isLocalUrl } from './providers.js';

export class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

// 统一入口：给定 provider + prompt，返回模型文本。
// opts: { system, temperature, maxTokens, json(bool 期望 JSON), signal }
export async function chat(providerInput, prompt, opts = {}) {
  const p = sanitizeProvider(providerInput);
  const base = Array.isArray(prompt) ? prompt : [{ role: 'user', content: String(prompt) }];
  // 支持文档化的 opts.system：作为 system 消息前置（与 messages 内已有的 system 合并）
  const messages = opts.system ? [{ role: 'system', content: String(opts.system) }, ...base] : base;
  const req = buildRequest(p, messages, opts);
  const res = await doFetch(req.url, req.init, opts.signal);
  const data = await parseJsonSafe(res);
  if (!res.ok) throw new AiError(errMessage(p, data, res.status), res.status);
  return extractText(p.protocol, data);
}

// 期望 JSON：调用 chat 后解析出对象（带 ```json 围栏容错）
export async function chatJson(providerInput, prompt, opts = {}) {
  const text = await chat(providerInput, prompt, { ...opts, json: true });
  return parseModelJson(text);
}

// 连通性测试：最小请求，返回 {ok, message, sample}
export async function testProvider(providerInput, opts = {}) {
  try {
    const text = await chat(providerInput, [{ role: 'user', content: '请只回复两个字：正常' }], {
      maxTokens: 16,
      temperature: 0,
      signal: opts.signal,
    });
    return { ok: true, message: '连接成功', sample: (text || '').slice(0, 40) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// 拉取模型列表（协议相关）。返回 string[] 模型 id。
export async function listModels(providerInput, opts = {}) {
  const p = sanitizeProvider(providerInput);
  const { url, init } = buildModelsRequest(p);
  const res = await doFetch(url, init, opts.signal);
  const data = await parseJsonSafe(res);
  if (!res.ok) throw new AiError(errMessage(p, data, res.status), res.status);
  return extractModelList(p.protocol, data);
}

// ============ 请求构造 ============
function buildRequest(p, messages, opts) {
  const temperature = opts.temperature ?? p.temperature ?? 0.3;
  const maxTokens = opts.maxTokens ?? p.maxTokens ?? 2048;
  const wantJson = !!opts.json;
  const { system, chatMsgs } = splitSystem(messages);

  if (p.protocol === 'anthropic') {
    return {
      url: reqUrl(p, 'messages'),
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': p.apiKey,
          'anthropic-version': p.anthropicVersion || '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...p.extraHeaders,
        },
        body: JSON.stringify({
          model: p.model,
          system: system || undefined,
          messages: chatMsgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          temperature,
          max_tokens: maxTokens,
        }),
      },
    };
  }

  if (p.protocol === 'gemini') {
    // key 走 query，system 用 systemInstruction
    const base = reqUrl(p, `models/${encodeURIComponent(p.model)}:generateContent`);
    const url = p.apiKey ? `${base}?key=${encodeURIComponent(p.apiKey)}` : base;
    return {
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...p.extraHeaders },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: chatMsgs.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            responseMimeType: wantJson ? 'application/json' : undefined,
          },
        }),
      },
    };
  }

  if (p.protocol === 'openai-responses') {
    return {
      url: reqUrl(p, 'responses'),
      init: {
        method: 'POST',
        headers: authHeaders(p),
        body: JSON.stringify({
          model: p.model,
          instructions: system || undefined,
          input: chatMsgs.map((m) => ({ role: m.role, content: m.content })),
          temperature,
          max_output_tokens: maxTokens,
          text: wantJson ? { format: { type: 'json_object' } } : undefined,
        }),
      },
    };
  }

  // 默认 openai-chat
  return {
    url: reqUrl(p, 'chat/completions'),
    init: {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify({
        model: p.model,
        messages: system ? [{ role: 'system', content: system }, ...chatMsgs] : chatMsgs,
        temperature,
        max_tokens: maxTokens,
        response_format: wantJson ? { type: 'json_object' } : undefined,
      }),
    },
  };
}

function buildModelsRequest(p) {
  if (p.modelsUrl) return { url: p.modelsUrl, init: { method: 'GET', headers: authHeaders(p, true) } };
  if (p.protocol === 'gemini') {
    const base = joinUrl(p.baseUrl, 'models');
    return { url: p.apiKey ? `${base}?key=${encodeURIComponent(p.apiKey)}` : base, init: { method: 'GET' } };
  }
  if (p.protocol === 'anthropic') {
    return {
      url: joinUrl(p.baseUrl, 'models'),
      init: {
        method: 'GET',
        headers: {
          'x-api-key': p.apiKey,
          'anthropic-version': p.anthropicVersion || '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...p.extraHeaders,
        },
      },
    };
  }
  // openai 系
  return { url: joinUrl(p.baseUrl, 'models'), init: { method: 'GET', headers: authHeaders(p, true) } };
}

function authHeaders(p, getOnly = false) {
  const h = { ...p.extraHeaders };
  if (!getOnly) h['content-type'] = 'application/json';
  if (p.apiKey) h['authorization'] = `Bearer ${p.apiKey}`;
  return h;
}

// baseUrl + endpoint 拼接；requestUrl 非空则直接用
function reqUrl(p, endpoint) {
  if (p.requestUrl) return p.requestUrl;
  return joinUrl(p.baseUrl, endpoint);
}
function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

function splitSystem(messages) {
  let system = '';
  const chatMsgs = [];
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n' : '') + m.content;
    else chatMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
  }
  if (chatMsgs.length === 0) chatMsgs.push({ role: 'user', content: system || '你好' });
  return { system, chatMsgs };
}

// ============ 响应解析 ============
function extractText(protocol, data) {
  if (!isObj(data)) return '';
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(data.content) ? data.content : [];
    return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('').trim();
  }
  if (protocol === 'gemini') {
    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    return parts.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('').trim();
  }
  if (protocol === 'openai-responses') {
    if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
    const out = Array.isArray(data.output) ? data.output : [];
    return out
      .flatMap((o) => (o && Array.isArray(o.content) ? o.content : []))
      .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
      .join('')
      .trim();
  }
  // openai-chat
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const msg = choices[0] && choices[0].message ? choices[0].message : {};
  if (typeof msg.content === 'string') return msg.content.trim();
  // 少数网关返回 content 数组
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('').trim();
  }
  return '';
}

function extractModelList(protocol, data) {
  if (!isObj(data)) return [];
  let raw = [];
  if (protocol === 'gemini') raw = Array.isArray(data.models) ? data.models : [];
  else raw = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const ids = raw
    .map((m) => {
      if (typeof m === 'string') return m;
      if (!isObj(m)) return '';
      // gemini 的 name 形如 "models/gemini-1.5-flash"
      const id = m.id || m.name || m.model || '';
      return typeof id === 'string' ? id.replace(/^models\//, '') : '';
    })
    .filter(Boolean);
  return Array.from(new Set(ids)).sort();
}

// ============ JSON 解析容错 ============
export function parseModelJson(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('模型返回为空');
  // 去掉 ```json 围栏
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  try {
    return JSON.parse(body);
  } catch {
    // 截取第一个 { 到最后一个 }
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(body.slice(first, last + 1));
    }
    throw new Error('无法解析模型返回的 JSON');
  }
}

// ============ 底层 ============
async function doFetch(url, init, signal) {
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new AiError(`网络请求失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
async function parseJsonSafe(res) {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}
function errMessage(p, data, status) {
  let detail = '';
  if (isObj(data)) {
    detail =
      (data.error && (data.error.message || data.error.type)) ||
      data.message ||
      (isObj(data.error) ? JSON.stringify(data.error) : '') ||
      (typeof data.__raw === 'string' ? data.__raw.slice(0, 300) : '');
  }
  const hint = status === 401 || status === 403 ? '（请检查 API Key 与权限）' : '';
  return `请求失败 ${status || ''}${detail ? '：' + detail : ''}${hint}`;
}
function isObj(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
