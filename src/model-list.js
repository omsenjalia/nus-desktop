// Asks a provider's model list endpoint (the /models route) so the settings
// screens can offer real choices instead of remembered IDs. Electron-free on
// purpose: the desktop main process, the Companion, and the tests all use it.
// Every listModels() call is a single GET (a few pages at most for Anthropic),
// made only when the user asks or right after a key is saved.
//
// The response shapes that exist in the wild, all tolerated:
//   OpenAI-compatible: { data: [ { id, ... } ] }          (openai, nvidia, groq, openrouter, opencode, custom)
//   Anthropic:         { data: [ { id, display_name } ], has_more, last_id }   (paginated)
//   Gemini:            { models: [ { name: 'models/x', displayName, supportedGenerationMethods } ] }
//   Ollama native:     { models: [ { name: 'llama3.2:latest' } ] }             (GET /api/tags)
'use strict';

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_MODELS = 300;
const MAX_PAGES = 4;

// Where the OpenAI-compatible providers keep their API, so a /models request
// is just the base URL plus /models.
const OPENAI_COMPATIBLE = {
  openai: 'https://api.openai.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  opencode: 'https://opencode.ai/zen/go/v1',
};

// Providers that cannot answer without a key. Ollama is local and keyless; a
// custom endpoint may be an unauthenticated proxy.
const NEEDS_KEY = new Set(['openai', 'anthropic', 'gemini', 'nvidia', 'groq', 'openrouter', 'opencode']);

// Models that exist on these endpoints but are not chat models for the Knot
// to run on. Offering them in a picker reads as a bug report waiting to happen.
const NOT_CHAT = /embed|whisper|transcri|tts|text-to-speech|audio|speech|dall-e|gpt-image|moderation|rerank|realtime|guard/i;

function stripModelsPrefix(id) {
  const s = String(id || '').trim();
  return s.startsWith('models/') ? s.slice('models/'.length) : s;
}

// Collect { id, label } rows from any of the shapes above. Tolerant by
// design: one odd row must not sink the whole list.
function idsFrom(json) {
  const out = [];
  const push = (id, label) => {
    const clean = stripModelsPrefix(id);
    if (clean && clean.length <= 200) out.push({ id: clean, label: String(label || clean).trim() || clean });
  };
  const fromItem = (key, m) => {
    if (!m || typeof m !== 'object') return;
    // Gemini lists what each model can do; keep the ones that can answer a prompt.
    if (key === 'models' && Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) return;
    push(m.id || m.name, m.display_name || m.displayName || m.label || m.id || m.name);
  };
  if (Array.isArray(json)) {
    for (const m of json) { if (typeof m === 'string') push(m); else fromItem('data', m); }
    return out;
  }
  if (!json || typeof json !== 'object') return out;
  for (const key of ['data', 'models']) {
    if (!Array.isArray(json[key])) continue;
    for (const m of json[key]) fromItem(key, m);
    return out;
  }
  return out;
}

async function fetchJson(url, { headers, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* the body may be noise; ok:false carries the status */ }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
    err.status = res.status;
    const apiMessage = json && json.error && (json.error.message || (typeof json.error === 'string' ? json.error : null));
    if (apiMessage) err.detail = String(apiMessage).slice(0, 200);
    throw err;
  }
  return json;
}

async function listAnthropic(apiKey, opts) {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const models = [];
  let afterId = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = 'https://api.anthropic.com/v1/models?limit=100' + (afterId ? `&after_id=${encodeURIComponent(afterId)}` : '');
    const json = await fetchJson(url, { ...opts, headers });
    for (const item of (json && Array.isArray(json.data) ? json.data : [])) {
      if (item && item.id) models.push({ id: String(item.id), label: item.display_name || item.id });
    }
    if (!json || json.has_more !== true || !json.last_id) break;
    afterId = json.last_id;
  }
  return models;
}

async function listGemini(apiKey, opts) {
  const json = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models', { ...opts, headers: { 'x-goog-api-key': apiKey } });
  return idsFrom(json);
}

async function listOllama(opts) {
  const host = String(process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const json = await fetchJson(host + '/api/tags', opts);
    return idsFrom(json);
  } catch (error) {
    // Older Ollama or a proxy: fall back to the OpenAI-compatible listing.
    try {
      const json = await fetchJson(host + '/v1/models', opts);
      return idsFrom(json);
    } catch {
      throw error;
    }
  }
}

async function listOpenAICompatible(base, apiKey, opts) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const json = await fetchJson(String(base).replace(/\/+$/, '') + '/models', { ...opts, headers });
  return idsFrom(json);
}

function cleanList(models) {
  const seen = new Set();
  const clean = [];
  for (const item of models || []) {
    if (!item || !item.id) continue;
    const id = String(item.id).trim();
    if (!id || seen.has(id)) continue;
    if (NOT_CHAT.test(id)) continue;
    seen.add(id);
    clean.push({ id, label: item.label || id });
    if (clean.length >= MAX_MODELS) break;
  }
  clean.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
  return clean;
}

// provider: one of the nine the app knows. apiKey/baseUrl come from the
// caller's store, never from the renderer. Returns { ok, models } or
// { ok:false, error } where error is a sentence the Settings UI can show.
async function listModels(provider, { apiKey = '', baseUrl = '', fetchImpl, timeoutMs } = {}) {
  const key = String(apiKey || '').trim();
  const opts = { fetchImpl, timeoutMs };
  if (NEEDS_KEY.has(provider) && !key) return { ok: false, error: 'No key saved for this provider yet.' };
  try {
    let models = [];
    if (provider === 'anthropic') models = await listAnthropic(key, opts);
    else if (provider === 'gemini') models = await listGemini(key, opts);
    else if (provider === 'ollama') models = await listOllama(opts);
    else if (provider === 'custom') {
      const base = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (!base) return { ok: false, error: 'Set the custom base URL first, then find models.' };
      models = await listOpenAICompatible(base, key, opts);
    } else if (OPENAI_COMPATIBLE[provider]) models = await listOpenAICompatible(OPENAI_COMPATIBLE[provider], key, opts);
    else return { ok: false, error: `Unknown provider: ${String(provider)}` };
    const clean = cleanList(models);
    if (!clean.length) return { ok: false, error: 'The provider listed no chat models.' };
    return { ok: true, models: clean };
  } catch (error) {
    const status = error && error.status;
    const detail = error && error.detail ? ` (${error.detail})` : '';
    const reason = status ? `HTTP ${status}` : String((error && error.message) || error).slice(0, 160);
    return { ok: false, error: `Could not list models: ${reason}${detail}`.slice(0, 240) };
  }
}

module.exports = { listModels, idsFrom, cleanList, stripModelsPrefix, OPENAI_COMPATIBLE, NEEDS_KEY, NOT_CHAT, MAX_MODELS };
