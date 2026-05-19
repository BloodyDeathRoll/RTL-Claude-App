// Claude RTL Fix - entry shim.
// package.json "main" is rewritten to point here by the patcher.
// Loads the RTL hook first, then hands off to Claude's original entry.
'use strict';
require('./rtl-fix-hook');
const pkg = require('./package.json');
require('./' + pkg.__rtlFixOriginalMain.replace(/^\.\//, ''));
