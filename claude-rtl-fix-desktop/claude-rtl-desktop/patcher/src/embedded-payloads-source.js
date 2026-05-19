// Source-mode shim used when running the patcher from a checkout (not bundled).
// Reads payload sources from disk so dev edits to payload/*.js don't require
// a rebuild step.
'use strict';

const fs = require('fs');
const path = require('path');

const PAYLOAD_DIR = path.join(__dirname, 'payload');

module.exports = {
  RTL_FIX_ENTRY_SOURCE:   fs.readFileSync(path.join(PAYLOAD_DIR, 'rtl-fix-entry.js'),   'utf8'),
  RTL_FIX_HOOK_SOURCE:    fs.readFileSync(path.join(PAYLOAD_DIR, 'rtl-fix-hook.js'),    'utf8'),
  RTL_FIX_PAYLOAD_SOURCE: fs.readFileSync(path.join(PAYLOAD_DIR, 'rtl-fix-payload.js'), 'utf8'),
};
