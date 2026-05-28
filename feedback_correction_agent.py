from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import docx_review


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
GLOBAL_FEEDBACK = RUNS / "global-feedback.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"
REGRESSION_CASES = RUNS / "regression-cases.jsonl"
LEDGER = RUNS / "feedback-correction-ledger.jsonl"
STATUS = RUNS / "feedback-correction-status.json"


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


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


def feedback_id(item: dict) -> str:
    return "|".join(str(item.get(key) or "") for key in ("at", "run_id", "agent", "field", "previous", "value"))


def corrected_value(note: str) -> str | None:
    patterns = [
        r"instead\s+of\s+(-?\d+(?:\.\d+)?)",
        r"should\s+(?:be|read)\s+(-?\d+(?:\.\d+)?)",
        r"correct(?:ed)?\s+(?:value|reading)?\s*(?:is|=|:)\s*(-?\d+(?:\.\d+)?)",
    ]
    for pattern in patterns:
        match = re.search(pattern, note, re.I)
        if match:
            return match.group(1)
    return None


def target_unit(feedback: dict, reading: dict) -> str:
    text = f"{feedback.get('value', '')} {reading.get('row_name', '')} {reading.get('annotation_label', '')}".lower()
    if "voltmeter" in text or "row 2" in text:
        return "mV DC"
    return str(reading.get("unit_seen") or "")


def emit_run_event(run_dir: Path, state: dict, event_type: str, message: str, **data) -> None:
    events_path = run_dir / "events.jsonl"
    seq = 0
    if events_path.exists():
        for line in events_path.read_text().splitlines():
            if line.strip():
                try:
                    seq = max(seq, int(json.loads(line).get("seq", 0)))
                except Exception:
                    pass
    event = {"seq": seq + 1, "at": now(), "type": event_type, "message": message, "data": data}
    with events_path.open("a") as handle:
        handle.write(json.dumps(event) + "\n")
    state.setdefault("messages", []).append({"at": event["at"], "type": event_type, "message": message})
    state["messages"] = state["messages"][-100:]


def mark_agent(run_dir: Path, state: dict, status: str, message: str, **data) -> None:
    at = now()
    agent = state.setdefault("agents", {}).setdefault("human-feedback-correction-leaf", {"name": "human-feedback-correction-leaf", "events": []})
    agent.update({"status": status, "message": message, "updated_at": at, **data})
    agent["events"].append({"at": at, "status": status, "message": message})
    agent["events"] = agent["events"][-30:]
    state["updated_at"] = at
    (run_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")
    emit_run_event(run_dir, state, "agent", message, agent="human-feedback-correction-leaf", status=status, **data)
    (run_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")


def find_reading(readings: list[dict], feedback: dict) -> dict | None:
    wanted = feedback.get("reading") or {}
    source = str(wanted.get("source_image") or "")
    label = str(wanted.get("annotation_label") or "")
    for reading in readings:
        if source and str(reading.get("source_image") or "") != source:
            continue
        if label and str(reading.get("annotation_label") or "") != label:
            continue
        return reading
    for reading in readings:
        if source and str(reading.get("source_image") or "") == source:
            return reading
    return None


def record_regression(feedback: dict, old: dict, new_value: str) -> None:
    item = {
        "at": now(),
        "case_id": f"feedback:{feedback_id(feedback)}",
        "validation_id": None,
        "anomaly_id": None,
        "signature": None,
        "evidence_hash": None,
        "structure": feedback.get("structure"),
        "run_id": feedback.get("run_id"),
        "agent": feedback.get("agent"),
        "title": f"STR {feedback.get('structure')} human feedback corrected upside-down meter reading",
        "kind": "human_feedback_value_correction",
        "severity": "high",
        "note": feedback.get("value"),
        "anomaly": {
            "evidence": [{
                "structure": feedback.get("structure"),
                "run_id": feedback.get("run_id"),
                "agent": feedback.get("agent"),
                "source_image": old.get("source_image"),
                "value": old.get("visible_value"),
                "expected": new_value,
                "label": old.get("annotation_label"),
            }]
        },
        "next_step": "Future extraction leaves must inspect meter orientation before accepting seven-segment LCD values.",
        "source": "human_feedback_correction_agent",
    }
    append_jsonl(REGRESSION_CASES, item)


def apply_feedback(feedback: dict) -> dict:
    run_id = str(feedback.get("run_id") or "")
    agent = str(feedback.get("agent") or "")
    correction = corrected_value(str(feedback.get("value") or ""))
    if not run_id or not agent or not correction:
        return {"status": "skipped", "reason": "feedback did not contain run, agent, and explicit corrected value", "feedback_id": feedback_id(feedback)}
    run_dir = RUNS / run_id
    state_path = run_dir / "state.json"
    leaf_path = run_dir / "leaf-results.json"
    state = read_json(state_path, {})
    leaf = read_json(leaf_path, {})
    readings = leaf.get(agent, {}).get("readings") or []
    reading = find_reading(readings, feedback)
    if not reading:
        return {"status": "failed", "reason": "matching reading not found", "feedback_id": feedback_id(feedback)}

    old = dict(reading)
    if str(reading.get("visible_value") or "") != correction:
        reading["visible_value"] = correction
        reading["unit_seen"] = target_unit(feedback, reading)
        reading["confidence"] = max(float(reading.get("confidence") or 0), 0.99)
        reading["notes"] = f"Human feedback correction: {feedback.get('value')} Previous extraction was {old.get('visible_value')} {old.get('unit_seen')}."
        unresolved = leaf.get(agent, {}).get("unresolved") or []
        leaf[agent]["unresolved"] = [
            item for item in unresolved
            if not (item.get("source_image") == old.get("source_image") and item.get("annotation_label") == old.get("annotation_label"))
        ]
        leaf[agent].setdefault("human_feedback_corrections", []).append({
            "at": now(),
            "feedback": feedback,
            "old": old,
            "new": dict(reading),
        })
        leaf_path.write_text(json.dumps(leaf, indent=2) + "\n")

    mark_agent(run_dir, state, "running", "Applying human feedback correction into shared final DOCX", old_value=old.get("visible_value"), new_value=correction, source_image=old.get("source_image"))
    result = subprocess.run([sys.executable, str(ROOT / "apply_to_docx.py"), "--run", run_id], cwd=ROOT, text=True, capture_output=True, timeout=90)
    if result.returncode != 0:
        mark_agent(run_dir, state, "failed", "DOCX write failed after feedback correction", stderr=result.stderr[-2000:])
        return {"status": "failed", "reason": "apply_to_docx failed", "stderr": result.stderr[-2000:], "feedback_id": feedback_id(feedback)}

    review = docx_review.build_payload()
    structure = next((item for item in review.get("structures") or [] if str(item.get("structure")) == str(feedback.get("structure"))), {})
    problems = (structure.get("summary") or {}).get("problem", 0)
    mark_agent(run_dir, state, "complete", "Human feedback correction written and DOCX review checked", old_value=old.get("visible_value"), new_value=correction, docx_review_problems=problems)
    record_regression(feedback, old, correction)
    return {
        "status": "corrected",
        "feedback_id": feedback_id(feedback),
        "run_id": run_id,
        "structure": feedback.get("structure"),
        "agent": agent,
        "source_image": old.get("source_image"),
        "old_value": old.get("visible_value"),
        "new_value": correction,
        "unit": reading.get("unit_seen"),
        "docx_review_problem_count": problems,
    }


def main() -> None:
    processed = {item.get("feedback_id") for item in read_jsonl(LEDGER)}
    feedbacks = [item for item in read_jsonl(GLOBAL_FEEDBACK) if item.get("field") == "value_feedback"]
    write_json(STATUS, {"status": "running", "agent": "feedback-router", "updated_at": now(), "pending": len([item for item in feedbacks if feedback_id(item) not in processed])})
    results = []
    for feedback in feedbacks:
        fid = feedback_id(feedback)
        if fid in processed:
            continue
        result = apply_feedback(feedback)
        result["at"] = now()
        result["feedback"] = feedback
        append_jsonl(LEDGER, result)
        append_jsonl(FEEDBACK_PROCESSING, {"kind": "human_feedback_correction_applied", **result})
        results.append(result)
    status = "complete" if all(item.get("status") in {"corrected", "skipped"} for item in results) else "failed"
    write_json(STATUS, {"status": status, "agent": "feedback-correction-orchestrator", "updated_at": now(), "processed": len(results), "results": results})
    print(json.dumps({"status": status, "processed": len(results), "results": results}, indent=2))
    if status != "complete":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
