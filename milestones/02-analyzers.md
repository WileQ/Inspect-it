# Milestone 02 — Analyzer Expansion

## Objective

Expand Inspect This into a genuinely broad universal analyzer.

Read AGENTS.md before beginning.

## Implement

### Documents
- PDF
- DOCX
- PPTX
- spreadsheets

### Archives
- ZIP
- TAR
- GZIP
- additional safe formats where practical

### Development
- Git
- source code
- dependency manifests
- logs

### Data
- SQLite

### Media
- audio
- video

### Web
- URL analysis

## Requirements

All analyzers must:

- be read-only
- follow the analyzer interface
- return structured InspectionResults
- expose evidence
- handle malformed input
- enforce resource limits
- never execute analyzed content

## Completion

Every analyzer has:

- implementation
- fixtures
- tests
- error handling
- documentation

Run the full test suite.