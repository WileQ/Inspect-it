# Milestone 01 — Foundation

## Objective

Build the first complete end-to-end Inspect It experience.

The user must be able to:

1. Launch the desktop application.
2. See the floating Inspect It bubble.
3. Click the bubble.
4. Open the inspection panel.
5. Drag a file/folder onto the bubble.
6. Select files through a file picker.
7. Analyze the object locally.
8. See real analysis results.
9. Cancel an analysis.
10. Reopen previous analyses.

## Scope

Implement:

- desktop shell
- browser shell
- floating bubble
- bubble positioning
- click behavior
- drag/drop
- file picker
- analyzer interface
- inspection result schema
- analysis engine
- progress reporting
- cancellation
- history
- caching
- basic UI

Initial analyzers:

- generic file
- text
- Markdown
- JSON
- CSV
- image
- folder

## Requirements

All analysis must be local.

No LLM yet.

No network calls for analysis.

No source files may be modified.

Do not create fake analysis results.

## Completion criteria

The following must work:

[ ] Desktop launches
[ ] Bubble appears
[ ] Bubble can be moved
[ ] Bubble can be clicked
[ ] Files can be dropped
[ ] Folders can be dropped
[ ] File picker works
[ ] CSV produces real statistics
[ ] JSON produces real structural analysis
[ ] Images produce real metadata
[ ] Folders produce real statistics
[ ] Results display evidence
[ ] Analysis can be cancelled
[ ] History works
[ ] Cache works
[ ] Tests pass
[ ] No source mutation occurs

## Important

Read AGENTS.md before beginning.

Inspect the existing repository before changing anything.

Do not implement later milestones prematurely.