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
FEEDBACK_CORRECTION_LEDGER = RUNS / "feedback-correction-ledger.jsonl"
CLOSED_LOOP_LEDGER = RUNS / "closed-loop-clean.jsonl"
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
    return [
        case("potential-sign-raw-vs-blocking-display", "Potential sign raw flags must not look like current red failures", "monitor", potential or "waiting for validation", severity="medium", evidence=[{"latest_validation": validation.get("validation_id"), "message": potential}]),
        case("dashboard-scroll-stability", "Dashboard panels must preserve scroll/input while polling", "monitor", "tracked from prior validation/feedback panel scroll-reset bugs", severity="medium"),
        case("hover-preview-stability", "Evidence hover previews must stay near anchor and not disappear during scroll", "monitor", "tracked from prior validation hover-preview bugs", severity="medium"),
        case("single-source-final-docx", "Only active final DOCX should be written/opened", "pass", "report-source-of-truth and DOCX review use the active final DOCX", severity="high"),
    ]


def build_payload(selected_case: str | None = None, record: bool = False) -> dict:
    checks = [
        check_feedback_corrections(),
        *check_docx_review(),
        *check_closed_loop_integrity(),
        *monitored_bug_cases(),
    ]
    order = {"fail": 0, "monitor": 1, "pass": 2}
    if selected_case:
        for item in checks:
            if item["id"] == selected_case:
                item["active"] = True
                item["detail"] = f"Replay requested. {item['detail']}"
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
