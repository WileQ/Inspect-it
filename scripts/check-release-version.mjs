// Release guard: the git tag and package.json version must agree.
//
// package.json is the single source of truth for the version (it is baked into
// the renderer at build time and into electron-builder artifact names). CI runs
// this before building installers from a `v*` tag, so a tag like v1.0.1 can
// never silently produce 1.0.0 artifacts again.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tag = (process.argv[2] ?? '').trim();
const tagVersion = tag.replace(/^v/i, '');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!tag) {
  console.error('[release] No tag argument provided. Usage: node scripts/check-release-version.mjs <tag>');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(tagVersion)) {
  console.error(`[release] Tag "${tag}" is not a valid semver tag (expected v1.2.3).`);
  process.exit(1);
}
if (pkg.version !== tagVersion) {
  console.error(
    `[release] Version mismatch: tag is ${tag} but package.json version is ${pkg.version}. ` +
      `Bump package.json to ${tagVersion}, commit, then push the tag again. ` +
      'See docs/RELEASING.md for the release flow.'
  );
  process.exit(1);
}
console.log(`[release] Tag ${tag} matches package.json version ${pkg.version}.`);
