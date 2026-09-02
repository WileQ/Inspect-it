---
# Inspect This — Master Development Specification

This document is the authoritative specification for the Inspect This project.

You are responsible for actually implementing this application, not merely planning it.

Follow the requirements in this document throughout development.

Do not remove, weaken, or bypass requirements unless technically impossible.
When a requirement is ambiguous, make a sensible engineering decision and continue.

The application must be:
- functional, not a mockup
- local-first
- privacy-first
- strictly read-only
- modular and extensible
- cross-platform
- usable without an LLM
- compatible with optional OpenAI-compatible LLM providers

Do not implement destructive or modifying functionality.

When working on a milestone, inspect the existing implementation first,
preserve working functionality, implement the requested changes,
run tests, and fix errors before considering the task complete.

The full product specification follows.

# INSPECT THIS — COMPLETE BUILD SPECIFICATION

## 0. ROLE

You are an expert senior full-stack/desktop engineer responsible for **actually building and delivering** the application described below.

Do not merely produce a plan, architecture document, mockup, or list of TODOs.

**Implement the application.**

Make reasonable engineering decisions without repeatedly asking for confirmation. If a decision is not explicitly specified, choose the simplest robust implementation that preserves the architecture and product vision.

The application should be production-quality, modular, extensible, privacy-first, and suitable for being published as an open-source GitHub project.

---

# 1. PRODUCT

## Name

**Inspect This**

## Tagline

> **Drop anything. Understand it.**

Inspect This is a privacy-first universal digital-object analysis application.

The core idea:

> A user can drop almost any digital object into Inspect This and immediately get a structured analysis of what it is, what matters, what is unusual, and what they should investigate.

The application **does not require an LLM**.

Its primary analysis engine is entirely local and deterministic/ML-based.

An optional LLM layer can be enabled by the user through an **OpenAI-compatible provider interface**.

The application must never modify the analyzed source data.

---

# 2. CORE PRODUCT PHILOSOPHY

Inspect This should NOT feel like:

> "Upload a file to ChatGPT."

It should feel like:

> **A universal inspection instrument for your computer.**

The app should have its own analysis engine.

The LLM is an optional enhancement.

The fundamental architecture is:

```text
                    INSPECT THIS
                         │
             ┌───────────┴───────────┐
             │                       │
       LOCAL ANALYSIS          OPTIONAL LLM
             │                       │
     ┌───────┼────────┐              │
     │       │        │              │
   Facts  Anomalies  Structure   Explanation
     │       │        │              │
     └───────┴────────┴──────────────┘
                         │
                         ▼
                  INSPECTION REPORT
```

The local analysis must remain useful even when the user has **zero AI providers configured**.

---

# 3. PLATFORM

Build for:

### Desktop

* Windows
* macOS
* Linux

### Browser

Provide a browser version of the analysis interface.

However, understand that browser security restrictions mean the browser version cannot have identical filesystem capabilities to the desktop application.

The architecture should share as much code as possible between desktop as well as browser.

---

# 4. RECOMMENDED TECHNOLOGY

Choose technologies that support a cross-platform desktop application and browser frontend.

A preferred architecture is:

### Desktop shell

**Tauri**

Use the desktop shell for:

* system tray
* floating always-on-top bubble
* global keyboard shortcuts
* filesystem access
* native file dialogs
* local analysis
* desktop notifications
* secure local storage

### Frontend

**React + TypeScript**

Use a modern component-based UI.

### Styling

Use a clean modern design system.

Prefer:

* dark mode
* subtle translucency
* rounded surfaces
* restrained animation
* excellent spacing
* keyboard accessibility

Avoid excessive gradients, generic "AI startup" visuals, and unnecessary visual noise.

### Local backend

Use Rust/Tauri capabilities where appropriate for:

* filesystem operations
* hashing
* file metadata
* archive inspection
* process management
* system integration
* security boundaries

Use specialized libraries where Python/Node ecosystems provide substantially better analysis capabilities, but do not introduce unnecessary runtime complexity.

The architecture should remain modular enough that analyzers can be implemented in the most appropriate language.

---

# 5. FLOATING BUBBLE

This is one of the defining features.

When the desktop application is running, display a small floating bubble near the side of the screen.

Conceptually:

```text
                                      ┌─────────┐
                                      │    ✦    │
                                      └─────────┘
```

The bubble should:

* remain above normal windows
* be draggable
* remember its position
* preferably magnetically dock to screen edges
* remain unobtrusive
* have a subtle hover animation
* be clickable
* support drag-and-drop

Clicking the bubble opens the main inspection panel.

---

# 6. BUBBLE DRAG BEHAVIOR

The user should be able to drag a file onto the bubble.

Example:

```text
Finder / Explorer

        report.pdf
             │
             │ drag
             ▼
          ┌─────┐
          │  ✦  │
          └─────┘
```

When a supported object is dragged over it:

* visually highlight the bubble
* indicate that dropping will begin inspection
* accept the drop

After dropping:

1. bubble expands
2. inspection panel opens
3. analysis begins
4. progress is displayed
5. results appear progressively

---

# 7. MAIN UI

The expanded panel should look approximately like:

```text
┌────────────────────────────────────────────────────────┐
│ ✦ Inspect This                                  ─ □ × │
├────────────────────────────────────────────────────────┤
│                                                        │
│                  DROP ANYTHING                         │
│                                                        │
│              ┌───────────────────┐                     │
│              │                   │                     │
│              │     📄 📊 🖼️      │                     │
│              │                   │                     │
│              └───────────────────┘                     │
│                                                        │
│         or click to browse files                      │
│                                                        │
│         Everything is analyzed locally                │
│                                                        │
└────────────────────────────────────────────────────────┘
```

After analysis:

```text
┌─────────────────────────────────────────────────────────┐
│ ←  sales.csv                               LOCAL ✓       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📊 DATASET                                             │
│                                                         │
│  182,392 rows       17 columns       4.8% missing       │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  🚨 IMPORTANT                                           │
│                                                         │
│  Revenue is heavily concentrated among a small           │
│  number of customers.                                   │
│                                                         │
│  👁️ UNUSUAL                                             │
│                                                         │
│  27 statistical outliers detected.                      │
│                                                         │
│  🧭 STRUCTURE                                           │
│                                                         │
│  ...                                                    │
│                                                         │
│  🛠️ SUGGESTED INVESTIGATION                             │
│                                                         │
│  ...                                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

# 8. UNIVERSAL ANALYSIS MODEL

Every inspection should produce a common result structure.

At minimum:

## Identity

What is the object?

```text
type
format
mime type
size
location
created
modified
```

## Facts

Directly measurable information.

## Structure

How the object is organized.

## Important

High-value observations.

## Unusual

Anomalies, inconsistencies, outliers, or suspicious characteristics.

## Relationships

Connections between elements.

## Recommendations

Things the user may want to inspect further.

## Evidence

Every non-trivial claim should be traceable back to an underlying observation.

This is critical.

Do not produce vague statements like:

> "This file seems suspicious."

Instead:

> **Unusually large file**

> `model.pkl` — 4.7 GB

> Larger than 99.2% of files in this project.

The user should be able to understand **why** Inspect This reached a conclusion.

---

# 9. ANALYSIS LEVELS

Implement three levels.

## Level 1 — Instant

Fast deterministic analysis.

Examples:

* metadata
* file type
* size
* hashes
* dimensions
* counts
* basic statistics
* directory structure
* basic code metrics

This should begin almost immediately.

---

## Level 2 — Deep Local Analysis

Potentially slower.

Examples:

* OCR
* duplicate detection
* perceptual image similarity
* embeddings
* anomaly detection
* dependency analysis
* code complexity
* document structure
* archive traversal
* advanced statistical analysis
* local ML models

The UI should show:

```text
✓ Instant analysis
⟳ Deep analysis...
```

and progressively update results.

---

## Level 3 — Optional LLM

Only enabled if the user explicitly configures it.

The LLM should receive **structured extracted information**, not blindly receive the entire object.

For example:

```text
Raw file
   ↓
Local analyzer
   ↓
structured analysis
   ↓
LLM
```

not:

```text
Raw file
   ↓
LLM
```

---

# 10. PRIVACY

Privacy is a fundamental product feature.

Default state:

```text
🟢 LOCAL ONLY

Everything is being analyzed on this device.
Nothing is being uploaded.
```

No cloud API calls should happen unless the user explicitly enables an LLM provider.

When LLM analysis is enabled:

```text
🟡 AI ANALYSIS ENABLED

Selected analysis data may be sent to:
OpenAI
```

The UI must make this clear.

Before sending sensitive content, provide a clear indication of what will be sent.

---

# 11. LLM ARCHITECTURE

Use an abstraction based around an **OpenAI-compatible provider interface**.

Do not hard-code the application around one vendor.

Conceptually:

```text
LLMProvider
├── endpoint
├── model
├── API key
├── capabilities
└── analyze()
```

Support:

* OpenAI
* Ollama
* LM Studio
* other OpenAI-compatible APIs
* custom endpoint

The provider configuration should allow:

```text
Provider name
Base URL
Model
API key
```

For local providers, API key can be optional.

---

# 12. LLM SHOULD BE OPTIONAL

If no LLM is configured:

```text
LOCAL ANALYSIS
✓ Available
```

The app must still be completely usable.

If an LLM is configured:

```text
LOCAL ANALYSIS
✓

AI ANALYSIS
✓
```

Allow users to disable LLM analysis globally.

Also allow:

> **Analyze locally only**

on an individual inspection.

---

# 13. SUPPORTED OBJECTS

Build the analyzer around a plugin/adapter architecture.

Initial support should include as broad a range as reasonably possible.

---

## Generic files

Support:

* TXT
* Markdown
* JSON
* JSONL
* XML
* YAML
* TOML
* INI
* CSV
* TSV
* log files
* source code
* configuration files

Extract:

* metadata
* structure
* size
* encoding
* line counts
* statistics
* repeated patterns
* anomalies

---

# 14. CSV / TABULAR DATA ANALYZER

Provide extensive local analysis.

Detect:

* row count
* column count
* types
* missing values
* unique values
* duplicates
* distributions
* min
* max
* mean
* median
* standard deviation
* quantiles
* outliers
* correlations
* categorical cardinality
* date ranges
* suspicious columns

Generate visualizations where appropriate.

Example:

```text
DATASET

182,392 rows
17 columns

Missing:
████░░░░░░ 4.8%

Potential anomalies:
27

Duplicate rows:
41
```

Use statistical methods rather than an LLM for these findings.

---

# 15. EXCEL ANALYZER

Support:

* `.xlsx`
* `.xls` where practical

Inspect:

* worksheets
* row/column counts
* formulas
* merged cells
* hidden sheets
* hidden rows/columns
* formatting anomalies
* formulas
* named ranges
* external links
* errors
* duplicate data
* unusual values

Highlight potentially important workbook features.

---

# 16. PDF ANALYZER

Extract:

* metadata
* pages
* text
* headings
* links
* images
* tables where practical
* fonts
* document structure
* annotations
* embedded files where safe

Detect:

* blank pages
* unusual metadata
* inconsistent metadata
* external links
* malformed structure
* scanned/image-only pages
* OCR opportunities

Never execute embedded content.

---

# 17. DOCUMENT ANALYZER

Support where practical:

* DOCX
* PPTX
* ODT

Inspect:

* document structure
* headings
* text
* tables
* images
* metadata
* hyperlinks
* comments
* notes
* hidden content where safely extractable

---

# 18. IMAGE ANALYZER

Support common formats:

* PNG
* JPEG
* WebP
* GIF
* TIFF
* BMP
* SVG where safely parseable

Inspect:

* dimensions
* aspect ratio
* color profile
* EXIF
* creation metadata
* file size
* compression
* transparency
* dominant colors
* perceptual hash
* blur
* brightness
* contrast

Deep analysis may include:

* OCR
* duplicate detection
* perceptual similarity
* optional pretrained image classification

Do not require cloud vision APIs.

---

# 19. AUDIO ANALYZER

Inspect:

* duration
* bitrate
* sample rate
* channels
* codec
* metadata
* ID3 tags
* album/artist information
* loudness where practical
* waveform statistics

Do not transmit audio externally unless explicitly selected for an LLM/provider that supports it.

---

# 20. VIDEO ANALYZER

Inspect:

* duration
* resolution
* frame rate
* codec
* bitrate
* audio streams
* metadata
* thumbnails
* scene statistics where practical

Deep analysis can optionally sample frames rather than processing the entire video.

---

# 21. ARCHIVE ANALYZER

Support:

* ZIP
* TAR
* GZIP
* common archive formats where safe

Inspect without modifying:

* file list
* compressed size
* uncompressed size
* compression ratio
* nested archives
* duplicate files
* suspicious paths
* unusually large expansion ratios

Protect against archive bombs.

Set:

* maximum extracted size
* maximum recursion depth
* maximum file count
* execution prohibition

Never automatically extract and execute content.

---

# 22. FOLDER ANALYZER

Recursively inspect directories.

Produce:

```text
FOLDER

Files: 18,291
Directories: 932
Total size: 84.2 GB

Types:
Python       31%
Images       24%
JavaScript   18%
Other        27%
```

Detect:

* duplicate files
* large files
* old files
* empty files
* empty folders
* suspicious extensions
* nested archives
* generated directories
* source directories
* build artifacts
* dependency directories
* temporary files

Never delete or modify anything.

---

# 23. GIT REPOSITORY ANALYZER

Detect repositories automatically.

Inspect:

* branches
* commits
* contributors
* commit frequency
* churn
* file history
* languages
* repository size
* largest files
* dependency manifests
* TODOs
* FIXMEs
* code statistics
* stale branches
* stale files
* unusual commit patterns

Potential findings:

> `auth.py` has unusually high churn.

> 37 TODOs have remained unchanged for over 2 years.

> `node_modules/` appears to be included in repository history.

> This file accounts for 14% of repository code.

All findings should include evidence.

---

# 24. SOURCE CODE ANALYSIS

Support as many languages as practical.

At minimum detect:

* Python
* JavaScript
* TypeScript
* Rust
* Go
* Java
* C
* C++
* C#
* PHP
* Ruby
* Swift
* Kotlin
* HTML
* CSS
* SQL
* Shell

Analyze:

* LOC
* comments
* functions
* classes
* imports
* dependency relationships
* complexity where supported
* duplicate blocks
* TODO/FIXME
* large functions
* suspicious patterns
* dead-looking files
* generated code indicators

Do not claim a file is "dead" unless the evidence supports the claim.

Use wording such as:

> "No references detected within the analyzed project."

rather than:

> "This file is unused."

---

# 25. DEPENDENCY ANALYSIS

Detect common manifests:

* package.json
* requirements.txt
* pyproject.toml
* Cargo.toml
* go.mod
* pom.xml
* Gradle files
* composer.json
* Gemfile
* etc.

Show:

```text
DEPENDENCIES

142 direct
391 transitive

Potential issues:
⚠ 8 outdated
⚠ 2 duplicated packages
⚠ 1 unusually large dependency
```

Do not claim vulnerabilities unless using a trustworthy vulnerability source or local database.

---

# 26. LOG ANALYZER

Support common logs.

Detect:

* timestamps
* severity
* error frequency
* repeated errors
* spikes
* patterns
* latency
* request IDs
* stack traces
* anomalous periods

Example:

```text
LOG ANALYSIS

1.2M lines

ERRORS:
███████░░░ 8.4%

Most common:
ConnectionTimeout

Spike:
14:32–14:41

⚠ 87% of errors originate from the same service.
```

---

# 27. DATABASE ANALYZER

Support local database formats where practical, especially:

* SQLite

Inspect read-only:

* tables
* schema
* indexes
* row counts
* null distributions
* foreign keys
* duplicate records
* unusual values
* database size

Absolutely no writes.

Open database connections in read-only mode.

---

# 28. WEBSITE ANALYZER

Given a URL, analyze it safely.

Inspect:

* title
* metadata
* headings
* links
* images
* scripts
* technologies where detectable
* accessibility indicators
* performance indicators
* security headers
* robots.txt
* sitemap
* canonical URLs
* structured data

Respect:

* robots.txt where applicable
* rate limits
* request limits
* HTTPS
* timeouts

Do not perform intrusive security testing.

This is an inspection tool, not a penetration-testing tool.

---

# 29. UNIVERSAL RESULT FORMAT

Every analyzer should output structured data.

Conceptually:

```typescript
InspectionResult {
    identity
    facts[]
    structure[]
    findings[]
    anomalies[]
    relationships[]
    recommendations[]
    evidence[]
    warnings[]
    capabilities[]
}
```

Each finding should contain:

```typescript
Finding {
    title
    severity
    category
    description
    evidence[]
    confidence
}
```

Severity:

* info
* low
* medium
* high

Do not use "critical" unless there is a genuinely critical condition.

---

# 30. CONFIDENCE

Distinguish:

### Measured

Directly observed.

### Inferred

Derived from measurable evidence.

### Heuristic

Based on rules.

### ML-derived

Produced by a model.

### LLM-derived

Produced by optional LLM analysis.

The UI should communicate this distinction.

Example:

```text
✓ FACT
182,392 rows

⚠ HEURISTIC
Potential duplicate dataset

🧠 ML
27 statistical anomalies

✨ AI
Possible interpretation...
```

This is extremely important for trust.

---

# 31. EVIDENCE SYSTEM

Every significant finding should have an evidence trail.

For example:

```text
⚠ Unusually large file

model.pkl
4.7 GB

Evidence:
• 99.2 percentile among project files
• 31× larger than median model file
```

Clicking the evidence should navigate to the relevant location where possible.

For PDFs:

> Page 27

For CSV:

> Column `revenue`

For code:

> `src/auth.py:182`

For folders:

> `/project/backups/`

---

# 32. MULTI-OBJECT ANALYSIS

Initial release should support multiple objects being inspected together.

Example:

```text
report.pdf
sales.csv
project/
```

Produce:

```text
3 OBJECTS

✓ report.pdf
✓ sales.csv
✓ project/

RELATIONSHIPS

report.pdf ↔ sales.csv
Possible shared date range

project/ ↔ sales.csv
Matching schema reference detected
```

Only report relationships supported by actual evidence.

---

# 33. ANALYSIS HISTORY

Save analysis history locally by default.

Example:

```text
HISTORY

Today
  sales.csv
  project/
  image.png

Yesterday
  report.pdf
```

Store:

* object identity
* analysis result
* timestamp
* hashes
* analyzer version

Do not store entire source files unless explicitly necessary.

The user must be able to disable history.

Provide:

> **Clear history**

and:

> **Delete all stored analysis data**

---

# 34. CACHING

Avoid repeatedly analyzing unchanged objects.

Use hashes and metadata.

Example:

```text
SHA-256
+
analyzer version
+
configuration
```

If unchanged:

> ✓ Analysis already available.

Allow:

> Re-analyze

---

# 35. PROGRESS

Deep analysis must provide meaningful progress.

Example:

```text
Analyzing project...

✓ Detecting files
✓ Calculating statistics
✓ Inspecting dependencies
⟳ Analyzing source code
○ Detecting anomalies
○ Building report
```

Allow cancellation.

Cancellation must safely stop work without modifying source data.

---

# 36. ERROR HANDLING

Never crash because of a malformed file.

Instead:

```text
⚠ Could not fully inspect this PDF.

Successfully extracted:
• metadata
• 18 pages
• 4,821 words

Unable to extract:
• 3 embedded objects
```

Continue analysis wherever possible.

---

# 37. SECURITY

Treat every input as untrusted.

Never:

* execute uploaded files
* execute scripts found in archives
* execute macros
* run binaries
* install dependencies from analyzed projects
* modify analyzed repositories
* automatically invoke shell commands contained in files

Use sandboxing where possible.

Limit:

* file size
* recursion
* archive expansion
* memory
* CPU
* network access

---

# 38. STRICT READ-ONLY POLICY

This is non-negotiable.

Inspect This is an **inspection application**.

It must never:

* delete files
* rename files
* modify files
* edit repositories
* modify databases
* install packages
* "clean up" automatically

There should be **no mutation functionality in v1**.

Even if an analyzer detects:

> "17 duplicate files"

it must only report them.

---

# 39. BROWSER VERSION

The browser application should provide:

* drag/drop
* file selection
* analysis UI
* results
* history where technically possible
* optional LLM provider configuration

Use browser APIs to inspect files locally.

Do not upload files by default.

Clearly communicate browser limitations.

Example:

> "Browser mode cannot inspect files outside the files you explicitly select."

---

# 40. DESKTOP GLOBAL HOTKEY

Implement:

### Ctrl/Cmd + Space

Open/focus Inspect This.

The exact modifier should follow platform conventions.

Also allow the user to configure the shortcut later.

---

# 41. CLIPBOARD ANALYSIS

Implement:

### Ctrl/Cmd + Shift + V

Analyze clipboard content where practical.

Support:

* copied text
* copied images
* clipboard file references where the OS permits

Example:

```text
Copy text
   ↓
Ctrl + Shift + V
   ↓
Inspect This
   ↓
analysis
```

---

# 42. SETTINGS

Settings should include:

## General

* launch on startup
* show floating bubble
* bubble position
* always-on-top
* global hotkey
* theme
* animations

## Privacy

* local-only mode
* analysis history
* clear history
* cache
* telemetry: OFF by default

## Analysis

* instant analysis
* deep analysis
* CPU limits
* maximum file size
* archive recursion depth

## AI

* enabled/disabled
* provider
* endpoint
* model
* API key
* maximum context
* send raw content toggle where applicable

Default:

**AI disabled.**

---

# 43. AI DATA CONTROL

Before LLM analysis, show a concise explanation.

Example:

```text
AI ANALYSIS

Local analysis is complete.

Inspect This can send the following
structured information to your configured model:

✓ file metadata
✓ extracted statistics
✓ detected findings
✓ selected text excerpts

[ Analyze with AI ]

[ Keep Local Only ]
```

Do not silently upload source data.

---

# 44. OPTIONAL LOCAL LLM

Support local LLMs through OpenAI-compatible APIs.

Especially:

* Ollama
* LM Studio

This allows:

```text
LOCAL ANALYSIS
+
LOCAL LLM
=
100% local AI workflow
```

This should be highlighted as a major feature.

---

# 45. PLUGIN ARCHITECTURE

Analyzers must be modular.

Conceptually:

```text
analyzers/
├── core/
├── generic/
├── pdf/
├── images/
├── audio/
├── video/
├── csv/
├── spreadsheets/
├── git/
├── code/
├── logs/
├── databases/
├── archives/
└── web/
```

Each analyzer should expose:

```text
canHandle(input)
analyze(input, context)
```

with structured results.

Make it possible to add future analyzers without rewriting the core application.

---

# 46. ANALYZER CAPABILITIES

The UI should know what an analyzer can do.

For example:

```text
sales.csv

Available:
✓ Structure
✓ Statistics
✓ Anomalies
✓ Relationships
✓ Visualization

Unavailable:
○ OCR
○ Git history
○ Audio analysis
```

This makes the system transparent.

---

# 47. UI DESIGN

The application should feel:

* premium
* technical
* calm
* fast
* slightly playful
* trustworthy

Use subtle iconography.

Possible sections:

```text
Overview
Facts
Structure
Important
Unusual
Relationships
Recommendations
Evidence
Raw Details
```

Do not overload the user immediately.

The overview should be concise.

---

# 48. ANALYSIS CARD DESIGN

Example:

```text
┌─────────────────────────────────────┐
│ 🚨 IMPORTANT                        │
│                                     │
│ Revenue is heavily concentrated.   │
│                                     │
│ Evidence                            │
│ Top 4% of customers = 61% revenue  │
│                                     │
│ Confidence: High                    │
│ Source: Statistical analysis        │
└─────────────────────────────────────┘
```

Cards should be expandable.

---

# 49. VISUALIZATIONS

Use visualizations where they genuinely improve understanding.

For example:

CSV:

* histograms
* distributions
* correlations
* missing-value map

Folder:

* file-type treemap
* directory tree
* size distribution

Git:

* commit activity
* contributor graph
* file churn
* dependency graph

Image:

* color palette
* dimensions
* similarity map

Do not turn every analysis into a dashboard.

---

# 50. “WHAT IS THIS?” WITHOUT AN LLM

The local engine should produce a deterministic classification.

For example:

```text
📊 DATASET

Confidence:
96%

Because:
• tabular structure
• 182k records
• repeated schema
• numerical/categorical columns
```

Or:

```text
💻 SOFTWARE PROJECT

Confidence:
99%

Because:
• package manifest
• source files
• dependency tree
• version-control metadata
```

Use explainable signals.

---

# 51. “WHAT'S WEIRD?”

This should be one of the signature features.

Build an anomaly engine.

Possible techniques:

* statistical thresholds
* percentile analysis
* clustering
* isolation forest
* duplicate detection
* structural comparison
* pattern frequency
* temporal anomaly detection

Every anomaly should have evidence.

Never manufacture weirdness simply to populate the section.

If nothing is unusual:

> **Nothing obviously unusual detected.**

That is a valid result.

---

# 52. “WHAT SHOULD I DO?”

Without an LLM, this should come from rules.

Example:

```text
Finding:
41 duplicate files

Recommendation:
Review duplicate groups before archiving.

Finding:
4.8% missing values

Recommendation:
Inspect columns with >20% missing values.
```

Recommendations should be conservative.

No automatic action.

---

# 53. LLM ENHANCEMENT

If enabled, the LLM can synthesize:

* plain-English explanation
* contextual summary
* cross-object relationships
* natural-language recommendations
* questions worth investigating
* executive summary

But clearly label it:

> ✨ AI INTERPRETATION

The LLM must not overwrite factual local analysis.

It should sit on top of it.

---

# 54. LLM PROMPTING ARCHITECTURE

Send structured analysis such as:

```json
{
  "object": {...},
  "facts": [...],
  "findings": [...],
  "anomalies": [...],
  "relationships": [...],
  "recommendations": [...]
}
```

Ask the model to:

1. summarize
2. explain importance
3. identify patterns
4. suggest questions
5. avoid inventing facts
6. cite supplied evidence
7. clearly identify uncertainty

The model must not claim it inspected information that was not supplied.

---

# 55. NO LLM DEPENDENCY

The project must compile and run without:

* OpenAI
* Anthropic
* Gemini
* any cloud API
* any API key

LLM support must be an optional module.

---

# 56. PERFORMANCE

The application should feel fast.

Target:

* bubble appears quickly at startup
* clicking bubble should feel instantaneous
* drag/drop feedback under 100 ms where practical
* metadata analysis immediately
* results stream progressively
* heavy analysis runs off the UI thread
* UI remains responsive

Never block the main UI while analyzing large objects.

---

# 57. LARGE FILE HANDLING

Never blindly load enormous files into memory.

Use:

* streaming
* chunked reads
* sampling
* memory limits
* lazy parsing

For very large datasets:

> "Analyzed 10 million sampled rows."

Clearly communicate sampling.

---

# 58. OBSERVABILITY

Do not add invasive telemetry.

Provide local diagnostic logs.

Allow:

> Export diagnostic information

which produces a sanitized diagnostic package.

Default telemetry:

**OFF.**

---

# 59. TESTING

Create automated tests for:

### Analyzer tests

Every analyzer should have fixture files.

Test:

* valid files
* malformed files
* empty files
* huge files
* unusual encodings
* corrupted files
* nested archives

### Security tests

Verify:

* no execution
* no writes
* archive limits
* path traversal protection
* oversized file protection

### UI tests

Test:

* bubble
* drag/drop
* file picker
* history
* settings
* cancellation

### LLM tests

Use mocked OpenAI-compatible endpoints.

Never require a real API key in CI.

---

# 60. README

The GitHub README should immediately communicate the idea.

Opening section:

```text
# Inspect This

### Drop anything. Understand it.

A privacy-first universal digital object analyzer.

Drop a file, folder, dataset, image, PDF,
Git repository, website, log, or database.

Inspect This tells you:

🔍 What is this?
🚨 What matters?
👁️ What's unusual?
🧭 What's connected?
🛠️ What should I investigate?

No LLM required.

Everything can run locally.

Optional AI analysis is supported through
OpenAI-compatible providers.
```

Include a GIF/video demonstrating:

```text
drag file
→ bubble reacts
→ analysis
→ findings
→ evidence
```

This demo is extremely important.

---

# 61. OPEN SOURCE POSITIONING

Emphasize:

### Local first

### Explainable

### Extensible

### No forced AI

### Open source

### Read-only

### Cross-platform

The project's philosophy should be:

> **AI can explain your data, but Inspect This should understand its structure without AI.**

---

# 62. FUTURE ROADMAP

Do NOT implement all of these now.

Design the architecture so they can eventually be added.

Potential future features:

* browser extension
* more database formats
* video semantic analysis
* audio semantic analysis
* more ML models
* local embeddings
* object relationship graphs
* plugin marketplace
* community analyzers
* cloud synchronization
* collaborative analysis
* command-line interface
* API
* MCP server
* mobile companion
* automation integrations

But **do not let future scope prevent a working v1.**

---

# 63. V1 PRIORITY

The first working release should prioritize:

### MUST HAVE

* desktop app
* browser app
* floating bubble
* clickable bubble
* drag/drop
* file picker
* global hotkey
* local analysis
* read-only operation
* analysis history
* caching
* progress indicators
* cancellation
* settings
* privacy indicators
* analyzer architecture
* PDF
* CSV
* JSON
* text/Markdown
* images
* folders
* ZIP
* Git repositories
* source code
* logs
* SQLite
* optional OpenAI-compatible LLM
* Ollama/LM Studio compatibility

### SHOULD HAVE

* Excel
* DOCX
* PPTX
* audio
* video
* website analysis
* OCR
* image similarity
* statistical anomaly detection
* visualizations

If some SHOULD HAVE components significantly delay a stable build, implement them as modular analyzers after the core application works.

---

# 64. CRITICAL DEVELOPMENT RULE

Do not build a fake demo.

The application must actually:

* inspect files
* calculate real statistics
* generate real findings
* preserve evidence
* run locally
* remain read-only
* handle errors
* support real drag/drop
* remember settings
* cache analysis
* provide actual LLM provider configuration

Do not populate the interface with fabricated example findings except inside dedicated demo/test fixtures.

---

# 65. DEVELOPMENT PROCESS

Follow this implementation order:

### Step 1

Create repository and project structure.

### Step 2

Implement desktop shell and browser frontend.

### Step 3

Implement floating bubble.

### Step 4

Implement drag/drop and file selection.

### Step 5

Implement core inspection abstraction.

### Step 6

Implement generic file analyzer.

### Step 7

Implement:

* text
* JSON
* Markdown
* CSV
* image
* folder

### Step 8

Implement:

* PDF
* archives
* Git
* source code
* logs
* SQLite

### Step 9

Implement deep-analysis framework.

### Step 10

Implement anomaly engine.

### Step 11

Implement history and caching.

### Step 12

Implement evidence system.

### Step 13

Implement optional LLM provider abstraction.

### Step 14

Implement Ollama/LM Studio/OpenAI-compatible support.

### Step 15

Implement website/document/spreadsheet/audio/video analyzers.

### Step 16

Polish UI.

### Step 17

Security audit.

### Step 18

Automated testing.

### Step 19

Package desktop applications.

### Step 20

Write README and documentation.

---

# 66. IMPORTANT: DON'T OVERENGINEER THE FIRST RELEASE

The goal is to get to:

```text
INSTALL
   ↓
BUBBLE APPEARS
   ↓
DRAG FILE
   ↓
LOCAL ANALYSIS
   ↓
BEAUTIFUL RESULT
```

as quickly as possible.

A user should be able to experience the core magic within **30 seconds of installing the application**.

---

# 67. THE “MAGIC MOMENT”

The most important UX test is:

A user installs Inspect This.

They see:

```text
       ✦
```

on the side of their screen.

They drag:

```text
mystery.zip
```

onto it.

The bubble expands.

Then:

```text
🔍 INSPECTING...

✓ 2,184 files
✓ 17 directories
✓ 3.8 GB
✓ 42 duplicates
✓ 12 suspiciously large files
✓ Git repository detected
✓ Python project detected
```

Then:

# 💻 PYTHON PROJECT

> **183,291 lines**

### 🚨 IMPORTANT

> The repository contains 3 separate dependency environments.

### 👁️ UNUSUAL

> `backup/` contains a second copy of the entire project.

### 🧭 STRUCTURE

> Backend → API → database → models

### 🛠️ INVESTIGATE

> The largest source file contains 18,221 lines.

And then:

> **✨ Ask your connected AI for a deeper explanation**

That is the product.

---

# 68. FINAL QUALITY BAR

Before considering the implementation complete, verify:

### UX

* Is the bubble attractive?
* Is it unobtrusive?
* Does drag/drop feel natural?
* Does analysis feel fast?
* Are results understandable?

### Technical

* Does local analysis work without AI?
* Does the app remain responsive?
* Does it handle large files?
* Does it survive malformed files?
* Is everything read-only?
* Is the browser version functional?

### Privacy

* Are files kept local by default?
* Is AI opt-in?
* Is network activity transparent?
* Is history local?
* Is telemetry disabled?

### Extensibility

* Can a new analyzer be added without modifying core code?
* Is the result schema stable?
* Can new LLM providers be added easily?

### Trust

* Can every finding be explained?
* Is evidence available?
* Are inferences distinguished from facts?
* Does the system avoid making claims it cannot support?

---

# 69. MOST IMPORTANT PRODUCT PRINCIPLE

**Do not make Inspect This an AI wrapper.**

The core product is:

> **A universal local analysis engine.**

AI is an optional interpretation layer.

The ideal experience is:

```text
                    INSPECT THIS
                         │
                 ┌───────▼────────┐
                 │  LOCAL ENGINE  │
                 └───────┬────────┘
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
     FACTS           ANOMALIES         STRUCTURE
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                         ▼
                 INSPECTION REPORT
                         │
                 ┌───────┴────────┐
                 │                │
              LOCAL ONLY      OPTIONAL AI
```

**If the AI provider disappears tomorrow, Inspect This should still be a useful and impressive application.**

That is the standard the implementation should meet.

---

## Final instruction to the coding agent

**Start building the application now.**

Do not stop at architecture.

Do not create placeholder screens instead of functionality.

Implement the core vertical slice first:

> **Floating bubble → drag/drop → local inspection → real analysis → evidence-backed results.**

Once that works end-to-end, expand the analyzer ecosystem.

When choosing between adding another feature and improving reliability, privacy, performance, or the core inspection experience, **prioritize the latter**.

The finished application should feel like a real open-source product someone would install because they saw the demo and thought:

> **“Wait… I can literally drop anything on this?”**
