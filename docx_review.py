from __future__ import annotations

import json
import re
import zipfile
from datetime import datetime
from pathlib import Path

from lxml import etree

import apply_to_docx


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
SITE_ROOT = Path("/Users/aadityarajesh/Downloads/MT/j260101 local/site-photos")
DOCX_REVIEW_FEEDBACK = RUNS / "docx-review-feedback.jsonl"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


class PatchState:
    def __init__(self, state: dict):
        self.state = state


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


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


def stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def cell_text(cell) -> str:
    return " ".join("".join(t.text or "" for t in cell.xpath(".//w:t", namespaces=NS)).split())


def structure_from_folder(name: str) -> str | None:
    match = re.search(r"-\s*(\d{3})\b", name)
    if match:
        return match.group(1)
    matches = re.findall(r"\b(\d{3})\b", name)
    return matches[-1] if matches else None


def source_structures() -> dict[str, dict]:
    out = {}
    if not SITE_ROOT.exists():
        return out
    for path in SITE_ROOT.iterdir():
        if not path.is_dir():
            continue
        structure = structure_from_folder(path.name)
        if structure:
            out[structure] = {"structure": structure, "source_folder": str(path), "source_folder_name": path.name}
    return out


def all_run_dirs_by_structure() -> dict[str, list[tuple[Path, dict]]]:
    runs: dict[str, list[tuple[Path, dict]]] = {}
    skip = {"validations", "regression-rechecks", ".thumbs"}
    for path in RUNS.iterdir():
        if not path.is_dir() or path.name.startswith(".") or path.name in skip:
            continue
        state = read_json(path / "state.json", {})
        structure = str(state.get("structure") or "").strip()
        if not structure:
            continue
        runs.setdefault(structure, []).append((path, state))
    for items in runs.values():
        items.sort(key=lambda item: str(item[1].get("updated_at") or item[1].get("started_at") or item[0].name))
    return runs


EXPECTED_LEAVES = {
    "table3-north",
    "table3-east",
    "table3-south",
    "table3-west",
    "table4-stations",
    "table5-currents",
    "table6-potentials",
}


def run_quality(run_dir: Path) -> dict:
    results = read_json(run_dir / "leaf-results.json", {})
    readings = 0
    useful_leaves = 0
    error_leaves = 0
    for name, payload in results.items():
        if not isinstance(payload, dict):
            continue
        leaf_readings = payload.get("readings") or []
        if payload.get("error") or payload.get("status") == "failed":
            error_leaves += 1
        if isinstance(leaf_readings, list):
            readings += len(leaf_readings)
            if name in EXPECTED_LEAVES and leaf_readings:
                useful_leaves += 1
    return {
        "readings": readings,
        "useful_leaves": useful_leaves,
        "error_leaves": error_leaves,
        "usable": readings > 0 and useful_leaves >= 3,
    }


def preferred_run_item(items: list[tuple[Path, dict]]) -> tuple[Path, dict] | None:
    for path, state in reversed(items):
        if run_quality(path)["usable"]:
            return path, state
    return items[-1] if items else None


def run_dirs_by_structure() -> dict[str, tuple[Path, dict]]:
    return {structure: item for structure, items in all_run_dirs_by_structure().items() if (item := preferred_run_item(items))}


def parse_docx_tables(docx: Path):
    if not docx.exists():
        return []
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    with zipfile.ZipFile(docx) as zf:
        root = etree.fromstring(zf.read("word/document.xml"), parser)
    return root.xpath(".//w:tbl", namespaces=NS)


def docx_value(tables, table_index, row_index, col_index) -> str:
    if table_index is None or table_index >= len(tables):
        return ""
    rows = tables[table_index].xpath("./w:tr", namespaces=NS)
    if row_index >= len(rows):
        return ""
    cells = rows[row_index].xpath("./w:tc", namespaces=NS)
    if col_index >= len(cells):
        return ""
    return cell_text(cells[col_index])


def slot_specs() -> list[dict]:
    specs = []
    table3_rows = [
        ("table3-north", "Table 3 North", 2),
        ("table3-east", "Table 3 East", 3),
        ("table3-south", "Table 3 South", 4),
        ("table3-west", "Table 3 West", 5),
    ]
    for agent, group, row in table3_rows:
        for index, col in enumerate([2, 4, 6, 8, 10], start=1):
            specs.append({
                "table_key": "table3",
                "group": group,
                "agent": agent,
                "label": f"Reading {index}",
                "row_index": row,
                "col_index": col,
            })
    for row, group, labels in [
        (1, "Table 4 Stations", ["Anodes TS1", "Anodes TS2"]),
        (2, "Table 4 Stations", ["Shunt TS1", "Shunt TS2"]),
        (3, "Table 4 Stations", ["Total current TS1", "Total current TS2"]),
        (5, "Table 4 Stations", ["Life TS1", "Life TS2"]),
    ]:
        for col, label in enumerate(labels, start=1):
            specs.append({
                "table_key": "table4",
                "group": group,
                "agent": "table4-stations",
                "label": label,
                "row_index": row,
                "col_index": col,
            })
    for index in range(1, 8):
        specs.append({
            "table_key": "table5",
            "group": "Table 5 Currents",
            "agent": "table5-currents",
            "label": f"MG {index}",
            "row_index": 1,
            "col_index": index,
        })
    for index in range(1, 8):
        specs.append({
            "table_key": "table6",
            "group": "Table 6 Potentials",
            "agent": "table6-potentials",
            "label": f"MG {index}",
            "row_index": 1,
            "col_index": index,
        })
    return specs


def patch_for_run(run_dir: Path, state: dict) -> tuple[dict, str | None]:
    if not (run_dir / "leaf-results.json").exists():
        return {"cells": []}, "leaf-results.json missing"
    if not state.get("target", {}).get("target_tables"):
        return {"cells": []}, "target table mapping missing"
    try:
        return apply_to_docx.build_patch(run_dir, PatchState(state)), None
    except Exception as exc:
        return {"cells": []}, str(exc)


def classify_slot(run_status: str, expected: str | None, actual: str, patch_error: str | None) -> str:
    expected_text = "" if expected is None else str(expected).strip()
    actual_text = str(actual or "").strip()
    if run_status == "not_started":
        return "not_started"
    if patch_error and not expected_text:
        return "patch_error"
    if expected_text and not actual_text:
        return "missing_write"
    if expected_text and actual_text and expected_text != actual_text:
        return "mismatch"
    if expected_text and actual_text == expected_text:
        return "matched"
    if not expected_text and actual_text:
        return "docx_only"
    return "blank"


def source_refs_from_notes(notes) -> list[str]:
    if isinstance(notes, dict):
        return [str(item) for item in notes.get("source_images") or [] if item]
    return []


def docx_slot_key(structure: str, slot: dict) -> str:
    return "|".join(str(part) for part in [
        structure,
        slot.get("table_key") or "",
        slot.get("label") or "",
        slot.get("row_index") or "",
        slot.get("col_index") or "",
    ])


def feedback_by_slot() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for item in read_jsonl(DOCX_REVIEW_FEEDBACK):
        key = str(item.get("slot_key") or "")
        if not key:
            continue
        out.setdefault(key, []).append(item)
    return out


def mg_number(label: str) -> int | None:
    match = re.search(r"\bMG\s*(\d+)\b", str(label or ""), re.I)
    return int(match.group(1)) if match else None


def numeric_cell(value: str) -> int | None:
    match = re.search(r"-?\d+", str(value or ""))
    return int(match.group(0)) if match else None


def apply_derived_anode_count_checks(slots: list[dict]) -> None:
    table5 = [slot for slot in slots if slot.get("table_key") == "table5"]
    station_counts = {1: 0, 2: 0}
    station_sources = {1: [], 2: []}
    for slot in table5:
        if not str(slot.get("actual") or "").strip():
            continue
        mg = mg_number(slot.get("label"))
        if not mg:
            continue
        station = 1 if mg <= 3 else 2
        station_counts[station] += 1
        for source in [slot.get("source_ref"), *source_refs_from_notes(slot.get("notes"))]:
            if source and str(source).lower().endswith((".jpg", ".jpeg", ".png", ".heic")):
                station_sources[station].append(str(source))
    for station in (1, 2):
        derived = station_counts[station]
        if derived <= 0:
            continue
        label = f"Anodes TS{station}"
        slot = next((item for item in slots if item.get("table_key") == "table4" and item.get("label") == label), None)
        if not slot:
            continue
        writer_count = numeric_cell(slot.get("expected"))
        if writer_count and writer_count > 0:
            derived = writer_count
            derived_source = "writer station-derived count"
        else:
            derived_source = "fallback occupied Table 5 MG split"
        actual_count = numeric_cell(slot.get("actual"))
        if actual_count == derived:
            slot.setdefault("source_refs", station_sources[station])
            continue
        slot["writer_expected"] = slot.get("expected") or ""
        slot["expected"] = str(derived)
        slot["derived_expected"] = str(derived)
        slot["status"] = "derived_mismatch" if str(slot.get("actual") or "").strip() else "missing_write"
        slot["notes"] = {
            "issue": "Derived anode count mismatch: Table 4 count must equal occupied Table 5 MG slots for the station.",
            "station": station,
            "mg_slots_filled": derived,
            "writer_expected": slot.get("writer_expected") or "",
            "source_images": sorted(set(station_sources[station])),
        }
        slot["source_refs"] = sorted(set(station_sources[station]))


def summarize(slots: list[dict]) -> dict:
    total = len(slots)
    filled = sum(1 for item in slots if str(item.get("actual") or "").strip())
    expected = sum(1 for item in slots if str(item.get("expected") or "").strip())
    counts = {}
    for item in slots:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    problem = sum(counts.get(key, 0) for key in ("missing_write", "mismatch", "patch_error", "derived_mismatch"))
    return {
        "total": total,
        "filled": filled,
        "blank": total - filled,
        "expected": expected,
        "matched": counts.get("matched", 0),
        "missing_write": counts.get("missing_write", 0),
        "mismatch": counts.get("mismatch", 0),
        "docx_only": counts.get("docx_only", 0),
        "patch_error": counts.get("patch_error", 0),
        "derived_mismatch": counts.get("derived_mismatch", 0),
        "not_started": counts.get("not_started", 0),
        "problem": problem,
        "counts": counts,
    }


def structure_payload(structure: str, source: dict, run_item, tables, specs: list[dict], run_count: int = 0, feedback=None) -> dict:
    feedback = feedback or {}
    run_dir, state = run_item if run_item else (None, {})
    target_tables = state.get("target", {}).get("target_tables") or {}
    run_status = state.get("status") or ("not_started" if not run_item else "unknown")
    patch, patch_error = patch_for_run(run_dir, state) if run_item else ({"cells": []}, None)
    patch_cells = {}
    patch_meta = {}
    for cell in patch.get("cells", []):
        key = (int(cell["table_index"]), int(cell["row_index"]), int(cell["col_index"]))
        patch_cells[key] = str(cell.get("value", ""))
        patch_meta[key] = cell

    slots = []
    for spec in specs:
        table_index = target_tables.get(spec["table_key"])
        table_index = int(table_index) if table_index is not None else None
        key = (table_index, spec["row_index"], spec["col_index"]) if table_index is not None else None
        expected = patch_cells.get(key) if key else None
        actual = docx_value(tables, table_index, spec["row_index"], spec["col_index"]) if table_index is not None else ""
        status = classify_slot("not_started" if not run_item else run_status, expected, actual, patch_error)
        meta = patch_meta.get(key, {}) if key else {}
        slot = {
            **spec,
            "table_index": table_index,
            "expected": expected or "",
            "actual": actual or "",
            "status": status,
            "source_ref": meta.get("source_ref"),
            "source_status": meta.get("source_status"),
            "confidence": meta.get("confidence"),
            "notes": meta.get("notes"),
            "source_refs": [meta.get("source_ref"), *source_refs_from_notes(meta.get("notes"))],
        }
        key_text = docx_slot_key(structure, slot)
        slot["feedback_key"] = key_text
        slot["feedback"] = feedback.get(key_text, [])[-8:]
        slots.append(slot)

    apply_derived_anode_count_checks(slots)
    summary = summarize(slots)
    if not run_item:
        status = "not_started"
    elif summary["problem"]:
        status = "needs_attention"
    elif summary["blank"]:
        status = "partial_or_blank"
    else:
        status = "complete"

    return {
        "structure": structure,
        "status": status,
        "run_id": state.get("run_id") if state else None,
        "run_count": run_count,
        "run_version": run_count if run_item else 0,
        "run_version_label": f"{run_count} / {run_count}" if run_item and run_count else "0 / 0",
        "run_status": run_status,
        "updated_at": state.get("updated_at"),
        "source_folder": source.get("source_folder"),
        "source_folder_name": source.get("source_folder_name"),
        "target_tables": target_tables,
        "patch_error": patch_error,
        "summary": summary,
        "slots": slots,
    }


def build_payload() -> dict:
    source = apply_to_docx.load_report_source_of_truth()
    active_docx = Path(source["active_docx"])
    tables = parse_docx_tables(active_docx)
    sources = source_structures()
    all_runs = all_run_dirs_by_structure()
    runs = {structure: item for structure, items in all_runs.items() if (item := preferred_run_item(items))}
    structures = sorted(set(sources) | set(runs), key=lambda value: int(value) if value.isdigit() else value)
    specs = slot_specs()
    feedback = feedback_by_slot()
    items = [structure_payload(structure, sources.get(structure, {}), runs.get(structure), tables, specs, len(all_runs.get(structure, [])), feedback) for structure in structures]
    all_slots = [slot for item in items for slot in item["slots"]]
    return {
        "updated_at": stamp(),
        "source_of_truth": source,
        "active_docx": str(active_docx),
        "active_docx_exists": active_docx.exists(),
        "active_docx_mtime": datetime.fromtimestamp(active_docx.stat().st_mtime).astimezone().isoformat(timespec="seconds") if active_docx.exists() else None,
        "structure_count": len(items),
        "summary": summarize(all_slots),
        "structures": items,
    }


def main() -> None:
    print(json.dumps(build_payload()))


if __name__ == "__main__":
    main()
