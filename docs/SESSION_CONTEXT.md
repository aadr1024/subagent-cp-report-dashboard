# Session Context

This document captures the important working context from the dashboard-building session so another agent can continue without relying on chat history.

## User intent

Aadi wants a real-time, agent/subagent-only workflow for filling CP installation report tables from source photos. The goal is not just final values; the workflow must make the agent process inspectable, correctable, and optimizable.

The dashboard should let Aadi watch extraction, API requests, evidence, confidence, errors, DOCX writes, speed, cost-like usage, and user feedback loops as they happen.

## Important constraints

- Never modify the original report.
- Write into copied/final reports only.
- Use OpenAI/LLM agents and subagents for visual extraction.
- Do not use non-OpenAI OCR/AI.
- Do not commit source photos, generated DOCX files, run artifacts, API logs, or thumbnails.
- Keep UI responsive: avoid re-render jumps, heavy images, and large DOM expansion.

## Source dataset

The site photos folder contains 35 structure folders:

- first: `001 - 238 (19 May 2026)`
- examples: `004 - 234 (19 May 2026)`, `026 - 193 (24 May 2026)`
- last: `035 - 183 (26 May 2026)`

The STR mapping is ordinal-based. For example:

- `026 - 193` maps to the 26th STR block in the DOCX, even if the report heading still says `STR XXX`.
- target table block formula used by the code: `table3_index = 5 + (ordinal - 1) * 4`, then table4/table5/table6 are the next three tables.

## Existing completed examples

STR193 was run and written into a copied report. The final shared report path is now:

`/Users/aadityarajesh/Downloads/MT/j260101 local/CP installation report/CP Installation Report___CETO 962L-986L__subagent-dashboard-FINAL.docx`

Earlier individual output paths exist locally but should not be committed.

## Dashboard design decisions

### Whole-document control room

The dashboard is now structured around the whole report rather than one STR. It lists all STR folders in ordinal order and lets the user start/reuse/fresh-run individual STRs.

### Parent and leaf agents

Every run should expose parent nodes and leaf nodes:

- parent nodes show prompt summaries and active status
- leaf nodes show values, evidence, confidence, source images, unresolved notes
- DOCX writing is treated as part of the run, not a hidden post-process

### User feedback loop

Clicking a value chip opens a feedback box. Enter saves. Escape cancels. Feedback is sent to `/api/feedback`, appended to server-side feedback logs, shown in the left feedback console, and loaded into future prompts for the same STR.

### Hover evidence

A value hover should show:

- current image large
- used evidence group band
- five previous images
- current highlighted image
- five next images

Images are served via cached thumbnail endpoints, not full originals, to keep the UI responsive.

### Fold rail

The floating fold rail is a convenience navigator:

- translucent by default
- clearer on hover/focus
- one STR per row
- explicit collapsed/open indicator
- click opens exactly one STR by default
- neighbors are only prewarmed, not opened
- open action scrolls to the board and flashes the target area

### Performance protections

The UI uses:

- thumbnail endpoints
- async decode/lazy loading
- CSS containment
- stable intrinsic sizes
- poll deferral while hovering/typing
- small default expanded board count
- floating rail instead of rendering all boards expanded

## Observability goals

The dashboard should expose both aggregate and per-run metrics:

- folders total
- runs started
- complete/running/failed
- API call count
- API elapsed seconds
- model request count
- total/input/output/cached/reasoning tokens
- image input counts
- average completed duration
- slowest API calls
- per-run active step
- leaf completion counts
- warnings/unresolved counts

Exact dollar cost is intentionally not shown unless pricing is configured. Token counts are shown for cost reasoning.

