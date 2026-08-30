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
- macOS and Linux targets are configured; builds for those platforms were not
  produced in the Windows development environment.

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

- PDF extraction is heuristic; complex/vector layouts may be partially extracted.
- Legacy .xls is detected but not structurally inspected (convert to XLSX).
- Audio/video analysis reads container metadata only (no decode).
- No vulnerability database is bundled, so no vulnerability claims are made.
- OCR is local and optional (tesseract.js when installed); otherwise the app
  honestly reports OCR is unavailable.
- Code complexity is a brace/indent heuristic, not full AST analysis.
- AI interpretations can be wrong; local findings remain authoritative.

## Installation

1. Download `Inspect-This-1.0.0-Windows-x64.exe` from GitHub Releases.
2. Run the installer (no Node/npm/terminal required).
3. Launch Inspect This; the orange bubble appears.
4. Drop anything onto it.

Uninstalling preserves your analysis history and settings (standard behavior for
the bundled installer).
