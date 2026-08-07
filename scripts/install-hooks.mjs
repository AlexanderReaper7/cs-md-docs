/**
 * Point this clone's git hooks at the tracked `.githooks` directory.
 *
 * `.git/hooks` is not versioned and does not survive a clone, so the hooks live
 * in `.githooks` and `core.hooksPath` is redirected at them. The hook is then
 * reviewed in a diff like any other file, and a fresh clone is one `npm install`
 * away from having it.
 *
 * Node rather than PowerShell, even though the hook it installs calls a .ps1:
 * this runs from npm's `prepare`, and npm guarantees node is present in a way it
 * does not guarantee pwsh. A machine without pwsh should still be able to
 * `npm install` and get a hook that declines to run.
 *
 * Every failure is non-fatal and reported. A tarball with no `.git`, a missing
 * git, or a `core.hooksPath` someone set deliberately must not break an install.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Trimmed stdout, or undefined if git failed for any reason. */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

if (git('rev-parse', '--git-dir') === undefined) {
  console.log('git hooks: not a git checkout, skipped');
} else {
  const current = git('config', '--local', 'core.hooksPath');
  if (current === '.githooks') {
    // Already ours. Silent, because this runs on every npm install.
  } else if (current) {
    // Someone chose a different directory. Overwriting it is not this script's
    // call to make, and a silent overwrite would be worse than saying nothing.
    console.log(`git hooks: core.hooksPath is already "${current}", left alone`);
  } else if (git('config', '--local', 'core.hooksPath', '.githooks') === undefined) {
    console.log('git hooks: could not set core.hooksPath, skipped');
  } else {
    console.log('git hooks: core.hooksPath -> .githooks (post-commit deploys the extension)');
  }
}
