# Session Context

This document captures reusable product and engineering context for the Subagent CP Report Dashboard.

## Intent

Build a real-time, agent/subagent workflow for filling CP installation report tables from source photos. The important product goal is not only final values; it is an inspectable, correctable, and auditable workflow.

The dashboard should expose extraction, API requests, evidence, confidence, errors, DOCX writes, speed, token usage, validation, and reviewer feedback loops as they happen.

## Constraints

- Never modify the original report.
- Write into copied/final reports only.
- Use OpenAI/LLM agents and subagents for visual extraction.
- Do not use non-OpenAI OCR/AI.
- Do not commit source photos, generated DOCX files, run artifacts, API logs, thumbnails, or local config.
- Keep UI responsive: avoid rerender jumps, heavy images, and large DOM expansion.

## Source mapping model

The dashboard maps source folders to report sections by ordinal order. A folder can map to the corresponding report block even if the report heading has not yet been relabeled.

The table block model is:

- Table 3: directional pipe-to-soil readings
- Table 4: station summary
- Table 5: current readings by MG/anode
- Table 6: potential readings by MG/anode

## Review and locking model

The active final DOCX is the source of truth for review.

DOCX Review reads the active final DOCX and displays table-shaped review surfaces. When a reviewer approves a cell or row, the lock ledger records the DOCX coordinate and value. Future writers may only write the same value unless that exact cell is unlocked.

Locked drift or attempted overwrite must appear immediately in DOCX Review, Software Validation Set, and the active monitor.

## Observability goals

The dashboard should expose:

- folders total
- runs started
- complete/running/failed
- API call count
- API elapsed seconds
- model request count
- token totals
- image input counts
- average completed duration
- slowest API calls
- per-run active step
- leaf completion counts
- warnings/unresolved counts
- locked-cell drift and attempted overwrites

Exact dollar cost is not shown unless pricing is configured. Token counts are shown for cost reasoning.
