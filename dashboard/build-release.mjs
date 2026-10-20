// Builds release.json: the SHA256 of every served asset plus a version stamp.
// The dashboard refuses to start when a served file no longer matches, so this
// must run after every edit to public/.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_META } from './nav.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const assets = {
  'assets/app.css': 'public/assets/app.css',
  'assets/app.js': 'public/assets/app.js',
  'assets/accounts.js': 'public/assets/accounts.js',
  'assets/shell.js': 'public/assets/shell.js',
  'assets/usage.js': 'public/assets/usage.js',
  'assets/models.js': 'public/assets/models.js',
  'assets/logs.js': 'public/assets/logs.js',
  'assets/keys.js': 'public/assets/keys.js',
};
// Every page listed in the navigation must be hashed, so adding a page cannot
// silently ship an unverified file.
const files = {
  ...Object.fromEntries(Object.values(PAGE_META).map(meta => [meta.file, 'public/' + meta.file])),
  ...assets,
};

const hashes = {};
for (const [name, relative] of Object.entries(files)) {
  hashes[name] = createHash('sha256').update(await readFile(join(ROOT, relative))).digest('hex');
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const version = stamp + '-' + createHash('sha256').update(JSON.stringify(hashes)).digest('hex').slice(0, 8);

const release = { version, builtAt: new Date().toISOString(), files: hashes };
await writeFile(join(ROOT, 'release.json'), JSON.stringify(release, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ event: 'release_built', version, files: Object.keys(hashes) }));
