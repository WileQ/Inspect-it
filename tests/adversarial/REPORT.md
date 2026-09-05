# Inspect It ? Full Adversarial Validation Report (325-entry manifest)

This is a complete expected-vs-actual pass over the uploaded 325-fixture adversarial manifest.
It supersedes the earlier partial report.

## 0. Method (transparent)

* **Pipeline:** the real production path `analyzeItem()` from `src/shared/analyzers.ts` (same analyzers/orchestration the app uses), run per fixture with an `AbortController` and a deterministic timeout (30 s file / 180 s folder). Directory + cross-file fixtures were also analyzed through the real **folder/project** path, including grouped multi-drop analysis for the relationship corpus.
* **Read-only audit:** SHA-256, size, and mtime captured before/after every fixture; directory structure counted before/after folder runs; no corpus writes, no extraction, no execution observed anywhere.
* **Captured per fixture:** analyzer, identity type/format, every evidence row, every formal Finding (id, title, severity, methodology, confidence, category, metrics, evidence refs), relationships, duration, errors, read-only result, unresolved-evidence count.
* **Classification oracle:** each entry is marked PASS / PARTIAL / MISS / FALSE_POSITIVE / CRASH / TIMEOUT / SECURITY_VIOLATION / ENVIRONMENT_UNAVAILABLE using the manifest's expected_finding_type + expected_behavior/security_property and captured signals (formal Finding present? issue only as raw evidence? no signal?). The oracle is deterministic and documented; it does **not** treat "did not crash" as PASS. Where expectation requires cross-file behavior it was evaluated against a real grouped folder run.
* **Limit:** expected_behavior is free text; the oracle maps it to structured checks. Exact semantic equality for all 325 is not automated ? category themes and representative examples are given, and expectations the architecture does not implement are flagged.

## 1. Aggregate results

| Status | Count |
|---|---|
| PASS | 208 |
| PARTIAL | 52 |
| MISS | 59 |
| FALSE_POSITIVE | 0 |
| CRASH | 0 |
| TIMEOUT | 0 |
| SECURITY_VIOLATION | 0 |
| ENVIRONMENT_UNAVAILABLE | 6 |
| **Total** | 325 |

Additional invariants across every executed fixture: **0 read-only violations**, **0 unresolved finding->evidence references**, **0 execution/network/archive-extraction violations**, **0 negative-control false positives** (see section 5).

## 2. Category coverage

| Category | PASS | PARTIAL | MISS | ENV_UNAVAILABLE |
|---|---|---|---|---|
| archives | 13 | 3 | 1 | 0 |
| binary | 19 | 7 | 12 | 0 |
| code | 8 | 9 | 0 | 0 |
| csv | 13 | 0 | 0 | 0 |
| dependencies | 2 | 4 | 9 | 0 |
| empty | 26 | 0 | 0 | 0 |
| filenames | 22 | 0 | 7 | 3 |
| git | 3 | 0 | 7 | 0 |
| images | 23 | 0 | 3 | 0 |
| json | 20 | 0 | 1 | 0 |
| logs | 8 | 3 | 0 | 0 |
| media | 8 | 13 | 2 | 0 |
| office | 9 | 6 | 0 | 0 |
| pdf | 14 | 0 | 2 | 0 |
| relationships | 14 | 2 | 5 | 0 |
| security | 4 | 3 | 3 | 3 |
| text | 2 | 2 | 7 | 0 |

## 3. Genuine bugs fixed during this pass

1. **CRASH - malformed/empty OOXML** (empty.docx/.pptx/.xlsx, binary/random_noise_pretending.docx, office/malformed_zip_truncated.docx, office/malformed_xml_inside_valid_zip.docx) threw out of analyzeItem. Fixed: analyzeOfficePackage() guard in src/shared/documents.ts returns graceful *-invalid(high) reports. Regression tests added.
2. **HIGH - valid-header PDFs with broken structure reported as healthy** (pdf/truncated_no_xref.pdf, circular_object_reference.pdf, missing_root_reference.pdf, zero_pages.pdf). Fixed: pdfjs fallback/parse failures now emit a pdf-structure-warning(low, heuristic) finding + evidence. Regression test added.

Full corpus re-run after fixes: **0 crashes, 0 timeouts**.

## 4. Main gaps by theme (root cause -> analyzer -> severity -> recommendation)

1. **Text near-duplicate detection is implemented but never called by the folder analyzer.** near_dup_text/version_2_lightly_edited.txt is not linked to version_1. Root cause: findTextNearDuplicates() exists in duplicates.ts but analyzeFolder never invokes it. Severity: HIGH. Fix: wire it in (bounded pairs + threshold + evidence); regression with v1/v2 match vs v3 no-match.
2. **Filename anomalies are not flagged.** report.pdf.exe, script.py.txt.md, data.csv.json.txt (double/misleading extension), RTL-override U+202E, 200+ char names. Root cause: no filename analysis stage. Severity: MEDIUM. Fix: conservative heuristic that avoids legit .tar.gz; flag very-long + RTL-override names.
3. **Container "magic OK but truncated/invalid" not surfaced for media/archives.** truncated_flac_magic.flac, truncated_riff_magic.wav, invalid_ogg_magic.ogg, zip_malformed_crc.zip, tar_long_name.tar, id3v2_tag_no_audio.mp3. Root cause: header parsers return partial metadata with no structural-validity signal. Severity: MEDIUM. Fix: minimum structural checks + low/medium anomaly with evidence.
4. **Text/encoding anomalies not detected.** UTF-16-with-BOM, latin1/non-UTF-8, mixed line endings, huge single line, binary-looking text. Root cause: text analyzer assumes UTF-8. Severity: MEDIUM. Fix: BOM sniffing, replacement-char ratio, line-ending consistency, line-length thresholds.
5. **Single-file dependency manifests don't surface issues; cross-manifest conflicts not aggregated.** requirements/pyproject/Cargo/go.mod/pom/gradle/Gemfile with conflicts/unpinned/missing versions give manifest evidence but no Finding; nested services only yield a duplicate-file signal. Severity: HIGH (weakest category). Fix: run collectDependencyGraph on folders and lift per-manifest issues into findings.
6. **Git fixtures analyzed as individual files cannot surface repo signals.** No git-repo analyzer for a .git-containing target. Severity: MEDIUM.
7. **Cross-reference relationships and nested same-name/same-size relationships not produced.** cross_reference/* and same-name files under nested dirs yield nothing. Severity: MEDIUM.
8. **Single-file ML similarity cannot be judged from one file.** Grouped image similarity passes; text near-dup ML stays unavailable/MISS. Severity: MEDIUM.

## 5. Negative controls - no false positives observed

relationships/should_not_link/*, same_size_diff_content/*, unrelated text version_3_unrelated.txt, random-noise images, benign Unicode filenames, and ordinary traversal-looking TEXT content produced no inappropriate duplicate/similarity/security finding. (The 187 evidence-only fixtures are the product's facts-as-evidence model, not false positives.)

## 6. Answers to the acceptance questions

1. Did every fixture run? 319/325 ran through the real pipeline; 6 are ENVIRONMENT_UNAVAILABLE (cannot exist on this host) and are not silently counted as PASS.
2. Which did not and why? filenames/quotes'and"double.txt, filenames/tab<TAB>in_name_placeholder.txt, filenames/combining_diacritics_e(combining)*, security/symlink_targets/{symlink_to_real_file.txt, broken_symlink.txt, loop_a} - host filesystem (Windows) constraints.
3. Every expected issue detected? No - see 59 MISS entries in report.json and themes in section 4.
4. Missed expected issues? See section 4 (near-dup text, filename/encoding/media/archive anomalies, single-file dependency issues, git repo signals, cross-reference relationships, single-file ML text).
5. False positives? None found (negative controls respected).
6. Every malformed input graceful? Yes - after the OOXML fix, 0 crashes; malformed pdf/office/zip/json/csv all return results.
7. Crash or hang? 0 crashes, 0 timeouts in the final run.
8. Any write/modification? 0 (sha256/size/mtime verified per fixture; no new files in corpus).
9. Did anything execute? No (no process/script/shell/SQL/HTML execution; suspicious strings stayed data).
10. Archive escape? No - traversal-looking entries listed only; nothing extracted.
11. HTML/JS/script execution? No (inert).
12. Duplicates/near-duplicates? Exact duplicates: yes (folder-deep-exact-duplicates). Image perceptual similarity: yes (folder-deep-similar-images, ml). Text near-duplicates: NO (not wired). Same-name/same-size negatives respected.
13. Negative controls respected? Yes.
14. Methodology/confidence/evidence correct? Evidence refs all resolve (0 unresolved). Methodology is sparse on many findings (anomaly engine sets it; generic finding helper does not) - product-wide labelling gap.
15. Categories fully covered? empty, csv, json, logs (near-full); binary/code/images/media/office/pdf mostly robust.
16. Categories with gaps? dependencies, git, filenames, text, media, relationships, archives (section 4).
17. Highest-priority remaining weaknesses? (1) text near-dup not wired; (2) single-file/nested dependency conflict analysis; (3) filename/encoding anomaly detection; (4) media/archive structural-validity anomalies; (5) sparse methodology/confidence on findings.
18. Regression tests added? Malformed/empty OOXML + PDF structural warning (tests/milestone02.mjs). Runner + reports in tests/adversarial/.

## 7. Where the data lives

* tests/adversarial/report.json - one row for all 325 entries (fixture, expected_behavior, expected finding type, status, reason, actual analyzer/findings/evidence, duration, read-only, env limitation).
* tests/adversarial/report-stats.json - aggregate counts.
* tests/adversarial/results.jsonl - raw per-run capture.
* tests/adversarial/grouped-relationships.json - cross-file folder runs.
* tests/adversarial/run-adversarial.mjs, run-grouped.mjs - deterministic runners.
* tests/adversarial/REPORT.md - this report.
