// Milestone 07 - adversarial-gap regression tests.
//
// Deterministic coverage for the generic fixes from the full-corpus pass:
//   - filename anomalies (double/exec extensions, RTL/control, overlong)
//   - content/extension mismatch + truncated-container detection
//   - text encoding/structure (UTF-16 BOM, Latin-1, mixed EOL, huge lines)
//   - folder-level text near-duplicates, exact-duplicate separation, cross-refs
//   - dependency manifest quality + cross-manifest version conflicts
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import { filenameChecks, contentIdentityChecks } from '../src/shared/object-identity.ts';
import { renderTextPng } from './ocr-font.mjs';

const signal = new AbortController().signal;

function textFileItem(name, text) {
  const bytes = new TextEncoder().encode(text);
  const file = new File([bytes], name, { type: 'text/plain', lastModified: 1_700_000_000_000 });
  return { kind: 'file', name, path: name, size: file.size, lastModified: file.lastModified, mimeType: 'text/plain', file };
}
function binFileItem(name, bytes, mime = 'application/octet-stream') {
  const file = new File([bytes], name, { type: mime, lastModified: 1_700_000_000_000 });
  return { kind: 'file', name, path: name, size: file.size, lastModified: file.lastModified, mimeType: mime, file };
}
function folderItem(name, children) {
  return { kind: 'folder', name, path: name, children };
}
function hasFinding(result, id) {
  return result.unusual.some((f) => f.id === id);
}

export async function runMilestoneSevenTests() {
  // --- Filename anomalies -----------------------------------------------------
  {
    const exec = filenameChecks('report.pdf.exe');
    assert.ok(exec.findings.some((f) => f.id === 'filename-exec-double-extension'), 'double exec extension flagged');
    const multi = filenameChecks('data.csv.json.txt');
    assert.ok(multi.findings.some((f) => f.id === 'filename-multiple-extensions'), 'ambiguous multi-extension flagged');
    const benign = filenameChecks('raport końcowy (wersja 2).txt');
    assert.equal(benign.findings.length, 0, 'benign unicode filename not flagged');
    const rtl = filenameChecks('safe_\u202Etest.txt');
    assert.ok(rtl.findings.some((f) => f.id === 'filename-control-characters'), 'RTL override flagged');
    const long = filenameChecks('x'.repeat(220) + '.txt');
    assert.ok(long.findings.some((f) => f.id === 'filename-overlong'), 'overlong name flagged');
    // Integration: text file with a double-extension name.
    const result = await analyzeItem(textFileItem('report.pdf.exe', 'hello world'), { signal });
    assert.equal(hasFinding(result, 'filename-exec-double-extension'), true, 'file analyzer surfaces filename finding');
    const clean = await analyzeItem(textFileItem('notes.txt', 'hello world'), { signal });
    assert.equal(clean.unusual.some((f) => f.id.startsWith('filename-')), false, 'plain names produce no filename findings');
  }

  // --- Content identity -------------------------------------------------------
  {
    const png = renderTextPng('HELLO', { scale: 6, pad: 12 }).bytes;
    const notes = contentIdentityChecks('photo.txt', png, png.length);
    assert.ok(notes.findings.some((f) => f.id === 'content-extension-mismatch'), 'PNG-in-txt mismatch flagged');
    // Valid PNG under .png extension must not be a mismatch.
    const ok = contentIdentityChecks('photo.png', png, png.length);
    assert.ok(!ok.findings.some((f) => f.id === 'content-extension-mismatch'), 'matching extension not flagged');
    // Truncated RIFF container.
    const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x50, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    const truncated = contentIdentityChecks('x.wav', riff, 12);
    assert.ok(truncated.findings.some((f) => f.id === 'content-container-truncated'), 'truncated RIFF flagged');
    // Random bytes claiming to be an image.
    const noise = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    const unknown = contentIdentityChecks('noise.png', noise, noise.length);
    assert.ok(unknown.findings.some((f) => f.id === 'content-extension-unrecognized'), 'claimed signature absent flagged');
  }

  // --- Text encoding / structure ----------------------------------------------
  {
    const utf16Chars = [...'hello world']; const utf16 = new Uint8Array(2 + utf16Chars.length * 2); utf16[0] = 0xff; utf16[1] = 0xfe; utf16Chars.forEach((ch, idx) => { const code = ch.charCodeAt(0); utf16[2 + idx * 2] = code & 0xff; utf16[3 + idx * 2] = (code >> 8) & 0xff; });
    const u16 = await analyzeItem(binFileItem('utf16.txt', utf16, 'text/plain'), { signal });
    assert.equal(hasFinding(u16, 'text-utf16'), true, 'UTF-16 BOM decoded and reported');
    // Latin-1 bytes (0xE9) are not valid UTF-8.
    const latin = new TextEncoder().encode('café'.replace('é', '\u00e9'));
    const rawLatin = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    const latinResult = await analyzeItem(binFileItem('latin.txt', rawLatin, 'text/plain'), { signal });
    assert.equal(hasFinding(latinResult, 'text-latin1'), true, 'non-UTF-8 Latin-1 fallback flagged');
    const mixed = await analyzeItem(textFileItem('mixed.txt', 'a\r\nb\nc\rd'), { signal });
    assert.equal(hasFinding(mixed, 'text-mixed-line-endings'), true, 'mixed line endings flagged');
    const huge = await analyzeItem(textFileItem('huge.txt', 'x'.repeat(100000)), { signal });
    assert.equal(hasFinding(huge, 'text-huge-line'), true, 'huge single line flagged');
    const plain = await analyzeItem(textFileItem('plain.txt', 'line one\nline two\n'), { signal });
    assert.equal(plain.unusual.some((f) => f.id.startsWith('text-')), false, 'plain UTF-8 text has no text anomalies');
  }

  // --- Folder text near-duplicates + exact-duplicate separation ---------------
  {
    const v1 = textFileItem('version_1.txt', 'The quick brown fox jumps over the lazy dog near the river bank.');
    const v2 = textFileItem('version_2.txt', 'The quick brown fox leaps over the lazy dog near the river bank.');
    const v3 = textFileItem('version_3.txt', 'Completely unrelated content about planetary orbits and kitchen appliances.');
    const folder = folderItem('docs', [v1, v2, v3]);
    const result = await analyzeItem(folder, { signal });
    assert.equal(hasFinding(result, 'folder-deep-near-duplicate-text'), true, 'near-duplicate text finding present');
    const similar = (result.relationships ?? []).filter((r) => r.type === 'similar-text');
    assert.ok(similar.length >= 1, 'similar-text relationship present');
    assert.ok(similar.some((r) => r.objects.includes('version_1.txt') && r.objects.includes('version_2.txt')), 'v1~v2 linked');
    assert.ok(similar.every((r) => !r.objects.includes('version_3.txt')), 'unrelated v3 not linked');
    // Exact duplicates must stay exact-duplicate findings, not near-duplicates.
    const dupFolder = folderItem('dups', [textFileItem('a.txt', 'same body text'), textFileItem('b.txt', 'same body text')]);
    const dupResult = await analyzeItem(dupFolder, { signal });
    assert.equal(hasFinding(dupResult, 'folder-deep-exact-duplicates'), true, 'exact duplicates found');
    assert.equal(hasFinding(dupResult, 'folder-deep-near-duplicate-text'), false, 'exact duplicates not re-reported as near-duplicates');
  }

  // --- Cross-file references ---------------------------------------------------
  {
    const docA = textFileItem('doc_a.md', '# A\nSee doc_b and shared_data for details.');
    const docB = textFileItem('doc_b.md', '# B\nRefer back to doc_a.');
    const data = binFileItem('shared_data.csv', new TextEncoder().encode('a,b\n1,2\n'), 'text/csv');
    const result = await analyzeItem(folderItem('refs', [docA, docB, data]), { signal });
    const refs = (result.relationships ?? []).filter((r) => r.type === 'reference');
    assert.ok(refs.some((r) => r.objects.includes('doc_a.md') && r.objects.includes('doc_b.md')), 'doc_a<->doc_b reference');
    assert.ok(refs.some((r) => r.objects.includes('doc_a.md') && r.objects.includes('shared_data.csv')), 'doc_a->shared_data reference');
  }

  // --- Dependency manifest quality + cross-manifest conflicts ------------------
  {
    const pkg = JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      dependencies: { express: '', axios: '*', moment: null, chalk: 'latest' },
      devDependencies: { axios: '^1.0.0' }
    });
    const manifest = await analyzeItem(binFileItem('package.json', new TextEncoder().encode(pkg), 'application/json'), { signal });
    assert.equal(manifest.unusual.filter((f) => f.id.startsWith('manifest-unpinned')).length >= 2, true, 'unpinned/floating flagged');
    assert.ok(hasFinding(manifest, 'manifest-null-version-spec-2') || manifest.unusual.some((f) => f.id.includes('null-version')), 'null version flagged');
    const req = 'requests==2.28.0\nflask\nrequests==2.31.0\ngit+https://github.com/example/lib.git#egg=lib';
    const reqResult = await analyzeItem(binFileItem('requirements.txt', new TextEncoder().encode(req), 'text/plain'), { signal });
    assert.ok(reqResult.unusual.some((f) => f.id.includes('conflicting-duplicate')), 'conflicting duplicate pins flagged');
    assert.ok(reqResult.unusual.some((f) => f.id.includes('unpinned')), 'unpinned requirement flagged');
    assert.ok(reqResult.unusual.some((f) => f.id.includes('vcs') || f.title.includes('VCS')), 'VCS install noted');
    // Cross-manifest version conflict in a project folder.
    const manifestChild = (rel, payload) => { const bytes = new TextEncoder().encode(payload); const file = new File([bytes], 'package.json', { type: 'application/json', lastModified: 1_700_000_000_000 }); return { kind: 'file', name: 'package.json', path: rel, size: file.size, lastModified: file.lastModified, mimeType: 'application/json', file }; };
    const svcA = manifestChild('service_a/package.json', JSON.stringify({ name: 'a', dependencies: { shared: '1.0.0' } }));
    const svcB = manifestChild('service_b/package.json', JSON.stringify({ name: 'b', dependencies: { shared: '2.0.0' } }));
    const proj = folderItem('monorepo', [svcA, svcB]);
    const projResult = await analyzeItem(proj, { signal });
    assert.equal(hasFinding(projResult, 'folder-dependency-version-conflicts'), true, 'cross-manifest version conflict flagged');
  }

  // --- Per-format dependency manifests (static, deterministic) ----------------
  {
    const cargo = '\n[dependencies]\nserde = "1.0"\nserde = "1.0.200"\n';
    const cargoResult = await analyzeItem(binFileItem('Cargo.toml', new TextEncoder().encode(cargo), 'text/plain'), { signal });
    assert.ok(cargoResult.unusual.some((f) => f.id.startsWith('manifest-cargo-')), 'Cargo duplicate TOML key flagged');
    const pom = '<?xml version="1.0"?><project><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>lib</artifactId><version>1.0</version></dependency><dependency><groupId>g</groupId><artifactId>lib</artifactId><version>2.0</version></dependency><dependency><groupId>g</groupId><artifactId>app</artifactId><version>1.0</version></dependency></dependencies></project>';
    const pomResult = await analyzeItem(binFileItem('pom.xml', new TextEncoder().encode(pom), 'text/xml'), { signal });
    assert.ok(pomResult.unusual.some((f) => f.id.startsWith('manifest-pom-conflicting')), 'pom conflicting versions flagged');
    assert.ok(pomResult.unusual.some((f) => f.id.startsWith('manifest-pom-self')), 'pom self dependency flagged');
  }

  // --- requirements.txt impossible ranges / VCS / invalid names --------------
  {
    const req = 'requests==2.28.0\nrequests==2.31.0\nnumpy>=1.20,<1.19\nflask\n-e git+https://example.invalid/repo.git#egg=custom-pkg\npackage-with-!!!weird***chars==1.0';
    const res = await analyzeItem(binFileItem('requirements.txt', new TextEncoder().encode(req), 'text/plain'), { signal });
    assert.ok(res.unusual.some((f) => f.id.startsWith('manifest-conflicting-duplicate')), 'conflicting duplicates flagged');
    assert.ok(res.unusual.some((f) => f.id.startsWith('manifest-unpinned')), 'unpinned flagged');
    assert.ok(res.unusual.some((f) => f.id.startsWith('manifest-vcs')), 'VCS (-e git+) flagged');
    assert.ok(res.unusual.some((f) => f.id.startsWith('manifest-impossible-version-range')), 'impossible range flagged');
    assert.ok(res.unusual.some((f) => f.id.startsWith('manifest-invalid-package-name')), 'invalid package name flagged');
  }

  // --- Code analyzer heuristics (static; never executes) ----------------------
  {
    const nul = await analyzeItem(binFileItem('x.py', new TextEncoder().encode('def f():\n    x = 1\u0000\n    return x\n'), 'text/x-python'), { signal });
    assert.ok(nul.unusual.some((f) => f.id === 'code-null-bytes'), 'NUL bytes flagged');
    const mixed = await analyzeItem(binFileItem('x.py', new TextEncoder().encode('def f():\n\tx = 1\n        y = 2\n\treturn x\n'), 'text/x-python'), { signal });
    assert.ok(mixed.unusual.some((f) => f.id === 'code-python-mixed-indentation'), 'mixed tabs/spaces flagged');
    const weird = await analyzeItem(binFileItem('x.py', new TextEncoder().encode('def f():\n  x = 1\n     y = 2\n  return x\n'), 'text/x-python'), { signal });
    assert.ok(weird.unusual.some((f) => f.id === 'code-python-indentation-error'), 'inconsistent indentation flagged');
    const minified = await analyzeItem(binFileItem('x.js', new TextEncoder().encode(('function a(b,c){return b+c}' + ';var q=0;for(var i=0;i<9;i++){q+=i}').repeat(3)), 'text/javascript'), { signal });
    assert.ok(minified.unusual.some((f) => f.id === 'code-minified'), 'minified JS flagged');
    const generated = await analyzeItem(binFileItem('gen.py', new TextEncoder().encode('# AUTO-GENERATED FILE - DO NOT EDIT\nFIELD_0000 = 0\nFIELD_0001 = 1\n'), 'text/x-python'), { signal });
    assert.ok(generated.unusual.some((f) => f.id === 'code-generated'), 'generated header flagged');
    const mismatch = await analyzeItem(binFileItem('x.py', new TextEncoder().encode('func main() {\n  console.log("hi");\n}\n'), 'text/x-python'), { signal });
    assert.ok(mismatch.unusual.some((f) => f.id === 'code-language-mismatch'), 'language mismatch flagged');
  }

  // --- Git metadata (read-only, no git execution) -----------------------------
  {
    const bad = 'not a valid reflog line at all\n0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A <a@x.test> -99999 +0000\tnegative ts\n0000000000000000000000000000000000000000 2222222222222222222222222222222222222222 A <a@x.test> 9999999999 +0000\tfar future\n';
    const bytes = new TextEncoder().encode(bad);
    const file = new File([bytes], 'HEAD', { type: 'text/plain', lastModified: 1_700_000_000_000 });
    const item = { kind: 'file', name: 'HEAD', path: 'repo/.git/logs/HEAD', size: file.size, lastModified: file.lastModified, mimeType: 'text/plain', file };
    const res = await analyzeItem(item, { signal });
    assert.equal(res.analyzerId, 'git', 'git metadata analyzer selected');
    assert.ok(res.unusual.some((f) => f.id === 'git-reflog-malformed'), 'malformed reflog lines flagged');
    assert.ok(res.unusual.some((f) => f.id === 'git-reflog-timestamp-anomaly'), 'timestamp anomalies flagged');
  }

  console.log('Milestone 07 adversarial-gap tests passed.');
}