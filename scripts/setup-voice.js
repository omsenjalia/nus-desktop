// Downloads the whisper.cpp Windows binary and the base English model for local voice.
// Usage: npm run setup:voice [-- --small]
//
// The implementation lives in src/whisper-setup.js (the app downloads its own
// voice engine at runtime the same way); this wrapper exists for the npm
// script and keeps `setup.*` importable for the tests, which run on Linux
// where the binary never would.
'use strict';

const setup = require('../src/whisper-setup');

module.exports = setup;

if (require.main === module) {
  setup.main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
