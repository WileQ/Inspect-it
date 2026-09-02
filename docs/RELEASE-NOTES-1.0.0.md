# Release Notes ? Inspect This 1.0.0

## What is Inspect This?

Inspect This is a privacy-first, read-only digital-object analyzer. It lives as a
small orange floating bubble on your desktop: drop a file, folder, archive,
database, or website URL onto it and get a structured, evidence-backed analysis
of what it is, what matters, what is unusual, and what to investigate next.

The analysis engine is entirely local and deterministic. An optional
OpenAI-compatible AI layer can add a plain-English interpretation on top.

## Major features

- Floating always-on-top bubble with drag, drop, and remembered positioning
- Compact popup that opens beside the bubble (movable, resizable, remembered)
- Universal local analyzer: documents, archives, code, data, media, websites, folders
- Evidence-first findings with FACT / ANOMALY / HEURISTIC / ML methodology labels
- Deep local analysis: anomalies, duplicates, near-duplicates, perceptual image
  similarity, code complexity, dependency graphs, relationships, visualizations
- Local history and caching (unchanged objects are not re-analyzed)
- Optional OpenAI-compatible AI interpretation (OpenAI, Ollama, LM Studio, custom)
- System tray integration, global shortcut (Ctrl/Cmd+Space), optional launch at login
- Strictly read-only: never modifies, deletes, executes, or installs anything

## Supported platforms

- Windows x64 ? installable NSIS build (`Inspect-This-1.0.0-Windows-x64.exe`)
- macOS x64 + arm64 ? DMG/ZIP builds (`Inspect-This-1.0.0-macOS-<arch>.dmg`)
- Linux x64 ? AppImage and `.deb` builds
- Browser ? drag-and-drop analysis (files you explicitly select)

Builds for each platform must be produced on that platform (or via the CI
workflow, `.github/workflows/build.yml`, which builds and tests all three).
See `docs/PLATFORMS.md` for details and troubleshooting.

## Local-first / privacy model

- Without AI, nothing leaves your device: no telemetry, no tracking, no accounts.
- With AI, a bounded structured summary is sent only to the provider you configure.
- Raw files are never uploaded automatically.
- API keys are encrypted at rest (OS keychain on desktop) and never logged or cached.

## Optional AI

- AI is off by default; local analysis works without it.
- Configure any OpenAI-compatible provider (base URL, model, API key, timeout,
  streaming) in Settings -> AI ANALYSIS, then use "Ask AI" per analysis.
- AI output is labelled "AI INTERPRETATION" and is never presented as a measured fact.

## Known limitations

- Linux: global shortcuts and strict always-on-top are unavailable on Wayland
  compositors; the system tray requires an AppIndicator/StatusNotifier host.
- macOS: `Cmd+Space` is reserved by Spotlight, so the default global shortcut
  is `Control+Space` (falls back to `Cmd+Shift+Space`).
- PDF extraction is heuristic; complex/vector layouts may be partially extracted.
- Legacy .xls is detected but not structurally inspected (convert to XLSX).
- Audio/video analysis reads container metadata only (no decode).
- No vulnerability database is bundled, so no vulnerability claims are made.
- OCR ships locally (tesseract.js + English language data bundled, no network):
  images and scanned PDFs get on-device text recognition; other languages can be
  added later.
- Code complexity is a brace/indent heuristic, not full AST analysis.
- AI interpretations can be wrong; local findings remain authoritative.

## Installation

- **Windows**: download `Inspect-This-1.0.0-Windows-x64.exe`, run the installer
  (no Node/npm/terminal required), and launch Inspect This. Uninstalling
  preserves your analysis history and settings.
- **macOS**: download the DMG for your architecture, drag the app into
  Applications, and open it (right-click -> Open the first time).
- **Linux**: download the AppImage (or `.deb`), make it executable, and run it.
  See `docs/PLATFORMS.md` for FUSE/tray/Wayland notes.

In all cases the orange bubble appears; drop anything onto it to begin.
