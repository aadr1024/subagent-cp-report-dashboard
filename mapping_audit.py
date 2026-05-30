from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import docx_review


ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
AUDITS = RUNS / "audits"


TABLE3_GROUP_BY_MANUAL_ROW = {
    1: "Table 3 North",
    2: "Table 3 East",
    3: "Table 3 South",
    4: "Table 3 West",
}


def stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def safe_stamp() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")


def image_name(value: str | None) -> str:
    if not value:
        return ""
    return Path(str(value)).name


def image_like(value: str | None) -> bool:
    return bool(re.search(r"\.(jpe?g|png|heic)$", str(value or ""), re.I))


def natural_image_key(value: str) -> tuple:
    name = image_name(value)
    parts = re.split(r"(\d+)", name.lower())
    return tuple(int(part) if part.isdigit() else part for part in parts)


def structure_from_path(value: str) -> str | None:
    folder = Path(str(value)).parent.name
    match = re.search(r"\b\d{3}\s*-\s*(\d{3})\b", folder)
    if match:
        return match.group(1)
    matches = re.findall(r"\b(\d{3})\b", folder)
    return matches[-1] if matches else None


def manual_slot_for_label(label: str) -> tuple[str, str, str] | None:
    text = " ".join(str(label or "").split())
    table3 = re.search(r"Table\s*3\s*Row\s*(\d+)", text, re.I)
    if table3:
        group = TABLE3_GROUP_BY_MANUAL_ROW.get(int(table3.group(1)))
        return ("table3", group, "") if group else None

    table4 = re.search(r"Table\s*4\s*Row\s*(\d+).*(?:Column|Col)\s*([AB])", text, re.I)
    if table4:
        row = int(table4.group(1))
        col = table4.group(2).upper()
        station = "TS1" if col == "A" else "TS2"
        if row == 2:
            return ("table4", "Table 4 Stations", f"Shunt {station}")
        if row == 3:
            return ("table4", "Table 4 Stations", f"Total current {station}")

    table5 = re.search(r"Table\s*5\s*MG\s*(\d+)", text, re.I)
    if table5:
        return ("table5", "Table 5 Currents", f"MG {int(table5.group(1))}")

    table6 = re.search(r"Table\s*6\s*MG\s*(\d+)", text, re.I)
    if table6:
        return ("table6", "Table 6 Potentials", f"MG {int(table6.group(1))}")

    return None


def slot_key(structure: str, table_key: str, group: str, label: str) -> str:
    return "|".join([str(structure), table_key or "", group or "", label or ""])


def load_manual_annotations(path: Path) -> tuple[dict[str, list[str]], dict]:
    raw = json.loads(path.read_text()) if path.exists() else {}
    manual: dict[str, list[str]] = defaultdict(list)
    table3_groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    skipped = Counter()
    label_counts = Counter()

    for source_path, labels in raw.items():
        structure = structure_from_path(source_path)
        image = image_name(source_path)
        if not structure or not image_like(image):
            skipped["path_without_structure"] += 1
            continue
        for label in labels or []:
            label_counts[str(label)] += 1
            normalized = manual_slot_for_label(str(label))
            if not normalized:
                skipped["unmapped_label"] += 1
                continue
            table_key, group, slot_label = normalized
            if table_key == "table3":
                table3_groups[(structure, group)].append(image)
                continue
            key = slot_key(structure, table_key, group, slot_label)
            manual[key].append(image)

    for (structure, group), images in table3_groups.items():
        unique_sorted = sorted(dict.fromkeys(images), key=natural_image_key)
        for index, image in enumerate(unique_sorted[:5], start=1):
            key = slot_key(structure, "table3", group, f"Reading {index}")
            manual[key].append(image)
        if len(unique_sorted) > 5:
            skipped["table3_extra_images"] += len(unique_sorted) - 5

    manual = {key: sorted(dict.fromkeys(values), key=natural_image_key) for key, values in manual.items()}
    meta = {
        "annotation_file": str(path),
        "annotated_image_count": len(raw),
        "manual_slot_count": len(manual),
        "label_counts": dict(label_counts),
        "skipped": dict(skipped),
    }
    return manual, meta


def folder_images_by_structure(payload: dict) -> dict[str, list[str]]:
    out = {}
    for item in payload.get("structures") or []:
        folder = item.get("source_folder") or ""
        if not folder:
            continue
        path = Path(folder)
        if not path.exists():
            continue
        out[str(item.get("structure"))] = sorted(
            [entry.name for entry in path.iterdir() if entry.is_file() and image_like(entry.name)],
            key=natural_image_key,
        )
    return out


def nearest_distance(structure: str, manual_images: list[str], agent_images: list[str], folders: dict[str, list[str]]) -> int | None:
    order = folders.get(str(structure)) or []
    if not order:
        return None
    index = {name: pos for pos, name in enumerate(order)}
    distances = [
        abs(index[m] - index[a])
        for m in manual_images
        for a in agent_images
        if m in index and a in index
    ]
    return min(distances) if distances else None


def compare_slot(structure: str, slot: dict, manual: dict[str, list[str]], folders: dict[str, list[str]]) -> dict | None:
    key = slot_key(structure, slot.get("table_key") or "", slot.get("group") or "", slot.get("label") or "")
    manual_images = manual.get(key, [])
    agent_images = [
        image_name(value)
        for value in [slot.get("source_ref"), *(slot.get("source_refs") or [])]
        if image_like(value)
    ]
    agent_images = sorted(dict.fromkeys(agent_images), key=natural_image_key)
    actual = str(slot.get("actual") or "").strip()
    expected = str(slot.get("expected") or "").strip()
    docx_status = slot.get("status") or "blank"

    if not manual_images and not agent_images:
        return None

    manual_set = set(manual_images)
    agent_set = set(agent_images)
    distance = nearest_distance(structure, manual_images, agent_images, folders)
    if manual_set and agent_set and manual_set == agent_set:
        status = "matched"
        severity = "ok"
    elif manual_set and agent_set and manual_set & agent_set:
        status = "partial_overlap"
        severity = "medium"
    elif manual_set and agent_set and distance == 1:
        status = "one_image_off"
        severity = "high" if actual else "medium"
    elif manual_set and agent_set:
        status = "mismatch"
        severity = "high" if actual else "medium"
    elif manual_set and not agent_set:
        status = "agent_missing_source"
        severity = "high" if actual or expected else "medium"
    else:
        status = "manual_missing_label"
        severity = "medium" if actual and docx_status in {"matched", "docx_only"} else "low"

    recommendation = {
        "matched": "No correction needed.",
        "partial_overlap": "Review whether the source range is too wide or missing one labeled image.",
        "one_image_off": "Use DOCX Review source controls: shift left/right, then save correction.",
        "mismatch": "Open hover evidence and replace the source range with the manually labeled image(s).",
        "agent_missing_source": "Attach the manual evidence image range before approving/locking this cell.",
        "manual_missing_label": "Check whether Aadi's annotation label is missing or the agent used unsupported evidence.",
    }[status]

    return {
        "structure": structure,
        "slot_key": slot.get("feedback_key") or "",
        "table": slot.get("table_key") or "",
        "group": slot.get("group") or "",
        "label": slot.get("label") or "",
        "manual_images": manual_images,
        "agent_images": agent_images,
        "docx_status": docx_status,
        "actual": actual,
        "expected": expected,
        "source_corrected": bool(slot.get("source_correction")),
        "status": status,
        "severity": severity,
        "nearest_image_distance": distance,
        "recommendation": recommendation,
    }


def build_audit() -> dict:
    payload = docx_review.build_payload()
    source = payload.get("source_of_truth") or {}
    annotation = Path(source.get("annotation_source") or "")
    manual, manual_meta = load_manual_annotations(annotation)
    folders = folder_images_by_structure(payload)
    comparisons = []
    for structure_item in payload.get("structures") or []:
        structure = str(structure_item.get("structure") or "")
        for slot in structure_item.get("slots") or []:
            comparison = compare_slot(structure, slot, manual, folders)
            if comparison:
                comparisons.append(comparison)

    counts = Counter(item["status"] for item in comparisons)
    severity = Counter(item["severity"] for item in comparisons)
    issues = [
        item for item in comparisons
        if item["status"] != "matched"
    ]
    issues.sort(key=lambda item: (
        {"high": 0, "medium": 1, "low": 2, "ok": 3}.get(item["severity"], 4),
        int(item["structure"]) if str(item["structure"]).isdigit() else 9999,
        item["table"],
        item["group"],
        item["label"],
    ))
    return {
        "updated_at": stamp(),
        "source": "manual image-grid annotations compared with docx_review source_refs",
        "active_docx": payload.get("active_docx"),
        "manual": manual_meta,
        "summary": {
            "structures": len(payload.get("structures") or []),
            "compared_slots": len(comparisons),
            "matched": counts.get("matched", 0),
            "issues": len(issues),
            "high": severity.get("high", 0),
            "medium": severity.get("medium", 0),
            "low": severity.get("low", 0),
            "source_corrected": sum(1 for item in comparisons if item.get("source_corrected")),
            "counts": dict(counts),
            "severity": dict(severity),
        },
        "issues": issues,
        "comparisons": comparisons,
    }


def write_audit(payload: dict) -> dict:
    AUDITS.mkdir(parents=True, exist_ok=True)
    path = AUDITS / f"manual-agent-mapping-{safe_stamp()}.json"
    latest = AUDITS / "manual-agent-mapping-latest.json"
    path.write_text(json.dumps(payload, indent=2))
    latest.write_text(json.dumps(payload, indent=2))
    return {**payload, "artifact": str(path), "latest_artifact": str(latest)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare Aadi's manual image-grid labels against agent DOCX source mappings.")
    parser.add_argument("--record", action="store_true", help="Persist this audit under runs/audits.")
    parser.add_argument("--latest", action="store_true", help="Return the latest persisted audit if present; otherwise compute a fresh one.")
    args = parser.parse_args()

    latest = AUDITS / "manual-agent-mapping-latest.json"
    if args.latest and latest.exists():
        print(latest.read_text())
        return

    payload = build_audit()
    if args.record:
        payload = write_audit(payload)
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
