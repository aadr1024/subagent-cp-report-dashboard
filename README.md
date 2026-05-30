# Subagent CP Report Dashboard

Real-time control room for turning field photos into source-backed DOCX report tables with LLM agents, human review, immutable locks, and live validation.

This repository is the **software infrastructure only**. It intentionally excludes customer reports, source photos, generated DOCX files, run artifacts, thumbnails, API logs, and local secrets.

## What it does

- Runs parent/leaf agent workflows for report-table extraction.
- Uses OpenAI visual leaves for image evidence review.
- Writes values into a copied final DOCX, never the original report.
- Reads the active final DOCX back as the source of truth.
- Shows every run, validation, feedback, DOCX write, and replay in a live dashboard.
- Lets a reviewer approve cells, lock cells/rows, and detect drift immediately.
- Tracks reusable regression cases so the same error class does not silently return.

## Why it exists

Field-report automation is risky when extracted values disappear into a black box. This dashboard treats extraction as an inspectable workflow:

- values stay tied to source images
- reviewer feedback is durable
- corrected error classes become replayable tests
- final DOCX state is continuously checked
- locked reviewed cells cannot be overwritten silently

## Core workflow

1. Map a structure/report section to its source photo folder.
2. Route photos into table-specific evidence groups.
3. Run OpenAI visual leaf agents for each table section.
4. Build a source-backed DOCX cell patch.
5. Write into the active final DOCX copy.
6. Read the DOCX back and compare actual cells against expected cells.
7. Review cells in a Word-like dashboard table.
8. Lock approved cells/rows so later agents cannot change them silently.
9. Run validation and replay suites until no unsuppressed issues remain.

## Dashboard features

- **Live run boards** for parent and leaf agents.
- **Speed + Health** metrics for API calls, tokens, images, durations, and bottlenecks.
- **DOCX Review** rendered like the report tables: Table 3, Table 4, Table 5, Table 6.
- **Evidence hover previews** with current image plus neighboring context images.
- **Keyboard review flow**: arrows or `j/k` move, `Enter`/`a`/`g` approves and locks, `r` opens review, `l` locks, `u` unlocks.
- **Cell and row locks** backed by an append-only lock ledger.
- **Software Validation Set** for dashboard/pipeline regressions.
- **General Solution Replay Suite** for reusable extraction/validation fixes.

## Safety model

The active final DOCX is the source of truth for review.

- Original DOCX is a read-only seed.
- Active final DOCX path is resolved from config.
- DOCX Review reads the active final DOCX directly.
- Locked cells are monitored for drift.
- Writers block attempted overwrites of locked cells unless the exact cell is unlocked.
- Source data and generated outputs are ignored by git.

## Configuration

The checked-in `report-source-of-truth.json` is a public-safe template.

For real local use, create an ignored `report-source-of-truth.local.json`:

```json
{
  "project": "Private report name",
  "original_docx": "/absolute/path/to/original.docx",
  "working_final_docx": "/absolute/path/to/final-copy.docx",
  "site_root": "/absolute/path/to/site-photo-folders",
  "annotation_source": "/absolute/path/to/annotations.json",
  "report_tool_src": "/absolute/path/to/report-tool/src",
  "heading_pattern": "STR",
  "heading_to_write_template": "STR {structure}",
  "single_output_name_template": "report-subagent-dashboard-STR{structure}.docx",
  "active_output_role": "working_final_docx",
  "never_write_original": true
}
```

Environment variables can override config:

```text
CP_REPORT_CONFIG
CP_REPORT_ORIGINAL_DOCX
CP_REPORT_SITE_ROOT
CP_REPORT_ANNOTATIONS
SBA_REPORT_TOOL_SRC
```

## Running locally

```bash
node server.js
```

Open:

```text
http://127.0.0.1:4873
```

The project expects local report tooling that provides DOCX utilities and OpenAI API helpers. Keep private tool paths in local config or environment variables.

## Repository hygiene

Do not commit:

- `runs/`
- source photos
- original reports
- generated report copies
- API payload logs
- thumbnails
- `.env` files
- `report-source-of-truth.local.json`

Commit only reusable dashboard code and public-safe documentation.
