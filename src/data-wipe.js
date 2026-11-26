// Wipes every byte the app keeps about this person. Called by Settings >
// Erase all data, right before the process exits and relaunches blank; the
// quit guard skips its final flush so none of it is recreated.
'use strict';

const fs = require('fs');
const path = require('path');

function wipeEverything(userDataDir) {
  // Directories and files, best effort each; a locked file must not abort
  // the rest of the wipe.
  for (const entry of ['data', 'snapshots', 'secrets', 'companion']) {
    try { fs.rmSync(path.join(userDataDir, entry), { recursive: true, force: true }); } catch { /* relaunch starts blank anyway */ }
  }
  for (const entry of ['settings.json', 'companion-settings.json', 'context.json', 'ai-errors.log']) {
    try { fs.rmSync(path.join(userDataDir, entry), { force: true }); } catch { /* best effort */ }
  }
}

module.exports = { wipeEverything };
