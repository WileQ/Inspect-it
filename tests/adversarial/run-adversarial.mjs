// Adversarial corpus runner for Inspect It.
//
// Drives the REAL analysis pipeline (src/shared/analyzers.ts analyzeItem) over
// every fixture in the adversarial corpus manifest, in an isolated manner:
//   - fixtures are read only, never executed, never extracted to disk
//   - per-fixture timeout via AbortController + Promise.race (a hung fixture is
//     recorded as timed_out and the run continues)
//   - read-only verification (size/mtime/sha256 before == after)
//   - incremental JSONL results so a hard kill never loses prior findings
//
// Usage (must match npm test module flags):
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//        tests/adversarial/run-adversarial.mjs [corpusRoot] [outDir]
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeItem } from '../../src/shared/analyzers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'adversarial-fixtures-corpus', 'adversarial-fixtures'));
const outDir = path.resolve(process.argv[3] ?? here);
const resultsPath = path.join(outDir, 'results.jsonl');
const FILE_TIMEOUT_MS = 30000;
const DIR_TIMEOUT_MS = 180000;

const MIME_BY_EXT = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', jsonl: 'application/jsonl',
  csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain', ini: 'text/plain',
  yml: 'text/yaml', yaml: 'text/yaml', xml: 'text/xml', html: 'text/html', htm: 'text/html',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', gzip: 'application/gzip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', sqlite: 'application/vnd.sqlite3', db: 'application/vnd.sqlite3',
  py: 'text/x-python', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  ts: 'text/typescript', tsx: 'text/typescript', rs: 'text/rust', go: 'text/x-go', java: 'text/x-java',
  c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c', cs: 'text/x-csharp', php: 'text/x-php', rb: 'text/x-ruby',
  swift: 'text/x-swift', kt: 'text/x-kotlin', sh: 'text/x-shellscript', bat: 'text/x-bat', ps1: 'text/x-powershell',
  sql: 'text/x-sql', css: 'text/css', eml: 'message/rfc822', epub: 'application/epub+zip', bin: 'application/octet-stream'
};

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function mimeFor(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function loadManifest() {
  const raw = JSON.parse(readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
  const entries = [];
  for (const [category, info] of Object.entries(raw.categories)) {
    for (const f of info.fixtures) {
      entries.push({ category, path: f.path, is_dir: Boolean(f.is_dir), description: f.description || '',
        expected_behavior: f.expected_behavior || '', finding_type: f.finding_type || 'NONE',
        graceful_failure_expected: Boolean(f.graceful_failure_expected),
        security_property: f.security_property || '', size_bytes: f.size_bytes, sha256: f.sha256 || '' });
    }
  }
  return entries;
}

function fileItem(rel) {
  const full = path.join(corpusRoot, rel);
  const bytes = readFileSync(full);
  const st = statSync(full);
  const file = new File([bytes], path.basename(rel), { type: mimeFor(rel), lastModified: Math.round(st.mtimeMs) });
  return {
    kind: 'file', name: path.basename(rel), path: rel, size: file.size,
    lastModified: file.lastModified, mimeType: mimeFor(rel), file
  };
}

function folderItem(rel) {
  const full = path.join(corpusRoot, rel);
  const children = [];
  let unreadable = 0;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    try {
      if (entry.isDirectory()) children.push(folderItem(childRel));
      else if (entry.isFile()) children.push(fileItem(childRel));
    } catch (error) {
      unreadable += 1;
      children.push({ kind: 'file', name: entry.name, path: childRel, size: 0, lastModified: 0, mimeType: 'application/octet-stream', file: new File([], entry.name), _unreadable: String(error && error.code || error) });
    }
  }
  return { kind: 'folder', name: path.basename(full), path: rel, children, _unreadable: unreadable };
}

function snapshotFile(rel) {
  const full = path.join(corpusRoot, rel);
  const bytes = readFileSync(full);
  const st = statSync(full);
  return { size: bytes.length, mtimeMs: st.mtimeMs, sha256: sha256(bytes) };
}

function folderSnapshot(rel, max = 6000) {
  const full = path.join(corpusRoot, rel);
  let files = 0; let total = 0; let truncated = false;
  const walk = (dir) => {
    if (files >= max) { truncated = true; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { truncated = true; return; }
    for (const e of entries) {
      if (files >= max) { truncated = true; return; }
      try {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.isFile()) { const st = statSync(path.join(dir, e.name)); files += 1; total += st.size; }
      } catch { truncated = true; }
    }
  };
  walk(full);
  return { files, total, truncated };
}

/** Race the analysis against a timeout; a hung fixture never blocks the run. */
function analyzeWithTimeout(item, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const analysis = analyzeItem(item, { signal: controller.signal });
  analysis.catch(() => undefined); // avoid unhandled rejection if it settles after timeout
  return Promise.race([
    analysis.then((result) => ({ result, timedOut: false })),
    new Promise((resolve) => setTimeout(() => resolve({ result: null, timedOut: true }), ms + 200))
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const entries = loadManifest();
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const lines = [];
  let index = 0;
  for (const entry of entries) {
    index += 1;
    const line = { index, category: entry.category, path: entry.path, is_dir: entry.is_dir,
      finding_type: entry.finding_type, graceful_failure_expected: entry.graceful_failure_expected,
      security_property: entry.security_property, size_bytes: entry.size_bytes,
      analyzer: null, actual_findings: [], actual_evidence: 0, pass: false,
      crashed: false, timed_out: false, duration_ms: 0, error: null, read_only_ok: null,
      skipped_reason: null, finding_types_seen: [], unreadable_children: 0,
      unresolved_evidence: 0, total_findings: 0, total_evidence: 0 };
    const rel = entry.path;
    const before = Date.now();
    try {
      if (!existsSync(path.join(corpusRoot, rel))) { line.skipped_reason = 'missing-on-disk'; appendLine(line); continue; }
      let beforeSnap = null;
      try { beforeSnap = entry.is_dir ? folderSnapshot(rel) : snapshotFile(rel); }
      catch (e) { line.skipped_reason = 'unopenable:' + (e.code || e.message); }
      if (line.skipped_reason) { appendLine(line); continue; }

      const item = entry.is_dir ? folderItem(rel) : fileItem(rel);
      if (item._unreadable) line.unreadable_children = item._unreadable;
      const { result, timedOut } = await analyzeWithTimeout(item, entry.is_dir ? DIR_TIMEOUT_MS : FILE_TIMEOUT_MS);
      if (timedOut) {
        line.timed_out = true;
      } else if (result) {
        line.pass = true;
        line.analyzer = result.analyzerId;
        line.actual_evidence = result.evidence ? result.evidence.length : 0;
        const findings = [...(result.important || []), ...(result.unusual || []), ...(result.recommendations || [])];
        line.identity_type = result.identity ? result.identity.type : null;
        line.identity_format = result.identity ? result.identity.format : null;
        line.actual_evidence = (result.evidence || []).length;
        line.evidence = (result.evidence || []).slice(0, 80).map((e) => ({ id: e.id, label: e.label, value: String(e.value || '').slice(0, 200) }));
        line.actual_findings = findings.slice(0, 60).map((f) => ({
          id: f.id, title: f.title, severity: f.severity, methodology: f.methodology || null,
          confidence: f.confidence || null, category: f.category || null,
          metrics: f.metrics || null, evidence_refs: (f.evidence || []).slice(0, 10)
        }));
        line.finding_types_seen = [...new Set(findings.map((f) => f.methodology || null).filter(Boolean))];
        line.relationships = (result.relationships || []).map((r) => ({ type: r.type, label: r.label, detail: String(r.detail || '').slice(0, 200), objects: (r.objects || []).slice(0, 6) }));
        // Evidence resolution: every finding's evidence refs must exist in the
        // flat evidence list or a section.
        const evidenceIds = new Set((result.evidence || []).map((e) => e.id));
        for (const section of result.sections || []) for (const item of section.items) evidenceIds.add(item.id);
        line.unresolved_evidence = findings.reduce((acc, f) => acc + (f.evidence || []).filter((id) => !evidenceIds.has(id)).length, 0);
        line.total_findings = findings.length;
        line.total_evidence = result.evidence ? result.evidence.length : 0;
      } else {
        line.crashed = true;
        line.error = 'no result';
      }
      // Read-only verification
      try {
        const afterSnap = entry.is_dir ? folderSnapshot(rel) : snapshotFile(rel);
        if (entry.is_dir) line.read_only_ok = afterSnap.files === beforeSnap.files && afterSnap.total === beforeSnap.total;
        else line.read_only_ok = beforeSnap.sha256 === afterSnap.sha256 && beforeSnap.size === afterSnap.size && beforeSnap.mtimeMs === afterSnap.mtimeMs;
      } catch { line.read_only_ok = null; }
    } catch (error) {
      line.crashed = true;
      line.error = error instanceof Error ? error.message : String(error);
    } finally {
      line.duration_ms = Date.now() - before;
      appendLine(line);
    }
    if (index % 25 === 0) console.error(`[adversarial] ${index}/${entries.length} done (${Date.now() - started}ms)`);
  }
  writeFileSync(path.join(outDir, 'summary-raw.json'), JSON.stringify({
    total: lines.length, generated_at: new Date().toISOString(), corpus_root: corpusRoot, lines
  }, null, 1), 'utf8');
  console.log(`[adversarial] done ${lines.length} fixtures in ${Date.now() - started}ms`);

  function appendLine(line) {
    lines.push(line);
    appendFileSync(resultsPath, JSON.stringify(line) + '\n');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
