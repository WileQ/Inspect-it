# Milestone 03 — Deep Local Analysis

## Objective

Make Inspect This substantially more intelligent without requiring an LLM.

## Implement

- statistical anomaly detection
- duplicate detection
- perceptual image similarity
- OCR
- code complexity
- dependency analysis
- advanced document analysis
- cross-object relationships
- visualizations

## Rules

Distinguish:

- measured
- heuristic
- inferred
- ML-derived

Every meaningful finding needs evidence.

Do not invent findings simply to populate the UI.

If nothing unusual is detected, say so.

## Performance

Heavy analysis must:

- run asynchronously
- report progress
- support cancellation
- respect resource limits
- avoid loading huge files entirely into memory

## Completion

Add tests and fixtures.

Run the complete suite.