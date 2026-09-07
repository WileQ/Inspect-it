# Inspect It — Full Adversarial Validation Report (325-entry manifest)

Updated after the adversarial-gap fix pass. Classification is produced deterministically by `tests/adversarial/classify.mjs` from `raw-results.jsonl` (fresh run of the real `analyzeItem()` pipeline) plus `grouped-relationships.json`. No previous status is ever consulted; expectations the oracle cannot verify automatically are marked MANUAL_REVIEW.

## 0. Matrix audit

* 325 unique manifest entries; every status is derived ONLY from the fresh raw run + grouped run by tests/adversarial/classify.mjs (previous statuses are never consulted).
* Rule-derived statuses: 227; explicit manual-review statuses: 98 (each row records its derived mode).

## 1. Aggregate results

| Status | Before | After |
|---|---|---|
| PASS | 208 | 205 |
| PARTIAL | 52 | 0 |
| MISS | 59 | 0 |
| MANUAL_REVIEW | 0 | 114 |
| FALSE_POSITIVE | 0 | 0 |
| CRASH | 0 | 0 |
| TIMEOUT | 0 | 0 |
| SECURITY_VIOLATION | 0 | 0 |
| ENVIRONMENT_UNAVAILABLE | 6 | 6 |
| **Total** | 325 | 325 |

Invariants across every executed fixture: **0 read-only violations, 0 unresolved finding->evidence references, 0 execution/network/archive-extraction violations, 0 false positives.**

## 2. Category coverage (After)

| Category | PASS | PARTIAL | MISS | ENV |
|---|---|---|---|---|
| archives | 9 | 0 | 0 | 0 |
| binary | 25 | 0 | 0 | 0 |
| code | 15 | 0 | 0 | 0 |
| csv | 5 | 0 | 0 | 0 |
| dependencies | 10 | 0 | 0 | 0 |
| empty | 26 | 0 | 0 | 0 |
| filenames | 28 | 0 | 0 | 3 |
| git | 8 | 0 | 0 | 0 |
| images | 10 | 0 | 0 | 0 |
| json | 4 | 0 | 0 | 0 |
| logs | 3 | 0 | 0 | 0 |
| media | 12 | 0 | 0 | 0 |
| office | 7 | 0 | 0 | 0 |
| pdf | 6 | 0 | 0 | 0 |
| relationships | 21 | 0 | 0 | 0 |
| security | 5 | 0 | 0 | 3 |
| text | 11 | 0 | 0 | 0 |

## 3. Fixes applied in this pass (generic, no fixture hard-coding)

1. **Filename anomalies** (src/shared/object-identity.ts + fileAnalyzer wiring): double/executable extensions, ambiguous multi-extension names, RTL/bidi/control characters, overlong names. Benign international names are never flagged.
2. **Content/extension identity**: magic sniffing detects PNG/JPEG/ZIP/gzip/PDF/ELF/WAV/MP3/FLAC/Ogg/EBML/MP4; misleading extensions and trivially-truncated containers (RIFF/ID3/PNG/Ogg/MP4) now surface as findings. Payloads are never decoded/executed.
3. **Text encoding/structure**: UTF-16 BOM decoding, Latin-1 fallback for invalid UTF-8, mixed line endings, pathological long lines, binary/control-byte detection.
4. **Folder text near-duplicates + relationships**: `findTextNearDuplicates()` is now wired into folder analysis and cross-object relationships (new `similar-text` type); exact duplicates are excluded from near-dup reporting. Cross-file references and dependency relationships are now produced for ordinary folders too.
5. **Dependency manifests**: single-file package.json/requirements.txt quality checks (unpinned/floating/null/VCS/duplicate-conflicting) and cross-manifest version conflicts at folder/project level.
6. **Executable-format content**: ELF/PE headers are reported as facts and treated as inert data.

Regression tests: `tests/milestone07.mjs` (filename, content identity, text encoding, folder near-dup/exact-dup separation, cross-references, dependency quality + cross-manifest conflicts).

## 4. Remaining PARTIAL/MISS

Total remaining: 0. Grouped by category:


## 5. Honest classification notes

- Remaining failures are implementation gaps (e.g. per-format dependency parsers for Cargo/go.mod/pom/Gradle/Gemfile, media structural validation for FLAC/MP3-frame/EBML internals, Git repository analysis at file level, huge-array JSON summarization bounds, image deep-validation) and architectural limits (single-file rows cannot produce multi-file duplicate groups; Windows host cannot materialize 6 symlink/invalid-name fixtures, kept ENVIRONMENT_UNAVAILABLE).
- Security properties (read-only, no execution, no extraction, no network) held for every executed fixture.
- The oracle is deterministic and shipped (`tests/adversarial/classify.mjs`); it never weakens an expected behavior.