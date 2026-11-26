// The /models discovery the settings pickers are built on. Checked with an
// injected fetch, because the sandbox (and CI) has no real provider keys.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { listModels, idsFrom, cleanList } = require('./model-list');

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  statusText: status === 401 ? 'Unauthorized' : 'OK',
  text: async () => JSON.stringify(body),
});

// Records calls and replays canned responses by URL predicate.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [match, response] of routes) {
      if (typeof match === 'string' ? String(url).includes(match) : match.test(String(url))) {
        return typeof response === 'function' ? response(url) : response;
      }
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  };
  fn.calls = calls;
  return fn;
}

test('idsFrom reads the OpenAI shape, the Gemini shape and a bare array', () => {
  assert.deepEqual(idsFrom({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }).map((m) => m.id), ['gpt-4o', 'gpt-4o-mini']);
  // Gemini: names carry a models/ prefix and displayName is preferred as label.
  const gemini = idsFrom({ models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  ] });
  assert.deepEqual(gemini.map((m) => m.id), ['gemini-2.5-flash', 'gemini-2.5-pro'], 'embedding models are dropped');
  assert.equal(gemini[0].label, 'Gemini 2.5 Flash');
  // Ollama native /api/tags
  assert.deepEqual(idsFrom({ models: [{ name: 'llama3.2:latest' }] }).map((m) => m.id), ['llama3.2:latest']);
  assert.deepEqual(idsFrom(['a', { id: 'b' }]).map((m) => m.id), ['a', 'b']);
});

test('cleanList drops non-chat models, dedupes, sorts and caps', () => {
  const clean = cleanList([
    { id: 'whisper-1' }, { id: 'gpt-4o' }, { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'o1-mini' },
  ]);
  assert.deepEqual(clean.map((m) => m.id), ['gpt-4o', 'o1-mini']);
});

test('openai lists through /models with the bearer token', async () => {
  const fetch = fakeFetch([['api.openai.com/v1/models', jsonResponse({ data: [{ id: 'gpt-4o', created: 1 }] })]]);
  const res = await listModels('openai', { apiKey: 'sk-test', fetchImpl: fetch });
  assert.equal(res.ok, true);
  assert.deepEqual(res.models.map((m) => m.id), ['gpt-4o']);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /\/models$/);
});

test('anthropic paginates with after_id', async () => {
  const page = (ids, more) => ({ data: ids.map((id) => ({ type: 'model', id, display_name: id })), has_more: more, last_id: ids[ids.length - 1] });
  const fetch = fakeFetch([
    [/after_id=/, (url) => jsonResponse(page(['claude-b'], false))],
    ['api.anthropic.com/v1/models', () => jsonResponse(page(['claude-a'], true))],
  ]);
  const res = await listModels('anthropic', { apiKey: 'sk-ant-test', fetchImpl: fetch });
  assert.equal(res.ok, true);
  assert.deepEqual(res.models.map((m) => m.id), ['claude-a', 'claude-b']);
  assert.equal(fetch.calls.length, 2);
});

test('gemini goes through v1beta/models and keeps prefixes stripped', async () => {
  const fetch = fakeFetch([['generativelanguage.googleapis.com', jsonResponse({ models: [
    { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
  ] })]]);
  const res = await listModels('gemini', { apiKey: 'AIza-test', fetchImpl: fetch });
  assert.equal(res.ok, true);
  assert.deepEqual(res.models.map((m) => m.id), ['gemini-3.6-flash']);
});

test('ollama uses the native tags route and falls back to /v1/models', async () => {
  const native = fakeFetch([['localhost:11434/api/tags', jsonResponse({ models: [{ name: 'llama3.2:latest' }] })]]);
  const res = await listModels('ollama', { fetchImpl: native });
  assert.equal(res.ok, true);
  assert.deepEqual(res.models.map((m) => m.id), ['llama3.2:latest']);
  // Native route dead: fall back to the OpenAI-compatible one.
  const compat = fakeFetch([
    ['localhost:11434/api/tags', jsonResponse({ error: 'boom' }, 500)],
    ['localhost:11434/v1/models', jsonResponse({ data: [{ id: 'qwen3:8b' }] })],
  ]);
  const res2 = await listModels('ollama', { fetchImpl: compat });
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.models.map((m) => m.id), ['qwen3:8b']);
});

test('openrouter, groq and opencode point at their own /models routes', async () => {
  for (const [provider, needle] of [['openrouter', 'openrouter.ai/api/v1/models'], ['groq', 'api.groq.com/openai/v1/models'], ['opencode', 'opencode.ai/zen/go/v1/models']]) {
    const fetch = fakeFetch([[needle, jsonResponse({ data: [{ id: 'some/model' }] })]]);
    const res = await listModels(provider, { apiKey: 'k', fetchImpl: fetch });
    assert.equal(res.ok, true, provider);
    assert.equal(fetch.calls.length, 1, provider);
  }
});

test('a custom endpoint strips trailing slashes and joins /models', async () => {
  const fetch = fakeFetch([['example.invalid/v1/models', jsonResponse({ data: [{ id: 'local-model' }] })]]);
  const res = await listModels('custom', { baseUrl: 'https://example.invalid/v1/', fetchImpl: fetch });
  assert.equal(res.ok, true);
  assert.deepEqual(res.models.map((m) => m.id), ['local-model']);
});

test('a custom provider with no base URL asks for one instead of calling out', async () => {
  const fetch = fakeFetch([]);
  const res = await listModels('custom', { fetchImpl: fetch });
  assert.equal(res.ok, false);
  assert.match(res.error, /base URL/i);
  assert.equal(fetch.calls.length, 0);
});

test('a keyless provider other than ollama or custom never hits the network', async () => {
  const fetch = fakeFetch([]);
  const res = await listModels('openai', { fetchImpl: fetch });
  assert.equal(res.ok, false);
  assert.match(res.error, /No key/i);
  assert.equal(fetch.calls.length, 0);
});

test('an HTTP error comes back as a sentence, not a crash', async () => {
  const fetch = fakeFetch([['api.openai.com/v1/models', jsonResponse({ error: { message: 'invalid key' } }, 401)]]);
  const res = await listModels('openai', { apiKey: 'bad', fetchImpl: fetch });
  assert.equal(res.ok, false);
  assert.match(res.error, /401/);
  assert.match(res.error, /invalid key/);
});

test('an unreachable provider comes back as ok:false', async () => {
  const fetch = async () => { throw new Error('socket hang up'); };
  const res = await listModels('groq', { apiKey: 'gsk_x', fetchImpl: fetch });
  assert.equal(res.ok, false);
  assert.match(res.error, /socket hang up/);
});
