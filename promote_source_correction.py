from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

import apply_to_docx


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
DOCX_SOURCE_CORRECTIONS = RUNS / "docx-source-corrections.jsonl"
DOCX_VALUE_CORRECTIONS = RUNS / "docx-value-corrections.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"

TABLE3_ROW_AGENT = {2: "table3-north", 3: "table3-east", 4: "table3-south", 5: "table3-west"}
TABLE3_COLS = [2, 4, 6, 8, 10]


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            out.append(item)
    return out


def active_source_corrections() -> dict[str, dict]:
    active: dict[str, dict] = {}
    for item in read_jsonl(DOCX_SOURCE_CORRECTIONS):
        key = str(item.get("slot_key") or "")
        if not key:
            continue
        if item.get("action") == "reset" or item.get("status") == "reset":
            active.pop(key, None)
        else:
            active[key] = item
    return active


def latest_run_for_structure(structure: str) -> Path:
    candidates = []
    for path in RUNS.iterdir():
        state_path = path / "state.json"
        if not path.is_dir() or not state_path.exists() or not (path / "leaf-results.json").exists():
            continue
        try:
            state = json.loads(state_path.read_text())
        except Exception:
            continue
        if str(state.get("structure")) == str(structure):
            candidates.append((state.get("updated_at") or state.get("finished_at") or path.name, path))
    if not candidates:
        raise RuntimeError(f"No leaf-result run exists for STR {structure}. Run extraction before promoting corrected sources.")
    return sorted(candidates)[-1][1]


def reading_index(label: str) -> int:
    match = re.search(r"Reading\s*(\d+)", str(label or ""), re.I)
    return int(match.group(1)) if match else 1


def mg_index(label: str) -> int:
    match = re.search(r"MG\s*(\d+)", str(label or ""), re.I)
    return int(match.group(1)) if match else 1


def slot_key(structure: str, table_key: str, label: str, row_index, col_index) -> str:
    return "|".join(str(part) for part in [structure, table_key, label, row_index, col_index])


def readings_by_source(run_dir: Path) -> dict[str, list[dict]]:
    results = json.loads((run_dir / "leaf-results.json").read_text())
    out: dict[str, list[dict]] = {}
    for leaf, payload in results.items():
        if not isinstance(payload, dict):
            continue
        for reading in payload.get("readings") or []:
            source = str(reading.get("source_image") or "")
            if source:
                out.setdefault(source, []).append({"leaf": leaf, **reading})
    return out


def preferred_reading(source: str, table_key: str, lookup: dict[str, list[dict]]) -> dict | None:
    candidates = lookup.get(source) or []
    if table_key == "table3":
        preferred = [item for item in candidates if str(item.get("leaf") or "").startswith("table3-")]
    elif table_key == "table5":
        preferred = [item for item in candidates if item.get("leaf") == "table5-currents"]
    elif table_key == "table6":
        preferred = [item for item in candidates if item.get("leaf") == "table6-potentials"]
    elif table_key == "table4":
        preferred = [item for item in candidates if item.get("leaf") == "table4-stations"]
    else:
        preferred = candidates
    return (preferred or candidates or [None])[0]


def target_cells(correction: dict, run_state: dict) -> list[dict]:
    structure = str(correction["structure"])
    table_key = str(correction.get("table_key") or "")
    label = str(correction.get("label") or "")
    row_index = int(correction.get("row_index") or 0)
    col_index = int(correction.get("col_index") or 0)
    table_index = int(run_state["target"]["target_tables"][table_key])
    sources = [str(item) for item in correction.get("new_source_refs") or [] if item]
    cells = []
    if table_key == "table3":
        start = reading_index(label)
        for offset, source in enumerate(sources):
            idx = start + offset
            if idx > 5:
                break
            cells.append({
                "slot_key": slot_key(structure, "table3", f"Reading {idx}", row_index, TABLE3_COLS[idx - 1]),
                "table_key": "table3",
                "label": f"Reading {idx}",
                "group": TABLE3_ROW_AGENT.get(row_index, "table3"),
                "table_index": table_index,
                "row_index": row_index,
                "col_index": TABLE3_COLS[idx - 1],
                "source_ref": source,
                "display_kind": "mv",
            })
        return cells
    if table_key in {"table5", "table6"}:
        start = mg_index(label)
        for offset, source in enumerate(sources):
            idx = start + offset
            if idx > 7:
                break
            cells.append({
                "slot_key": slot_key(structure, table_key, f"MG {idx}", 1, idx),
                "table_key": table_key,
                "label": f"MG {idx}",
                "group": "Table 5 Currents" if table_key == "table5" else "Table 6 Potentials",
                "table_index": table_index,
                "row_index": 1,
                "col_index": idx,
                "source_ref": source,
                "display_kind": "plain" if table_key == "table5" else "mv",
            })
        return cells
    if sources:
        cells.append({
            "slot_key": slot_key(structure, table_key, label, row_index, col_index),
            "table_key": table_key,
            "label": label,
            "group": "Table 4 Stations" if table_key == "table4" else table_key,
            "table_index": table_index,
            "row_index": row_index,
            "col_index": col_index,
            "source_ref": sources[0],
            "display_kind": "plain",
        })
    return cells


class MinimalState:
    def __init__(self, state: dict):
        self.state = state


def promote(slot_key_arg: str, note: str = "") -> dict:
    correction = active_source_corrections().get(slot_key_arg)
    if not correction:
        raise RuntimeError(f"No active source correction found for {slot_key_arg}")
    structure = str(correction["structure"])
    run_dir = latest_run_for_structure(structure)
    run_state = json.loads((run_dir / "state.json").read_text())
    lookup = readings_by_source(run_dir)
    promotion_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-source-promotion-str{structure}"
    promotion_dir = RUNS / promotion_id
    promotion_dir.mkdir(parents=True, exist_ok=True)
    (promotion_dir / "source-correction.json").write_text(json.dumps(correction, indent=2) + "\n")

    patch_cells = []
    value_events = []
    missing = []
    for target in target_cells(correction, run_state):
        reading = preferred_reading(target["source_ref"], target["table_key"], lookup)
        if not reading:
            missing.append(target["source_ref"])
            continue
        visible = str(reading.get("visible_value") or reading.get("value") or "").strip()
        if not visible:
            missing.append(target["source_ref"])
            continue
        value = apply_to_docx.display_mv(visible) if target["display_kind"] == "mv" else apply_to_docx.display_plain(visible)
        patch_cells.append({
            "table_index": target["table_index"],
            "row_index": target["row_index"],
            "col_index": target["col_index"],
            "value": value,
            "source_ref": target["source_ref"],
            "source_status": "operator_promoted_corrected_source_range",
            "evidence": f"Promoted from corrected source range {correction.get('correction_id')}: {target['source_ref']}",
            "confidence": reading.get("confidence"),
            "notes": {
                "source_correction_id": correction.get("correction_id"),
                "source_correction_slot_key": slot_key_arg,
                "source_method": "existing_agent_leaf_result",
                "reviewer_note": note or correction.get("note") or "",
                "leaf": reading.get("leaf"),
                "unit_seen": reading.get("unit_seen"),
                "reading_notes": reading.get("notes"),
                "source_images": [target["source_ref"]],
            },
        })
        value_events.append({
            "at": now(),
            "promotion_id": promotion_id,
            "source_correction_id": correction.get("correction_id"),
            "source_correction_slot_key": slot_key_arg,
            "slot_key": target["slot_key"],
            "structure": structure,
            "table_key": target["table_key"],
            "label": target["label"],
            "row_index": target["row_index"],
            "col_index": target["col_index"],
            "table_index": target["table_index"],
            "value": value,
            "visible_value": visible,
            "unit_seen": reading.get("unit_seen"),
            "source_refs": [target["source_ref"]],
            "source_method": "existing_agent_leaf_result",
            "note": note or correction.get("note") or "",
            "status": "active",
            "source": "docx_review_source_promotion",
        })
    if missing:
        raise RuntimeError(f"Corrected source image(s) have no existing leaf transcription yet: {', '.join(missing)}. Run fresh extraction or focused recheck first.")
    if not patch_cells:
        raise RuntimeError("No DOCX cells were produced from the corrected source range.")

    patch = {
        "run_id": promotion_id,
        "structure": structure,
        "target": run_state["target"],
        "cells": patch_cells,
        "warnings": [],
    }
    patch_path = promotion_dir / "docx-source-promotion-patch.json"
    patch_path.write_text(json.dumps(patch, indent=2) + "\n")
    out = apply_to_docx.write_docx(promotion_dir, MinimalState({"structure": structure, "target": run_state["target"]}), patch, shared=True)
    with DOCX_VALUE_CORRECTIONS.open("a") as handle:
        for event in value_events:
            handle.write(json.dumps(event) + "\n")
    with FEEDBACK_PROCESSING.open("a") as handle:
        handle.write(json.dumps({
            "at": now(),
            "kind": "docx_source_correction_promoted",
            "promotion_id": promotion_id,
            "structure": structure,
            "slot_key": slot_key_arg,
            "cell_count": len(value_events),
            "output_docx": str(out),
            "values": [{"slot_key": item["slot_key"], "value": item["value"], "source_refs": item["source_refs"]} for item in value_events],
        }) + "\n")
    result = {
        "ok": True,
        "promotion_id": promotion_id,
        "structure": structure,
        "source_run": run_dir.name,
        "cell_count": len(value_events),
        "cells": value_events,
        "output_docx": str(out),
        "patch_artifact": str(patch_path),
    }
    (promotion_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slot-key", required=True)
    parser.add_argument("--note", default="")
    args = parser.parse_args()
    print(json.dumps(promote(args.slot_key, args.note)))


if __name__ == "__main__":
    main()
