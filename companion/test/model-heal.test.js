'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isModelRetiredError, pickReplacement, withModelHeal, familyTokens } = require('../src/model-heal');

test('isModelRetiredError: status codes win', () => {
  assert.equal(isModelRetiredError({ status: 404, message: 'whatever' }), true);
  assert.equal(isModelRetiredError({ status: 410, message: 'whatever' }), true);
  assert.equal(isModelRetiredError({ code: 404 }), true);
  assert.equal(isModelRetiredError({ status: 429, message: 'quota' }), false);
  assert.equal(isModelRetiredError({ status: 401, message: 'bad key' }), false);
});

test('isModelRetiredError: message shapes from the SDKs in use', () => {
  assert.equal(isModelRetiredError(new Error('models/gemini-2.5-flash is not found for API version v1beta, or is not supported for generateContent')), true);
  assert.equal(isModelRetiredError(new Error('404 The model `gemini-3.6-flash` is not found')), true);
  assert.equal(isModelRetiredError(new Error('The model meta/llama-3.2-90b-vision-instruct has reached its end of life and is no longer available.')), true);
  assert.equal(isModelRetiredError(new Error('HTTP 410 Gone')), true);
  assert.equal(isModelRetiredError(new Error('429 quota exceeded')), false);
  assert.equal(isModelRetiredError(new Error('network socket hang up')), false);
  assert.equal(isModelRetiredError(new Error('route not found')), false); // no model word
  assert.equal(isModelRetiredError(''), false);
  assert.equal(isModelRetiredError(null), false);
});

test('familyTokens drops paths and the word model/latest', () => {
  assert.deepEqual(familyTokens('models/gemini-3.6-flash'), ['gemini', '3.6', 'flash']);
  assert.deepEqual(familyTokens('meta/llama-3.3-70b-instruct'), ['meta', 'llama', '3.3', '70b', 'instruct']);
  assert.deepEqual(familyTokens('gemini-flash-latest'), ['gemini', 'flash']);
});

test('pickReplacement prefers the tier shape and the same family', () => {
  const listed = [
    { id: 'gemini-3.7-pro' },
    { id: 'gemini-3.7-flash' },
    { id: 'gemini-flash-latest' },
    { id: 'text-embedding-004' },
  ];
  assert.equal(pickReplacement(listed, 'gemini-3.6-flash', 'fast'), 'gemini-3.7-flash');
  assert.equal(pickReplacement(listed, 'gemini-3.6-pro', 'smart'), 'gemini-3.7-pro');
  // No family overlap: the tier hint still wins over an unrelated pro model.
  assert.equal(pickReplacement([{ id: 'foo-pro' }, { id: 'bar-flash' }], 'gemini-3.6-flash', 'fast'), 'bar-flash');
  // Nothing hinted, nothing shared: the first chat model it was given.
  assert.equal(pickReplacement([{ id: 'a-model' }, { id: 'b-model' }], '', 'fast'), 'a-model');
  assert.equal(pickReplacement([], 'gemini-3.6-flash', 'fast'), '');
  assert.equal(pickReplacement(null, 'x', 'fast'), '');
});

test('withModelHeal: a retired model is swapped for a listed one and the ask retried', async () => {
  const seen = [];
  const result = await withModelHeal({
    provider: 'gemini', tier: 'fast', currentModel: 'gemini-3.6-flash', apiKey: 'AQ.x',
    listModelsImpl: async () => ({ ok: true, models: [{ id: 'gemini-3.7-flash' }, { id: 'gemini-3.7-pro' }] }),
    onSwitch: (found, previous) => seen.push(['switch', previous, '->', found]),
  }, async (model) => {
    if (model === 'gemini-3.6-flash') { const e = new Error('404 Not Found'); e.status = 404; throw e; }
    return 'answer from ' + model;
  });
  assert.equal(result, 'answer from gemini-3.7-flash');
  assert.deepEqual(seen, [['switch', 'gemini-3.6-flash', '->', 'gemini-3.7-flash']]);
});

test('withModelHeal: a non-retired failure is thrown, pin untouched, fn called once', async () => {
  let calls = 0;
  await assert.rejects(
    withModelHeal({
      provider: 'gemini', tier: 'fast', currentModel: 'gemini-3.6-flash', apiKey: 'k',
      listModelsImpl: async () => ({ ok: true, models: [{ id: 'gemini-3.7-flash' }] }),
      onSwitch: () => { throw new Error('onSwitch must not run'); },
    }, async () => { calls += 1; const e = new Error('429 quota'); e.status = 429; throw e; }),
    /429/
  );
  assert.equal(calls, 1);
});

test('withModelHeal: discovery failing rethrows the original retired-model error', async () => {
  for (const lister of [async () => ({ ok: false, error: 'Could not list models: HTTP 401' }), async () => { throw new Error('boom'); }]) {
    let calls = 0;
    await assert.rejects(
      withModelHeal({ provider: 'gemini', tier: 'fast', currentModel: 'm', apiKey: 'k', listModelsImpl: lister, onSwitch: () => assert.fail('no switch without a replacement') },
        async () => { calls += 1; const e = new Error('404 not found'); e.status = 404; throw e; }),
      (err) => { assert.equal(err.status, 404); return true; }
    );
    assert.equal(calls, 1);
  }
});

test('withModelHeal: the retried ask fails too, so the caller still gets a plain error', async () => {
  const switches = [];
  await assert.rejects(
    withModelHeal({
      provider: 'gemini', tier: 'fast', currentModel: 'old-model', apiKey: 'k',
      listModelsImpl: async () => ({ ok: true, models: [{ id: 'new-model' }] }),
      onSwitch: (found, previous) => switches.push([previous, found]),
    }, async () => { const e = new Error('404 not found'); e.status = 404; throw e; }),
    (err) => { assert.equal(err.status, 404); return true; }
  );
  assert.deepEqual(switches, [['old-model', 'new-model']]);
});


// ---- the ask paths, end to end, with the wire stubbed -------------------
// The SDKs are real and the fetch underneath is fake: the first generateContent
// answers 404 like a retired model, the /models discovery answers with a
// current list, and the retry succeeds. This is the exact shape of the bug
// this module exists for.
test('complete(): a retired Gemini model is discovered, swapped and answered', async () => {
  const { createLLM } = require('../src/llm');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    seen.push(u);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('generativelanguage.googleapis.com') && u.includes(':generateContent')) {
      const model = decodeURIComponent(u.split('/models/')[1].split(':')[0]);
      if (model === 'gemini-3.6-flash') return json({ error: { code: 404, message: 'models/gemini-3.6-flash is not found for API version v1beta' } }, 404);
      return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'answer from ' + model }] }, finishReason: 'STOP' }] });
    }
    if (u.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) {
      return json({ models: [
        { name: 'models/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.7-pro', displayName: 'Gemini 3.7 Pro', supportedGenerationMethods: ['generateContent'] },
      ] });
    }
    throw new Error('unexpected fetch: ' + u + ' ' + (opts && opts.method));
  };
  try {
    const llm = createLLM({ provider: 'gemini', smart: false, apiKeys: { gemini: 'AQ.test-key' }, models: { gemini: { fast: 'gemini-3.6-flash' } } });
    const text = await llm.complete({ system: 'be short', turns: [{ role: 'user', text: 'hi' }] });
    assert.equal(text, 'answer from gemini-3.7-flash');
    assert.ok(seen.some((u) => u.includes('gemini-3.6-flash')), 'the ask went out with the pinned model first');
    assert.ok(seen.some((u) => u.startsWith('https://generativelanguage.googleapis.com/v1beta/models')), 'a model list was discovered');
    assert.ok(seen.some((u) => u.includes('gemini-3.7-flash') && u.includes(':generateContent')), 'the retried ask used the discovered model');
  } finally {
    globalThis.fetch = realFetch;
  }
});


// ---- the voice path, end to end, with the wire stubbed -------------------
// This is the reported bug: hold Ctrl+Alt, speak, and the pinned fast model
// transcribing the speech has been retired. The transcription heals the same
// way an ask does instead of returning nothing.
test('STT: a retired Gemini fast model transcribes after discovery', async () => {
  const { createSTT } = require('../src/stt');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    seen.push(u);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('generativelanguage.googleapis.com') && u.includes(':generateContent')) {
      const model = decodeURIComponent(u.split('/models/')[1].split(':')[0]);
      if (model === 'gemini-3.6-flash') return json({ error: { code: 404, message: 'models/gemini-3.6-flash is not found for API version v1beta' } }, 404);
      return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'transcribed words' }] }, finishReason: 'STOP' }] });
    }
    if (u.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) {
      return json({ models: [
        { name: 'models/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', supportedGenerationMethods: ['generateContent'] },
      ] });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const settings = { provider: 'gemini', apiKeys: { gemini: 'AQ.test-key' }, models: { gemini: { fast: 'gemini-3.6-flash' } } };
    const stt = createSTT(settings);
    // 16 kHz mono s16, well over the 0.4 s floor, loud enough for the RMS gate.
    const pcm = Buffer.alloc(16000 * 2 * 2, 0);
    for (let i = 0; i + 1 < pcm.length; i += 2) pcm.writeInt16LE(7000, i);
    const res = await stt.transcribe(pcm);
    assert.equal(res.text, 'transcribed words');
    assert.equal(res.provider, 'gemini');
    assert.ok(seen.some((u) => u.includes('gemini-3.7-flash') && u.includes(':generateContent')), 'the retry used the discovered model');
  } finally {
    globalThis.fetch = realFetch;
  }
});
