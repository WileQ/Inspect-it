# Inspect It

> **Drop anything. Understand it.**

Inspect It is a privacy-first, read-only digital-object analyzer that lives as a small floating desktop bubble.

Drop a file, folder, archive, database, image, project, or website URL onto it and get a structured answer to:

* **What is this?**
* **What's important?**
* **What's unusual?**
* **What evidence supports that?**
* **What should I investigate next?**

Inspect It is **not a generic chatbot**. Its local analysis engine is the source of truth; optional AI can explain the results in plain English.

---

## Why Inspect It?

Digital objects often contain more information than their filename suggests.

A folder can contain duplicates, unusual files, broken references, generated code, dependency problems, and suspicious structure. A spreadsheet can contain missing values, outliers, duplicate rows, and inconsistent columns. A PDF can contain hidden metadata, scanned pages, or text that requires OCR.

Inspect It turns these objects into a compact, evidence-backed inspection report.

**Drop → Analyze → Understand → Investigate.**

---

## Core principles

### Read-only by design

Inspect It does not modify, rename, delete, execute, or install anything from the objects you inspect.

Analysis happens over the supplied data, primarily in memory.

Archives are inspected without extracting them to disk. SQLite databases are analyzed from an in-memory copy. Git repositories are treated as data; Inspect It does not invoke the Git executable or execute hooks.

### Local-first

The core analysis engine runs locally.

No account is required. There is no telemetry or background monitoring, and analyzed files are not silently uploaded.

### Evidence-first

Findings are tied to evidence whenever the analyzer can provide it.

Evidence can represent things such as:

* measured facts
* statistical anomalies
* heuristic findings
* duplicate relationships
* source/text locations
* PDF pages
* CSV rows and columns
* JSON paths
* archive entries

Inspect It distinguishes measurements and heuristics from optional AI interpretation.

### Explicit network access

Local analysis does not require the network.

Website analysis is a separate, explicit feature that is **off by default**. When enabled, Inspect It only analyzes URLs you submit.

AI is also optional and off by default.

---

## The experience

```text
                 Inspect It
                     │
                     ▼
             ┌─────────────────┐
             │  Floating       │
             │  desktop bubble │
             └────────┬────────┘
                      │
             Drop / select / URL
                      │
                      ▼
             ┌─────────────────┐
             │ Local analysis  │
             │                 │
             │ Facts           │
             │ Findings        │
             │ Anomalies       │
             │ Relationships   │
             │ Evidence        │
             └────────┬────────┘
                      │
             ┌────────┴────────┐
             ▼                 ▼
       What to know       What to inspect
                              next
                      │
                      ▼
               Optional AI
              interpretation
```

The desktop application is self-contained. You do not need a browser, localhost development server, Node.js, npm, or a terminal to use a packaged release.

---

## Key capabilities

* **Floating desktop bubble** — small, warm-orange, draggable, always-on-top, with drag-and-drop support.
* **Universal analyzer** — documents, archives, code, data, media, images, folders, Git repositories, and explicit website URLs.
* **Evidence-first findings** — findings can link back to the measurements, rules, statistics, or locations that produced them.
* **Deep analysis** — anomalies, duplicates, near-duplicates, image similarity, code complexity, dependency graphs, and cross-object relationships.
* **Local OCR** — OCR for scanned PDFs and text-like images when local OCR is available.
* **Website analysis** — explicit HTTP/HTTPS URL analysis with bounded fetching and security controls.
* **Optional AI interpretation** — OpenAI-compatible providers including OpenAI, Ollama, LM Studio, and custom endpoints.
* **History and cache** — recent inspection results are stored locally as derived metadata.
* **Read-only architecture** — analyzed user objects are never modified, deleted, renamed, executed, or installed.

---

## What can it inspect?

| Category                | Formats / Objects                                                | Examples of analysis                                                                                                    |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Documents**           | PDF, DOCX, PPTX, XLSX                                            | metadata, text, headings, links, tables, formulas, comments, hidden content, named ranges, external links               |
| **Legacy spreadsheets** | XLS                                                              | detected; structural inspection is not currently supported                                                              |
| **Archives**            | ZIP, TAR, GZIP, `.tar.gz`, `.zip.gz`                             | entries, sizes, compression ratios, nested archives, duplicate names, suspicious paths, bounded decompression           |
| **Development**         | source code, manifests, logs, Git repositories                   | LOC, comments, functions, classes, imports, complexity, TODOs, dependencies, log patterns, Git metadata                 |
| **Data**                | SQLite                                                           | tables, schema, indexes, row counts, null distributions, foreign keys, duplicates                                       |
| **Tabular/text data**   | CSV, TSV, JSON, JSONL, XML, YAML, TOML, INI, TXT, Markdown, logs | structure, types, missing values, duplicates, distributions, anomalies, repeated patterns                               |
| **Media**               | WAV, MP3, FLAC, OGG, MP4, MOV, M4A, WebM, MKV, AVI               | duration, bitrate, sample rate, channels, resolution, codec, metadata                                                   |
| **Images**              | PNG, JPEG, WebP, GIF, TIFF, BMP                                  | dimensions, metadata, perceptual similarity, visual statistics, text-like content                                       |
| **Folders / projects**  | directories and their contents                                   | file counts, sizes, type distribution, duplicates, large/old/empty files, generated-directory hints, relationships      |
| **Web**                 | explicit HTTP/HTTPS URLs                                         | title, headings, links, images, scripts, canonical URL, structured data, selected security headers, robots.txt, sitemap |

Support varies by analyzer. Inspect It reports limitations instead of pretending unsupported or unavailable information was successfully extracted.

---

## Deep analysis

Inspect It can go beyond basic metadata and extraction.

Depending on the object, analysis can include:

* statistical anomalies
* z-scores, IQR, MAD and percentile-based analysis
* frequency and duplicate detection
* exact duplicate detection using SHA-256
* text near-duplicate detection
* perceptual image similarity
* missing-value analysis
* constant-column detection
* temporal spikes
* code complexity heuristics
* dependency graphs
* cross-file relationships
* cross-object relationships
* filename and extension anomalies
* content/extension mismatches
* malformed or suspicious container structures

Large or expensive operations are bounded to prevent untrusted input from consuming unlimited resources.

---

## OCR

OCR is performed locally when available.

For scanned PDFs and text-like images, Inspect It can attempt local OCR and present:

* OCR availability
* OCR success/failure state
* recovered text
* page-level results for PDFs
* confidence information where available
* separation between native document text and OCR-recovered text

OCR input and processing are bounded.

There is no cloud OCR service.

If OCR is unavailable or fails, Inspect It reports that honestly rather than fabricating extracted text.

---

## Website analysis

Website analysis is **disabled by default**.

Enable it in:

**Settings → Web Analysis → Allow website analysis**

When disabled, URL analysis performs no network request.

When enabled, Inspect It can analyze an explicitly submitted HTTP/HTTPS URL.

The desktop web-fetch layer provides:

* bounded response size
* bounded request time
* bounded redirects
* HTTP/HTTPS scheme restrictions
* credential URL rejection
* protection against public-to-private/local redirects
* no cookies or user credentials sent by the analyzer
* no arbitrary website JavaScript execution
* HTML treated as data rather than executable content

Direct local/private destinations remain supported intentionally for local development-server analysis.

Website analysis is not a crawler, background monitor, or general-purpose browser.

---

## Optional AI interpretation

AI is completely optional.

The local analysis engine works without an AI provider.

When enabled, Inspect It supports OpenAI-compatible providers such as:

* OpenAI
* Ollama
* LM Studio
* custom OpenAI-compatible endpoints

The AI receives a **bounded structured context** derived from the local inspection result rather than automatically receiving the original file bytes.

AI output is explicitly labelled:

> **AI INTERPRETATION**

AI interpretation is not treated as measured fact. Local findings remain the source of truth.

AI can be used manually with **Ask AI**, or configured for automatic interpretation.

---

## Privacy

### Local analysis

Without AI or website analysis:

* analysis stays on the device
* OCR stays on the device
* hashing stays on the device
* no telemetry is sent
* no account is required
* no analyzed files are uploaded

### Website analysis

Website analysis is:

* off by default
* explicitly enabled by the user
* limited to URLs the user submits
* bounded by request size, timeout, and redirects
* credential- and cookie-free

### AI

When AI is enabled:

* the configured provider receives the bounded inspection context
* raw files are not automatically uploaded
* AI is never silently enabled
* the provider is controlled by the user

### Credentials

On the desktop app, API keys use Electron's OS-backed `safeStorage` when available.

Keys remain in the main process and are not included in inspection results, history, or normal logs.

If OS-backed encryption is unavailable, Inspect It uses a restricted local file as a fallback. This is documented as a limitation.

---

## Security and safety

Inspect It is designed to treat inspected content as **untrusted data**.

The application does not:

* execute source code
* execute scripts from inspected files
* execute Git hooks
* invoke the Git executable for analysis
* extract archives to disk
* follow archive traversal paths onto the filesystem
* modify analyzed files
* delete analyzed files
* rename analyzed files
* automatically clean up analyzed objects
* execute website JavaScript as part of HTML analysis

Electron uses isolation features including context isolation, disabled Node integration in the renderer, sandboxing, and web security.

The current adversarial corpus contains **325 deterministic fixtures** covering malformed, misleading, duplicate, archive, image, log, dependency, code, Git, and other hostile inputs.

The current security verification reports:

* 0 crashes
* 0 timeouts
* 0 read-only violations
* 0 unresolved evidence references

Six fixtures are environment-limited on Windows because their filesystem representation cannot exist on that host.

See the project's security documentation and audit material for deeper implementation details.

---

## Installation

Download the latest release from the **[GitHub Releases](../../releases)** page.

### Windows

Current release target:

**Windows x64**

Download:

```text
Inspect-It-1.0.5-Windows-x64.exe
```

Run the installer and launch **Inspect It** from the Start menu or shortcut.

No Node.js, npm, or terminal is required.

Windows builds may display a SmartScreen warning when the installer is not signed with a trusted commercial/open-source signing identity.

### macOS

Current release target:

**Apple Silicon / arm64**

Download the macOS DMG or ZIP from Releases.

Open the DMG and move **Inspect It** to Applications.

Community builds may not be Apple-notarized. If macOS Gatekeeper blocks an unsigned build, use the macOS **Open** flow from Finder/System Settings as appropriate.

### Linux

Current release target:

**Linux x64 / amd64**

Available packages:

* AppImage
* Debian `.deb`

For AppImage:

```bash
chmod +x Inspect-It-1.0.5.AppImage
./Inspect-It-1.0.5.AppImage
```

For Debian/Ubuntu:

```bash
sudo apt install ./inspect-it_1.0.5_amd64.deb
```

AppImage desktop integration depends on the Linux desktop environment.

On Wayland, compositor restrictions can limit global shortcuts and strict always-on-top behavior. X11 provides the broadest desktop integration.

---

## Platform support

| Platform    | Current target        | Package formats  | Notes                                                                         |
| ----------- | --------------------- | ---------------- | ----------------------------------------------------------------------------- |
| **Windows** | x64                   | NSIS `.exe`      | Bubble, tray, shortcuts, launch at login                                      |
| **macOS**   | Apple Silicon / arm64 | `.dmg`, `.zip`   | macOS login-item support; Gatekeeper behavior depends on signing/notarization |
| **Linux**   | x64 / amd64           | AppImage, `.deb` | Best desktop integration on X11; Wayland has compositor limitations           |

Other architectures are not currently official release targets.

---

## From source

### Requirements

* Node.js 22
* npm

Clone the repository:

```bash
git clone <repository-url>
cd Inspect-it
npm ci
```

Start development:

```bash
npm run dev
```

---

## Development and building

```bash
npm run dev          # development with Vite + Electron
npm test             # full test suite
npx vitest run       # test suites through Vitest
npx tsc --noEmit     # TypeScript check
npm run build        # production renderer build
npm run package      # unpacked application for current platform
npm run dist         # installer(s) for current platform
npm run dist:win     # Windows NSIS installer
npm run dist:mac     # macOS DMG/ZIP
npm run dist:linux   # Linux AppImage/deb
npm run icons        # regenerate application/tray icons
```

Production builds bundle the renderer into the Electron application. The packaged application does not require Vite, localhost, Node.js, or npm at runtime.

Platform installers are built in CI for the supported platforms.

---

## Releases

Inspect It uses semantic version tags such as:

```text
v1.0.5
```

`package.json` is the version source of truth and CI verifies that the pushed tag matches it.

Build jobs do not publish releases implicitly.

The release workflow:

```text
version bump
     ↓
commit
     ↓
push to main
     ↓
create vX.Y.Z tag
     ↓
GitHub Actions
     ↓
Windows + macOS + Linux builds
     ↓
GitHub Release
```

For release details, see [`docs/RELEASING.md`](docs/RELEASING.md).

---

## Testing

The test suite covers the analysis engine, security boundaries, packaging assumptions, and adversarial inputs.

Coverage includes:

* text, JSON, CSV, image and folder analysis
* PDF, DOCX, PPTX and XLSX
* ZIP, TAR and GZIP
* SQLite
* source code and dependency manifests
* logs
* Git metadata
* audio/video metadata
* website analysis
* anomaly detection
* exact and near duplicates
* perceptual hashing
* OCR
* dependency graphs
* cross-object relationships
* LLM provider behavior
* bounded AI context
* privacy boundaries
* cancellation
* history/cache
* read-only guarantees
* web/SSRF security guards
* adversarial fixtures
* deterministic golden regression tests

Before opening a pull request:

```bash
npm test
npx tsc --noEmit
npm run build
```

---

## Architecture

```text
Inspect It
│
├── Electron desktop shell
│   ├── Floating bubble
│   ├── Popup UI
│   ├── Tray
│   ├── Secure IPC
│   ├── Local OCR bridge
│   └── Bounded web-fetch bridge
│
├── React UI
│   ├── Findings
│   ├── Facts
│   ├── Evidence
│   ├── Deep Analysis
│   ├── OCR
│   ├── Limitations
│   └── Optional AI interpretation
│
└── Shared analysis engine
    ├── Documents
    ├── Archives
    ├── Code
    ├── Data
    ├── Media
    ├── Images
    ├── Folders
    ├── Git
    ├── Web
    ├── OCR
    └── Deep analysis
```

The shared analysis core lives in `src/shared/`.

Analyzers follow a common contract and return a structured inspection result containing information such as:

* identity
* facts
* structure
* findings
* anomalies
* relationships
* recommendations
* evidence
* limitations

---

## Project layout

```text
electron/             Electron main process + preload
src/                  React UI and shared application code
src/shared/           Analysis engine and analyzers
src/shared/llm/       Optional AI provider layer
src/components/       UI components
scripts/              Development/build utilities
tests/                Test suites and fixtures
milestones/           Product milestone specifications
docs/                 Release/platform documentation
build/                Application and tray assets
release/              Local packaged artifacts
```

---

## Limitations

Inspect It intentionally reports limitations instead of hiding them.

* **PDF:** extraction is heuristic; complex layouts, vector content, and tables may be partially extracted.
* **Legacy `.xls`:** detected but not structurally inspected; convert to XLSX for deeper analysis.
* **Audio/video:** container and stream metadata are inspected; media is not decoded.
* **Git:** analysis is based on repository files; the Git executable and hooks are not invoked.
* **Dependencies:** manifests are analyzed, but Inspect It does not bundle a vulnerability database and therefore does not make vulnerability claims.
* **OCR:** local OCR availability depends on the packaged OCR capability and input; unavailable or failed OCR is reported explicitly.
* **Code complexity:** complexity metrics use analyzer heuristics rather than a complete language AST for every supported language.
* **Web:** website analysis is bounded and intentionally does not behave like a full browser or crawler.
* **AI:** AI interpretations can be wrong. Local measurements and findings remain authoritative.
* **Linux desktop integration:** Wayland compositor restrictions can affect global shortcuts and always-on-top behavior.
* **macOS/Windows trust:** unsigned community builds may trigger platform security warnings.

---

## Contributing

Contributions are welcome.

Please:

1. Read [`AGENTS.md`](AGENTS.md), the authoritative product specification.
2. Keep changes **local-first, read-only, and evidence-first**.
3. Add deterministic fixtures and regression tests for new analyzers or security-sensitive behavior.
4. Do not introduce automatic file modification, deletion, execution, telemetry, or hidden network activity.
5. Run:

```bash
npm test
npx tsc --noEmit
npm run build
```

before opening a pull request.

---

## License

[MIT](LICENSE)
