# Report source of truth

Read when changing DOCX write/open behavior.

The active report path is defined only in `report-source-of-truth.json`.

- `original_docx`: read-only seed report. Never write here.
- `working_final_docx`: active shared output report. All dashboard runs write here.
- `active_output_role`: key that points to the one active output.

Rules:

- `apply_to_docx.py` must load report paths from the manifest.
- The dashboard open button must load/open the same manifest active output.
- Any future script that writes or opens the report must use this manifest, not a hardcoded DOCX path.
- If active output equals original, writer must fail before touching the file.
