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

import docx_review


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
VALIDATIONS = RUNS / "validations"
VALIDATION_REVIEW_METADATA = RUNS / "validation-review-metadata.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"
SOURCE_BACKED_EXCEPTIONS = RUNS / "source-backed-exceptions.jsonl"
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
                "potential-sign-validator": {"name": "potential-sign-validator", "status": "pending", "message": "Queued"},
                "decimal-scale-validator": {"name": "decimal-scale-validator", "status": "pending", "message": "Queued"},
                "meter-orientation-validator": {"name": "meter-orientation-validator", "status": "pending", "message": "Queued"},
                "unit-sanity-validator": {"name": "unit-sanity-validator", "status": "pending", "message": "Queued"},
                "station-pair-validator": {"name": "station-pair-validator", "status": "pending", "message": "Queued"},
                "docx-review-validator": {"name": "docx-review-validator", "status": "pending", "message": "Queued"},
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

    log.agent("potential-sign-validator", "running", "Checking potential sign, faint-minus, and polarity anomalies")
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
    for structure, items in dataset["structures"].items():
        potentials = [item for item in items if item["agent"].startswith("table3-") or item["agent"] == "table6-potentials"]
        by_potential_agent = {}
        for item in potentials:
            by_potential_agent.setdefault(item["agent"], []).append(item)
        for agent, agent_items in by_potential_agent.items():
            positive = [item for item in agent_items if item["numeric"] is not None and item["numeric"] > 0]
            negative = [item for item in agent_items if item["numeric"] is not None and item["numeric"] < 0]
            note_negative = [item for item in agent_items if re.search(r"\bminus|negative|leading\s*-|faint\s*-", str(item.get("notes") or ""), re.I) and item["numeric"] is not None and item["numeric"] > 0]
            if note_negative:
                flags.append(anomaly(
                    "potential_sign_note_mismatch",
                    "high",
                    f"STR {structure} {agent} values stored positive but notes/evidence say negative",
                    "The stored numeric sign conflicts with extraction notes mentioning a minus/negative sign. This is a likely dropped-minus transcription error.",
                    note_negative,
                    0.94,
                ))
            if positive and negative:
                flags.append(anomaly(
                    "mixed_potential_polarity",
                    "medium",
                    f"STR {structure} {agent} mixes positive and negative potential values",
                    "Mixed polarity in a local Table 3/Table 6 group requires source review: either dropped minus signs or true source-positive/reversed-lead readings.",
                    [*positive[:6], *negative[:6]],
                    0.82,
                ))
            if positive and len(positive) == len(agent_items) and (agent.startswith("table3-") or agent == "table6-potentials"):
                flags.append(anomaly(
                    "source_positive_potential_review",
                    "medium",
                    f"STR {structure} {agent} has all-positive potential values",
                    "Table 3/Table 6 potentials are usually negative. If LCDs truly show no minus, keep source-positive values but flag polarity/reverse-lead review.",
                    positive[:8],
                    0.76,
                ))
    log.agent("potential-sign-validator", "complete", f"Potential sign pass produced {len(flags) - before} flags")

    log.agent("decimal-scale-validator", "running", "Checking missed decimal and magnitude-scale anomalies")
    before = len(flags)
    for agent, items in by_agent.items():
        for record in items:
            value = record["numeric"]
            if value is None:
                continue
            abs_value = abs(value)
            is_current = agent in {"table4-stations", "table5-currents"}
            if is_current and abs_value >= 250:
                flags.append(anomaly(
                    "current_decimal_scale",
                    "high" if abs_value >= 1000 else "medium",
                    f"STR {record['structure']} {agent} value {record['value']} may have missed decimal point",
                    "Current/shunt LCD readings with very large magnitudes often come from missed decimal points and should be source-rechecked before DOCX write.",
                    [record],
                    0.88,
                ))
            if (agent.startswith("table3-") or agent == "table6-potentials") and 0 < abs_value < 0.1:
                peers = [abs(item["numeric"]) for item in items if item["numeric"] is not None and item is not record]
                peer_median = sorted(peers)[len(peers) // 2] if peers else None
                if peer_median and peer_median >= 0.5:
                    flags.append(anomaly(
                        "potential_decimal_scale",
                        "high",
                        f"STR {record['structure']} {agent} value {record['value']} is about 10x smaller than peers",
                        "Potential value is much smaller than neighboring readings; re-zoom for dropped digit/decimal and faint minus sign.",
                        [record],
                        0.88,
                    ))
    log.agent("decimal-scale-validator", "complete", f"Decimal/scale pass produced {len(flags) - before} flags")


    log.agent("meter-orientation-validator", "running", "Checking rotated/upside-down seven-segment LCD risks")
    before = len(flags)
    for record in records:
        if record["agent"] != "table4-stations":
            continue
        label_text = " ".join(str(record.get(key) or "") for key in ("row", "station", "notes", "value", "source_image")).lower()
        unit = str(record.get("unit") or "")
        numeric = record.get("numeric")
        is_row2_shunt = "row 2" in label_text or "shunt" in label_text
        orientation_terms = re.search(r"upside|rotat|orientation|angle|glare|seven[- ]?segment|voltmeter", label_text, re.I)
        unit_conflict = is_row2_shunt and re.search(r"ma|amp", unit, re.I)
        suspicious_digit = is_row2_shunt and numeric is not None and abs(numeric) >= 50 and re.search(r"[069]", str(record.get("value") or ""))
        if orientation_terms or unit_conflict or suspicious_digit:
            flags.append(anomaly(
                "meter_orientation_seven_segment",
                "high" if unit_conflict or orientation_terms else "medium",
                f"STR {record['structure']} Table 4 shunt/meter reading may be orientation-sensitive",
                "Rotated/upside-down seven-segment LCDs can produce a wrong transcription. Re-orient the meter image, verify decimal/unit indicators, and do not silently accept the old value.",
                [record],
                0.9 if unit_conflict or orientation_terms else 0.78,
            ))
    log.agent("meter-orientation-validator", "complete", f"Meter orientation pass produced {len(flags) - before} flags")

    log.agent("unit-sanity-validator", "running", "Checking table/unit consistency anomalies")
    before = len(flags)
    for record in records:
        unit = str(record.get("unit") or "")
        agent = record["agent"]
        if (agent.startswith("table3-") or agent == "table6-potentials") and unit and not re.search(r"\bV\b", unit, re.I):
            flags.append(anomaly(
                "unit_sanity",
                "medium",
                f"STR {record['structure']} {agent} has non-voltage unit {unit}",
                "Table 3/Table 6 potentials should be voltage readings; unit inconsistency needs review.",
                [record],
                0.78,
            ))
        if agent == "table4-stations" and unit and not re.search(r"\bm?A\b|\bmV\b|amp|volt", unit, re.I):
            flags.append(anomaly(
                "unit_sanity",
                "medium",
                f"STR {record['structure']} Table 4 has unusual unit {unit}",
                "Table 4 station rows should be current or shunt-voltage measurements; unusual units need review.",
                [record],
                0.72,
            ))
    log.agent("unit-sanity-validator", "complete", f"Unit sanity pass produced {len(flags) - before} flags")

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
            "rotated/upside-down seven-segment LCD orientation errors, especially Table 4 shunt readings where 90 may actually be 6.0",
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


def cluster_key(item: dict) -> tuple | None:
    kind = str(item.get("kind") or "")
    cluster_kinds = {
        "sign_outlier",
        "potential_sign_note_mismatch",
        "mixed_potential_polarity",
        "source_positive_potential_review",
        "current_decimal_scale",
        "potential_decimal_scale",
        "unit_sanity",
    }
    if kind not in cluster_kinds:
        return None
    evidence = item.get("evidence") or []
    first = evidence[0] if evidence else {}
    structure = first.get("structure")
    agent = first.get("agent")
    if not structure or not agent:
        return None
    class_name = "potential_sign" if kind in {"sign_outlier", "potential_sign_note_mismatch", "mixed_potential_polarity", "source_positive_potential_review"} else kind
    return (class_name, structure, agent)


def clustered(anomalies: list[dict]) -> list[dict]:
    groups = {}
    passthrough = []
    severity_rank = {"high": 0, "medium": 1, "low": 2}
    for item in anomalies:
        key = cluster_key(item)
        if not key:
            passthrough.append(item)
            continue
        group = groups.setdefault(key, [])
        group.append(item)
    out = passthrough[:]
    for (class_name, structure, agent), items in groups.items():
        evidence = []
        seen = set()
        for item in items:
            for record in item.get("evidence") or []:
                key = (record.get("run_id"), record.get("agent"), record.get("source_image"), record.get("value"))
                if key in seen:
                    continue
                seen.add(key)
                evidence.append(record)
        worst = sorted(items, key=lambda item: severity_rank.get(item.get("severity"), 3))[0]
        title_map = {
            "potential_sign": f"STR {structure} {agent} potential sign/polarity evidence needs grouped replay",
            "current_decimal_scale": f"STR {structure} {agent} current decimal-scale evidence needs grouped replay",
            "potential_decimal_scale": f"STR {structure} {agent} potential decimal-scale evidence needs grouped replay",
            "unit_sanity": f"STR {structure} {agent} unit consistency evidence needs grouped replay",
        }
        why = " | ".join(dict.fromkeys(str(item.get("why") or "") for item in items if item.get("why")))
        fingerprint = json.dumps(
            [(ev.get("structure"), ev.get("agent"), ev.get("source_image"), ev.get("value"), ev.get("numeric")) for ev in evidence],
            sort_keys=True,
            separators=(",", ":"),
        )
        signature = hashlib.sha1(f"{class_name}|{structure}|{agent}|{fingerprint}".encode()).hexdigest()
        out.append({
            "id": re.sub(r"[^a-zA-Z0-9_-]+", "-", f"{class_name}-{structure}-{agent}-{signature[:12]}").strip("-")[:140],
            "signature": signature,
            "evidence_hash": hashlib.sha1(fingerprint.encode()).hexdigest(),
            "kind": class_name,
            "severity": worst.get("severity") or "medium",
            "title": title_map.get(class_name, f"STR {structure} {agent} grouped validation evidence"),
            "why": why or "Grouped first-pass validator evidence should be replayed together so correction happens in one source-backed pass.",
            "confidence": max(float(item.get("confidence") or 0.0) for item in items),
            "evidence": evidence[:12],
            "status": "open",
            "clustered_from": len(items),
        })
    return out


def _jsonl_records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            records.append(item)
    return records


def prior_review_decisions() -> dict:
    accepted_statuses = {
        "accepted_source_backed",
        "source_backed_accepted",
        "reviewed",
        "resolved",
        "good_job",
        "saved",
        "not_error",
        "accepted",
        "corrected",
        "verified",
    }
    decisions = {}
    for item in [*_jsonl_records(VALIDATION_REVIEW_METADATA), *_jsonl_records(FEEDBACK_PROCESSING)]:
        status = str(item.get("status") or item.get("decision") or "").lower()
        if status and status not in accepted_statuses:
            continue
        for key in (
            item.get("signature"),
            item.get("anomaly_signature"),
            item.get("case_signature"),
        ):
            if key:
                decisions[str(key)] = item
        evidence_key = item.get("evidence_hash")
        if evidence_key:
            decisions[f"evidence:{evidence_key}"] = item
    return decisions


def source_backed_exceptions() -> list[dict]:
    accepted = []
    for item in _jsonl_records(SOURCE_BACKED_EXCEPTIONS):
        status = str(item.get("status") or "").lower()
        if not status or status in {"accepted_source_backed", "source_backed_accepted", "source-backed"}:
            accepted.append(item)
    return accepted


def anomaly_review_class(item: dict) -> str:
    text = " ".join(str(item.get(key) or "").lower() for key in ("kind", "title", "why", "note", "status", "error_class"))
    if any(token in text for token in ("sign", "polarity", "minus", "positive", "negative", "potential", "v dc")):
        return "potential_sign"
    if any(token in text for token in ("upside", "rotat", "orientation", "seven-segment", "voltmeter")):
        return "meter_orientation"
    if any(token in text for token in ("decimal", "magnitude", "scale", "outlier", "dropped digit")):
        return "magnitude_scale"
    if any(token in text for token in ("unit", "ma", "mv", "dc", "amp", "volt")):
        return "unit_sanity"
    if any(token in text for token in ("missing", "extra", "count", "four", "five", "expected")):
        return "shape_count"
    kind = str(item.get("kind") or item.get("error_class") or "review").lower()
    return kind or "review"


def evidence_groups(item: dict) -> dict[tuple[str, str], set[str]]:
    groups: dict[tuple[str, str], set[str]] = {}
    evidence = item.get("evidence") if isinstance(item.get("evidence"), list) else []
    if not evidence and isinstance(item.get("source_evidence"), list):
        evidence = item.get("source_evidence")
    for ev in evidence:
        if not isinstance(ev, dict):
            continue
        structure = str(ev.get("structure") or item.get("structure") or "").strip()
        agent = str(ev.get("agent") or ev.get("table") or item.get("agent") or "").strip()
        source = str(ev.get("source_image") or ev.get("source") or ev.get("image") or "").strip()
        if structure and agent and source:
            groups.setdefault((structure, agent), set()).add(source)
    structure = str(item.get("structure") or "").strip()
    agent = str(item.get("agent") or "").strip()
    source = str(item.get("source_image") or item.get("source") or "").strip()
    if structure and agent and source:
        groups.setdefault((structure, agent), set()).add(source)
    return groups


def source_backed_exception_match(item: dict, exceptions: list[dict]) -> dict | None:
    item_groups = evidence_groups(item)
    if not item_groups:
        return None
    item_class = anomaly_review_class(item)
    for prior in exceptions:
        prior_groups = evidence_groups(prior)
        if not prior_groups:
            continue
        prior_class = anomaly_review_class(prior)
        if prior_class != item_class:
            continue
        for key, item_sources in item_groups.items():
            prior_sources = prior_groups.get(key)
            if not prior_sources:
                continue
            overlap = item_sources & prior_sources
            if not overlap:
                continue
            if item_sources <= prior_sources:
                return prior
            required = min(2, len(item_sources), len(prior_sources))
            if len(overlap) >= required:
                return prior
    return None


def suppress_previously_resolved(anomalies: list[dict]) -> tuple[list[dict], list[dict]]:
    prior = prior_review_decisions()
    source_exceptions = source_backed_exceptions()
    kept = []
    suppressed = []
    for item in anomalies:
        signature_key = str(item.get("signature") or "")
        evidence_key = str(item.get("evidence_hash") or "")
        matched = prior.get(signature_key) or prior.get(f"evidence:{evidence_key}")
        if not matched:
            matched = source_backed_exception_match(item, source_exceptions)
        if matched:
            suppressed.append({**item, "suppressed_by": matched})
            continue
        kept.append(item)
    return kept, suppressed


def docx_review_flags(log: ValidationLog) -> list[dict]:
    log.agent("docx-review-validator", "running", "Reading final DOCX and comparing against writer cell patches")
    payload = docx_review.build_payload()
    flags = []
    blocking = {"missing_write", "mismatch", "patch_error"}
    for structure in payload.get("structures") or []:
        evidence = []
        for slot in structure.get("slots") or []:
            if slot.get("status") not in blocking:
                continue
            evidence.append({
                "structure": structure.get("structure"),
                "run_id": structure.get("run_id"),
                "agent": slot.get("agent"),
                "table": slot.get("table_key"),
                "row": slot.get("row_index"),
                "col": slot.get("col_index"),
                "source_image": slot.get("source_ref"),
                "value": slot.get("actual"),
                "expected": slot.get("expected"),
                "status": slot.get("status"),
                "label": slot.get("label"),
            })
        if evidence:
            flags.append(anomaly(
                "docx_review_discrepancy",
                "high",
                f"STR {structure.get('structure')} final DOCX does not match expected writer cells",
                "DOCX Review found missing-write, mismatch, or patch-error cells in the active final DOCX. These must be corrected before trusting the report.",
                evidence,
                0.99,
            ))
    summary = payload.get("summary") or {}
    log.agent(
        "docx-review-validator",
        "complete",
        f"DOCX review pass produced {len(flags)} blocking flags",
        docx_review_summary=summary,
        active_docx=payload.get("active_docx"),
    )
    return flags


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
        docx_flags = docx_review_flags(log)
        try:
            llm_flags = llm_review(dataset, [*preflags, *docx_flags], log)
        except Exception as exc:
            llm_flags = []
            log.agent("llm-reviewer", "failed", f"OpenAI validation reviewer failed; keeping deterministic anomaly cards: {exc}")
        anomalies, suppressed = suppress_previously_resolved(dedupe(clustered([*preflags, *docx_flags, *llm_flags])))
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
