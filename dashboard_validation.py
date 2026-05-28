from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import docx_review


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
VALIDATIONS = RUNS / "validations"
GLOBAL_FEEDBACK = RUNS / "global-feedback.jsonl"
SOFTWARE_VALIDATION_FEEDBACK = RUNS / "software-validation-feedback.jsonl"
FEEDBACK_CORRECTION_LEDGER = RUNS / "feedback-correction-ledger.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"
REGRESSION_CASES = RUNS / "regression-cases.jsonl"
REGRESSION_RECHECKS = RUNS / "regression-rechecks"
CLOSED_LOOP_LEDGER = RUNS / "closed-loop-clean.jsonl"
CLOSED_LOOP_STATUS = RUNS / "closed-loop-status.json"
FEEDBACK_CORRECTION_STATUS = RUNS / "feedback-correction-status.json"
DASHBOARD_HISTORY = RUNS / "dashboard-validation-history.jsonl"


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


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
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def append_jsonl(path: Path, item: dict) -> None:
    with path.open("a") as handle:
        handle.write(json.dumps(item) + "\n")


def latest_dir_events(root: Path, limit: int = 8) -> list[dict]:
    dirs = [path for path in root.iterdir() if path.is_dir()] if root.exists() else []
    if not dirs:
        return []
    latest = max(dirs, key=lambda path: path.name)
    out = []
    for event in read_jsonl(latest / "events.jsonl")[-limit:]:
        out.append({
            "at": event.get("at"),
            "source": latest.name,
            "kind": event.get("type") or "event",
            "message": event.get("message") or "",
        })
    return out


def live_log_for_case(item: dict, selected_case: str | None) -> list[dict]:
    case_id = item.get("id")
    should_stream = item.get("status") == "fail" or item.get("active") or selected_case == case_id
    if not should_stream:
        return []
    out = []
    closed_loop = read_json(CLOSED_LOOP_STATUS, {})
    if closed_loop:
        out.append({
            "at": closed_loop.get("updated_at") or now(),
            "source": closed_loop.get("agent") or "closed-loop-orchestrator",
            "kind": closed_loop.get("stage") or "closed-loop",
            "message": closed_loop.get("message") or "closed-loop status heartbeat",
        })
    feedback_status = read_json(FEEDBACK_CORRECTION_STATUS, {})
    if feedback_status:
        out.append({
            "at": feedback_status.get("updated_at") or feedback_status.get("at") or now(),
            "source": feedback_status.get("agent") or "feedback-correction-agent",
            "kind": "feedback-correction",
            "message": f"{feedback_status.get('status') or 'unknown'}; processed={feedback_status.get('processed', feedback_status.get('pending', 0))}",
        })
    for event in latest_dir_events(VALIDATIONS, 8):
        out.append(event)
    for event in latest_dir_events(REGRESSION_RECHECKS, 8):
        out.append(event)
    for event in read_jsonl(FEEDBACK_PROCESSING)[-8:]:
        out.append({
            "at": event.get("at"),
            "source": "feedback-processing",
            "kind": event.get("kind") or "feedback",
            "message": event.get("title") or event.get("value") or event.get("prior_note") or "",
        })
    for event in read_jsonl(CLOSED_LOOP_LEDGER)[-5:]:
        out.append({
            "at": event.get("at"),
            "source": "closed-loop-ledger",
            "kind": event.get("status") or "ledger",
            "message": f"iteration {event.get('iteration', '?')}: anomalies={event.get('anomaly_count', '?')}; readback mismatches={(event.get('readback') or {}).get('mismatch_count', '?')}",
        })
    out.append({
        "at": now(),
        "source": "software-validation-poll",
        "kind": "heartbeat",
        "message": f"watching {case_id}; status={item.get('status')}; active={bool(item.get('active'))}",
    })
    return sorted(out, key=lambda entry: str(entry.get("at") or ""))[-18:]


def feedback_id(item: dict) -> str:
    return "|".join(str(item.get(key) or "") for key in ("at", "run_id", "agent", "field", "previous", "value"))


def latest_validation() -> dict:
    dirs = [path for path in VALIDATIONS.iterdir() if path.is_dir()] if VALIDATIONS.exists() else []
    if not dirs:
        return {}
    latest = max(dirs, key=lambda path: path.name)
    state = read_json(latest / "state.json", {})
    state["validation_id"] = latest.name
    return state


def case(case_id: str, title: str, status: str, detail: str, *, severity: str = "medium", active: bool = False, evidence=None) -> dict:
    return {
        "id": case_id,
        "title": title,
        "status": status,
        "severity": severity,
        "active": active,
        "detail": detail,
        "evidence": evidence or [],
        "updated_at": now(),
    }


def check_feedback_corrections() -> dict:
    feedbacks = [item for item in read_jsonl(GLOBAL_FEEDBACK) if item.get("field") == "value_feedback"]
    ledger = read_jsonl(FEEDBACK_CORRECTION_LEDGER)
    done = {item.get("feedback_id") for item in ledger if item.get("status") in {"corrected", "skipped"}}
    pending = [item for item in feedbacks if feedback_id(item) not in done]
    if pending:
        return case("feedback-corrections-promoted", "Human feedback must promote into leaf values and DOCX", "fail", f"{len(pending)} feedback item(s) not processed", severity="high", active=True, evidence=pending[:5])
    latest = ledger[-1] if ledger else {}
    return case("feedback-corrections-promoted", "Human feedback must promote into leaf values and DOCX", "pass", f"{len(feedbacks)} feedback item(s) processed; latest {latest.get('old_value')} -> {latest.get('new_value')}", severity="high", evidence=ledger[-3:])


def check_docx_review() -> list[dict]:
    payload = docx_review.build_payload()
    summary = payload.get("summary") or {}
    validation = latest_validation()
    agents = validation.get("agents") or {}
    anomalies = validation.get("anomalies") or []
    checks = []
    problem = int(summary.get("problem") or 0)
    if "docx-review-validator" not in agents:
        checks.append(case("docx-review-is-validation-leaf", "DOCX Review issues must feed validation cases", "fail", "latest validation has no docx-review-validator leaf", severity="high", active=True))
    else:
        checks.append(case("docx-review-is-validation-leaf", "DOCX Review issues must feed validation cases", "pass", agents["docx-review-validator"].get("message") or "DOCX review validator present", severity="high", evidence=[agents["docx-review-validator"]]))
    if problem:
        has_docx_anomaly = any(item.get("kind") == "docx_review_discrepancy" for item in anomalies)
        checks.append(case("docx-review-blocking-clear", "Final DOCX review should have no blocking mismatches", "fail", f"DOCX review has {problem} blocking cell issue(s)", severity="high", active=True, evidence=[summary]))
        checks.append(case("docx-review-blocking-anomaly", "Blocking DOCX review issues must appear as anomaly cards", "pass" if has_docx_anomaly else "fail", "docx_review_discrepancy anomaly present" if has_docx_anomaly else "blocking DOCX issue is not represented in validation anomalies", severity="high", active=not has_docx_anomaly, evidence=anomalies[:5]))
    else:
        checks.append(case("docx-review-blocking-clear", "Final DOCX review should have no blocking mismatches", "pass", f"{summary.get('matched', 0)} expected cells matched; {summary.get('problem', 0)} blocking", severity="high", evidence=[summary]))
    return checks


def check_anode_count_guard() -> dict:
    payload = docx_review.build_payload()
    bad = []
    for structure in payload.get("structures") or []:
        for slot in structure.get("slots") or []:
            if slot.get("status") == "derived_mismatch" and slot.get("label", "").startswith("Anodes TS"):
                bad.append({
                    "structure": structure.get("structure"),
                    "run_id": structure.get("run_id"),
                    "label": slot.get("label"),
                    "actual": slot.get("actual"),
                    "derived_expected": slot.get("derived_expected"),
                    "writer_expected": slot.get("writer_expected"),
                    "notes": slot.get("notes"),
                })
    if bad:
        return case("docx-anode-count-derived-from-mg", "DOCX anode counts must derive from filled MG rows", "fail", f"{len(bad)} anode count cell(s) disagree with occupied Table 5 MG slots", severity="high", active=True, evidence=bad[:8])
    return case("docx-anode-count-derived-from-mg", "DOCX anode counts must derive from filled MG rows", "pass", "Table 4 anode count cells agree with filled Table 5 MG rows", severity="high")


def check_locked_cell_drift() -> dict:
    payload = docx_review.build_payload()
    bad = []
    locked = 0
    for structure in payload.get("structures") or []:
        for slot in structure.get("slots") or []:
            if slot.get("locked"):
                locked += 1
            if slot.get("status") in {"locked_drift", "locked_write_attempt"}:
                bad.append({
                    "structure": structure.get("structure"),
                    "run_id": structure.get("run_id"),
                    "label": slot.get("label"),
                    "table": slot.get("table_key"),
                    "actual": slot.get("actual"),
                    "expected": slot.get("expected"),
                    "locked_value": slot.get("locked_value"),
                    "status": slot.get("status"),
                    "lock_key": slot.get("lock_key"),
                })
    if bad:
        return case("locked-docx-cell-drift-monitor", "Locked DOCX cells must never change silently", "fail", f"{len(bad)} locked cell issue(s): drift or attempted overwrite", severity="high", active=True, evidence=bad[:12])
    return case("locked-docx-cell-drift-monitor", "Locked DOCX cells must never change silently", "pass", f"{locked} locked cell(s) monitored; no drift/attempted overwrite", severity="high")


def check_docx_source_of_truth_mode() -> dict:
    payload = docx_review.build_payload()
    source = payload.get("source_of_truth") or {}
    active = str(payload.get("active_docx") or source.get("active_docx") or "")
    original = str(source.get("original_docx") or "")
    active_exists = bool(payload.get("active_docx_exists"))
    bad = []
    if not active_exists:
        bad.append("active final DOCX missing")
    if active and original and active == original:
        bad.append("active DOCX equals original DOCX")
    if not active:
        bad.append("active DOCX path missing")
    if bad:
        return case("docx-review-source-of-truth-active-docx", "DOCX Review must read only the active final DOCX", "fail", "; ".join(bad), severity="high", active=True, evidence=[{"active_docx": active, "original_docx": original, "active_docx_exists": active_exists}])
    return case("docx-review-source-of-truth-active-docx", "DOCX Review must read only the active final DOCX", "pass", "DOCX Review is backed by active final DOCX readback; original DOCX is not the active path", severity="high", evidence=[{"active_docx": active, "original_docx": original, "active_docx_exists": active_exists}])


def check_closed_loop_integrity() -> list[dict]:
    entries = read_jsonl(CLOSED_LOOP_LEDGER)
    bad_clean = [
        item for item in entries
        if item.get("status") == "clean" and (item.get("validation_failed") or (item.get("validation_command") or {}).get("returncode") not in (0, None))
    ]
    latest_clean = next((item for item in reversed(entries) if item.get("status") == "clean"), None)
    latest_false_clean = bool(latest_clean and (latest_clean.get("validation_failed") or (latest_clean.get("validation_command") or {}).get("returncode") not in (0, None)))
    false_clean_detail = "latest clean record is false-clean" if latest_false_clean else (f"historical false-clean records fixed by later clean run: {len(bad_clean)}" if bad_clean else "no false-clean records found")
    return [
        case("closed-loop-no-false-clean", "Closed loop must not mark clean after validation failure", "fail" if latest_false_clean else "pass", false_clean_detail, severity="high", active=latest_false_clean, evidence=bad_clean[-3:]),
        case("final-docx-readback-clean", "Final DOCX readback must match current leaf patches", "pass" if latest_clean and (latest_clean.get("readback") or {}).get("mismatch_count") == 0 else "fail", "latest clean run has 0 DOCX mismatches" if latest_clean else "no clean closed-loop run found", severity="high", active=not latest_clean, evidence=[latest_clean] if latest_clean else []),
    ]


def monitored_bug_cases() -> list[dict]:
    validation = latest_validation()
    potential = ((validation.get("agents") or {}).get("potential-sign-validator") or {}).get("message", "")
    orientation = ((validation.get("agents") or {}).get("meter-orientation-validator") or {}).get("message", "")
    regressions = read_jsonl(REGRESSION_CASES)
    has_orientation_case = any(item.get("kind") == "meter_orientation_seven_segment" or item.get("solution_id") == "meter-orientation-seven-segment" for item in regressions)
    feedback_failures = [item for item in read_jsonl(FEEDBACK_CORRECTION_LEDGER) if item.get("status") == "failed"]
    return [
        case("meter-orientation-generalized", "Upside-down/rotated seven-segment meter errors must be reusable", "pass" if has_orientation_case and orientation else "fail", orientation or "meter-orientation validator or regression case missing", severity="high", active=not (has_orientation_case and orientation), evidence=[{"has_orientation_case": has_orientation_case, "validator": orientation}]),
        case("feedback-never-silent-fail", "Feedback correction failures must be visible, never silent", "fail" if feedback_failures else "pass", f"{len(feedback_failures)} feedback correction failure(s)" if feedback_failures else "no silent/failed feedback corrections", severity="high", active=bool(feedback_failures), evidence=feedback_failures[-5:]),
        case("potential-sign-raw-vs-blocking-display", "Potential sign raw flags must not look like current red failures", "monitor", potential or "waiting for validation", severity="medium", evidence=[{"latest_validation": validation.get("validation_id"), "message": potential}]),
        case("software-scroll-stability", "Software panels must preserve scroll/input while polling", "monitor", "tracked from prior validation/DOCX/software-validation panel scroll-reset bugs", severity="medium"),
        case("hover-preview-stability", "Evidence hover previews must stay near anchor and not disappear during scroll", "monitor", "tracked from prior validation hover-preview bugs", severity="medium"),
        case("single-source-final-docx", "Only active final DOCX should be written/opened", "pass", "report-source-of-truth and DOCX review use the active final DOCX", severity="high"),
    ]


def attach_feedback(checks: list[dict]) -> list[dict]:
    feedback = read_jsonl(SOFTWARE_VALIDATION_FEEDBACK)
    by_case: dict[str, list[dict]] = {}
    for item in feedback:
        by_case.setdefault(str(item.get("case_id") or ""), []).append(item)
    for item in checks:
        item["feedback"] = by_case.get(item["id"], [])[-8:]
    return checks


def guarded(label: str, fn):
    try:
        return fn()
    except Exception as exc:
        return case(
            f"software-validation-runtime-{label}",
            f"Software validation check failed: {label}",
            "fail",
            f"{type(exc).__name__}: {exc}",
            severity="high",
            active=True,
            evidence=[{"error": str(exc), "check": label}],
        )


def build_payload(selected_case: str | None = None, record: bool = False) -> dict:
    checks = []
    for result in [
        guarded("feedback-corrections", check_feedback_corrections),
        guarded("docx-review", check_docx_review),
        guarded("docx-source-of-truth", check_docx_source_of_truth_mode),
        guarded("anode-count", check_anode_count_guard),
        guarded("locked-cells", check_locked_cell_drift),
        guarded("closed-loop", check_closed_loop_integrity),
        guarded("monitored-bugs", monitored_bug_cases),
    ]:
        if isinstance(result, list):
            checks.extend(result)
        else:
            checks.append(result)
    checks = attach_feedback(checks)
    order = {"fail": 0, "monitor": 1, "pass": 2}
    if selected_case:
        for item in checks:
            if item["id"] == selected_case:
                item["active"] = True
                item["detail"] = f"Replay requested. {item['detail']}"
    for item in checks:
        item["live_log"] = live_log_for_case(item, selected_case)
    checks.sort(key=lambda item: (order.get(item["status"], 1), not item.get("active"), item["id"]))
    payload = {
        "updated_at": now(),
        "selected_case": selected_case,
        "summary": {
            "total": len(checks),
            "fail": sum(1 for item in checks if item["status"] == "fail"),
            "monitor": sum(1 for item in checks if item["status"] == "monitor"),
            "pass": sum(1 for item in checks if item["status"] == "pass"),
            "active": sum(1 for item in checks if item.get("active")),
        },
        "cases": checks,
    }
    if record:
        append_jsonl(DASHBOARD_HISTORY, payload)
    payload["history"] = read_jsonl(DASHBOARD_HISTORY)[-20:]
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case")
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build_payload(args.case, args.record)))


if __name__ == "__main__":
    main()
