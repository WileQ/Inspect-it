// Grouped/project analyses for relationship + dependency fixtures.
// Builds real folder items (like a multi-drop) and runs the real folder
// analyzer, capturing cross-file relationships/findings to a JSON file.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeItem } from '../../src/shared/analyzers.ts';
import { writeFileSync } from 'node:fs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'adversarial-fixtures-corpus', 'adversarial-fixtures'));
function fileItem(rel) {
  const full = path.join(root, rel); const bytes = readFileSync(full); const st = statSync(full);
  const file = new File([bytes], path.basename(rel), { type: 'application/octet-stream', lastModified: Math.round(st.mtimeMs) });
  return { kind: 'file', name: path.basename(rel), path: rel, size: file.size, lastModified: file.lastModified, mimeType: 'application/octet-stream', file };
}
function dirFolder(rel) {
  const children = readdirSync(path.join(root, rel), { withFileTypes: true }).map((e) => {
    const cr = `${rel}/${e.name}`;
    try { return e.isFile() ? fileItem(cr) : dirFolder(cr); } catch { return null; }
  }).filter(Boolean);
  return { kind: 'folder', name: path.basename(rel), path: rel, children };
}
const groups = {
  'multi-duplicate': ['relationships/dup_folder_a','relationships/dup_folder_b','relationships/dup_folder_c'],
  'near_dup_text': ['relationships/near_dup_text'],
  'similar_images': ['relationships/similar_images'],
  'cross_reference': ['relationships/cross_reference'],
  'conflicting_deps': ['relationships/conflicting_deps_folder'],
  'same_name_diff_content': ['relationships/same_name_diff_content'],
  'same_size_diff_content': ['relationships/same_size_diff_content'],
  'should_not_link': ['relationships/should_not_link'],
  'images_dir': ['images']
};
const out = {};
for (const [name, rels] of Object.entries(groups)) {
  const children = rels.map(dirFolder);
  const item = children.length === 1 ? children[0] : { kind: 'folder', name: name, path: `selection://${name}`, children };
  try {
    const r = await analyzeItem(item, { signal: new AbortController().signal });
    out[name] = {
      analyzer: r.analyzerId,
      relationships: (r.relationships || []).map((x) => ({ type: x.type, label: x.label, objects: x.objects, detail: String(x.detail||'').slice(0,160) })),
      findings: [...(r.unusual||[]), ...(r.important||[])].map((f) => ({ id: f.id, title: f.title, severity: f.severity, methodology: f.methodology || null }))
    };
  } catch (e) { out[name] = { error: String(e && e.message || e) }; }
}
writeFileSync(path.join(here, 'grouped-relationships.json'), JSON.stringify(out, null, 1), 'utf8');
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
