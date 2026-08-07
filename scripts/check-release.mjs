/**
 * Refuse to publish when the tag, `package.json` and `CHANGELOG.md` disagree.
 *
 *   node scripts/check-release.mjs v0.2.0
 *   node scripts/check-release.mjs v0.2.0 --notes release-notes.md
 *
 * The three are independent records of one fact, and the Marketplace has no undo:
 * a version, once published, cannot be replaced or withdrawn, only superseded. So
 * the guard runs before anything is packaged, and names which of the three is out
 * of step rather than just failing.
 *
 * `--notes` writes the changelog section for this version to a file, for
 * `gh release create --notes-file`. It lives here rather than in a second script
 * because the parse it needs is the parse the check already did, and two parsers
 * of one file drift.
 *
 * Falls back to `GITHUB_REF_NAME`, which on a tag push is the tag, so the workflow
 * step needs no argument.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const args = process.argv.slice(2);
const notesTo = args[args.indexOf('--notes') + 1 || -1];
const tag = args.find((arg) => !arg.startsWith('--') && arg !== notesTo) ?? process.env.GITHUB_REF_NAME ?? '';
// Not a full semver grammar: this repo tags releases, not prereleases, and a
// pattern that accepts more than the project uses is a guard that checks less.
const tagged = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!tagged) {
  fail(`tag ${tag || '(none)'} is not of the form v1.2.3`);
}

const version = tagged[1];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== version) {
  problems.push(`package.json says ${manifest.version}, the tag says ${version}`);
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const headings = [...changelog.matchAll(/^## \[([^\]]+)\](.*)$/gm)];

/**
 * Everything between the Unreleased heading and whatever heading follows it. An
 * Unreleased section that still has entries in it means those changes are in the
 * build and not in the notes, which is the failure this catches: the release goes
 * out documenting less than it contains, and nobody notices until the next one.
 */
const unreleased = headings.findIndex((h) => h[1].toLowerCase() === 'unreleased');
if (unreleased >= 0) {
  const from = headings[unreleased].index + headings[unreleased][0].length;
  const to = headings[unreleased + 1]?.index ?? changelog.length;
  const body = changelog.slice(from, to).trim();
  if (body !== '') {
    problems.push(`CHANGELOG.md has entries under [Unreleased] that ${version} would ship undocumented:\n    ${body.split('\n').join('\n    ')}`);
  }
}

const released = headings.filter((h) => h[1].toLowerCase() !== 'unreleased');
const top = released[0];
if (!top) {
  problems.push('CHANGELOG.md has no released version heading');
} else if (top[1] !== version) {
  problems.push(`CHANGELOG.md's newest entry is ${top[1]}, the tag says ${version}`);
} else if (!/^\s*-\s*\d{4}-\d{2}-\d{2}\s*$/.test(top[2])) {
  // The date is what makes the entry a record rather than a plan, and it is the
  // field a copy-pasted heading forgets.
  problems.push(`CHANGELOG.md's ${version} heading has no "- YYYY-MM-DD" date`);
}

if (problems.length > 0) {
  fail(problems.join('\n  '));
}
console.log(`release ${tag} is consistent: package.json, CHANGELOG.md and the tag all say ${version}`);

if (notesTo) {
  // From just after this version's heading to whichever comes first: the previous
  // release's heading, or the block of link reference definitions at the bottom.
  // The oldest entry in the file has no heading after it, and without the second
  // stop its notes would end with `[0.1.0]: https://...`.
  const from = top.index + top[0].length;
  const nextHeading = headings.find((h) => h.index > top.index)?.index;
  const linkBlock = /^\[[^\]]+\]:\s/m.exec(changelog.slice(from));
  const ends = [nextHeading, linkBlock ? from + linkBlock.index : undefined, changelog.length];
  const body = changelog.slice(from, Math.min(...ends.filter((e) => e !== undefined))).trim();
  fs.writeFileSync(notesTo, `${body}\n`);
  console.log(`wrote ${body.split('\n').length} lines of notes to ${notesTo}`);
}

function fail(message) {
  console.error(`check-release: refusing to publish\n  ${message}`);
  process.exit(1);
}
