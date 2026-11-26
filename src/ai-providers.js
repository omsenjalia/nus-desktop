// The provider matrix for the desktop brain. Electron-free on purpose: ai.js
// wires these to the settings file and the OS keychain; the tests check them
// directly. Nothing in here throws on bad input; every cleaner answers with an
// error object the UI can show.
'use strict';

const MODEL_ID_PATTERN = /^[\w][\w.\-/:@]{0,137}$/;
const PROVIDERS = ['claude-code', 'anthropic', 'gemini', 'openai', 'nvidia', 'groq', 'openrouter', 'opencode', 'ollama', 'custom'];
const PROVIDER_LABELS = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic API',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  nvidia: 'Nvidia',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  opencode: 'opencode go',
  ollama: 'Ollama (local)',
  custom: 'Custom endpoint',
};
// Needs an OpenAI-style base URL (vs Anthropic and Gemini shapes).
const OPENAI_STYLE = new Set(['openai', 'nvidia', 'groq', 'openrouter', 'opencode', 'ollama', 'custom']);
const EXTRA_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  opencode: 'https://opencode.ai/zen/go/v1',
};
const PROVIDER_DEFAULTS = {
  'claude-code': 'claude-sonnet-5',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-4o-mini',
  nvidia: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  opencode: '',
  ollama: 'llama3.2',
  custom: '',
};
const ANTHROPIC_KEY_NAME = 'anthropic_api_key';

const needsKey = (provider) => !['ollama', 'custom', 'claude-code'].includes(provider);
const isProvider = (value) => PROVIDERS.includes(String(value || ''));
const keyNameFor = (provider) => (provider === 'anthropic' ? ANTHROPIC_KEY_NAME : `desktop_key_${provider}`);

// Settings shape helpers. Anything odd in the file reads as unset.
function desktopProviderChoice(prefs) {
  const choice = prefs && typeof prefs === 'object' ? prefs.desktop_provider : '';
  return typeof choice === 'string' && isProvider(choice) ? choice : 'auto';
}
function desktopBaseUrl(prefs) {
  const base = prefs && typeof prefs === 'object' ? prefs.desktop_base_url : '';
  return typeof base === 'string' ? base.trim() : '';
}
function desktopModelFor(prefs, provider) {
  const models = prefs && typeof prefs === 'object' ? prefs.desktop_models : null;
  return models && typeof models === 'object' && typeof models[provider] === 'string' ? models[provider].trim() : '';
}

// Input cleaners: what the settings verbs accept.
function cleanProviderChoice(value) {
  const choice = String(value || '');
  return isProvider(choice) || choice === 'auto' ? choice : 'auto';
}
function cleanModelId(value) {
  const clean = String(value == null ? '' : value).trim().slice(0, 200);
  if (clean && !MODEL_ID_PATTERN.test(clean)) return { error: 'bad_model_id' };
  return { model: clean };
}
function cleanBaseUrl(value) {
  const clean = String(value == null ? '' : value).trim().slice(0, 300);
  if (clean && !/^https?:\/\/.+\S/.test(clean)) return { error: 'bad_base_url' };
  return { baseUrl: clean };
}

// Resolution: what the router actually uses.
function baseUrlFor(provider, prefs, env) {
  const environment = env || process.env;
  if (provider === 'custom') return desktopBaseUrl(prefs);
  if (provider === 'ollama') return String(environment.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '') + '/v1';
  return EXTRA_BASE_URLS[provider] || '';
}
function modelFor(provider, prefs, modelOverride, env) {
  const environment = env || process.env;
  if (provider === 'claude-code' || provider === 'anthropic') {
    return modelOverride || desktopModelFor(prefs, 'claude-code') || desktopModelFor(prefs, 'anthropic') || environment.NUS_AI_MODEL || PROVIDER_DEFAULTS['claude-code'];
  }
  return desktopModelFor(prefs, provider) || PROVIDER_DEFAULTS[provider] || '';
}

module.exports = {
  MODEL_ID_PATTERN, PROVIDERS, PROVIDER_LABELS, PROVIDER_DEFAULTS, EXTRA_BASE_URLS, OPENAI_STYLE,
  ANTHROPIC_KEY_NAME, needsKey, isProvider, keyNameFor,
  desktopProviderChoice, desktopBaseUrl, desktopModelFor,
  cleanProviderChoice, cleanModelId, cleanBaseUrl, baseUrlFor, modelFor,
};
