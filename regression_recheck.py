from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, "/Users/aadityarajesh/Downloads/MT/us-mike-carose-soil-data-2026/J260106 - SBA (anchor inspections Y-2026) -- in process/src")

from sba_report_tool.openai_api import as_input_image, create_response, response_text


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
SITE_ROOT = Path("/Users/aadityarajesh/Downloads/MT/j260101 local/site-photos")
REGRESSION_CASES = RUNS / "regression-cases.jsonl"
RECHECKS = RUNS / "regression-rechecks"
MODEL = "gpt-5.2"
SOLUTION_RULES = {
    "potential-minus-sign-discipline": {
        "title": "Potential sign discipline",
        "prompt": "This replay targets sign discipline: preserve faint LCD minus signs, default Table 3/Table 6 potentials negative when local evidence supports it, and leave true positive/no-minus source readings positive while flagging polarity.",
    },
    "table4-current-decimal-scale": {
        "title": "Table 4 current decimal scale",
        "prompt": "This replay targets Table 4 current scale: inspect decimal points carefully, read current as mA, and compare suspicious large integer-like values against current/shunt peers.",
    },
    "table3-five-reading-completeness": {
        "title": "Table 3 five-reading completeness",
        "prompt": "This replay targets Table 3 completeness: directional rows usually require five readings unless source evidence proves a missing value.",
    },
    "station-pairing-coverage": {
        "title": "Station/anode pairing coverage",
        "prompt": "This replay targets station/anode pairing: group local image runs by station/anode labels plus image proximity before comparing Table 5 and Table 6 coverage.",
    },
    "general-anomaly-review": {
        "title": "General anomaly review loop",
        "prompt": "This replay targets a general reviewed anomaly that has not yet been promoted into a narrower class.",
    },
}


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


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


class RecheckLog:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.events_path = run_dir / "events.jsonl"
        self.state_path = run_dir / "state.json"
        self.seq = 0
        self.state = {
            "recheck_id": run_dir.name,
            "status": "running",
            "started_at": now(),
            "updated_at": now(),
            "cases_total": 0,
            "cases_done": 0,
            "results": [],
        }
        self.write()

    def write(self):
        self.state["updated_at"] = now()
        self.state_path.write_text(json.dumps(self.state, indent=2) + "\n")

    def event(self, event_type: str, message: str, **data):
        self.seq += 1
        event = {"seq": self.seq, "at": now(), "type": event_type, "message": message, "data": data}
        with self.events_path.open("a") as handle:
            handle.write(json.dumps(event) + "\n")
        self.state.setdefault("messages", []).append({"at": event["at"], "type": event_type, "message": message})
        self.state["messages"] = self.state["messages"][-120:]
        self.write()

    def finish(self, status: str, message: str):
        self.state["status"] = status
        self.state["finished_at"] = now()
        self.write()
        self.event("finish", message, status=status)


def site_folder(structure: str) -> Path | None:
    for path in SITE_ROOT.iterdir():
        if path.is_dir() and re.match(r"^\d+\s+-\s+", path.name) and re.search(rf"\b{re.escape(str(structure))}\b", path.name):
            return path
    return None


def image_path(structure: str, name: str) -> Path | None:
    folder = site_folder(structure)
    if not folder:
        return None
    path = folder / name
    return path if path.exists() else None


def compress(src: Path, run_dir: Path) -> Path:
    out_dir = run_dir / "api-images"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{src.stem}.jpg"
    if not out.exists():
        subprocess.run(["sips", "-Z", "1800", str(src), "--out", str(out)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out


def strict_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text[text.find("{") : text.rfind("}") + 1])


def latest_cases() -> list[dict]:
    by_signature = {}
    for item in read_jsonl(REGRESSION_CASES):
        key = item.get("signature") or item.get("case_id")
        if key:
            by_signature[key] = item
    return list(by_signature.values())


def solution_text(case: dict) -> str:
    evidence = case.get("anomaly", {}).get("evidence") or []
    parts = [
        case.get("title"),
        case.get("kind"),
        case.get("severity"),
        case.get("note"),
        case.get("next_step"),
    ]
    for item in evidence:
        parts.extend([item.get("agent"), item.get("row"), item.get("station"), item.get("value"), item.get("source_image")])
    return " ".join(str(part) for part in parts if part is not None).lower()


def solution_id_for_case(case: dict) -> str:
    text = solution_text(case)
    if re.search(r"\btable\s*4\b|table4|shunt|\bma\b|\bmv\b|current|6369|4386|345\.7|decimal", text) and re.search(r"current|shunt|\bma\b|\bmv\b|decimal|6369|4386|345\.7", text):
        return "table4-current-decimal-scale"
    if re.search(r"\btable\s*3\b|table3", text) and re.search(r"five|5\s+values|expected\s+five|expected\s+5|only\s+four|4\s+data|missing|count", text):
        return "table3-five-reading-completeness"
    if re.search(r"station|anode|\bmg\b|pair|coverage|group", text) and re.search(r"\btable\s*5\b|table5|\btable\s*6\b|table6|potential|current", text):
        return "station-pairing-coverage"
    if re.search(r"minus|negative|positive|polarity|sign|potential|\bv\s*dc\b|\btable\s*3\b|table3|\btable\s*6\b|table6", text):
        return "potential-minus-sign-discipline"
    return "general-anomaly-review"


def prompt_for_case(case: dict, solution_id: str | None = None) -> str:
    solution_rule = SOLUTION_RULES.get(solution_id or "")
    return json.dumps({
        "task": "Focused regression recheck for a CP report extraction anomaly. Re-read the source image(s) only, compare against the recorded failure, and decide whether the failure reproduces under the current reviewer guidance.",
        "general_solution_under_test": {
            "solution_id": solution_id,
            "title": solution_rule.get("title") if solution_rule else None,
            "instruction": solution_rule.get("prompt") if solution_rule else None,
        },
        "case": {
            "title": case.get("title"),
            "kind": case.get("kind"),
            "severity": case.get("severity"),
            "reviewer_note": case.get("note"),
            "evidence": case.get("anomaly", {}).get("evidence") or [],
        },
        "domain_rules": [
            "Do not use the old extracted value as truth; it is the suspect value.",
            "Table 3 and Table 6 potentials are normally negative; preserve visible minus signs and consider reverse polarity/missing minus in notes.",
            "Table 4 current readings are normally mA, not A. Table 4 shunt readings are normally mV.",
            "Large un-decimaled current values like 6369/4386 are likely missed decimal readings if the display visually supports 63.69/43.86.",
            "Tiny Table 3 values around 0.08 beside peers around 0.8 may indicate missed digit/decimal; inspect the LCD carefully.",
        ],
        "output_schema": {
            "status": "reproduced|fixed|needs_review",
            "summary": "short explanation",
            "case_still_flags": "boolean",
            "readings": [{
                "source_image": "filename",
                "old_value": "old suspect value",
                "rechecked_value": "source-backed value",
                "unit": "unit if visible/inferred",
                "issue_present": "boolean",
                "confidence": "0..1",
                "notes": "why",
            }],
            "agent_prompt_lessons": ["short reusable lessons for future leaf agents"],
        },
    }, separators=(",", ":"))


def run_case(case: dict, log: RecheckLog, solution_id: str | None = None) -> dict:
    evidence = case.get("anomaly", {}).get("evidence") or []
    content = [{"type": "input_text", "text": prompt_for_case(case, solution_id)}]
    image_count = 0
    for item in evidence[:12]:
        path = image_path(str(item.get("structure")), str(item.get("source_image")))
        content.append({"type": "input_text", "text": f"structure={item.get('structure')}; agent={item.get('agent')}; source_image={item.get('source_image')}; old_value={item.get('value')}"})
        if path:
            content.append(as_input_image(compress(path, log.run_dir)))
            image_count += 1
    log.event("case", f"Rechecking {case.get('title')}", case_id=case.get("case_id"), image_count=image_count)
    started = time.time()
    response = create_response(model=MODEL, content=content, start_dir=log.run_dir / "llm-usage", reasoning_effort="low")
    elapsed = round(time.time() - started, 2)
    text = response_text(response)
    parsed = strict_json(text)
    return {
        "case_id": case.get("case_id"),
        "signature": case.get("signature"),
        "title": case.get("title"),
        "kind": case.get("kind"),
        "severity": case.get("severity"),
        "solution_id": solution_id_for_case(case),
        "review_note": case.get("note"),
        "image_count": image_count,
        "elapsed_seconds": elapsed,
        "response_id": response.get("id"),
        **parsed,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recheck-id", required=True)
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--solution-id", choices=sorted(SOLUTION_RULES), default=None)
    args = parser.parse_args()

    run_dir = RECHECKS / args.recheck_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log = RecheckLog(run_dir)
    cases = latest_cases()
    if args.solution_id:
        cases = [case for case in cases if solution_id_for_case(case) == args.solution_id]
        log.state["solution_id"] = args.solution_id
        log.state["solution_title"] = SOLUTION_RULES[args.solution_id]["title"]
    cases = cases[: args.limit]
    log.state["cases_total"] = len(cases)
    log.write()
    try:
        for case in cases:
            try:
                result = run_case(case, log, args.solution_id)
            except Exception as exc:
                result = {
                    "case_id": case.get("case_id"),
                    "signature": case.get("signature"),
                    "title": case.get("title"),
                    "status": "needs_review",
                    "summary": f"Recheck failed: {exc}",
                    "case_still_flags": True,
                    "readings": [],
                    "agent_prompt_lessons": [],
                }
            log.state["results"].append(result)
            log.state["cases_done"] = len(log.state["results"])
            log.write()
            log.event("case_complete", f"{result.get('status')}: {result.get('title')}", case_id=result.get("case_id"), status=result.get("status"))
        (run_dir / "results.json").write_text(json.dumps(log.state["results"], indent=2) + "\n")
        log.finish("complete", "Focused regression recheck complete")
    except Exception as exc:
        log.finish("failed", f"Focused regression recheck failed: {exc}")
        raise


if __name__ == "__main__":
    main()
