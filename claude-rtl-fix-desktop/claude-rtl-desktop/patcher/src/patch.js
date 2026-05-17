// Claude RTL Fix - patcher
// Usage: node patch.js [--claude-path /path/to/install] [--unpatch]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');
const { ensureIntegrityDisabled, resolveElectronBinary } = require('./integrity');

// Embedded payload sources. The 'embedded-payloads' specifier resolves to:
//   - in source mode: ./embedded-payloads-source.js (a thin shim that fs-reads
//     the on-disk payload files, so dev edits don't require a rebuild)
//   - in bundle mode: ../dist/embedded-payloads.js (string constants)
// The build script wires the alias at bundle time.
const embedded = (() => {
  try {
    // eslint-disable-next-line node/no-missing-require
    return require('embedded-payloads');
  } catch (_) {
    return require('./embedded-payloads-source');
  }
})();

// ----- locate Claude install ----------------------------------------------

function findMsixInstall() {
  // Anthropic ships Claude as an MSIX package now (publisher hash
  // pzs8sxrjxfjjc). Ask Windows where it is rather than guessing paths.
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-AppxPackage -Name Claude | ' +
        'Sort-Object Version -Descending | ' +
        'Select-Object -First 1).InstallLocation',
      ],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    if (out && fs.existsSync(out)) {
      const resources = path.join(out, 'app', 'resources');
      if (fs.existsSync(path.join(resources, 'app.asar'))) {
        return resources;
      }
    }
  } catch (_) {
    // PowerShell missing / Get-AppxPackage failed / etc.
  }
  return null;
}

function defaultClaudePaths() {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') {
    return [
      '/Applications/Claude.app/Contents/Resources',
      path.join(home, 'Applications/Claude.app/Contents/Resources'),
    ];
  }
  if (platform === 'win32') {
    const out = [];
    // Try MSIX first (current Anthropic distribution).
    const msix = findMsixInstall();
    if (msix) out.push(msix);
    // Legacy Squirrel layout.
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const root = path.join(localAppData, 'AnthropicClaude');
    if (fs.existsSync(root)) {
      const appDirs = fs.readdirSync(root)
        .filter((n) => n.startsWith('app-'))
        .map((n) => path.join(root, n, 'resources'))
        .filter((p) => fs.existsSync(path.join(p, 'app.asar')))
        .sort();
      if (appDirs.length) out.push(appDirs[appDirs.length - 1]);
    }
    return out;
  }
  if (platform === 'linux') {
    return [
      '/opt/Claude/resources',
      '/usr/lib/claude/resources',
      path.join(home, '.local/share/Claude/resources'),
    ];
  }
  return [];
}

function isMsixInstall(resources) {
  // MSIX installs live under C:\Program Files\WindowsApps\Claude_*
  return process.platform === 'win32' &&
    /\\WindowsApps\\Claude[^\\]*\\app\\resources$/i.test(resources);
}

function findClaude(explicit) {
  const candidates = explicit ? [explicit] : defaultClaudePaths();
  for (const dir of candidates) {
    const asarPath = path.join(dir, 'app.asar');
    if (fs.existsSync(asarPath)) {
      return { resources: dir, asar: asarPath, isMsix: isMsixInstall(dir) };
    }
  }
  throw new Error(
    'Could not find Claude install. Tried:\n  ' + candidates.join('\n  ')
  );
}

// ----- patching -----------------------------------------------------------

const RTL_ENTRY = 'rtl-fix-entry.js';
const RTL_HOOK = 'rtl-fix-hook.js';
const RTL_PAYLOAD = 'rtl-fix-payload.js';
const ORIG_MAIN_KEY = '__rtlFixOriginalMain';

function patchUnpackedTree(unpackedDir) {
  const pkgJsonPath = path.join(unpackedDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error('No package.json inside app.asar — unexpected structure.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  const currentMain = pkg.main || 'index.js';
  const alreadyPatched = currentMain === RTL_ENTRY && pkg[ORIG_MAIN_KEY];

  // Resolve where the original main actually lives. Electron resolves "main"
  // relative to package.json with normal node resolution; cover the common case.
  const originalMain = alreadyPatched ? pkg[ORIG_MAIN_KEY] : currentMain;

  // Sanity-check original main exists
  const probePaths = [
    path.join(unpackedDir, originalMain),
    path.join(unpackedDir, originalMain + '.js'),
    path.join(unpackedDir, originalMain, 'index.js'),
  ];
  if (!probePaths.some((p) => fs.existsSync(p))) {
    throw new Error(
      `Original main "${originalMain}" not found inside asar. ` +
        `Refusing to patch. Resolved candidates:\n  ` + probePaths.join('\n  ')
    );
  }

  // Write our payload + hook into the app root.
  // Sources come from the embedded module so the patcher works both as a
  // source checkout and as a bundled single-file binary.
  fs.writeFileSync(path.join(unpackedDir, RTL_PAYLOAD), embedded.RTL_FIX_PAYLOAD_SOURCE);
  fs.writeFileSync(path.join(unpackedDir, RTL_HOOK),    embedded.RTL_FIX_HOOK_SOURCE);

  // Write the entry shim
  const entryContent =
    '// Injected by claude-rtl-fix. Do not edit.\n' +
    "try { require('./" + RTL_HOOK + "'); } catch (e) { console.error('[claude-rtl-fix]', e); }\n" +
    'module.exports = require(' + JSON.stringify('./' + originalMain) + ');\n';
  fs.writeFileSync(path.join(unpackedDir, RTL_ENTRY), entryContent);

  // Update package.json (idempotent)
  pkg[ORIG_MAIN_KEY] = originalMain;
  pkg.main = RTL_ENTRY;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));

  return { originalMain };
}

function unpatchUnpackedTree(unpackedDir) {
  const pkgJsonPath = path.join(unpackedDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  if (!pkg[ORIG_MAIN_KEY]) {
    return { changed: false };
  }
  pkg.main = pkg[ORIG_MAIN_KEY];
  delete pkg[ORIG_MAIN_KEY];
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
  for (const f of [RTL_ENTRY, RTL_HOOK, RTL_PAYLOAD]) {
    const p = path.join(unpackedDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { changed: true };
}

// ----- main ---------------------------------------------------------------

const ACL = process.platform === 'win32' ? require('./windows-acl') : null;

function readPkgJsonFromAsar(asarPath) {
  try {
    const buf = asar.extractFile(asarPath, 'package.json');
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

function alreadyPatched(asarPath) {
  const pkg = readPkgJsonFromAsar(asarPath);
  return !!(pkg && pkg.main === RTL_ENTRY && pkg[ORIG_MAIN_KEY]);
}

function backupPath(asarPath, isMsix) {
  if (!isMsix) return asarPath + '.rtlbak';
  // On Windows MSIX we don't want to drop random files inside WindowsApps —
  // it's not ours and may upset Windows. Keep backups in our managed area.
  const root = path.join(
    process.env.ProgramData || 'C:\\ProgramData',
    'ClaudeRTLFix',
    'backups'
  );
  fs.mkdirSync(root, { recursive: true });
  // Include a fragment of the version dir so we know which Claude this was.
  const versionTag = (asarPath.match(/Claude_([\d.]+)_/i) || [])[1] || 'unknown';
  return path.join(root, 'app.asar.' + versionTag + '.rtlbak');
}

// When --quiet is set, console output is suppressed but we still want to log
// runs so we can debug. Append to C:\ProgramData\ClaudeRTLFix\log.txt on
// Windows, /var/log/claude-rtl-fix.log on Unix (creating the parent dir if
// needed). Truncate if the file grows past ~1 MB.
let logFh = null;
function openLog() {
  if (logFh !== null) return;
  try {
    let logDir;
    if (process.platform === 'win32') {
      logDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeRTLFix');
    } else {
      // user-level log dir works without root; only the watcher needs root,
      // and root can write here too.
      logDir = path.join(os.homedir(), '.local', 'state', 'claude-rtl-fix');
    }
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'log.txt');
    // crude rotation: if >1MB, truncate
    try {
      if (fs.statSync(logPath).size > 1024 * 1024) fs.unlinkSync(logPath);
    } catch (_) {}
    logFh = fs.openSync(logPath, 'a');
  } catch (_) {
    logFh = -1; // mark as broken, don't retry
  }
}

function log(quiet, ...args) {
  if (!quiet) {
    console.log(...args);
    return;
  }
  openLog();
  if (logFh && logFh !== -1) {
    const stamp = new Date().toISOString();
    const line = `[${stamp}] ${args.join(' ')}\n`;
    try { fs.writeSync(logFh, line); } catch (_) {}
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unpatch = args.includes('--unpatch');
  const quiet = args.includes('--quiet');
  const ci = args.indexOf('--claude-path');
  const explicit = ci >= 0 ? args[ci + 1] : null;

  let target;
  try {
    target = findClaude(explicit);
  } catch (e) {
    if (quiet) {
      // Watcher mode: Claude may not be installed, that's fine.
      return;
    }
    throw e;
  }
  const { resources, asar: asarPath, isMsix } = target;
  log(quiet, '[claude-rtl-fix] target:', asarPath, isMsix ? '(MSIX)' : '');

  // Fast path: already patched? Bail. This is the common case for the watcher.
  if (!unpatch && alreadyPatched(asarPath)) {
    log(quiet, '[claude-rtl-fix] already patched, nothing to do.');
    return;
  }

  // Pre-flight: confirm we can also locate the Electron binary.
  let binaryPath = null;
  if (!unpatch) {
    try {
      const r = resolveElectronBinary(resources);
      binaryPath = r.binary;
      log(quiet, '[claude-rtl-fix] electron binary:', binaryPath);
    } catch (e) {
      throw new Error('pre-flight failed: ' + e.message);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rtl-fix-'));
  const unpacked = path.join(tmp, 'app');
  asar.extractAll(asarPath, unpacked);
  log(quiet, '[claude-rtl-fix] extracted to', unpacked);

  if (unpatch) {
    const r = unpatchUnpackedTree(unpacked);
    if (!r.changed) {
      log(quiet, '[claude-rtl-fix] not patched, nothing to do.');
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    }
    log(quiet, '[claude-rtl-fix] removed patch.');
  } else {
    const r = patchUnpackedTree(unpacked);
    log(quiet, '[claude-rtl-fix] hooked. original main was:', r.originalMain);
  }

  // The write phase — touches files inside WindowsApps when on MSIX.
  async function writePhase() {
    const backup = backupPath(asarPath, isMsix);
    if (!fs.existsSync(backup) && fs.existsSync(asarPath)) {
      fs.copyFileSync(asarPath, backup);
      log(quiet, '[claude-rtl-fix] backed up original asar →', backup);
    }
    await asar.createPackage(unpacked, asarPath);
    log(quiet, '[claude-rtl-fix] repacked', asarPath);

    if (!unpatch) {
      const r = await ensureIntegrityDisabled(resources, { verbose: !quiet });
      if (r.changed) log(quiet, '[claude-rtl-fix] integrity bypass applied.');
      else log(quiet, '[claude-rtl-fix] integrity bypass not needed (' + r.reason + ').');
    }
  }

  try {
    if (isMsix && ACL) {
      // Take ownership of both files we touch. We don't need the whole
      // directory, just the asar and the binary.
      ACL.takeOwnership(asarPath);
      try {
        if (binaryPath) ACL.takeOwnership(binaryPath);
        try {
          await writePhase();
        } finally {
          if (binaryPath) ACL.restoreOwnership(binaryPath);
        }
      } finally {
        ACL.restoreOwnership(asarPath);
      }
    } else {
      await writePhase();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  log(quiet, '[claude-rtl-fix] done.');
}

main().catch((e) => {
  const msg = '[claude-rtl-fix] FAILED: ' + (e && e.message ? e.message : String(e));
  if (process.argv.includes('--quiet')) {
    // Write the failure to the log even in quiet mode.
    openLog();
    if (logFh && logFh !== -1) {
      try {
        fs.writeSync(logFh, `[${new Date().toISOString()}] ${msg}\n${e && e.stack ? e.stack + '\n' : ''}`);
      } catch (_) {}
    }
  } else {
    console.error(msg);
  }
  process.exit(1);
});
