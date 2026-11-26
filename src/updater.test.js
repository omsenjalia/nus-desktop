'use strict';
// src/updater.js: when it starts, when it stays out of the way, and what it asks
// before it restarts the app.
//
// Nothing here touches the network or Electron. The updater is injected: an
// EventEmitter with the four methods electron-updater's autoUpdater has, and a
// dialog that records what it was asked. That is the only way to test a popup
// that appears once, days after a release, on someone else's machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { initAutoUpdate } = require('./updater');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.calls = { check: 0, quitAndInstall: 0 };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.checkForUpdates = () => { updater.calls.check++; return Promise.resolve(null); };
  updater.quitAndInstall = () => { updater.calls.quitAndInstall++; };
  return updater;
}

function fakeDialog(response = 0) {
  const dialog = { asked: [], response };
  dialog.showMessageBox = async (options) => { dialog.asked.push(options); return { response: dialog.response }; };
  return dialog;
}

function fakeTimers() {
  const timers = { intervals: [], cleared: [], setInterval: null, clearInterval: null };
  timers.setInterval = (fn, ms) => { const t = { fn, ms, unref() { t.unrefd = true; } }; timers.intervals.push(t); return t; };
  timers.clearInterval = (t) => timers.cleared.push(t);
  return timers;
}

const packaged = { isPackaged: true };
const dev = { isPackaged: false };
const quiet = { log: () => {}, error: () => {} };

function start(overrides = {}) {
  const updater = overrides.updater || fakeUpdater();
  const dialog = overrides.dialog || fakeDialog();
  const timers = overrides.timers || fakeTimers();
  const result = initAutoUpdate({
    app: packaged, dialog, updater, platform: 'win32', env: {}, timers, intervalMs: 1000,
    onError: () => {}, log: quiet, now: () => 42, ...overrides,
  });
  return { result, updater, dialog, timers };
}

test('an unpackaged run does not check anything', () => {
  const { result, updater } = start({ app: dev });
  assert.deepEqual(result, { started: false, reason: 'not_packaged' });
  assert.equal(updater.calls.check, 0, 'a dev run has no feed to poll');
});

test('the portable exe does not try to patch itself', () => {
  // It has no install directory to write into; the updater would replace the
  // running file and leave a second copy beside it.
  const { result, updater } = start({ env: { PORTABLE_EXECUTABLE_DIR: 'D:\\' } });
  assert.deepEqual(result, { started: false, reason: 'portable' });
  assert.equal(updater.calls.check, 0);
});

test('macOS is off until the build is notarized', () => {
  const { result, updater } = start({ platform: 'darwin' });
  assert.deepEqual(result, { started: false, reason: 'mac_unsigned' });
  assert.equal(updater.calls.check, 0);
});

test('and nothing but Windows is on', () => {
  const { result } = start({ platform: 'linux' });
  assert.deepEqual(result, { started: false, reason: 'not_windows' });
});

test('a packaged Windows install checks once, then on a timer, then stops', async () => {
  const { result, updater, timers } = start();
  assert.equal(result.started, true);
  assert.equal(updater.autoDownload, true, 'the download is background work, not a question');
  assert.equal(updater.autoInstallOnAppQuit, true, 'no answer means it installs on quit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.calls.check, 1, 'one check at startup');
  assert.equal(timers.intervals.length, 1, 'and a timer for a machine that stays open');
  assert.equal(timers.intervals[0].ms, 1000);
  assert.equal(timers.intervals[0].unrefd, true, 'the timer never holds the app open');

  timers.intervals[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.calls.check, 2, 'the timer checks again');

  result.stop();
  assert.deepEqual(timers.cleared, [timers.intervals[0]]);
});

test('a downloaded update asks, and Restart now restarts', async () => {
  const dialog = fakeDialog(0);
  const { updater } = start({ dialog });
  updater.emit('update-downloaded', { version: '0.4.0' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dialog.asked.length, 1, 'one popup');
  const asked = dialog.asked[0];
  assert.deepEqual(asked.buttons, ['Restart now', 'Later']);
  assert.equal(asked.defaultId, 0, 'the restart is the default button');
  assert.equal(asked.cancelId, 1, 'and Escape is Later, not a restart nobody asked for');
  assert.match(asked.message, /0\.4\.0/, 'the version is in the message');
  assert.match(asked.detail, /next time you quit/, 'and what Later means');
  assert.match(asked.detail, /not touched/, 'and that data survives, which is the real fear');
  assert.equal(updater.calls.quitAndInstall, 1);
});

test('the popup is parented to the window, so it is in front of the app', async () => {
  const parentCalls = [];
  const window = { isDestroyed: () => false };
  const dialog = {
    asked: [],
    showMessageBox: async (first, second) => {
      parentCalls.push(second ? 'parented' : 'floating');
      dialog.asked.push(second || first);
      return { response: 1 };
    },
  };
  const { updater } = start({ dialog, window });
  updater.emit('update-downloaded', { version: '0.4.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parentCalls, ['parented']);
});

test('a window that is already closed is not a parent', async () => {
  const window = { isDestroyed: () => true };
  let sawParent = true;
  const dialog = { showMessageBox: async (first, second) => { sawParent = Boolean(second); return { response: 1 }; } };
  const { updater } = start({ dialog, window });
  updater.emit('update-downloaded', { version: '0.4.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sawParent, false, 'a destroyed window would throw instead of showing');
});

test('Later does not restart, and the update still lands on quit', async () => {
  const dialog = fakeDialog(1);
  const { updater } = start({ dialog });
  updater.emit('update-downloaded', { version: '0.4.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.calls.quitAndInstall, 0, 'the app is not restarted under the person');
  assert.equal(updater.autoInstallOnAppQuit, true, 'but the next quit installs it');
});

test('the popup appears once per run, not once per event', async () => {
  const dialog = fakeDialog(1);
  const { updater } = start({ dialog });
  updater.emit('update-downloaded', { version: '0.4.0' });
  updater.emit('update-downloaded', { version: '0.4.0' });
  updater.emit('update-downloaded', { version: '0.4.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialog.asked.length, 1, 'a check that finds the same update twice asks twice');
  assert.equal(updater.calls.quitAndInstall, 0);
});

test('a dialog that throws is a logged failure, not a crash', async () => {
  const dialog = { showMessageBox: async () => { throw new Error('no display'); } };
  const seen = [];
  const { updater } = start({ dialog, onError: (e) => seen.push(e.message) });
  updater.emit('update-downloaded', { version: '0.4.0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['no display']);
  assert.equal(updater.calls.quitAndInstall, 0);
});

test('a failing check is swallowed and reported', async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = () => { updater.calls.check++; return Promise.reject(new Error('ETIMEDOUT')); };
  const seen = [];
  const { result } = start({ updater, onError: (e) => seen.push(e.message) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.started, true, 'the app still starts');
  assert.deepEqual(seen, ['ETIMEDOUT']);
});

test('an updater that throws synchronously is caught too', async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = () => { throw new Error('no feed'); };
  const seen = [];
  start({ updater, onError: (e) => seen.push(e.message) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['no feed']);
});

test('an error event never escapes into boot', () => {
  const seen = [];
  const { updater } = start({ onError: (e) => seen.push(e.message) });
  assert.doesNotThrow(() => updater.emit('error', new Error('github said no')));
  assert.deepEqual(seen, ['github said no']);
});

test('with no updater module, the app still starts', () => {
  // electron-updater builds an Electron adapter when it is imported, so it is
  // loaded defensively. A packaged app that cannot load it must not lose boot.
  const result = initAutoUpdate({
    app: packaged, dialog: fakeDialog(), resolveUpdater: () => null,
    platform: 'win32', env: {}, timers: fakeTimers(), log: quiet,
  });
  assert.deepEqual(result, { started: false, reason: 'module_missing' });
});

test('requiring this module does not require electron, or a network', () => {
  // ./updater was required at the top of this file, in plain node, where
  // require('electron') throws and there is no feed. Every test in here running
  // at all is the assertion; this names it so the laziness is not removed by a
  // tidy-up that moves a require to the top.
  assert.equal(typeof initAutoUpdate, 'function');
  assert.equal(typeof require('./updater').HOUR, 'number');
});
