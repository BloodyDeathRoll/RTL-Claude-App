// Claude RTL Fix - Windows ACL helpers.
//
// Files under C:\Program Files\WindowsApps are owned by TrustedInstaller with
// restrictive ACLs. To modify app.asar / claude.exe we have to:
//   1. takeown   -> change ownership to Administrators
//   2. icacls    -> grant Administrators full control
//   3. ... modify ...
//   4. icacls    -> restore TrustedInstaller ownership and remove our grant
//
// This file abstracts that, idempotently and reversibly.

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  });
}

function takeOwnership(target) {
  // /F target  /A grant to administrators group rather than current user.
  // /R recursive if directory.
  const isDir = require('fs').statSync(target).isDirectory();
  const args = ['/F', target, '/A'];
  if (isDir) args.push('/R', '/D', 'Y');
  try {
    run('takeown.exe', args);
  } catch (e) {
    throw new Error('takeown failed for ' + target + ': ' + (e.stderr || e.message));
  }

  const grantArgs = [target, '/grant', 'Administrators:F', '/C'];
  if (isDir) grantArgs.splice(1, 0, '/T'); // recurse
  try {
    run('icacls.exe', grantArgs);
  } catch (e) {
    throw new Error('icacls grant failed for ' + target + ': ' + (e.stderr || e.message));
  }
}

function restoreOwnership(target) {
  // Be a good citizen: hand ownership back to TrustedInstaller. If this fails
  // it's not fatal — the file is still under WindowsApps and the next MSIX
  // update will replace the directory entirely. We log a warning instead.
  try {
    run('icacls.exe', [target, '/setowner', 'NT SERVICE\\TrustedInstaller', '/T', '/C']);
  } catch (e) {
    console.warn('[acl] could not restore ownership of', target, '-', (e.stderr || e.message).trim());
  }
}

// Convenience: do {work} with ownership taken on `target`, then restore.
// `work` is an async function. ALWAYS restores ownership, even on throw.
async function withOwnership(target, work) {
  takeOwnership(target);
  try {
    return await work();
  } finally {
    restoreOwnership(target);
  }
}

module.exports = { takeOwnership, restoreOwnership, withOwnership };
