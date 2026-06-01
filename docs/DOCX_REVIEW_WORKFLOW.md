# DOCX Review Workflow

This dashboard treats the active final DOCX as the readback source of truth for values.

Durable ledgers under `runs/` explain reviewer decisions:

- `docx-review-feedback.jsonl`: human review notes per DOCX slot.
- `docx-cell-locks.jsonl`: append-only lock/unlock events for cells and rows.
- `docx-source-corrections.jsonl`: append-only reviewer corrections to source image ranges.
- `audits/manual-agent-mapping-latest.json`: latest comparison between manual image-grid labels and agent source mappings.

Important invariant: the browser must not invent lasting state. If a correction is visible after refresh, it must have been replayed from a backend ledger or from the active DOCX readback.

Source-range corrections do not edit DOCX values. They correct the evidence mapping used for review, future validation, and future subagent prompts.

Manual-vs-agent mapping audit:

- Manual source: configured `annotation_source` from the report source-of-truth manifest.
- Agent source: `/api/docx-review` payload, after source correction ledger replay.
- Comparison artifact: `runs/audits/manual-agent-mapping-*.json`.
- Actionable statuses: `one_image_off`, `mismatch`, `agent_missing_source`, `manual_missing_label`, and `partial_overlap`.

Reviewer controls should keep common one-image-off fixes cheap: shift left/right, extend before/after, trim first/last, and reset.

Floating preview source picker:

- Hover a DOCX Review cell that has evidence.
- The floating image preview shows a `Correct evidence range` toolbar.
- Drag across thumbnails, or shift-click from one image to another, to choose a contiguous evidence range.
- `Save selected range` writes `action: set_explicit` to `docx-source-corrections.jsonl`.
- Refresh state must come from `docx_review.py` replaying that ledger; browser-only selection is never authoritative.
