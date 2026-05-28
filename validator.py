from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, "/Users/aadityarajesh/Downloads/MT/us-mike-carose-soil-data-2026/J260106 - SBA (anchor inspections Y-2026) -- in process/src")

from sba_report_tool.openai_api import create_response, response_text


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
VALIDATIONS = RUNS / "validations"
VALIDATION_REVIEW_METADATA = RUNS / "validation-review-metadata.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"
MODEL = "gpt-5.2"


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class ValidationLog:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.events_path = run_dir / "events.jsonl"
        self.state_path = run_dir / "state.json"
        self.seq = 0
        self.state = {
            "validation_id": run_dir.name,
            "status": "running",
            "started_at": now(),
            "updated_at": now(),
            "agents": {
                "validation-orchestrator": {"name": "validation-orchestrator", "status": "running", "message": "Collecting extracted STR dataset"},
                "shape-validator": {"name": "shape-validator", "status": "pending", "message": "Queued"},
                "range-sign-validator": {"name": "range-sign-validator", "status": "pending", "message": "Queued"},
                "station-pair-validator": {"name": "station-pair-validator", "status": "pending", "message": "Queued"},
                "llm-reviewer": {"name": "llm-reviewer", "status": "pending", "message": "Queued"},
            },
            "anomalies": [],
            "metrics": {},
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
        self.state["messages"] = self.state["messages"][-100:]
        self.write()

    def agent(self, key: str, status: str, message: str, **data):
        agent = self.state.setdefault("agents", {}).setdefault(key, {"name": key, "events": []})
        agent.update({"status": status, "message": message, "updated_at": now(), **data})
        agent["events"] = [*agent.get("events", []), {"at": now(), "status": status, "message": message}][-30:]
        self.write()
        self.event("agent", message, agent=key, status=status, **data)

    def finish(self, status: str, message: str):
        self.state["status"] = status
        self.state["finished_at"] = now()
        self.write()
        self.event("finish", message, status=status)


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def latest_runs() -> list[tuple[Path, dict]]:
    runs = []
    for path in RUNS.iterdir():
        if not path.is_dir() or path.name.startswith(".") or path.name == "validations":
            continue
        state_path = path / "state.json"
        leaf_path = path / "leaf-results.json"
        if not state_path.exists() or not leaf_path.exists():
            continue
        state = read_json(state_path, {})
        if not state.get("structure"):
            continue
        runs.append((path, state))
    runs.sort(key=lambda item: item[1].get("updated_at") or item[1].get("started_at") or item[0].name, reverse=True)
    latest = {}
    for path, state in runs:
        latest.setdefault(str(state.get("structure")), (path, state))
    return sorted(latest.values(), key=lambda item: int(item[1].get("target", {}).get("ordinal") or 999))


def number(value):
    text = str(value if value is not None else "").replace(",", "").strip()
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def record_from_reading(structure: str, run_id: str, ordinal, agent: str, reading: dict, index: int) -> dict:
    value = reading.get("visible_value", reading.get("value"))
    numeric = number(value)
    table = "table3" if agent.startswith("table3") else agent.split("-")[0]
    return {
        "id": f"{run_id}:{agent}:{index}",
        "structure": structure,
        "run_id": run_id,
        "ordinal": ordinal,
        "agent": agent,
        "table": table,
        "row": reading.get("row_name") or reading.get("annotation_label") or reading.get("mg") or reading.get("test_station") or "",
        "station": reading.get("station") or reading.get("test_station") or reading.get("mg") or "",
        "source_image": reading.get("source_image") or "",
        "sequence_index": reading.get("sequence_index"),
        "value": value,
        "numeric": numeric,
        "unit": reading.get("unit_seen") or "",
        "confidence": reading.get("confidence"),
        "notes": reading.get("notes") or "",
    }


def collect_dataset(log: ValidationLog) -> dict:
    records = []
    runs = latest_runs()
    for path, state in runs:
        leaf = read_json(path / "leaf-results.json", {})
        for agent, payload in leaf.items():
            for index, reading in enumerate(payload.get("readings", []) if isinstance(payload, dict) else [], start=1):
                records.append(record_from_reading(str(state.get("structure")), path.name, state.get("target", {}).get("ordinal"), agent, reading, index))
    by_structure = {}
    for record in records:
        by_structure.setdefault(record["structure"], []).append(record)
    log.agent("validation-orchestrator", "complete", f"Collected {len(records)} readings from {len(by_structure)} STRs", structures=len(by_structure), readings=len(records))
    return {"records": records, "structures": by_structure}


def anomaly(kind: str, severity: str, title: str, why: str, records: list[dict], confidence: float = 0.8) -> dict:
    evidence = []
    for record in records[:12]:
        evidence.append({
            "structure": record.get("structure"),
            "run_id": record.get("run_id"),
            "agent": record.get("agent"),
            "source_image": record.get("source_image"),
            "value": record.get("value"),
            "numeric": record.get("numeric"),
            "row": record.get("row"),
            "station": record.get("station"),
        })
    evidence_fingerprint = json.dumps(
        [(item.get("structure"), item.get("agent"), item.get("source_image"), item.get("value"), item.get("numeric")) for item in evidence],
        sort_keys=True,
        separators=(",", ":"),
    )
    signature = hashlib.sha1(f"{kind}|{title}|{evidence_fingerprint}".encode()).hexdigest()
    seed = "|".join([kind, title, signature[:12]])
    return {
        "id": re.sub(r"[^a-zA-Z0-9_-]+", "-", seed).strip("-")[:140],
        "signature": signature,
        "evidence_hash": hashlib.sha1(evidence_fingerprint.encode()).hexdigest(),
        "kind": kind,
        "severity": severity,
        "title": title,
        "why": why,
        "confidence": confidence,
        "evidence": evidence,
        "status": "open",
    }


def deterministic_flags(dataset: dict, log: ValidationLog) -> list[dict]:
    records = dataset["records"]
    flags = []
    by_structure_agent = {}
    for record in records:
        by_structure_agent.setdefault((record["structure"], record["agent"]), []).append(record)

    log.agent("shape-validator", "running", "Checking table row shapes and missing value counts")
    for (structure, agent), items in by_structure_agent.items():
        if agent.startswith("table3") and len(items) != 5:
            flags.append(anomaly(
                "missing_or_extra_values",
                "high" if len(items) < 5 else "medium",
                f"STR {structure} {agent} has {len(items)} Table 3 values, expected 5",
                "Table 3 rows usually have five pipe-to-soil readings. A row with four or six values is review-worthy.",
                items,
                0.92,
            ))
    log.agent("shape-validator", "complete", f"Shape pass produced {len(flags)} flags")

    log.agent("range-sign-validator", "running", "Checking sign and magnitude outliers")
    by_agent = {}
    for record in records:
        if record["numeric"] is not None:
            by_agent.setdefault(record["agent"], []).append(record)
    before = len(flags)
    for agent, items in by_agent.items():
        values = [record["numeric"] for record in items if record["numeric"] is not None]
        if len(values) < 6:
            continue
        positives = [record for record in items if record["numeric"] is not None and record["numeric"] > 0]
        negatives = [record for record in items if record["numeric"] is not None and record["numeric"] < 0]
        minority = positives if len(positives) < len(negatives) else negatives
        majority = "negative" if len(negatives) >= len(positives) else "positive"
        if minority and len(minority) <= max(2, math.ceil(len(items) * 0.08)):
            for record in minority[:10]:
                sign = "positive" if record["numeric"] > 0 else "negative"
                flags.append(anomaly(
                    "sign_outlier",
                    "medium",
                    f"STR {record['structure']} {agent} has {sign} value among mostly {majority} values",
                    "The sign differs from the dominant sign pattern for the same leaf across the extracted dataset.",
                    [record],
                    0.78,
                ))
        sorted_values = sorted(values)
        median = sorted_values[len(sorted_values) // 2]
        deviations = [abs(v - median) for v in values]
        mad = sorted(deviations)[len(deviations) // 2] or 1
        for record in items:
            if record["numeric"] is None:
                continue
            robust_z = abs(record["numeric"] - median) / mad
            if robust_z >= 8 and abs(record["numeric"] - median) >= 100:
                flags.append(anomaly(
                    "magnitude_outlier",
                    "medium",
                    f"STR {record['structure']} {agent} value {record['value']} is far from peer median {median:g}",
                    "Robust median/MAD scan found a large magnitude deviation inside the same table leaf.",
                    [record],
                    0.72,
                ))
    log.agent("range-sign-validator", "complete", f"Range/sign pass produced {len(flags) - before} flags")

    log.agent("station-pair-validator", "running", "Checking station/anode pairing coverage")
    before = len(flags)
    for structure, items in dataset["structures"].items():
        table5 = [item for item in items if item["agent"] == "table5-currents"]
        table6 = [item for item in items if item["agent"] == "table6-potentials"]
        if table5 and table6 and abs(len(table5) - len(table6)) >= 2:
            flags.append(anomaly(
                "station_pair_mismatch",
                "medium",
                f"STR {structure} Table 5/Table 6 count mismatch",
                f"Table 5 has {len(table5)} readings while Table 6 has {len(table6)} readings. Current/potential station pairs may need review.",
                [*table5[:6], *table6[:6]],
                0.8,
            ))
    log.agent("station-pair-validator", "complete", f"Station pairing pass produced {len(flags) - before} flags")
    return flags


def strict_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text[text.find("{") : text.rfind("}") + 1])


def llm_review(dataset: dict, preflags: list[dict], log: ValidationLog) -> list[dict]:
    compact_records = dataset["records"]
    prompt = {
        "task": "Validate extracted CP installation report readings. Find anomalies a human reviewer should inspect. Do not invent values. Use the extracted records only.",
        "look_for": [
            "Table 3 rows with missing/extra values",
            "sign abnormalities compared with neighboring structures or same table leaf",
            "magnitude outliers",
            "station/anode pairing mismatches across Table 4/5/6",
            "unit or label oddities",
            "low confidence values that also look structurally suspicious",
        ],
        "output_schema": {
            "summary": "short overall validation assessment",
            "accuracy_estimate": {"overall_percent": "number or null", "basis": "string"},
            "anomalies": [{
                "kind": "short category",
                "severity": "low|medium|high",
                "title": "human-readable title",
                "why": "specific reason",
                "confidence": "0..1",
                "evidence_ids": ["record id strings"],
            }],
        },
        "records": compact_records,
        "deterministic_preflags": preflags,
        "prior_review_decisions": list(prior_review_decisions().values())[-200:],
    }
    log.agent("llm-reviewer", "running", "OpenAI validation reviewer checking extracted dataset", model=MODEL, records=len(compact_records))
    started = time.time()
    response = create_response(
        model=MODEL,
        content=[{"type": "input_text", "text": json.dumps(prompt, separators=(",", ":"))}],
        start_dir=log.run_dir / "llm-usage",
        reasoning_effort="low",
    )
    elapsed = round(time.time() - started, 2)
    text = response_text(response)
    (log.run_dir / "llm-review.raw.txt").write_text(text + "\n")
    parsed = strict_json(text)
    (log.run_dir / "llm-review.json").write_text(json.dumps(parsed, indent=2) + "\n")
    by_id = {record["id"]: record for record in compact_records}
    out = []
    for item in parsed.get("anomalies", []):
        records = [by_id[item_id] for item_id in item.get("evidence_ids", []) if item_id in by_id]
        if not records:
            continue
        out.append(anomaly(
            str(item.get("kind") or "llm_review"),
            str(item.get("severity") or "medium"),
            str(item.get("title") or "Validation anomaly"),
            str(item.get("why") or "OpenAI validation reviewer flagged this extracted value."),
            records,
            float(item.get("confidence") or 0.7),
        ))
    log.state["summary"] = parsed.get("summary") or ""
    log.state["accuracy_estimate"] = parsed.get("accuracy_estimate") or {}
    log.agent("llm-reviewer", "complete", f"OpenAI validation review complete in {elapsed}s", elapsed_seconds=elapsed, response_id=response.get("id"))
    return out


def dedupe(anomalies: list[dict]) -> list[dict]:
    seen = set()
    out = []
    order = {"high": 0, "medium": 1, "low": 2}
    for item in sorted(anomalies, key=lambda x: (order.get(x.get("severity"), 3), x.get("title", ""))):
        key = (item.get("kind"), tuple((ev.get("run_id"), ev.get("agent"), ev.get("source_image"), ev.get("value")) for ev in item.get("evidence", [])[:4]))
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out[:80]


def prior_review_decisions() -> dict:
    decisions = {}
    if not VALIDATION_REVIEW_METADATA.exists():
        return decisions
    for line in VALIDATION_REVIEW_METADATA.read_text().splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        signature = item.get("signature")
        if signature:
            decisions[signature] = item
    return decisions


def suppress_previously_resolved(anomalies: list[dict]) -> tuple[list[dict], list[dict]]:
    decisions = prior_review_decisions()
    kept = []
    suppressed = []
    for item in anomalies:
        prior = decisions.get(item.get("signature"))
        if prior and prior.get("evidence_hash") == item.get("evidence_hash") and prior.get("status") in {"good", "reviewed", "dismissed"}:
            suppressed.append({**item, "suppressed_by": prior})
        else:
            kept.append(item)
    return kept, suppressed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation-id", required=True)
    args = parser.parse_args()

    run_dir = VALIDATIONS / args.validation_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log = ValidationLog(run_dir)
    try:
        dataset = collect_dataset(log)
        (run_dir / "dataset.json").write_text(json.dumps(dataset["records"], indent=2) + "\n")
        preflags = deterministic_flags(dataset, log)
        try:
            llm_flags = llm_review(dataset, preflags, log)
        except Exception as exc:
            llm_flags = []
            log.agent("llm-reviewer", "failed", f"OpenAI validation reviewer failed; keeping deterministic anomaly cards: {exc}")
        anomalies, suppressed = suppress_previously_resolved(dedupe([*preflags, *llm_flags]))
        if suppressed:
            with FEEDBACK_PROCESSING.open("a") as handle:
                for item in suppressed:
                    handle.write(json.dumps({
                        "at": now(),
                        "kind": "validation_anomaly_suppressed_from_prior_review",
                        "validation_id": args.validation_id,
                        "signature": item.get("signature"),
                        "evidence_hash": item.get("evidence_hash"),
                        "prior_status": item.get("suppressed_by", {}).get("status"),
                        "prior_note": item.get("suppressed_by", {}).get("note"),
                        "title": item.get("title"),
                    }) + "\n")
        log.state["anomalies"] = anomalies
        log.state["suppressed_anomalies"] = suppressed
        log.state["metrics"] = {
            "structures": len(dataset["structures"]),
            "readings": len(dataset["records"]),
            "anomalies": len(anomalies),
            "suppressed": len(suppressed),
            "high": sum(1 for item in anomalies if item.get("severity") == "high"),
            "medium": sum(1 for item in anomalies if item.get("severity") == "medium"),
            "low": sum(1 for item in anomalies if item.get("severity") == "low"),
            "review_accuracy_proxy_percent": max(0, round(100 - (len(anomalies) / max(1, len(dataset["records"]))) * 100, 1)),
        }
        (run_dir / "anomalies.json").write_text(json.dumps(anomalies, indent=2) + "\n")
        (run_dir / "suppressed-anomalies.json").write_text(json.dumps(suppressed, indent=2) + "\n")
        log.agent("validation-orchestrator", "complete", f"Validation run complete with {len(anomalies)} anomaly cards")
        log.finish("complete", "Validation run complete")
    except Exception as exc:
        log.agent("validation-orchestrator", "failed", str(exc))
        log.finish("failed", f"Validation run failed: {exc}")
        raise


if __name__ == "__main__":
    main()
