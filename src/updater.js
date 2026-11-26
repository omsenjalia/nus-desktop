// Auto-update against the GitHub releases feed, with a popup when the update is
// downloaded and waiting.
//
// v0.1.0 shipped with no updater, which meant every install was frozen forever:
// no way to deliver a bug fix, a limit change, or a security patch to anyone who
// had already downloaded it. This is the seam that makes every later release
// actually reach people, so it has to land before any traffic does.
//
// The installer is ~460 MB because the Fable voice model is inside it, so the
// update must not be a second 460 MB download. electron-updater reads the
// `latest.yml` and `.exe.blockmap` published beside the installer and fetches
// only the blocks that changed: a code change is a few megabytes, and the 334 MB
// of voice the two versions share is not transferred at all. That is why the
// release has to carry the blockmap (docs/release.md §3) — without it the same
// feed silently falls back to downloading the whole file.
//
// Only the NSIS install can self-update. The portable .exe has no install
// directory to write into, so it is skipped by design and those users
// re-download. Dev runs are skipped too: an unpackaged app has no feed to check.
//
// Nothing in here may take the app down with it. No network, a rate-limited
// GitHub, a half-written feed: every one of those lands in the fail path, which
// logs and returns.
'use strict';

// electron and electron-updater are required lazily and defensively: under plain
// node (`npm test`) `require('electron')` throws, and electron-updater builds an
// Electron adapter on import. A test injects its own fakes instead.
function loadElectron() {
  try { return require('electron'); } catch { return null; }
}

function loadUpdater() {
  try { return require('electron-updater').autoUpdater; } catch (error) {
    console.error('[nus] electron-updater unavailable', error && error.message);
    return null;
  }
}

const HOUR = 60 * 60 * 1000;

function initAutoUpdate({
  app: appOverride,
  dialog: dialogOverride,
  updater: updaterOverride,
  resolveUpdater = loadUpdater,
  env = process.env,
  platform = process.platform,
  intervalMs = 4 * HOUR,
  timers = { setInterval, clearInterval },
  now = Date.now,
  window: parentWindow,
  onError,
  log = console,
} = {}) {
  const electron = appOverride && dialogOverride ? null : loadElectron();
  const app = appOverride || (electron && electron.app);
  if (!app || typeof app.isPackaged !== 'boolean') return { started: false, reason: 'no_app' };
  if (!app.isPackaged) return { started: false, reason: 'not_packaged' };
  // electron-builder sets this only for the portable target.
  if (env.PORTABLE_EXECUTABLE_DIR) return { started: false, reason: 'portable' };
  // The Mac build is ad-hoc signed, and electron-updater refuses to apply an
  // update to an app without a Developer ID signature (and there is no
  // latest-mac.yml or zip in the release to point it at). Mac users re-download
  // until the build is notarized; then add the zip target and delete this line.
  if (platform === 'darwin') return { started: false, reason: 'mac_unsigned' };
  // NSIS is the only feed this reads.
  if (platform !== 'win32') return { started: false, reason: 'not_windows' };

  const autoUpdater = updaterOverride || resolveUpdater();
  if (!autoUpdater) return { started: false, reason: 'module_missing' };

  // Download in the background, ask before restarting, and if the person never
  // answers, install on the next quit rather than blocking them now.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const dialog = dialogOverride || (electron && electron.dialog);
  const fail = (error) => {
    log.error('[nus] update check failed', (error && error.message) || error);
    if (onError) { try { onError(error); } catch { /* a listener, never a failure */ } }
  };

  let prompted = false;

  async function promptToRestart(info) {
    if (prompted) return;         // one popup per run, however many events
    prompted = true;
    const version = info && info.version ? String(info.version) : '';
    let choice = 1;               // no dialog, no restart
    if (dialog && typeof dialog.showMessageBox === 'function') {
      const options = {
        type: 'info',
        // Default to the restart: the thing a person wants when they have
        // already said yes to an update is for it to be done.
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'A new JARVIS is ready',
        message: version ? `JARVIS ${version} has been downloaded.` : 'An update has been downloaded.',
        detail: 'Restart to finish installing it. Choose Later and it installs the next time you quit.\n\nYour notes, settings and data are not touched: the update replaces the app.',
      };
      // Parented to the window when there is one, so the popup is in front of
      // the app rather than behind it or on another display. A window that has
      // already been closed is not a parent.
      const parent = parentWindow && typeof parentWindow.isDestroyed === 'function' && !parentWindow.isDestroyed() ? parentWindow : null;
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      choice = answer && typeof answer.response === 'number' ? answer.response : 1;
    }
    if (choice !== 0) {
      log.log('[nus] update downloaded; it will install on quit');
      return;
    }
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      fail(error);
    }
  }

  autoUpdater.on('error', fail);
  autoUpdater.on('update-available', (info) => {
    log.log('[nus] update available', info && info.version ? info.version : '');
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.log('[nus] update downloaded', info && info.version ? info.version : '');
    Promise.resolve(promptToRestart(info)).catch(fail);
  });

  let lastCheckedAt = 0;
  const check = () => {
    lastCheckedAt = now();
    return Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .catch(fail);
  };

  check();
  // A machine that stays open for days should not need a restart to hear about
  // a release. unref so the timer never keeps the process alive on its own.
  const timer = timers.setInterval(check, intervalMs);
  if (timer && timer.unref) timer.unref();

  return {
    started: true,
    check,
    lastCheckedAt: () => lastCheckedAt,
    stop: () => timers.clearInterval(timer),
  };
}

module.exports = { initAutoUpdate, HOUR };
