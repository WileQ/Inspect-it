# Inspect It

> **Drop anything. Understand it.**

Inspect It is a privacy-first, read-only digital-object analyzer that lives as a small orange floating bubble on your desktop. Drop a file, folder, archive, database, or website URL onto the bubble and get a structured, evidence-backed analysis of what it is, what matters, what is unusual, and what to investigate next.

The analysis engine is **entirely local and deterministic** ? no LLM is required, and no cloud service is involved in analysis. An **optional** OpenAI-compatible AI layer can add a plain-English interpretation on top of the local findings.

**Read-only by design.** Inspect It never modifies, deletes, renames, executes, or installs anything from the objects it inspects.

---

## The core experience

```
Install Inspect It
        |
        v
orange bubble appears on your desktop
        |
        v
drop a file / folder / archive / URL onto it
        |
        v
local analysis: findings, statistics, anomalies, relationships, evidence
        |
        v
optional: "Ask AI" for a plain-English interpretation
```

No browser, no localhost, no terminal ? the bubble is always there, click it to open the compact popup, or drag anything onto it.

---

## Key capabilities

- **Floating bubble** ? circular, warm orange, draggable, remembers its position, accepts drag-and-drop, and stays above other windows. Click it to open the compact popup beside it; drag the popup's header to move it, or its corner handle to resize it.
- **Universal analyzer** ? documents, archives, code, data, media, websites, folders, and generic files (full format list below).
- **Evidence-first findings** ? every non-trivial claim is traceable to a measurement (`FACT`), a statistical deviation (`ANOMALY`), a rule (`HEURISTIC`), or a model (`ML`). Nothing is presented as fact without evidence.
- **Local OCR** ? on-device text recognition for images and scanned PDFs (tesseract.js + English language data bundled; no cloud, no network).
- **Deep local analysis** ? statistical anomaly detection, exact + near-duplicate detection, perceptual image similarity, code complexity, dependency graphs, cross-object relationships, and visualizations.
- **Optional AI interpretation** ? works with any OpenAI-compatible provider (OpenAI, Ollama, LM Studio, custom endpoints). Off by default.
- **History & cache** ? past analyses are stored locally; unchanged objects are not re-analyzed.
- **Local-first & private** ? no telemetry, no accounts, no silent uploads.

## What it can inspect

| Category | Formats | Highlights |
| --- | --- | --- |
| Documents | PDF, DOCX, PPTX, XLSX (legacy XLS detected) | metadata, text, headings, links, images, tables, comments, formulas, merged cells, hidden content, named ranges, external links, errors |
| Archives | ZIP, TAR, GZIP (incl. `.tar.gz` / `.zip.gz`) | file list, sizes, expansion ratio, nested archives, duplicate names, suspicious paths, bomb limits |
| Development | source code, dependency manifests, logs, Git repos | LOC, comments, functions, classes, imports, complexity, TODOs, dependencies, error rates, spikes, branches, contributors |
| Data | SQLite | tables, schema, indexes, row counts, null distributions, foreign keys, duplicates (read-only, in-memory) |
| Media | WAV, MP3, FLAC, OGG, MP4/MOV/M4A, WebM/MKV, AVI | duration, bitrate, sample rate, channels, resolution, codec, ID3 tags |
| Web | explicit http/https URLs | title, headings, links, images, scripts, canonical, structured data, security headers, robots.txt, sitemap |
| Images | PNG, JPEG, WebP, GIF, TIFF, BMP | dimensions, EXIF, dominant colors, perceptual hash, blur, brightness |
| Data files | CSV, TSV, JSON, JSONL, XML, YAML, TOML, INI, TXT, Markdown, logs | row/column stats, types, missing values, outliers, correlations, structure |
| Folders | any directory | file/dir counts, sizes, type distribution, duplicates, large/old/empty files, generated-dir hints |

Milestone 1?3 analyzers (text, JSON, CSV, images, folders, deep analysis) all share the same result schema and evidence model.

## Local-first architecture

```
                    INSPECT It
                         |
             +-----------+-----------+
             |                       |
       LOCAL ANALYSIS          OPTIONAL LLM
             |                       |
     +-------+--------+              |
     |       |        |              |
   Facts  Anomalies  Structure   Explanation
     |       |        |              |
     +-------+--------+--------------+
                         |
                         v
                  INSPECTION REPORT
```

The analyzer engine lives in `src/shared/` and is shared between the desktop app and the browser build. Every analyzer implements the same contract (`canHandle` / `analyze`) and returns the universal result schema with identity, facts, structure, findings, anomalies, relationships, recommendations, evidence, and limitations.

## Optional AI

- AI analysis is **off by default**; local analysis works fully without it.
- Add a provider in **Settings ? AI ANALYSIS**: name, base URL, model, API key, timeout, streaming, auto-analyze.
- Supported providers include OpenAI, Ollama, LM Studio, and any OpenAI-compatible endpoint.
- The AI receives a **bounded structured context** (facts, findings, statistics, evidence) ? never raw files. Nothing is sent until you click **Ask AI** (or enable auto-analyze).
- AI output is clearly labelled **AI INTERPRETATION** and is never presented as a measured fact.

## Privacy

- **Without AI:** everything stays on your device (analysis, OCR, hashing ? all local). No network calls, no telemetry, no tracking.
- **With AI:** a bounded structured summary is sent to the provider you explicitly configured. Raw files are never uploaded automatically.
- **Desktop key storage:** API keys are encrypted with your OS keychain via Electron `safeStorage` and are only used inside the main process. They are never logged, cached, or included in results.
- **Browser key storage:** local storage (not encrypted) ? a documented limitation; use the desktop app for sensitive keys.
- Inspect It never modifies analyzed files, never executes analyzed content, and never performs automatic cleanup.

## Installation

### Windows (release build)

1. Download `Inspect-It-1.0.0-Windows-x64.exe` from the [Releases](../../releases) page.
2. Run the installer (no Node, npm, or terminal required).
3. Launch **Inspect It** from the Start menu or desktop shortcut. The orange bubble appears.

> The installer preserves your analysis history and settings when uninstalling.

### macOS (release build)

1. Download `Inspect-It-1.0.0-macOS-<arch>.dmg` from the [Releases](../../releases) page (choose the build for your Mac: Apple Silicon `arm64` or Intel `x64`).
2. Open the DMG and drag **Inspect It** into your Applications folder.
3. Launch it. The first time, right-click the app and choose **Open** if macOS Gatekeeper complains (the app is not notarized in community builds).

> The menu-bar icon, the global shortcut, and launch-at-login use the macOS conventions. `Cmd+Space` is reserved by Spotlight, so the default shortcut is **Control+Space** (falls back to `Cmd+Shift+Space`).

### Linux (release build)

1. Download `Inspect-It-1.0.0.AppImage` (or the `.deb` for Debian/Ubuntu) from the [Releases](../../releases) page.
2. Make the AppImage executable and run it, or install the `.deb`:

   ```bash
   chmod +x Inspect-It-1.0.0.AppImage
   ./Inspect-It-1.0.0.AppImage
   # or
   sudo apt install ./inspect-it_1.0.0_amd64.deb
   ```

3. Some desktop environments need the AppImage runtime; install `libfuse2` if you see a FUSE error (Ubuntu 22.04+):

   ```bash
   sudo apt install libfuse2
   ```

> On X11 the global shortcut and always-on-top bubble work out of the box. On **Wayland**, global shortcuts and strict always-on-top are limited by the compositor, so use the bubble/tray instead. The system tray needs an AppIndicator/StatusNotifier host (GNOME: install the "AppIndicator and KStatusNotifierItem" extension).
### From source (developers)

```bash
git clone <repository-url>
cd Inspect-It
npm install
npm run dev          # development (Vite + Electron)
```

## Development & building

```bash
npm run dev          # development with hot reload (Vite + Electron)
npm test             # full test suite (node runner)
npx vitest run       # same suites via vitest
npx tsc --noEmit     # type check
npm run build        # production renderer bundle (dist/)
npm run package      # build + unpacked app for the current platform (release/<platform>-unpacked)
npm run dist         # build + installers for the current platform (release/)
npm run dist:win     # build + NSIS Windows installer (run on Windows)
npm run dist:mac     # build + DMG/ZIP macOS app (run on macOS)
npm run dist:linux   # build + AppImage/deb Linux packages (run on Linux)
npm run icons        # regenerate app/tray icons (scripts/generate-icons.mjs)
```

> Each installer must be built on its own OS: macOS packages require macOS
> (code signing/notarization needs a Mac and Apple credentials), Linux packages
> are produced on Linux, and Windows packages on Windows. The CI workflow
> (`.github/workflows/build.yml`) builds and tests all three on every push, and
> publishing a GitHub Release with all installers is a tag away:
>
> ```bash
> npm version 1.0.1 --no-git-tag-version   # bump package.json first
> git commit -am "release: 1.0.1"
> git tag v1.0.1 && git push origin main --tags
> ```
>
> `package.json` is the single source of truth for the version; CI fails if the
> tag and package.json disagree (see `scripts/check-release-version.mjs`).
> Builds never publish implicitly - only the dedicated release job creates the
> GitHub Release. See [docs/RELEASING.md](docs/RELEASING.md) for the full
> version/tag flow and the macOS signing/notarization setup.


**Production builds are self-contained**: the renderer is bundled into the Electron app (`dist/`), so the packaged application does not need Vite, localhost, Node, or npm at runtime.

## Platform support

| Platform | Installers | Notes |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | Fully supported; global shortcut `Ctrl+Space`, launch at login, tray. |
| macOS (x64 + arm64) | `.dmg`, `.zip` | Default shortcut `Control+Space` (`Cmd+Space` is Spotlight); launch at login via macOS login items. |
| Linux | AppImage, `.deb` | Tray + shortcuts work on X11; Wayland limits global shortcuts and always-on-top. Launch at login via XDG autostart. |

See [docs/PLATFORMS.md](docs/PLATFORMS.md) for troubleshooting.


## Testing

`npm test` (and `npx vitest run`) cover:

- Milestone 1 analyzers: text, JSON, CSV, image, folder, cache/history, cancellation.
- Milestone 2 analyzers with real in-memory fixtures: PDF, DOCX, PPTX, XLSX, ZIP, TAR, GZIP, SQLite, code, manifests, logs, Git signals, audio/video, website (local mock server).
- Milestone 3 deep analysis: anomaly engine, duplicates, near-duplicates, perceptual hashing, OCR availability, complexity, dependency graphs, relationships, cancellation, read-only guarantee.
- Milestone 4 LLM layer: provider abstraction, payload/SSE parsing, error mapping, timeout, cancellation, bounded context, evidence preservation, caching, local-only operation, privacy boundaries (mock provider, no internet).
- Milestone 5 production readiness: package metadata, CSP, read-only audit, secrets/private-path scan.

## Project layout

```
electron/            Electron main + preload (bubble, popup, tray, shortcuts, secure key storage)
src/                 React UI (bubble + compact popup) and shared analysis core
src/shared/          analyzers, result schema, utilities, per-family modules
src/shared/llm/      optional AI layer (provider, context, cache, settings)
src/components/      AI settings + AI report UI
scripts/             dev launcher, icon generator, capture helpers
tests/               test runner, vitest suites, fixture generators
milestones/          milestone specifications
build/               icon assets (icon.png, tray.png)
release/             packaged artifacts (gitignored)
```

## Limitations

- **PDF** extraction is heuristic (metadata, text operators, links, images, annotations, fonts); complex/vector layouts and tables may be partially extracted.
- **Legacy `.xls`** is detected but not structurally inspected; convert to XLSX.
- **Audio/video** reads container metadata and stream headers; it does not decode media.
- **Git** signals come from repository files present in the inspected tree (no `git` binary is invoked).
- **Dependencies** are counted from manifests; no vulnerability database is bundled, so no vulnerability claims are made.
- **OCR** is local and optional: when tesseract.js is installed it runs on-device; otherwise the app reports that OCR is unavailable instead of faking text. No cloud OCR, no silent model downloads.
- **Code complexity** is a brace/indent heuristic, not a full AST analysis.
- **AI interpretations can be wrong.** Local findings remain authoritative.

## Contributing

Contributions are welcome. Please:

1. Read `AGENTS.md` (the authoritative product specification).
2. Keep changes local-first, read-only, and evidence-first.
3. Add fixtures and tests for new analyzers.
4. Run `npm test`, `npx vitest run`, `npx tsc --noEmit`, and `npm run build` before opening a PR.

## License

[MIT](LICENSE)

