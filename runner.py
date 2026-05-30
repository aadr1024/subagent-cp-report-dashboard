from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("CP_REPORT_CONFIG") or (ROOT / "report-source-of-truth.local.json" if (ROOT / "report-source-of-truth.local.json").exists() else ROOT / "report-source-of-truth.json"))
CONFIG = json.loads(CONFIG_PATH.read_text())
REPORT_TOOL_SRC = os.environ.get("SBA_REPORT_TOOL_SRC") or CONFIG.get("report_tool_src") or ""
if REPORT_TOOL_SRC:
    sys.path.insert(0, str(Path(REPORT_TOOL_SRC).expanduser()))

from sba_report_tool.docx_ops import NS, extract_text, load_docx_parts
from sba_report_tool.openai_api import as_input_image, create_response, response_text


RUNS = ROOT / "runs"
CURRENT = RUNS / "current-run.txt"
REPORT = Path(os.environ.get("CP_REPORT_ORIGINAL_DOCX") or CONFIG["original_docx"]).expanduser()
SITE_ROOT = Path(os.environ.get("CP_REPORT_SITE_ROOT") or CONFIG.get("site_root", ROOT / "site-photos")).expanduser()
ANNOTATIONS = Path(os.environ.get("CP_REPORT_ANNOTATIONS") or CONFIG.get("annotation_source", "")).expanduser()
HEADING_PATTERN = CONFIG.get("heading_pattern", "STR")
HEADING_TO_WRITE_TEMPLATE = CONFIG.get("heading_to_write_template", "STR {structure}")
MODEL = "gpt-5.2"
GLOBAL_FEEDBACK = RUNS / "global-feedback.jsonl"
FEEDBACK_PROCESSING = RUNS / "feedback-processing.jsonl"
VALIDATION_REVIEW_METADATA = RUNS / "validation-review-metadata.jsonl"
REGRESSION_CASES = RUNS / "regression-cases.jsonl"

STATUS_ORDER = ["pending", "running", "blocked", "failed", "complete"]


class RunLog:
    def __init__(self, run_dir: Path, structure: str):
        self.run_dir = run_dir
        self.events_path = run_dir / "events.jsonl"
        self.state_path = run_dir / "state.json"
        self.lock = threading.Lock()
        self.seq = 0
        self.state = {
            "run_id": run_dir.name,
            "status": "running",
            "structure": structure,
            "started_at": now(),
            "updated_at": now(),
            "steps": {},
            "agents": {},
            "api_calls": [],
            "artifacts": [],
            "messages": [],
            "target": {},
        }

    def emit(self, event_type: str, message: str, **data):
        with self.lock:
            self.seq += 1
            event = {"seq": self.seq, "at": now(), "type": event_type, "message": message, "data": data}
            with self.events_path.open("a") as handle:
                handle.write(json.dumps(event) + "\n")
            self.state["updated_at"] = event["at"]
            self.state.setdefault("messages", []).append({"at": event["at"], "type": event_type, "message": message})
            self.state["messages"] = self.state["messages"][-80:]
            self.write_state()

    def step(self, key: str, status: str, message: str, **data):
        with self.lock:
            item = self.state["steps"].setdefault(key, {"name": key, "status": "pending", "events": []})
            item.update({"status": status, "message": message, "updated_at": now(), **data})
            item["events"].append({"at": now(), "status": status, "message": message})
            item["events"] = item["events"][-20:]
            self.write_state()
        self.emit("step", message, step=key, status=status, **data)

    def agent(self, key: str, status: str, message: str, **data):
        with self.lock:
            item = self.state["agents"].setdefault(key, {"name": key, "status": "pending", "events": []})
            item.update({"status": status, "message": message, "updated_at": now(), **data})
            item["events"].append({"at": now(), "status": status, "message": message})
            item["events"] = item["events"][-20:]
            self.write_state()
        self.emit("agent", message, agent=key, status=status, **data)

    def api_call(self, agent: str, status: str, message: str, **data):
        with self.lock:
            item = {"at": now(), "agent": agent, "status": status, "message": message, **data}
            self.state["api_calls"].append(item)
            self.state["api_calls"] = self.state["api_calls"][-200:]
            self.write_state()
        self.emit("api", message, agent=agent, status=status, **data)

    def artifact(self, label: str, path: Path):
        rel = path.relative_to(self.run_dir)
        with self.lock:
            self.state["artifacts"].append({"label": label, "path": str(rel), "updated_at": now()})
            self.write_state()
        self.emit("artifact", f"Artifact written: {label}", path=str(rel))

    def write_state(self):
        self.state_path.write_text(json.dumps(self.state, indent=2) + "\n")

    def refresh_from_disk(self):
        with self.lock:
            try:
                disk_state = json.loads(self.state_path.read_text())
            except Exception:
                disk_state = None
            if isinstance(disk_state, dict):
                self.state = disk_state
            try:
                for line in self.events_path.read_text().splitlines():
                    if line.strip():
                        self.seq = max(self.seq, int(json.loads(line).get("seq") or 0))
            except Exception:
                pass

    def finish(self, status: str, message: str):
        with self.lock:
            self.state["status"] = status
            self.state["finished_at"] = now()
            self.write_state()
        self.emit("finish", message, status=status)


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def read_jsonl(path: Path, limit: int = 80) -> list[dict]:
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
    return items[-limit:]


def global_validation_feedback_context() -> str:
    reviews = [
        {
            "status": item.get("status"),
            "note": item.get("note"),
            "anomaly_id": item.get("anomaly_id"),
        }
        for item in read_jsonl(VALIDATION_REVIEW_METADATA, 60)
        if item.get("note") or item.get("status") in {"reviewed", "good"}
    ][-30:]
    cases = [
        {
            "title": item.get("title"),
            "kind": item.get("kind"),
            "note": item.get("note"),
            "evidence": [
                {
                    "structure": ev.get("structure"),
                    "agent": ev.get("agent"),
                    "value": ev.get("value"),
                    "source_image": ev.get("source_image"),
                }
                for ev in (item.get("anomaly", {}).get("evidence") or [])[:6]
            ],
        }
        for item in read_jsonl(REGRESSION_CASES, 40)
        if item.get("note")
    ][-20:]
    domain_rules = [
        "Table 3 pipe-to-soil potential values are normally negative. Do not drop a visible minus sign because of glare, shadow, LCD segment weakness, or photo angle.",
        "Table 6 anode open-circuit potentials are normally negative. If the meter appears positive but the context suggests reverse polarity or missing minus, return the negative value and note the sign ambiguity.",
        "Table 4 current readings are normally milliamps (mA), not amps (A). The leading m can be hidden by lighting; normalize current units to mA unless the display unambiguously says A.",
        "Table 4 shunt readings are normally millivolts (mV). If units are unclear for shunt readings, prefer mV and explain uncertainty.",
        "Before transcribing any digital multimeter LCD, check whether the photo/meter is upside down or rotated. Seven-segment digits can invert into a different number; mentally rotate the display, verify decimal/unit indicators, and flag ambiguity visibly instead of silently accepting.",
        "For Table 4 large LCD numbers such as 6369 or 4386, inspect carefully for a decimal point. These are often 63.69 or 43.86 style current readings, not thousands.",
        "For Table 3 tiny values such as 0.086 where peer values are around 0.8, inspect for a missed digit or decimal position before returning the value.",
        "Do not invent values. If a correction is based on visual ambiguity and domain convention, include notes/confidence so validation can still surface it.",
    ]
    payload = {"domain_rules": domain_rules, "reviewed_feedback": reviews, "regression_cases": cases}
    return "\nGlobal reviewer feedback and regression lessons for all leaf agents: " + json.dumps(payload, separators=(",", ":"))


def site_folders() -> list[Path]:
    folders = [p for p in SITE_ROOT.iterdir() if p.is_dir() and re.match(r"^\d+\s+-\s+\d+", p.name)]
    return sorted(folders, key=lambda p: int(re.match(r"^(\d+)", p.name).group(1)))


def find_site(structure: str) -> tuple[int, Path]:
    for idx, folder in enumerate(site_folders(), start=1):
        if re.search(rf"\b{re.escape(structure)}\b", folder.name):
            return idx, folder
    raise FileNotFoundError(f"No site folder found for structure {structure}")


def latest_reusable_run(structure: str, exclude: str) -> Path | None:
    candidates = []
    for path in RUNS.iterdir():
        if not path.is_dir() or path.name == exclude:
            continue
        state_path = path / "state.json"
        results_path = path / "leaf-results.json"
        if not state_path.exists() or not results_path.exists():
            continue
        try:
            state = json.loads(state_path.read_text())
        except Exception:
            continue
        if str(state.get("structure")) == str(structure) and state.get("status") == "complete":
            candidates.append((state.get("updated_at") or state.get("finished_at") or path.name, path))
    return sorted(candidates, reverse=True)[0][1] if candidates else None


def target_tables_for_ordinal(ordinal: int) -> dict[str, int]:
    start = 5 + (ordinal - 1) * 4
    return {"table3": start, "table4": start + 1, "table5": start + 2, "table6": start + 3}


def heading_body_index_for_ordinal(ordinal: int) -> int | None:
    root, _ = load_docx_parts(REPORT)
    body = root.find(".//w:body", NS)
    if body is None:
        return None
    hits = []
    for i, child in enumerate(list(body)):
        if child.tag.endswith("}p") and re.search(HEADING_PATTERN, extract_text(child).replace("\xa0", " ")):
            hits.append(i)
    return hits[ordinal - 1] if ordinal <= len(hits) else None


def annotations_for_site(folder: Path) -> dict[str, list[Path]]:
    raw = json.loads(ANNOTATIONS.read_text())
    token = f"/{folder.name}/"
    groups: dict[str, list[Path]] = {}
    for raw_path, labels in raw.items():
        if token not in raw_path:
            continue
        for label in labels:
            label = str(label).strip()
            if label.startswith("Table "):
                groups.setdefault(label, []).append(Path(raw_path))
    for paths in groups.values():
        paths.sort(key=lambda p: p.name)
    return dict(sorted(groups.items()))


def site_images(folder: Path) -> list[Path]:
    allowed = {".jpg", ".jpeg", ".png"}
    return sorted([p for p in folder.iterdir() if p.suffix.lower() in allowed], key=lambda p: p.name)


def route_unannotated_images(log: RunLog, run_dir: Path, folder: Path) -> dict[str, list[Path]]:
    images = site_images(folder)
    log.step("image_router", "running", f"No annotations found. Routing {len(images)} folder images with OpenAI planner.")
    log.agent(
        "image-router",
        "running",
        "Parent planner routing unannotated folder images into table evidence groups",
        image_count=len(images),
        prompt_summary="Classify folder images into Table 3 Row 1/2/3/4, Table 4, Table 5, and Table 6 evidence groups before leaf extraction.",
    )
    content = [{
        "type": "input_text",
        "text": (
            "Source-only image router for one CP installation report structure. "
            "You will see the inspection photos in filename order. Assign candidate source images to these exact downstream labels: "
            "Table 3 Row 1, Table 3 Row 2, Table 3 Row 3, Table 3 Row 4, Table 4, Table 5, Table 6. "
            "Table 3 rows are close-up pipe-to-soil potential meter photos, usually multiple sequential values per compass row. "
            "Table 4 is test-station shunt/total-current evidence. Table 5 is Mg anode current evidence. Table 6 is Mg open-circuit potential evidence. "
            "Return strict JSON only: {leaf:'image-router', groups:{label:[filenames...]}, unresolved:[...]}. "
            "Use filenames only. Include uncertain but plausible candidates rather than returning an empty group. Do not extract values."
        ),
    }]
    for index, path in enumerate(images, start=1):
        content.append({"type": "input_text", "text": f"folder_sequence={index}; source_image={path.name}"})
        content.append(as_input_image(compress(path, run_dir)))
    log.api_call("image-router", "running", "Responses API request started", model=MODEL, image_count=len(images))
    started = time.time()
    payload = create_response(model=MODEL, content=content, start_dir=run_dir / "llm-usage", reasoning_effort="low")
    elapsed = round(time.time() - started, 2)
    text = response_text(payload)
    raw_path = run_dir / "image-router.raw.txt"
    json_path = run_dir / "image-router.json"
    raw_path.write_text(text + "\n")
    parsed = strict_json(text)
    json_path.write_text(json.dumps(parsed, indent=2) + "\n")
    log.api_call("image-router", "complete", "Responses API request complete", model=MODEL, elapsed_seconds=elapsed, response_id=payload.get("id"))
    log.artifact("image router raw", raw_path)
    log.artifact("image router json", json_path)
    by_name = {p.name: p for p in images}
    groups: dict[str, list[Path]] = {}
    for label, names in parsed.get("groups", {}).items():
        if not str(label).startswith("Table "):
            continue
        paths = [by_name[name] for name in names if name in by_name]
        if paths:
            groups[str(label)] = paths
    log.agent("image-router", "complete", "Unannotated folder routed into table evidence groups", image_count=len(images), elapsed_seconds=elapsed, groups={k: [p.name for p in v] for k, v in groups.items()}, unresolved=parsed.get("unresolved", []))
    log.step("image_router", "complete", f"Router produced {len(groups)} table evidence groups")
    return groups


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
    first, last = text.find("{"), text.rfind("}")
    return json.loads(text[first : last + 1])


def label_paths(groups: dict[str, list[Path]], prefixes: list[str]) -> list[tuple[str, Path]]:
    out = []
    for label, paths in groups.items():
        if any(label == prefix or label.startswith(prefix) for prefix in prefixes):
            out.extend((label, path) for path in paths)
    return out


def run_leaf(log: RunLog, run_dir: Path, agent: str, prompt: str, labeled_paths: list[tuple[str, Path]], feedback_context: str = "") -> dict:
    log.agent(agent, "running", "Preparing source-image packet", image_count=len(labeled_paths))
    content = [{"type": "input_text", "text": prompt + feedback_context + "\nReturn strict JSON only. Do not use any completed report value as truth."}]
    image_refs = []
    for index, (label, path) in enumerate(labeled_paths, start=1):
        content.append({"type": "input_text", "text": f"sequence_index={index}; source_image={path.name}; annotation_label={label}"})
        packed = compress(path, run_dir)
        image_refs.append({
            "sequence_index": index,
            "source_image": path.name,
            "annotation_label": label,
            "artifact": str(packed.relative_to(run_dir)),
        })
        content.append(as_input_image(packed))
    log.agent(agent, "running", "Responses API request in flight", image_count=len(labeled_paths), image_refs=image_refs)
    log.api_call(agent, "running", "Responses API request started", model=MODEL, image_count=len(labeled_paths))
    started = time.time()
    payload = create_response(model=MODEL, content=content, start_dir=run_dir / "llm-usage", reasoning_effort="low")
    elapsed = round(time.time() - started, 2)
    text = response_text(payload)
    raw_path = run_dir / f"{agent}.raw.txt"
    json_path = run_dir / f"{agent}.json"
    raw_path.write_text(text + "\n")
    parsed = strict_json(text)
    json_path.write_text(json.dumps(parsed, indent=2) + "\n")
    log.api_call(agent, "complete", "Responses API request complete", model=MODEL, elapsed_seconds=elapsed, response_id=payload.get("id"))
    log.agent(
        agent,
        "complete",
        "Leaf complete",
        artifact=f"{agent}.json",
        elapsed_seconds=elapsed,
        image_refs=image_refs,
        readings=parsed.get("readings", []),
        unresolved=parsed.get("unresolved", []),
    )
    log.artifact(f"{agent} raw", raw_path)
    log.artifact(f"{agent} json", json_path)
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--structure", required=True)
    parser.add_argument("--run-id")
    parser.add_argument("--reuse-from")
    args = parser.parse_args()

    run_id = args.run_id or f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-str{args.structure}"
    run_dir = RUNS / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    CURRENT.write_text(run_id + "\n")
    log = RunLog(run_dir, args.structure)
    log.emit("run", "Run created", run_id=run_id)
    log.agent(
        "run-orchestrator",
        "running",
        "Parent agent coordinating target mapping, evidence routing, leaf extraction, and shared DOCX write",
        prompt_summary="Use source images plus existing report structure to fill one STR block, preserve audit trail, and write only a copied/shared DOCX.",
    )

    try:
        log.agent("target-mapper", "running", "Mapping STR number to source folder ordinal and DOCX table block", prompt_summary="Find site folder by STR, compute ordinal, heading paragraph, and target tables 3-6.")
        log.step("discover_site", "running", "Locating source folder and ordinal")
        ordinal, folder = find_site(args.structure)
        tables = target_tables_for_ordinal(ordinal)
        heading_index = heading_body_index_for_ordinal(ordinal)
        log.state["target"] = {
            "ordinal": ordinal,
            "source_folder": str(folder),
            "target_tables": tables,
            "heading_body_index": heading_index,
            "heading_to_write": HEADING_TO_WRITE_TEMPLATE.format(structure=args.structure),
            "report": str(REPORT),
        }
        log.write_state()
        log.agent("target-mapper", "complete", f"Mapped STR {args.structure} to ordinal {ordinal}", target=log.state["target"])
        log.step("discover_site", "complete", f"Structure {args.structure} maps to site ordinal {ordinal}", source_folder=str(folder), target_tables=tables)

        log.agent("annotation-loader", "running", "Loading human annotations or invoking image router fallback", prompt_summary="Prefer pre-existing Streamlit labels; if absent, use OpenAI image-router parent planner.")
        log.step("load_annotations", "running", "Loading Streamlit annotation groups")
        groups = annotations_for_site(folder)
        if not groups:
            groups = route_unannotated_images(log, run_dir, folder)
        groups_path = run_dir / "annotation-groups.json"
        groups_path.write_text(json.dumps({k: [str(p) for p in v] for k, v in groups.items()}, indent=2) + "\n")
        log.artifact("annotation groups", groups_path)
        log.agent("annotation-loader", "complete", f"Loaded {len(groups)} evidence groups", labels=list(groups.keys()))
        log.step("load_annotations", "complete", f"Loaded {len(groups)} label groups", labels=list(groups.keys()))

        feedback_items = []
        if GLOBAL_FEEDBACK.exists():
            for line in GLOBAL_FEEDBACK.read_text().splitlines():
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(item.get("structure")) == str(args.structure):
                    feedback_items.append(item)
        if feedback_items:
            feedback_path = run_dir / "prior-feedback.json"
            feedback_path.write_text(json.dumps(feedback_items[-50:], indent=2) + "\n")
            with FEEDBACK_PROCESSING.open("a") as handle:
                for item in feedback_items[-50:]:
                    handle.write(json.dumps({
                        "at": now(),
                        "kind": "extraction_feedback_loaded",
                        "run_id": run_id,
                        "structure": args.structure,
                        "source": "global-feedback.jsonl",
                        "agent": item.get("agent"),
                        "field": item.get("field"),
                        "previous": item.get("previous"),
                        "value": item.get("value"),
                    }) + "\n")
            log.artifact("prior human feedback", feedback_path)
            log.agent("human-feedback", "complete", f"Loaded {len(feedback_items)} prior feedback items for this STR", feedback_count=len(feedback_items), feedback=feedback_items[-50:])
            log.step("load_feedback", "complete", f"Loaded {len(feedback_items)} prior feedback items")
        else:
            log.agent("human-feedback", "complete", "No prior human feedback for this STR", feedback_count=0, feedback=[])
            log.step("load_feedback", "complete", "No prior feedback")
        feedback_context = global_validation_feedback_context()
        if feedback_items:
            compact = [{"agent": item.get("agent"), "field": item.get("field"), "previous": item.get("previous"), "value": item.get("value")} for item in feedback_items[-20:]]
            feedback_context += "\nHuman feedback from earlier dashboard review for this STR, apply only when relevant to this leaf: " + json.dumps(compact)

        log.step("target_section", "complete", f"Will fill ordinal {ordinal} block tables {tables['table3']}-{tables['table6']} and heading STR {args.structure}")

        if args.reuse_from == "latest":
            reusable = latest_reusable_run(args.structure, run_id)
            if reusable:
                log.agent("reuse-transcription", "complete", f"Reusing leaf transcription from {reusable.name}", source_run=reusable.name, prompt_summary="Skip OpenAI vision calls; reuse previous leaf-results.json and regenerate DOCX patch/write/readback.")
                shutil.copy2(reusable / "leaf-results.json", run_dir / "leaf-results.json")
                for artifact in reusable.glob("*.json"):
                    if artifact.name.endswith(".json") and artifact.name not in {"state.json", "leaf-results.json"}:
                        shutil.copy2(artifact, run_dir / artifact.name)
                log.step("run_leaves", "complete", f"Reused existing transcription from {reusable.name}", reused_from=reusable.name)
                log.step("apply_docx", "running", "Launching monitored DOCX write from reused transcription", target_tables=tables)
                apply = subprocess.run([sys.executable, str(ROOT / "apply_to_docx.py"), "--run", run_id], cwd=ROOT, text=True, capture_output=True)
                if apply.returncode != 0:
                    detail = (apply.stderr or apply.stdout or "apply_to_docx.py failed").strip()
                    log.refresh_from_disk()
                    log.step("apply_docx", "failed", detail[-1200:])
                    log.agent("run-orchestrator", "failed", "Run failed during monitored DOCX write")
                    log.finish("failed", "DOCX apply failed")
                    return
                log.refresh_from_disk()
                log.step("apply_docx", "complete", "Shared DOCX write complete", target_tables=tables)
                log.agent("run-orchestrator", "complete", "Reuse run complete: shared DOCX write finished")
                log.finish("complete", "End-to-end reuse run complete")
                return
            log.agent("reuse-transcription", "blocked", "No complete prior transcription found; falling back to fresh OpenAI visual leaves")

        leaves = {
            "table3-north": (
                "Source-only visual leaf for Table 3 North row. Read meter values in sequence from annotated Table 3 Row 1 images. Return {leaf, readings:[{sequence_index, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 3 Row 1"]),
            ),
            "table3-east": (
                "Source-only visual leaf for Table 3 East row. Read meter values in sequence from annotated Table 3 Row 2 images. Return {leaf, readings:[{sequence_index, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 3 Row 2"]),
            ),
            "table3-south": (
                "Source-only visual leaf for Table 3 South row. Read meter values in sequence from annotated Table 3 Row 3 images. Return {leaf, readings:[{sequence_index, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 3 Row 3"]),
            ),
            "table3-west": (
                "Source-only visual leaf for Table 3 West row. Read meter values in sequence from annotated Table 3 Row 4 images. Return {leaf, readings:[{sequence_index, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 3 Row 4"]),
            ),
            "table4-stations": (
                "Source-only visual leaf for Table 4 test station readings. Read shunt and total-current meter values, preserving station/row label and unit. Return {leaf, readings:[{annotation_label, test_station, row_name, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 4"]),
            ),
            "table5-currents": (
                "Source-only visual leaf for Table 5 anode current values. Read Mg current values in mA and preserve station labels. Return {leaf, readings:[{annotation_label, mg, station, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 5"]),
            ),
            "table6-potentials": (
                "Source-only visual leaf for Table 6 open-circuit anode potential values. Read Mg potential values and preserve station labels. Return {leaf, readings:[{annotation_label, mg, station, source_image, visible_value, unit_seen, confidence, notes}], unresolved:[...]}.",
                label_paths(groups, ["Table 6"]),
            ),
        }
        for key, (_, paths) in leaves.items():
            log.agent(key, "pending", "Queued", image_count=len(paths))

        log.step("run_leaves", "running", "Dispatching OpenAI visual leaf agents", leaf_count=len(leaves))
        results = {}
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(run_leaf, log, run_dir, key, prompt, paths, feedback_context): key for key, (prompt, paths) in leaves.items()}
            for future in as_completed(futures):
                key = futures[future]
                try:
                    results[key] = future.result()
                except Exception as exc:
                    log.agent(key, "failed", f"Leaf failed: {exc}")
                    results[key] = {"error": str(exc)}
        results_path = run_dir / "leaf-results.json"
        results_path.write_text(json.dumps(results, indent=2) + "\n")
        log.artifact("leaf results", results_path)
        if any("error" in result for result in results.values()):
            log.step("run_leaves", "failed", "One or more leaves failed")
            log.finish("failed", "Extraction failed; see failed leaf cards")
            return
        log.step("run_leaves", "complete", "All leaf agents completed")

        log.step("apply_docx", "running", "Launching monitored DOCX write", target_tables=tables)
        apply = subprocess.run([sys.executable, str(ROOT / "apply_to_docx.py"), "--run", run_id], cwd=ROOT, text=True, capture_output=True)
        if apply.returncode != 0:
            detail = (apply.stderr or apply.stdout or "apply_to_docx.py failed").strip()
            log.refresh_from_disk()
            log.step("apply_docx", "failed", detail[-1200:])
            log.agent("run-orchestrator", "failed", "Run failed during monitored DOCX write")
            log.finish("failed", "DOCX apply failed")
            return
        log.refresh_from_disk()
        log.step("apply_docx", "complete", "Shared DOCX write complete", target_tables=tables)
        log.agent("run-orchestrator", "complete", "Run complete: extraction and shared DOCX write finished")
        log.finish("complete", "End-to-end run complete")
    except Exception as exc:
        log.step("fatal", "failed", str(exc))
        log.agent("run-orchestrator", "failed", str(exc))
        log.finish("failed", str(exc))
        raise


if __name__ == "__main__":
    main()
