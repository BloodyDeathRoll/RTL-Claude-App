// Claude RTL Fix - patcher
// Usage: node patch.js [--claude-path /path/to/install] [--unpatch]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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

// Kill Claude so its process releases the lock on Claude.exe before we flip
// the fuse. Returns after a brief wait for the OS to release file handles.
async function killClaude() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', ['/F', '/IM', 'Claude.exe', '/T'],
      { stdio: 'pipe', windowsHide: true });
    await new Promise((r) => setTimeout(r, 1500));
  } catch (_) { /* not running — that's fine */ }
}

// Adds a Windows Defender exclusion for the given directory so the fuse-flip
// in Claude.exe isn't quarantined mid-write. Non-fatal: Defender may not be
// present (third-party AV, or a policy that blocks Add-MpPreference).
function addDefenderExclusion(dirPath) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-MpPreference -ExclusionPath '${dirPath}'`,
    ], { stdio: 'pipe', windowsHide: true });
  } catch (_) { /* non-fatal */ }
}

// Returns display names of non-Defender AV products visible to SecurityCenter2.
// Returns [] if the query fails (old Windows, WMI unavailable, etc.).
function detectThirdPartyAv() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct |' +
      ' Where-Object { $_.displayName -notmatch "Defender" } |' +
      ' Select-Object -ExpandProperty displayName',
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

// Build a micromatch glob for files that live in app.asar.unpacked (native
// modules etc.). These cannot be loaded from inside a packed asar, so they
// must stay unpacked when we repack. We derive the list from the existing
// .unpacked directory rather than parsing the asar header.
function buildUnpackGlob(asarPath) {
  const unpackedDir = asarPath + '.unpacked';
  if (!fs.existsSync(unpackedDir)) return null;
  const files = [];
  function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const relPath = rel ? rel + '/' + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, relPath);
      else files.push(relPath);
    }
  }
  walk(unpackedDir, '');
  if (!files.length) return null;
  // Escape glob metacharacters in each path so filenames containing , { } * ?
  // [ ] etc. are matched literally (and, inside the brace list, an embedded
  // comma doesn't split one file into two bogus alternatives). Without this an
  // unpacked native module with such a name would get packed INTO the asar and
  // fail to load at runtime.
  const esc = (s) => s.replace(/[\\,{}()!+@|*?[\]]/g, '\\$&');
  return files.length === 1
    ? esc(files[0])
    : '{' + files.map(esc).join(',') + '}';
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

const RTL_ENTRY   = 'rtl-fix-entry.js';
const RTL_HOOK    = 'rtl-fix-hook.js';
const RTL_PAYLOAD = 'rtl-fix-payload.js';
// Key stored in package.json that holds the original "main" value. Its
// presence also serves as the "already patched" marker.
const ORIG_MAIN_KEY = '__rtlFixOriginalMain';

function patchUnpackedTree(unpackedDir) {
  const pkgJsonPath = path.join(unpackedDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error('No package.json inside app.asar — unexpected structure.');
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  // Idempotent: if this tree is already patched (our marker is present, or main
  // already points at our entry shim), keep the previously-saved original main
  // instead of recording the entry shim as the "original". Recording the shim
  // would make a later --unpatch restore main → rtl-fix-entry.js, a file that
  // unpatch deletes, bricking the app.
  const alreadyHooked = (ORIG_MAIN_KEY in pkg) || pkg.main === RTL_ENTRY;
  const originalMain = alreadyHooked
    ? (pkg[ORIG_MAIN_KEY] || 'index.js')
    : (pkg.main || 'index.js');

  // Write our three payload files to the asar root.
  fs.writeFileSync(path.join(unpackedDir, RTL_ENTRY),   embedded.RTL_FIX_ENTRY_SOURCE);
  fs.writeFileSync(path.join(unpackedDir, RTL_HOOK),    embedded.RTL_FIX_HOOK_SOURCE);
  fs.writeFileSync(path.join(unpackedDir, RTL_PAYLOAD), embedded.RTL_FIX_PAYLOAD_SOURCE);

  // Redirect main → our entry shim, and save the original so we can restore.
  // We never touch Claude's own JS files, so its internal integrity checks pass.
  pkg[ORIG_MAIN_KEY] = originalMain;
  pkg.main = RTL_ENTRY;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));

  return { originalMain };
}

function unpatchUnpackedTree(unpackedDir) {
  const pkgJsonPath = path.join(unpackedDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  if (!pkg[ORIG_MAIN_KEY]) return { changed: false };

  // Restore the original main entry.
  pkg.main = pkg[ORIG_MAIN_KEY];
  delete pkg[ORIG_MAIN_KEY];
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));

  // Remove our injected files.
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
  return !!(pkg && pkg[ORIG_MAIN_KEY]);
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
  // When the version can't be parsed, fall back to a short hash of the full
  // asar path rather than a shared literal 'unknown' — otherwise two different
  // installs would collide on one backup file and a later --unpatch could
  // restore the wrong install's asar.
  const parsedVersion = (asarPath.match(/Claude_([\d.]+)_/i) || [])[1];
  const versionTag = parsedVersion ||
    ('unknown-' + require('crypto').createHash('sha1')
      .update(asarPath).digest('hex').slice(0, 8));
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
  const noFuseFlip = args.includes('--no-fuse-flip');
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

  // Locate the Electron binary (logged for diagnostics; only needed if fuse
  // flip is ever required in future).
  let binaryPath = null;
  try {
    const r = resolveElectronBinary(resources);
    binaryPath = r.binary;
    log(quiet, '[claude-rtl-fix] electron binary:', binaryPath);
  } catch (_) { /* non-fatal — we no longer modify the binary */ }

  // --unpatch: if we have the original backup, restore it directly — no repack
  // needed and no risk of structural changes to the asar.
  if (unpatch) {
    const backup = backupPath(asarPath, isMsix);
    if (fs.existsSync(backup)) {
      log(quiet, '[claude-rtl-fix] restoring from backup:', backup);
      async function restoreFromBackup() {
        fs.copyFileSync(backup, asarPath);
        log(quiet, '[claude-rtl-fix] restored original asar.');
      }
      if (isMsix && ACL) {
        ACL.takeOwnership(asarPath);
        try { await restoreFromBackup(); }
        finally { ACL.restoreOwnership(asarPath); }
      } else {
        await restoreFromBackup();
      }
      return;
    }
    log(quiet, '[claude-rtl-fix] no backup found, falling back to repack-based unpatch.');
  }

  // Warn about third-party AV when running interactively (not the watcher).
  // The installer handles this via its own dialog; here we cover direct .exe runs.
  if (!unpatch && !quiet && process.stdin.isTTY && process.stdout.isTTY) {
    const avList = detectThirdPartyAv();
    if (avList.length > 0) {
      console.warn(
        '\nWARNING: Third-party antivirus detected: ' + avList.join(', ') + '\n' +
        'Your antivirus may quarantine Claude.exe during patching, which will\n' +
        'prevent Claude from launching.\n\n' +
        'Before continuing, add an exclusion for:\n' +
        '  C:\\Program Files\\WindowsApps\n\n' +
        'Press Enter once the exclusion is added, or Ctrl+C to cancel.'
      );
      await new Promise((resolve) => {
        const rl = require('readline').createInterface({ input: process.stdin });
        rl.question('', () => { rl.close(); resolve(); });
      });
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
    const unpackGlob = buildUnpackGlob(asarPath);
    if (unpackGlob) {
      await asar.createPackageWithOptions(unpacked, asarPath, { unpack: unpackGlob });
      log(quiet, '[claude-rtl-fix] repacked', asarPath, '(preserved unpacked:', unpackGlob + ')');
    } else {
      await asar.createPackage(unpacked, asarPath);
      log(quiet, '[claude-rtl-fix] repacked', asarPath);
    }

    if (!unpatch) {
      if (isMsix) addDefenderExclusion('C:\\Program Files\\WindowsApps');
      if (noFuseFlip) {
        log(quiet, '[claude-rtl-fix] skipping fuse flip (--no-fuse-flip).');
      } else {
        // Kill Claude to release its lock on Claude.exe before the fuse flip.
        await killClaude();
        // Retry on EBUSY — the OS may hold the file handle briefly after kill.
        let r;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            r = await ensureIntegrityDisabled(resources, { verbose: !quiet });
            break;
          } catch (e) {
            if (e.code !== 'EBUSY' || attempt === 3) throw e;
            log(quiet, '[claude-rtl-fix] Claude.exe busy, retrying fuse flip...');
            await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
          }
        }
        if (r.changed) log(quiet, '[claude-rtl-fix] integrity bypass applied.');
        else log(quiet, '[claude-rtl-fix] integrity bypass not needed (' + r.reason + ').');
      }
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

  // After a successful patch (not unpatch, not watcher), relaunch Claude so
  // the user can immediately see the fix without a manual restart.
  if (!unpatch && !quiet) {
    launchClaude(isMsix, binaryPath);
  }
}

function launchClaude(isMsix, binaryPath) {
  const { spawn } = require('child_process');
  if (process.platform === 'darwin') {
    try {
      spawn('open', ['-a', 'Claude'], { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    if (isMsix) {
      const familyName = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1).PackageFamilyName',
      ], { encoding: 'utf8', windowsHide: true }).trim();
      if (!familyName) return;
      spawn('explorer.exe', [`shell:AppsFolder\\${familyName}!Claude`],
        { detached: true, stdio: 'ignore' }).unref();
    } else if (binaryPath) {
      spawn(binaryPath, [], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) { /* non-fatal */ }
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
