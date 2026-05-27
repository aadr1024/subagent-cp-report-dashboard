# Subagent CP Report Dashboard

Real-time control room for filling CP installation report tables from source site photos using OpenAI visual leaf agents, reusable transcription artifacts, and a shared final DOCX writer.

This repo intentionally stores only the software infrastructure. It must not store customer report files, source photos, run artifacts, thumbnails, API logs, or generated DOCX outputs.

## Current local context

- Original report: `/Users/aadityarajesh/Downloads/MT/j260101 local/CP installation report/CP Installation Report___CETO 962L-986L .docx`
- Site photos: `/Users/aadityarajesh/Downloads/MT/j260101 local/site-photos`
- Annotation source: `/Users/aadityarajesh/Downloads/all_scripts/streamlit-image-mt/variations/j260101-article-reports/.j260101-article-reports-annotations.json`
- Existing agent knowledge index: `/Users/aadityarajesh/Downloads/all_scripts/AGENT_SUBAGENTS_EMPTY_REPORT_INDEX.md`
- Report tooling source used by this dashboard: `/Users/aadityarajesh/Downloads/MT/us-mike-carose-soil-data-2026/J260106 - SBA (anchor inspections Y-2026) -- in process/src`
- Dashboard URL: `http://127.0.0.1:4873`
- Shared final output: `/Users/aadityarajesh/Downloads/MT/j260101 local/CP installation report/CP Installation Report___CETO 962L-986L__subagent-dashboard-FINAL.docx`

## Problem statement

Fill the CP installation report tables for every available STR folder from site photos, while keeping the original report untouched and making all agent work observable in real time.

Key user requirements:

- Use agents/subagents and OpenAI only for visual extraction.
- Do not use non-OpenAI OCR/AI.
- Keep source data and original report out of version control.
- Show every parent and leaf node in the dashboard.
- Display status, API calls, extracted values, source evidence, confidence, unresolved issues, and DOCX write status live.
- Let the user click values and attach feedback that feeds future agent prompts.
- Allow reruns either by reusing prior transcription or by making fresh OpenAI calls.
- Write completed STR blocks into one shared final report copy.

## Architecture

- `server.js`: local HTTP server, static dashboard, run orchestration endpoints, artifact routes, thumbnail routes, stats endpoint, feedback endpoint.
- `runner.py`: run orchestrator. Maps STR to folder/report tables, loads annotations, routes unannotated folders, dispatches OpenAI visual leaves, and calls the DOCX writer.
- `apply_to_docx.py`: builds source-backed cell patches from leaf JSON, serializes writes through a lock, writes the shared final DOCX, performs structural readback/package checks.
- `public/index.html`: dashboard shell.
- `public/app.js`: live UI, fold rail, stats, feedback, hover evidence, run boards, polling.
- `public/styles.css`: layout, status colors, hover evidence, performance containment, floating panels.

## Agent graph

Parent nodes:

- `run-orchestrator`: coordinates target mapping, evidence routing, leaf extraction, and shared DOCX write.
- `target-mapper`: maps STR number to source folder ordinal and target DOCX table block.
- `annotation-loader`: loads existing Streamlit annotations or invokes router fallback.
- `image-router`: OpenAI planner for unannotated folders; routes folder images into table evidence groups.
- `docx-writer`: translates leaf outputs into table-cell patches and writes/readbacks the shared final DOCX.
- `human-feedback`: captures user feedback for future prompt context.

Leaf nodes:

- `table3-north`
- `table3-east`
- `table3-south`
- `table3-west`
- `table4-stations`
- `table5-currents`
- `table6-potentials`

## Run modes

Dashboard start mode:

- `Reuse transcription`: use latest completed prior `leaf-results.json` for that STR when available; skip OpenAI visual calls and only regenerate the DOCX patch/write/readback.
- `Fresh OpenAI calls`: run visual leaves again.

Reuse mode is the default because transcription is expensive and should not be repeated unless needed.

## Evidence UI

Value chips show:

- extracted visible value
- unit
- source DSC image name
- confidence
- editable label
- click-to-feedback editor

Hover preview shows:

- large current source image
- used evidence group band
- five images before, current image highlighted, five images after
- cached thumbnails, async decode, and lazy loading for snappy interaction

Group evidence behavior:

- Table 3 rows show the row image group used by the leaf.
- Table 5/6 prefer same-station grouping when station data is present.
- If station data is missing, the preview falls back to the leaf image group.

## Dashboard controls

- Fold rail: floating STR list, one folder per row.
- Click rail item: opens only that STR and scrolls to it.
- Click same open item: closes it without scrolling.
- Shift-click: opens/closes a range.
- Cmd/Ctrl-click: toggles one STR without clearing others.
- Opening a board triggers a subtle arrival pulse.
- Live run board heading toggles open/closed.
- Default board density is intentionally small to reduce DOM churn.

## Observability

The `Speed + Health` panel displays:

- folder count and started count
- complete/running/failed totals
- API call count and API elapsed time
- token totals from `llm-usage.summary.json`
- input/output/cached/reasoning token totals
- visual/router image counts
- average completed STR duration
- running-now active step
- slowest API calls across STRs
- per-STR health table

The dashboard also includes per-board live movement logs:

- recent step/agent/API events
- active heartbeat for running boards
- visible log tail so long phases do not appear frozen

## Data and repo safety

Do not commit:

- `runs/`
- source photos
- original report
- generated report copies
- API payload logs
- thumbnails
- local `.env` files

Commit only the reusable dashboard code and documentation.

