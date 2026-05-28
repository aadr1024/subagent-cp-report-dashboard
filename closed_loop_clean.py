from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

from lxml import etree

import apply_to_docx


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
VALIDATIONS = RUNS / "validations"
REGRESSION_CASES = RUNS / "regression-cases.jsonl"
RECHECKS = RUNS / "regression-rechecks"
VALIDATION_REVIEW_METADATA = RUNS / "validation-review-metadata.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"
LEDGER = RUNS / "closed-loop-clean.jsonl"
STATUS = RUNS / "closed-loop-status.json"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def stamp() -> str:
    date = datetime.now()
    return date.strftime("%Y%m%d-%H%M%S")


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def append_jsonl(path: Path, item: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(item) + "\n")


def text_of(node) -> str:
    return " ".join("".join(t.text or "" for t in node.xpath(".//w:t", namespaces=NS)).split())


def latest_runs() -> list[tuple[Path, dict]]:
    runs = []
    for path in RUNS.iterdir():
        if not path.is_dir() or path.name.startswith(".") or path.name in {"validations", "regression-rechecks"}:
            continue
        state_path = path / "state.json"
        leaf_path = path / "leaf-results.json"
        if not state_path.exists() or not leaf_path.exists():
            continue
        state = read_json(state_path, {})
        if not state.get("structure") or not state.get("target"):
            continue
        runs.append((path, state))
    runs.sort(key=lambda item: item[1].get("updated_at") or item[1].get("started_at") or item[0].name, reverse=True)
    by_structure: dict[str, tuple[Path, dict]] = {}
    for path, state in runs:
        by_structure.setdefault(str(state.get("structure")), (path, state))
    return sorted(by_structure.values(), key=lambda item: int(item[1].get("target", {}).get("ordinal") or 999))


def run_command(args: list[str], label: str, timeout: int | None = None) -> dict:
    started = time.time()
    result = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    return {
        "label": label,
        "args": args,
        "returncode": result.returncode,
        "elapsed_seconds": round(time.time() - started, 2),
        "output_tail": result.stdout[-6000:],
    }


def rewrite_all_latest() -> list[dict]:
    started = time.time()
    runs = latest_runs()
    try:
        patches = batch_write_latest_runs(runs)
        return [{
            "label": "batch final DOCX write",
            "returncode": 0,
            "elapsed_seconds": round(time.time() - started, 2),
            "run_count": len(runs),
            "cell_count": sum(len(item.get("cells", [])) for item in patches),
            "output_docx": str(apply_to_docx.SHARED_OUTPUT),
            "output_tail": "",
        }]
    except Exception as exc:
        return [{
            "label": "batch final DOCX write",
            "returncode": 1,
            "elapsed_seconds": round(time.time() - started, 2),
            "run_count": len(runs),
            "output_tail": str(exc),
        }]


def batch_write_latest_runs(runs: list[tuple[Path, dict]]) -> list[dict]:
    out = apply_to_docx.SHARED_OUTPUT
    original = apply_to_docx.ORIGINAL
    if out.resolve() == original.resolve():
        raise RuntimeError("Refusing to batch-write original DOCX.")
    source = out if out.exists() and apply_to_docx.valid_docx(out) else original
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    patches = []
    apply_to_docx.FINAL_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with apply_to_docx.FINAL_LOCK.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with zipfile.ZipFile(source) as zin:
                infos = zin.infolist()
                members = {info.filename: zin.read(info.filename) for info in infos}
            root = etree.fromstring(members["word/document.xml"], parser)
            body = root.find(".//w:body", namespaces=NS)
            body_items = list(body)
            tables = root.xpath(".//w:tbl", namespaces=NS)
            for run_dir, state_data in runs:
                state = apply_to_docx.State(run_dir)
                patch = apply_to_docx.build_patch(run_dir, state)
                patches.append(patch)
                heading_index = int(state_data["target"]["heading_body_index"])
                apply_to_docx.set_paragraph_text(body_items[heading_index], state_data["target"]["heading_to_write"])
                patch_path = run_dir / "docx-cell-patch.json"
                write_json(patch_path, patch)
                for item in patch.get("cells", []):
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
                        apply_to_docx.set_formula_result(cell, str(item["value"]))
                    else:
                        apply_to_docx.set_plain_cell(cell, str(item["value"]))
                state.state["output_docx"] = str(out)
                state.state["report_source_of_truth"] = apply_to_docx.REPORT_SOURCE_OF_TRUTH
                state.step("write_docx", "complete", "Batch closed-loop writer included this STR in shared final DOCX", output_docx=str(out))
                state.agent("docx-writer", "complete", "Batch closed-loop final DOCX write complete", output_docx=str(out))
                state.write()
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
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    if not apply_to_docx.valid_docx(out):
        raise RuntimeError("Batch writer produced an invalid DOCX package.")
    return patches


def docx_tables_and_body() -> tuple[list, list]:
    docx = apply_to_docx.SHARED_OUTPUT
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    with zipfile.ZipFile(docx) as zf:
        root = etree.fromstring(zf.read("word/document.xml"), parser)
    body = root.find(".//w:body", namespaces=NS)
    return root.xpath(".//w:tbl", namespaces=NS), list(body)


def normalize_cell(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def verify_docx_readback() -> dict:
    tables, body_items = docx_tables_and_body()
    mismatches = []
    checked_cells = 0
    checked_headings = 0
    for run_dir, state_data in latest_runs():
        state = apply_to_docx.State(run_dir)
        patch = apply_to_docx.build_patch(run_dir, state)
        heading_index = int(state_data["target"]["heading_body_index"])
        expected_heading = normalize_cell(state_data["target"]["heading_to_write"])
        actual_heading = normalize_cell(text_of(body_items[heading_index])) if heading_index < len(body_items) else ""
        checked_headings += 1
        if actual_heading != expected_heading:
            mismatches.append({
                "run_id": run_dir.name,
                "structure": state_data.get("structure"),
                "kind": "heading",
                "expected": expected_heading,
                "actual": actual_heading,
            })
        for item in patch.get("cells", []):
            table_index = int(item["table_index"])
            row_index = int(item["row_index"])
            col_index = int(item["col_index"])
            expected = normalize_cell(str(item["value"]))
            actual = ""
            if table_index < len(tables):
                rows = tables[table_index].xpath("./w:tr", namespaces=NS)
                if row_index < len(rows):
                    cells = rows[row_index].xpath("./w:tc", namespaces=NS)
                    if col_index < len(cells):
                        actual = normalize_cell(text_of(cells[col_index]))
            checked_cells += 1
            if actual != expected:
                mismatches.append({
                    "run_id": run_dir.name,
                    "structure": state_data.get("structure"),
                    "kind": "cell",
                    "table": table_index,
                    "row": row_index,
                    "col": col_index,
                    "expected": expected,
                    "actual": actual,
                    "source_ref": item.get("source_ref"),
                })
    return {
        "status": "clean" if not mismatches else "failed",
        "checked_runs": len(latest_runs()),
        "checked_headings": checked_headings,
        "checked_cells": checked_cells,
        "mismatch_count": len(mismatches),
        "mismatches": mismatches[:200],
    }


def run_validation(iteration: int) -> tuple[str, dict, dict]:
    validation_id = f"{stamp()}-closed-loop-{iteration:02d}-validation"
    result = run_command([sys.executable, str(ROOT / "validator.py"), "--validation-id", validation_id], f"validation {validation_id}")
    state = read_json(VALIDATIONS / validation_id / "state.json", {})
    return validation_id, state, result


def anomaly_signature(anomaly: dict) -> str:
    if anomaly.get("signature"):
        return str(anomaly["signature"])
    evidence = json.dumps(anomaly.get("evidence") or [], sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(f"{anomaly.get('kind')}|{anomaly.get('title')}|{evidence}".encode()).hexdigest()


def existing_case_keys() -> set[str]:
    keys = set()
    for item in read_jsonl(REGRESSION_CASES):
        for key in (item.get("case_id"), item.get("signature"), f"{item.get('validation_id')}:{item.get('anomaly_id')}"):
            if key:
                keys.add(str(key))
    return keys


def record_anomalies(validation_id: str, anomalies: list[dict]) -> list[dict]:
    existing = existing_case_keys()
    recorded = []
    for anomaly in anomalies:
        anomaly_id = str(anomaly.get("id") or anomaly_signature(anomaly))
        case_id = f"{validation_id}:{anomaly_id}"
        signature = anomaly_signature(anomaly)
        if case_id in existing or signature in existing:
            continue
        item = {
            "at": now(),
            "case_id": case_id,
            "validation_id": validation_id,
            "anomaly_id": anomaly_id,
            "signature": signature,
            "evidence_hash": anomaly.get("evidence_hash"),
            "status": "recorded",
            "source": "closed_loop_clean",
            "title": anomaly.get("title"),
            "kind": anomaly.get("kind"),
            "severity": anomaly.get("severity"),
            "note": "Closed-loop clean run recorded this validation anomaly for focused replay.",
            "anomaly": anomaly,
            "next_step": "Focused replay must either correct source extraction and write DOCX, or mark exact source-backed anomaly accepted.",
        }
        append_jsonl(REGRESSION_CASES, item)
        append_jsonl(FEEDBACK_PROCESSING, {
            "at": item["at"],
            "kind": "regression_case_recorded",
            "source": "closed_loop_clean",
            "validation_id": validation_id,
            "anomaly_id": anomaly_id,
            "signature": signature,
            "title": anomaly.get("title"),
        })
        existing.add(case_id)
        existing.add(signature)
        recorded.append(item)
    return recorded


def run_recheck(iteration: int) -> tuple[str, dict, dict]:
    recheck_id = f"{stamp()}-closed-loop-{iteration:02d}-recheck"
    result = run_command([sys.executable, str(ROOT / "regression_recheck.py"), "--recheck-id", recheck_id, "--limit", "96"], f"recheck {recheck_id}")
    state = read_json(RECHECKS / recheck_id / "state.json", {})
    return recheck_id, state, result


def changed_readings(result: dict) -> list[dict]:
    out = []
    for reading in result.get("readings") or []:
        old = str(reading.get("old_value") or "").strip()
        new = str(reading.get("rechecked_value") or "").strip()
        if old and new and old != new:
            out.append(reading)
    return out


def accepted_source_result(result: dict) -> bool:
    text = " ".join(str(part) for part in [
        result.get("summary"),
        result.get("status"),
        *[reading.get("notes") for reading in result.get("readings") or []],
        *(result.get("agent_prompt_lessons") or []),
    ] if part).lower()
    if changed_readings(result):
        return False
    if result.get("status") == "fixed" and not result.get("case_still_flags"):
        return True
    return any(phrase in text for phrase in [
        "matches the source",
        "source-backed",
        "no visible minus",
        "keep the source",
        "not a transcription error",
        "ignorable",
        "do not flag",
    ])


def accept_source_backed(validation_id: str, anomalies: list[dict], recheck_state: dict) -> list[dict]:
    by_key = {}
    for result in recheck_state.get("results") or []:
        for key in (result.get("case_id"), result.get("signature")):
            if key:
                by_key[str(key)] = result
    accepted = []
    for anomaly in anomalies:
        anomaly_id = str(anomaly.get("id") or anomaly_signature(anomaly))
        case_id = f"{validation_id}:{anomaly_id}"
        signature = anomaly_signature(anomaly)
        result = by_key.get(case_id) or by_key.get(signature)
        if not result or not accepted_source_result(result):
            continue
        item = {
            "at": now(),
            "validation_id": validation_id,
            "anomaly_id": anomaly_id,
            "signature": signature,
            "evidence_hash": anomaly.get("evidence_hash"),
            "status": "reviewed",
            "note": "Closed-loop accepted exact source-backed anomaly after focused replay. Suppressed for this exact evidence hash only.",
            "source": "closed_loop_clean",
            "recheck_id": recheck_state.get("recheck_id"),
            "result_status": result.get("status"),
            "title": anomaly.get("title"),
        }
        append_jsonl(VALIDATION_REVIEW_METADATA, item)
        append_jsonl(FEEDBACK_PROCESSING, {
            "at": item["at"],
            "kind": "validation_anomaly_accepted_source_backed",
            "validation_id": validation_id,
            "anomaly_id": anomaly_id,
            "signature": signature,
            "title": anomaly.get("title"),
        })
        accepted.append(item)
    return accepted


def write_ledger(item: dict) -> None:
    append_jsonl(LEDGER, item)


def heartbeat(stage: str, message: str, **data) -> None:
    payload = {
        "loop_id": "closed-loop-clean",
        "status": data.pop("status", "running"),
        "stage": stage,
        "agent": data.pop("agent", "closed-loop-orchestrator"),
        "message": message,
        "updated_at": now(),
        **data,
    }
    write_json(STATUS, payload)


def clean_loop(max_iterations: int) -> dict:
    history = []
    final_docx = str(apply_to_docx.SHARED_OUTPUT)
    heartbeat("start", "closed loop started", max_iterations=max_iterations)
    for iteration in range(1, max_iterations + 1):
        heartbeat("batch_docx_write", "writing all latest STR patches into the single final DOCX", iteration=iteration, agent="docx-writer")
        writes = rewrite_all_latest()
        write_failures = [item for item in writes if item["returncode"] != 0]
        heartbeat("docx_readback", "parsing final DOCX and comparing cells against current leaf results", iteration=iteration, agent="docx-readback")
        readback = verify_docx_readback()
        heartbeat("validation", "running validation agents on latest extracted dataset", iteration=iteration, agent="validation-orchestrator", readback_mismatches=readback["mismatch_count"])
        validation_id, validation_state, validation_command = run_validation(iteration)
        anomalies = validation_state.get("anomalies") or []
        entry = {
            "at": now(),
            "iteration": iteration,
            "final_docx": final_docx,
            "writes": writes,
            "write_failures": write_failures,
            "readback": readback,
            "validation_id": validation_id,
            "validation_command": validation_command,
            "anomaly_count": len(anomalies),
            "anomaly_titles": [item.get("title") for item in anomalies[:20]],
        }
        if write_failures or readback["mismatch_count"]:
            heartbeat("docx_failed", "DOCX write/readback failed; loop will retry before opening", iteration=iteration, status="running", failures=len(write_failures), mismatches=readback["mismatch_count"])
            write_ledger({**entry, "status": "docx_failed"})
            history.append(entry)
            continue
        if not anomalies:
            final_entry = {**entry, "status": "clean"}
            write_ledger(final_entry)
            heartbeat("clean", "DOCX readback clean and validation returned zero unsuppressed anomalies", iteration=iteration, status="clean", validation_id=validation_id, final_docx=final_docx)
            return {
                "status": "clean",
                "iterations": iteration,
                "final_docx": final_docx,
                "readback": readback,
                "validation_id": validation_id,
                "history": history + [final_entry],
            }
        heartbeat("record_anomalies", f"recording {len(anomalies)} validation anomalies for focused replay", iteration=iteration, validation_id=validation_id, anomaly_count=len(anomalies), agent="regression-case-recorder")
        recorded = record_anomalies(validation_id, anomalies)
        heartbeat("focused_recheck", "running focused OpenAI replay over recorded anomalies", iteration=iteration, validation_id=validation_id, recorded_cases=len(recorded), agent="focused-openai-leaf")
        recheck_id, recheck_state, recheck_command = run_recheck(iteration)
        heartbeat("accept_source_backed", "accepting exact source-backed anomalies and suppressing only exact evidence hashes", iteration=iteration, recheck_id=recheck_id, agent="validation-reviewer")
        accepted = accept_source_backed(validation_id, anomalies, recheck_state)
        promoted = sum((promotion.get("candidate_count") or 0) for promotion in recheck_state.get("docx_promotions") or [])
        entry.update({
            "status": "iterated",
            "recorded_cases": len(recorded),
            "recheck_id": recheck_id,
            "recheck_command": recheck_command,
            "recheck_status": recheck_state.get("status"),
            "recheck_results": len(recheck_state.get("results") or []),
            "promoted_corrections": promoted,
            "accepted_source_backed": len(accepted),
        })
        write_ledger(entry)
        heartbeat("iteration_complete", f"iteration complete; promoted={promoted}; accepted_source_backed={len(accepted)}", iteration=iteration, recheck_id=recheck_id, promoted_corrections=promoted, accepted_source_backed=len(accepted))
        history.append(entry)
    heartbeat("not_clean", "closed loop reached iteration limit before clean state", status="not_clean", iterations=max_iterations)
    return {
        "status": "not_clean",
        "iterations": max_iterations,
        "final_docx": final_docx,
        "history": history,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-iterations", type=int, default=6)
    args = parser.parse_args()
    result = clean_loop(args.max_iterations)
    print(json.dumps(result, indent=2))
    if result["status"] != "clean":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
