// A pinned model id ages out, and the person is left with a 404 on every
// ask. Store.js rewrites known-retired ids at load, but a provider can retire
// a model at any time and the pinned id lives in the settings file forever.
// So the ask itself heals: a retired-model failure triggers one discovery
// call (the /models endpoint, the same one Settings uses), the pin moves to
// a working model, and the ask is retried once. Electron-free on purpose:
// the tests drive it with a fake lister and a fake settings sink.
'use strict';

const { listModels } = require('../../src/model-list');

// What a retired model looks like from the wire. Status codes when the SDK
// carries them; message shapes otherwise, all model-shaped.
const RETIRED_STATUS = new Set([404, 410]);
const RETIRED_RE = /not[- ]found|no longer available|end[- ]of[- ]life|retired|shut ?down|deprecat|does ?not exist|unsupported model|unknown model|invalid model|not supported/i;
const MODEL_RE = /model/i;

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.status || err.code ? `${err.status || err.code} ` : '') + String(err.message || err.detail || err.error || err || '');
}

function isModelRetiredError(err) {
  if (!err) return false;
  const status = Number(err.status || err.code);
  if (RETIRED_STATUS.has(status)) return true;
  const text = errorText(err);
  if (!text) return false;
  if (/\b(404|410)\b/.test(text)) return true;
  // No status carried: only a model-shaped complaint counts, so a stray
  // "not found" about something else (a file, a route) never rewrites pins.
  return MODEL_RE.test(text) && RETIRED_RE.test(text);
}

// flash/haiku/mini for the fast tier, pro/sonnet/opus for the smart one.
const TIER_HINTS = {
  fast: /flash|haiku|mini|fast|instant|small|lite|8b/i,
  smart: /pro|sonnet|opus|large|120b|70b|max|ultra|super/i,
};

function familyTokens(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/^models\//, '')
    .split(/[^a-z0-9.]+/)
    .filter((token) => token.length > 2 && !/^(models?|latest)$/.test(token));
}

function scoreCandidate(id, oldId, tier) {
  const lower = String(id || '').toLowerCase();
  let score = 0;
  const oldTokens = familyTokens(oldId);
  for (const token of oldTokens) if (lower.includes(token)) score += 10;
  const hint = TIER_HINTS[tier];
  if (hint && hint.test(lower)) score += 25;
  return score;
}

// The best chat model for the tier, given what the provider lists today.
// Prefers the same family and the tier's shape; failing that, any tier hint;
// failing that, whatever chat model the provider offers.
function pickReplacement(models, oldId, tier) {
  const candidates = (models || [])
    .map((m) => String((m && (m.id || m)) || '').trim())
    .filter(Boolean);
  if (!candidates.length) return '';
  const scored = candidates
    .map((id) => ({ id, score: scoreCandidate(id, oldId, tier) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score > 0) return scored[0].id;
  const hint = TIER_HINTS[tier];
  const hinted = hint ? candidates.filter((id) => hint.test(id.toLowerCase())) : [];
  return (hinted[0] || candidates[0]);
}

// fn(model) runs the ask. On a retired-model error: one /models discovery,
// pick a working chat model, move the pin via onSwitch, retry once.
// Any other failure, or no discoverable replacement, rethrows the original.
async function withModelHeal({ provider, tier, currentModel, apiKey, baseUrl, onSwitch, listModelsImpl }, fn) {
  try {
    return await fn(currentModel);
  } catch (err) {
    if (!isModelRetiredError(err)) throw err;
    let discovered = null;
    try {
      const lister = listModelsImpl || listModels;
      const res = await lister(provider, { apiKey, baseUrl });
      if (res && res.ok && Array.isArray(res.models) && res.models.length) {
        const pick = pickReplacement(res.models.map((m) => (m && (m.id || m)) || ''), currentModel, tier || 'fast');
        if (pick) discovered = pick;
      }
    } catch { /* discovery failing means the original error stands */ }
    if (!discovered) throw err;
    try {
      if (typeof onSwitch === 'function') onSwitch(discovered, currentModel);
    } catch { /* moving the pin must never hide a working model */ }
    return fn(discovered);
  }
}

// The pin move, shared by the LLM paths and the speech path: write the new
// model into the companion's models block in the shared settings file.
function persistPin(provider, tier, model) {
  try {
    require('./store').setSettings({ models: { [provider]: { [tier]: model } } });
    return true;
  } catch (error) {
    console.log('[llm] could not save the model switch: ' + String((error && error.message) || error));
    return false;
  }
}

module.exports = { isModelRetiredError, pickReplacement, withModelHeal, persistPin, familyTokens, TIER_HINTS };
