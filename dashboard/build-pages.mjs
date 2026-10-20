// Expands dashboard/pages/*.html into full documents in dashboard/public/.
// Run before build-release.mjs; the release gate hashes the generated files, so
// an edited fragment cannot reach the browser without a rebuild.
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_META } from './nav.mjs';
import { renderDocument } from './layout.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

for (const route of Object.keys(PAGE_META)) {
  const meta = PAGE_META[route];
  const fragment = await readFile(join(ROOT, 'pages', meta.fragment), 'utf8');
  const document = renderDocument(route, fragment.trimEnd());
  await writeFile(join(ROOT, 'public', meta.file), document, 'utf8');
  console.log(JSON.stringify({ event: 'page_built', route, file: meta.file, bytes: Buffer.byteLength(document) }));
}
