// Claude RTL Fix - integrity bypass.
//
// After we modify app.asar, two things can stop Claude from launching:
//
//   1. Electron's embedded asar integrity check (compares a hash baked into
//      the binary against the asar header). We turn it off by flipping the
//      EnableEmbeddedAsarIntegrityValidation fuse in the Electron binary.
//
//   2. macOS code signature — flipping fuses modifies the binary, which
//      invalidates the signature. We re-sign ad-hoc; that's enough for
//      Gatekeeper as long as the app was already approved on this Mac.
//
// On Windows, modifying Claude.exe doesn't trip anything as long as the user
// isn't running with strict SmartScreen / WDAC policies (uncommon on personal
// machines). No re-sign needed in practice.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  flipFuses,
  getCurrentFuseWire,
  FuseVersion,
  FuseV1Options,
  FuseState,
} = require('@electron/fuses');

// Resolve the actual Electron binary inside a Claude install.
// `resources` is the path containing app.asar.
function resolveElectronBinary(resources) {
  const platform = process.platform;

  if (platform === 'darwin') {
    // resources is .../Claude.app/Contents/Resources
    // Electron binary is .../Claude.app/Contents/MacOS/Claude
    // We can also just pass the .app path — flipFuses handles it — but
    // passing the binary directly is more deterministic.
    const appBundle = path.resolve(resources, '..', '..');
    const binary = path.join(appBundle, 'Contents', 'MacOS', 'Claude');
    if (!fs.existsSync(binary)) {
      throw new Error('Could not find Claude Mach-O binary at ' + binary);
    }
    return { binary, appBundle };
  }

  if (platform === 'win32') {
    // resources is ...\app-<version>\resources
    // The Electron binary is ...\app-<version>\Claude.exe (sibling of resources)
    const appDir = path.resolve(resources, '..');
    const binary = path.join(appDir, 'Claude.exe');
    if (!fs.existsSync(binary)) {
      throw new Error('Could not find Claude.exe at ' + binary);
    }
    return { binary, appBundle: null };
  }

  if (platform === 'linux') {
    // .../Claude/resources/  → .../Claude/claude (lowercase) or .../Claude/Claude
    const appDir = path.resolve(resources, '..');
    for (const name of ['claude', 'Claude']) {
      const binary = path.join(appDir, name);
      if (fs.existsSync(binary)) return { binary, appBundle: null };
    }
    throw new Error('Could not find Claude binary in ' + appDir);
  }

  throw new Error('Unsupported platform: ' + platform);
}

async function ensureIntegrityDisabled(resources, opts = {}) {
  const { binary, appBundle } = resolveElectronBinary(resources);
  const verbose = !!opts.verbose;

  let wire;
  try {
    wire = await getCurrentFuseWire(binary);
  } catch (e) {
    // Older Electron without fuses, or non-fuse-enabled binary. Nothing to do.
    if (verbose) console.log('[integrity] no fuse wire found:', e.message);
    return { changed: false, reason: 'no-fuse-wire' };
  }

  const integrityState = wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation];
  if (verbose) {
    console.log('[integrity] EnableEmbeddedAsarIntegrityValidation =',
      integrityState === FuseState.ENABLE ? 'ENABLE' :
      integrityState === FuseState.DISABLE ? 'DISABLE' :
      integrityState === FuseState.REMOVED ? 'REMOVED' :
      integrityState === FuseState.INHERIT ? 'INHERIT' : integrityState);
  }

  if (integrityState !== FuseState.ENABLE) {
    return { changed: false, reason: 'already-disabled' };
  }

  await flipFuses(binary, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  });

  if (verbose) console.log('[integrity] fuse flipped off in', binary);

  // macOS: re-sign the now-modified bundle ad-hoc so Gatekeeper accepts launch.
  if (process.platform === 'darwin' && appBundle) {
    try {
      execFileSync(
        'codesign',
        ['--force', '--deep', '--sign', '-', appBundle],
        { stdio: verbose ? 'inherit' : 'pipe' }
      );
      if (verbose) console.log('[integrity] re-signed', appBundle, 'ad-hoc');
    } catch (e) {
      throw new Error(
        'codesign re-sign failed. Output:\n' +
          (e.stderr ? e.stderr.toString() : e.message)
      );
    }
  }

  return { changed: true, reason: 'flipped' };
}

module.exports = { ensureIntegrityDisabled, resolveElectronBinary };
