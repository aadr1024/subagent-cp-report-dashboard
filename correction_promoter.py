from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
REGRESSION_CASES = RUNS / "regression-cases.jsonl"
RECHECKS = RUNS / "regression-rechecks"
PROMOTIONS = RUNS / "correction-promotions.jsonl"
APPLY_DOCX = ROOT / "apply_to_docx.py"


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
    items = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return items


def compact_value(value) -> str:
    return str(value if value is not None else "").strip()


def changed_value(reading: dict) -> bool:
    old_value = compact_value(reading.get("old_value"))
    new_value = compact_value(reading.get("rechecked_value"))
    return bool(old_value and new_value and old_value != new_value)


def promotable_result(result: dict) -> bool:
    status = str(result.get("status") or "").lower()
    return status in {"fixed", "reproduced", "corrected", "source-corrected"}


def case_maps() -> dict[str, dict]:
    out = {}
    for item in read_jsonl(REGRESSION_CASES):
        for key in (item.get("case_id"), item.get("signature")):
            if key:
                out[str(key)] = item
    return out


def recheck_dirs() -> list[Path]:
    if not RECHECKS.exists():
        return []
    return sorted(
        [entry for entry in RECHECKS.iterdir() if entry.is_dir()],
        key=lambda item: item.name,
    )


def results_for_recheck(recheck_id: str) -> list[dict]:
    directory = RECHECKS / recheck_id
    state = read_json(directory / "state.json", {})
    results = state.get("results") if isinstance(state.get("results"), list) else read_json(directory / "results.json", [])
    return [{**result, "recheck_id": recheck_id} for result in results]


def latest_results_by_case() -> list[dict]:
    latest = {}
    for directory in recheck_dirs():
        for result in results_for_recheck(directory.name):
            key = result.get("case_id") or result.get("signature")
            if key:
                latest[str(key)] = result
    return list(latest.values())


def evidence_for(case: dict, reading: dict) -> dict | None:
    source_image = compact_value(reading.get("source_image"))
    evidence = case.get("anomaly", {}).get("evidence") or []
    matches = [item for item in evidence if compact_value(item.get("source_image")) == source_image]
    if matches:
        old_value = compact_value(reading.get("old_value"))
        exact = [item for item in matches if compact_value(item.get("value")) == old_value]
        return exact[0] if exact else matches[0]
    return None


def candidate_score(candidate: dict) -> tuple:
    status_rank = {"fixed": 3, "corrected": 3, "source-corrected": 3, "reproduced": 2}
    return (
        str(candidate.get("recheck_id") or ""),
        status_rank.get(str(candidate.get("result_status") or "").lower(), 0),
        float(candidate.get("confidence") or 0),
    )


def collect_candidates(results: list[dict]) -> tuple[dict[tuple[str, str, str], dict], list[dict]]:
    cases = case_maps()
    candidates: dict[tuple[str, str, str], dict] = {}
    conflicts = []
    for result in results:
        if not promotable_result(result):
            continue
        case = cases.get(str(result.get("case_id"))) or cases.get(str(result.get("signature")))
        if not case:
            continue
        for reading in result.get("readings") or []:
            if not changed_value(reading):
                continue
            evidence = evidence_for(case, reading)
            if not evidence:
                continue
            run_id = compact_value(evidence.get("run_id"))
            agent = compact_value(evidence.get("agent"))
            source_image = compact_value(reading.get("source_image"))
            if not run_id or not agent or not source_image:
                continue
            candidate = {
                "at": now(),
                "run_id": run_id,
                "agent": agent,
                "source_image": source_image,
                "old_value": compact_value(reading.get("old_value")),
                "new_value": compact_value(reading.get("rechecked_value")),
                "unit": compact_value(reading.get("unit")),
                "confidence": reading.get("confidence"),
                "notes": compact_value(reading.get("notes")),
                "case_id": result.get("case_id"),
                "signature": result.get("signature"),
                "title": result.get("title"),
                "recheck_id": result.get("recheck_id"),
                "result_status": result.get("status"),
                "solution_id": result.get("solution_id"),
            }
            key = (run_id, agent, source_image)
            existing = candidates.get(key)
            if existing and existing.get("new_value") != candidate["new_value"]:
                conflicts.append({"key": key, "kept": existing, "incoming": candidate})
            if not existing or candidate_score(candidate) >= candidate_score(existing):
                candidates[key] = candidate
    return candidates, conflicts


def append_run_event(run_id: str, event_type: str, message: str, data: dict) -> None:
    run_dir = RUNS / run_id
    events_path = run_dir / "events.jsonl"
    state_path = run_dir / "state.json"
    if not run_dir.exists():
        return
    seq = 0
    if events_path.exists():
        for line in events_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                seq = max(seq, int(json.loads(line).get("seq", 0)))
            except Exception:
                continue
    event = {"seq": seq + 1, "at": now(), "type": event_type, "message": message, "data": data}
    with events_path.open("a") as handle:
        handle.write(json.dumps(event) + "\n")
    state = read_json(state_path, {"run_id": run_id})
    state["updated_at"] = event["at"]
    state["messages"] = [*(state.get("messages") or []), {"at": event["at"], "type": event_type, "message": message}][-120:]
    state["agents"] = state.get("agents") or {}
    corrections = data.get("corrections") or []
    correction_count = corrections if isinstance(corrections, int) else len(corrections)
    correction_items = [] if isinstance(corrections, int) else corrections
    state["agents"]["correction-promoter"] = {
        "name": "correction-promoter",
        "status": "complete",
        "message": message,
        "updated_at": event["at"],
        "correction_count": correction_count,
        "events": [{"at": event["at"], "status": "complete", "message": message}],
    }
    state["corrections"] = [*(state.get("corrections") or []), *correction_items][-200:]
    write_json(state_path, state)


def update_leaf_results(candidates: dict[tuple[str, str, str], dict]) -> tuple[dict[str, list[dict]], list[dict]]:
    by_run: dict[str, list[dict]] = {}
    unmatched = []
    for candidate in candidates.values():
        run_id = candidate["run_id"]
        agent = candidate["agent"]
        source_image = candidate["source_image"]
        leaf_path = RUNS / run_id / "leaf-results.json"
        leaf = read_json(leaf_path, None)
        if not isinstance(leaf, dict):
            unmatched.append({**candidate, "reason": "missing leaf-results.json"})
            continue
        payload = leaf.get(agent)
        readings = payload.get("readings") if isinstance(payload, dict) else None
        if not isinstance(readings, list):
            unmatched.append({**candidate, "reason": "missing agent readings"})
            continue
        target = next((item for item in readings if compact_value(item.get("source_image")) == source_image), None)
        if target is None:
            old_value = candidate["old_value"]
            target = next((item for item in readings if compact_value(item.get("visible_value", item.get("value"))) == old_value), None)
        if target is None:
            unmatched.append({**candidate, "reason": "no matching source image/value in leaf results"})
            continue
        current_value = compact_value(target.get("visible_value", target.get("value")))
        if current_value != candidate["new_value"]:
            target["visible_value"] = candidate["new_value"]
            if candidate["unit"]:
                target["unit_seen"] = candidate["unit"]
            if candidate.get("confidence") is not None:
                target["confidence"] = candidate["confidence"]
            note = f"Regression correction {candidate['recheck_id']}: {candidate['notes']}".strip()
            existing_notes = compact_value(target.get("notes"))
            if note and note not in existing_notes:
                target["notes"] = f"{existing_notes}; {note}" if existing_notes else note
            target["correction_status"] = "promoted_to_docx"
            target["correction_source"] = {
                "at": candidate["at"],
                "recheck_id": candidate["recheck_id"],
                "case_id": candidate["case_id"],
                "old_value": candidate["old_value"],
                "new_value": candidate["new_value"],
                "source_image": candidate["source_image"],
            }
            write_json(leaf_path, leaf)
            candidate["leaf_update"] = "changed"
        else:
            candidate["leaf_update"] = "already_current"
        by_run.setdefault(run_id, []).append(candidate)
    return by_run, unmatched


def write_docx_for_runs(by_run: dict[str, list[dict]], apply_docx: bool = True) -> list[dict]:
    writes = []
    for run_id, corrections in sorted(by_run.items()):
        append_run_event(
            run_id,
            "correction",
            f"Correction promoter synchronized {len(corrections)} corrected value(s) before DOCX write",
            {"corrections": corrections},
        )
        item = {
            "run_id": run_id,
            "corrections": len(corrections),
            "docx_write": "skipped",
            "output": "",
        }
        if apply_docx:
            result = subprocess.run(
                [sys.executable, str(APPLY_DOCX), "--run", run_id],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            item["docx_write"] = "complete" if result.returncode == 0 else "failed"
            item["returncode"] = result.returncode
            item["output"] = result.stdout[-4000:]
            if result.returncode != 0:
                append_run_event(run_id, "correction", "Correction promoter failed during DOCX write", item)
            else:
                append_run_event(run_id, "correction", "Correction promoter wrote corrected values into final DOCX", item)
        writes.append(item)
    return writes


def promote_results(results: list[dict], apply_docx: bool = True) -> dict:
    candidates, conflicts = collect_candidates(results)
    by_run, unmatched = update_leaf_results(candidates)
    writes = write_docx_for_runs(by_run, apply_docx=apply_docx)
    summary = {
        "at": now(),
        "candidate_count": len(candidates),
        "run_count": len(by_run),
        "docx_writes": writes,
        "unmatched": unmatched,
        "conflicts": conflicts,
    }
    PROMOTIONS.parent.mkdir(parents=True, exist_ok=True)
    with PROMOTIONS.open("a") as handle:
        handle.write(json.dumps(summary) + "\n")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recheck-id")
    parser.add_argument("--latest-by-case", action="store_true")
    parser.add_argument("--no-docx", action="store_true")
    args = parser.parse_args()
    if args.latest_by_case:
        results = latest_results_by_case()
    elif args.recheck_id:
        results = results_for_recheck(args.recheck_id)
    else:
        latest = recheck_dirs()[-1] if recheck_dirs() else None
        results = results_for_recheck(latest.name) if latest else []
    summary = promote_results(results, apply_docx=not args.no_docx)
    print(json.dumps(summary, indent=2))
    if any(item.get("docx_write") == "failed" for item in summary["docx_writes"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
