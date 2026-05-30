from __future__ import annotations

import argparse
import fcntl
import json
import math
import re
import shutil
import zipfile
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from lxml import etree


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
CURRENT = RUNS / "current-run.txt"
SOURCE_OF_TRUTH = ROOT / "report-source-of-truth.json"
LOCAL_SOURCE_OF_TRUTH = ROOT / "report-source-of-truth.local.json"
DOCX_CELL_LOCKS = RUNS / "docx-cell-locks.jsonl"


def load_report_source_of_truth() -> dict:
    config_path = Path(__import__("os").environ.get("CP_REPORT_CONFIG", "")).expanduser() if __import__("os").environ.get("CP_REPORT_CONFIG") else (LOCAL_SOURCE_OF_TRUTH if LOCAL_SOURCE_OF_TRUTH.exists() else SOURCE_OF_TRUTH)
    data = json.loads(config_path.read_text())
    original = Path(data["original_docx"]).expanduser().resolve()
    active = Path(data[data.get("active_output_role", "working_final_docx")]).expanduser().resolve()
    if data.get("never_write_original", True) and active == original:
        raise RuntimeError("Report source-of-truth misconfigured: active output equals original DOCX.")
    return {**data, "config_path": str(config_path), "original_docx": str(original), "active_docx": str(active)}


REPORT_SOURCE_OF_TRUTH = load_report_source_of_truth()
ORIGINAL = Path(REPORT_SOURCE_OF_TRUTH["original_docx"])
SHARED_OUTPUT = Path(REPORT_SOURCE_OF_TRUTH["active_docx"])
REPORT_DIR = SHARED_OUTPUT.parent
FINAL_LOCK = RUNS / "final-docx.lock"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


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


def active_cell_locks() -> dict[str, dict]:
    locks: dict[str, dict] = {}
    for item in read_jsonl(DOCX_CELL_LOCKS):
        key = str(item.get("lock_key") or "")
        if not key:
            continue
        action = str(item.get("action") or item.get("status") or "lock").lower()
        if action in {"unlock", "unlocked"}:
            locks.pop(key, None)
        else:
            locks[key] = item
    return locks


def cell_lock_key(structure: str, table_index, row_index, col_index) -> str:
    return "|".join(str(part) for part in [structure, table_index, row_index, col_index])


def enforce_cell_lock(structure: str, item: dict, locks: dict[str, dict] | None = None) -> None:
    locks = locks if locks is not None else active_cell_locks()
    key = cell_lock_key(structure, item.get("table_index"), item.get("row_index"), item.get("col_index"))
    lock = locks.get(key)
    if not lock:
        return
    locked_value = str(lock.get("locked_value") or lock.get("value") or "").strip()
    incoming = str(item.get("value") or "").strip()
    if incoming == locked_value:
        return
    raise RuntimeError(f"Locked DOCX cell write blocked for {key}: locked={locked_value!r}, incoming={incoming!r}. Unlock this exact cell before changing it.")


def q(local: str) -> str:
    return f"{{{W}}}{local}"


def run_dir_from_arg(run_id: str | None) -> Path:
    if run_id:
        return RUNS / run_id
    return RUNS / CURRENT.read_text().strip()


class State:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.state_path = run_dir / "state.json"
        self.events_path = run_dir / "events.jsonl"
        self.state = json.loads(self.state_path.read_text())
        self.seq = 0
        if self.events_path.exists():
            for line in self.events_path.read_text().splitlines():
                if line.strip():
                    self.seq = max(self.seq, int(json.loads(line).get("seq", 0)))

    def write(self):
        self.state["updated_at"] = now()
        self.state_path.write_text(json.dumps(self.state, indent=2) + "\n")

    def emit(self, event_type: str, message: str, **data):
        self.seq += 1
        event = {"seq": self.seq, "at": now(), "type": event_type, "message": message, "data": data}
        with self.events_path.open("a") as handle:
            handle.write(json.dumps(event) + "\n")
        self.state.setdefault("messages", []).append({"at": event["at"], "type": event_type, "message": message})
        self.state["messages"] = self.state["messages"][-100:]
        self.write()

    def step(self, key: str, status: str, message: str, **data):
        item = self.state.setdefault("steps", {}).setdefault(key, {"name": key, "events": []})
        item.update({"status": status, "message": message, "updated_at": now(), **data})
        item["events"].append({"at": now(), "status": status, "message": message})
        item["events"] = item["events"][-30:]
        self.write()
        self.emit("step", message, step=key, status=status, **data)

    def artifact(self, label: str, path: Path):
        rel = path.relative_to(self.run_dir) if path.is_relative_to(self.run_dir) else path
        self.state.setdefault("artifacts", []).append({"label": label, "path": str(rel), "updated_at": now()})
        self.write()
        self.emit("artifact", f"Artifact written: {label}", path=str(rel))

    def agent(self, key: str, status: str, message: str, **data):
        item = self.state.setdefault("agents", {}).setdefault(key, {"name": key, "status": "pending", "events": []})
        item.update({"status": status, "message": message, "updated_at": now(), **data})
        item["events"].append({"at": now(), "status": status, "message": message})
        item["events"] = item["events"][-30:]
        self.write()
        self.emit("agent", message, agent=key, status=status, **data)


def cell_text(cell) -> str:
    return " ".join("".join(t.text or "" for t in cell.xpath(".//w:t", namespaces=NS)).split())


def set_plain_cell(cell, value: str) -> None:
    paras = cell.xpath("./w:p", namespaces=NS)
    if not paras:
        paras = [etree.SubElement(cell, q("p"))]
    p = paras[0]
    texts = p.xpath(".//w:t", namespaces=NS)
    if texts:
        texts[0].text = value
        for extra in texts[1:]:
            extra.text = ""
        return
    run = etree.Element(q("r"))
    first_run = p.find(q("r"))
    if first_run is not None:
        rpr = first_run.find(q("rPr"))
        if rpr is not None:
            run.append(deepcopy(rpr))
    text = etree.SubElement(run, q("t"))
    text.text = value
    p.append(run)


def set_paragraph_text(paragraph, value: str) -> None:
    texts = paragraph.xpath(".//w:t", namespaces=NS)
    if texts:
        texts[0].text = value
        for extra in texts[1:]:
            extra.text = ""
        return
    run = etree.SubElement(paragraph, q("r"))
    text = etree.SubElement(run, q("t"))
    text.text = value


def set_formula_result(cell, value: str) -> None:
    in_result = False
    for run in cell.xpath(".//w:r", namespaces=NS):
        fld = run.find(q("fldChar"))
        if fld is not None:
            kind = fld.get(q("fldCharType"))
            if kind == "separate":
                in_result = True
                continue
            if kind == "end":
                return
        if in_result:
            texts = run.xpath("./w:t", namespaces=NS)
            if texts:
                texts[0].text = value
                for extra in texts[1:]:
                    extra.text = ""
                return
    set_plain_cell(cell, value)


def display_mv(visible: str) -> str:
    value = str(visible).strip()
    sign = "-" if value.startswith("-") else ""
    cleaned = value.lstrip("+-")
    number = float(cleaned.replace(",", ""))
    mv = int(round(number * 1000))
    return sign + f"{mv:,}"


def display_plain(visible: str) -> str:
    return str(visible).strip()


def mg_index(label: str) -> int:
    m = re.search(r"MG\s*(\d+)", label, re.I)
    if not m:
        raise ValueError(f"Could not parse MG index from {label!r}")
    return int(m.group(1))


def reading_mg_index(reading: dict, fallback: int) -> int:
    for key in ("mg", "annotation_label", "row_name", "notes"):
        value = reading.get(key)
        if value:
            match = re.search(r"MG\s*(\d+)|\bM\s*(\d+)\b", str(value), re.I)
            if match:
                return int(match.group(1) or match.group(2))
    return fallback


def station_number(reading: dict, fallback: int) -> str | None:
    text = " ".join(str(reading.get(key) or "") for key in ("test_station", "station", "row_name", "annotation_label", "notes"))
    match = re.search(r"(?:test\s*station|station|TS)\s*([12])|\bTS\s*([12])\b", text, re.I)
    if match:
        return match.group(1) or match.group(2)
    return str(fallback) if fallback in (1, 2) else None


def station_key_for_mg_index(idx: int) -> str:
    return "Test Station 1" if int(idx) <= 3 else "Test Station 2"


def normalized_station_key(reading: dict, idx: int) -> str:
    fallback_station = 1 if int(idx) <= 3 else 2
    explicit = station_number(reading, fallback_station)
    if explicit in {"1", "2"}:
        return f"Test Station {explicit}"
    return station_key_for_mg_index(idx)


def build_patch(run_dir: Path, state: State) -> dict:
    results = json.loads((run_dir / "leaf-results.json").read_text())
    target = state.state["target"]["target_tables"]
    cells = []
    warnings = []

    def leaf_readings(name: str) -> list[dict]:
        leaf = results.get(name, {})
        warnings.extend(leaf.get("unresolved", []) or [])
        return leaf.get("readings", []) or []

    def add(table, row, col, value, source, evidence, confidence=None, notes=None):
        cells.append({
            "table_index": table,
            "row_index": row,
            "col_index": col,
            "value": value,
            "source_ref": source,
            "source_status": "raw_image_openai_visual_leaf",
            "evidence": evidence,
            "confidence": confidence,
            "notes": notes,
            "verifier_id": "gpt-5.2",
            "lock_key": cell_lock_key(state.state["structure"], table, row, col),
        })

    rows = [
        ("table3-north", 2),
        ("table3-east", 3),
        ("table3-south", 4),
        ("table3-west", 5),
    ]
    cols = [2, 4, 6, 8, 10]
    for leaf, row in rows:
        for reading in sorted(leaf_readings(leaf), key=lambda item: int(item.get("sequence_index", 0))):
            seq = int(reading["sequence_index"])
            if 1 <= seq <= 5:
                add(target["table3"], row, cols[seq - 1], display_mv(reading["visible_value"]), reading["source_image"], f"{leaf} sequence {seq}: {reading['visible_value']} {reading.get('unit_seen')}", reading.get("confidence"), reading.get("notes"))

    table5 = leaf_readings("table5-currents")
    station_counts = {"Test Station 1": 0, "Test Station 2": 0}
    station_sources = {"Test Station 1": [], "Test Station 2": []}
    for fallback, reading in enumerate(table5, start=1):
        idx = reading_mg_index(reading, fallback)
        if not 1 <= idx <= 7:
            warnings.append({"issue": "Skipped Table 5 reading because MG index is outside the report table shape.", "mg_index": idx, "reading": reading})
            continue
        station = normalized_station_key(reading, idx)
        station_counts[station] = station_counts.get(station, 0) + 1
        if reading.get("source_image"):
            station_sources.setdefault(station, []).append(reading.get("source_image"))
        add(target["table5"], 1, idx, display_plain(reading["visible_value"]), reading["source_image"], f"{reading['annotation_label']}: {reading['visible_value']} {reading.get('unit_seen')}", reading.get("confidence"), reading.get("notes"))

    table6 = leaf_readings("table6-potentials")
    for fallback, reading in enumerate(table6, start=1):
        idx = reading_mg_index(reading, fallback)
        if not 1 <= idx <= 7:
            warnings.append({"issue": "Skipped Table 6 reading because MG index is outside the report table shape.", "mg_index": idx, "reading": reading})
            continue
        add(target["table6"], 1, idx, display_mv(reading["visible_value"]), reading["source_image"], f"{reading['annotation_label']}: {reading['visible_value']} {reading.get('unit_seen')}", reading.get("confidence"), reading.get("notes"))

    t4_values = {}
    for fallback, reading in enumerate(leaf_readings("table4-stations"), start=1):
        station = station_number(reading, 1 if fallback % 2 else 2)
        label_text = " ".join(str(reading.get(key) or "") for key in ("row_name", "annotation_label", "notes"))
        if not station:
            warnings.append({"issue": "Skipped Table 4 reading because station number was not identifiable.", "reading": reading})
            continue
        if "Row 2" in label_text:
            t4_values[(2, station)] = reading
        elif "Row 3" in label_text:
            t4_values[(3, station)] = reading

    count1 = station_counts.get("Test Station 1", 0)
    count2 = station_counts.get("Test Station 2", 0)
    if table5 and not count1 and any(reading_mg_index(reading, index) <= 3 for index, reading in enumerate(table5, start=1)):
        warnings.append({"issue": "Station 1 anode count recovered from MG index split because explicit station labels were unusable."})
    if table5 and not count2 and any(reading_mg_index(reading, index) >= 4 for index, reading in enumerate(table5, start=1)):
        warnings.append({"issue": "Station 2 anode count recovered from MG index split because explicit station labels were unusable."})
    add(target["table4"], 1, 1, str(count1), "Table 5 station-1 MG leaves", "Derived anode count from Table 5 MG1-MG3 occupied current leaves", None, {"source_images": station_sources.get("Test Station 1", [])})
    add(target["table4"], 1, 2, str(count2), "Table 5 station-2 MG leaves", "Derived anode count from Table 5 MG4+ occupied current leaves", None, {"source_images": station_sources.get("Test Station 2", [])})
    for col, station in [(1, "1"), (2, "2")]:
        shunt = t4_values.get((2, station))
        total = t4_values.get((3, station))
        if shunt:
            add(target["table4"], 2, col, display_plain(shunt["visible_value"]), shunt["source_image"], f"{shunt['annotation_label']}: {shunt['visible_value']} {shunt.get('unit_seen')}", shunt.get("confidence"), shunt.get("notes"))
        if total:
            add(target["table4"], 3, col, display_plain(total["visible_value"]), total["source_image"], f"{total['annotation_label']}: {total['visible_value']} {total.get('unit_seen')}", total.get("confidence"), total.get("notes"))

    if (3, "1") in t4_values and count1:
        current1 = float(t4_values[(3, "1")]["visible_value"])
        life1 = str(round(1000 * (32 * count1 * 0.5 * 0.85) / (current1 * 8.76)))
        cells.append({"table_index": target["table4"], "row_index": 5, "col_index": 1, "value": life1, "source_status": "derived_from_raw_image_formula", "source_ref": "Table 4 formula", "evidence": f"Existing Word formula cache using count={count1}, current={current1}", "verifier_id": "formula"})
    else:
        warnings.append({"issue": "Skipped Table 4 station 1 life formula because current/count evidence was incomplete."})
    if (3, "2") in t4_values and count2:
        current2 = float(t4_values[(3, "2")]["visible_value"])
        life2 = str(round(1000 * (32 * count2 * 0.5 * 0.85) / (current2 * 8.76)))
        cells.append({"table_index": target["table4"], "row_index": 5, "col_index": 2, "value": life2, "source_status": "derived_from_raw_image_formula", "source_ref": "Table 4 formula", "evidence": f"Existing Word formula cache using count={count2}, current={current2}", "verifier_id": "formula"})
    else:
        warnings.append({"issue": "Skipped Table 4 station 2 life formula because current/count evidence was incomplete."})

    return {
        "run_id": state.state["run_id"],
        "structure": state.state["structure"],
        "target": state.state["target"],
        "cells": cells,
        "warnings": warnings,
    }


def valid_docx(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as zf:
            return zf.testzip() is None and "word/document.xml" in zf.namelist()
    except Exception:
        return False


def write_docx(run_dir: Path, state: State, patch: dict, shared: bool = True) -> Path:
    structure = state.state["structure"]
    single_name = REPORT_SOURCE_OF_TRUTH.get("single_output_name_template", "report-subagent-dashboard-STR{structure}.docx").format(structure=structure)
    out = SHARED_OUTPUT if shared else REPORT_DIR / single_name
    if out.resolve() == ORIGINAL.resolve():
        raise RuntimeError("Refusing to write original DOCX. Check report-source-of-truth.json.")
    if shared and out.resolve() != SHARED_OUTPUT.resolve():
        raise RuntimeError("Shared DOCX output drifted away from report-source-of-truth.json.")
    source = out if shared and out.exists() and valid_docx(out) else ORIGINAL
    if source.resolve() not in {ORIGINAL.resolve(), SHARED_OUTPUT.resolve()}:
        raise RuntimeError("Unexpected DOCX source path. Check report-source-of-truth.json.")
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    locks = active_cell_locks()
    with zipfile.ZipFile(source) as zin:
        infos = zin.infolist()
        members = {info.filename: zin.read(info.filename) for info in infos}
    root = etree.fromstring(members["word/document.xml"], parser)
    body = root.find(".//w:body", namespaces=NS)
    body_items = list(body)
    heading_index = int(state.state["target"]["heading_body_index"])
    set_paragraph_text(body_items[heading_index], state.state["target"]["heading_to_write"])
    tables = root.xpath(".//w:tbl", namespaces=NS)
    for item in patch["cells"]:
        enforce_cell_lock(structure, item, locks)
        table_index = int(item["table_index"])
        row_index = int(item["row_index"])
        col_index = int(item["col_index"])
        if table_index >= len(tables):
            continue
        rows = tables[table_index].xpath("./w:tr", namespaces=NS)
        if row_index >= len(rows):
            continue
        cells = rows[row_index].xpath("./w:tc", namespaces=NS)
        if col_index >= len(cells):
            continue
        cell = cells[col_index]
        if item["source_status"] == "derived_from_raw_image_formula":
            set_formula_result(cell, str(item["value"]))
        else:
            set_plain_cell(cell, str(item["value"]))
    members["word/document.xml"] = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    tmp = out.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for info in infos:
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zi.comment = info.comment
            zout.writestr(zi, members[info.filename])
    shutil.move(str(tmp), str(out))
    return out


def readback(docx: Path, target: dict) -> dict:
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    with zipfile.ZipFile(docx) as zf:
        root = etree.fromstring(zf.read("word/document.xml"), parser)
    tables = root.xpath(".//w:tbl", namespaces=NS)
    out = {}
    for name, idx in target.items():
        rows = []
        for row in tables[int(idx)].xpath("./w:tr", namespaces=NS):
            rows.append([cell_text(cell) for cell in row.xpath("./w:tc", namespaces=NS)])
        out[name] = rows
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run")
    parser.add_argument("--single-output", action="store_true")
    args = parser.parse_args()
    run_dir = run_dir_from_arg(args.run)
    state = State(run_dir)
    try:
        state.state["status"] = "running"
        state.agent(
            "docx-writer",
            "running",
            "Parent writer translating leaf outputs into table-cell patch and shared final DOCX",
            prompt_summary="Build source-backed cell writes, acquire shared DOCX lock, update heading/tables, read back target tables, and package-check the copied report.",
            report_source_of_truth=REPORT_SOURCE_OF_TRUTH,
        )
        state.step("apply_docx", "running", "Building source-backed table-cell patch")
        state.step("build_patch", "running", "Translating leaf outputs into DOCX coordinates")
        patch = build_patch(run_dir, state)
        patch_path = run_dir / "docx-cell-patch.json"
        patch_path.write_text(json.dumps(patch, indent=2) + "\n")
        state.artifact("DOCX cell patch", patch_path)
        state.step("build_patch", "complete", f"Patch contains {len(patch['cells'])} cell writes", warnings=len(patch.get("warnings", [])))

        state.step("write_docx", "running", "Writing shared final DOCX" if not args.single_output else "Writing single STR DOCX copy")
        FINAL_LOCK.parent.mkdir(parents=True, exist_ok=True)
        with FINAL_LOCK.open("w") as lock:
            if not args.single_output:
                state.step("write_docx_lock", "running", "Waiting for shared DOCX write lock")
                fcntl.flock(lock, fcntl.LOCK_EX)
                state.step("write_docx_lock", "complete", "Shared DOCX write lock acquired")
            out = write_docx(run_dir, state, patch, shared=not args.single_output)
            if not args.single_output:
                fcntl.flock(lock, fcntl.LOCK_UN)
        state.state["output_docx"] = str(out)
        state.state["report_source_of_truth"] = REPORT_SOURCE_OF_TRUTH
        state.step("write_docx", "complete", f"Wrote report copy: {out.name}", output_docx=str(out))

        state.step("readback", "running", "Reading STR table block from written DOCX")
        rb = readback(out, state.state["target"]["target_tables"])
        rb_path = run_dir / "docx-readback.json"
        rb_path.write_text(json.dumps(rb, indent=2) + "\n")
        state.artifact("DOCX readback", rb_path)
        state.step("readback", "complete", "Structural readback succeeded")

        state.step("package_check", "running", "Checking DOCX package and XML parse")
        with zipfile.ZipFile(out) as zf:
            bad = zf.testzip()
            if bad:
                raise RuntimeError(f"Bad ZIP member: {bad}")
            etree.fromstring(zf.read("word/document.xml"))
        state.step("package_check", "complete", "DOCX package and document.xml parse succeeded")
        state.step("apply_docx", "complete", "Report copy written and structurally verified", output_docx=str(out))
        state.agent("docx-writer", "complete", "Shared final DOCX write complete", output_docx=str(out))
        state.state["status"] = "complete"
        state.state["finished_apply_at"] = now()
        state.emit("finish", "End-to-end run complete", output_docx=str(out))
    except Exception as exc:
        state.step("apply_docx", "failed", str(exc))
        state.agent("docx-writer", "failed", str(exc))
        state.state["status"] = "failed"
        state.emit("finish", f"End-to-end run failed: {exc}")
        raise
    finally:
        state.write()


if __name__ == "__main__":
    main()
