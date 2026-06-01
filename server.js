const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const REPORT_SOURCE_OF_TRUTH = path.join(ROOT, "report-source-of-truth.json");
const LOCAL_REPORT_SOURCE_OF_TRUTH = path.join(ROOT, "report-source-of-truth.local.json");
const RUNS = path.join(ROOT, "runs");
const CURRENT = path.join(RUNS, "current-run.txt");
const GLOBAL_FEEDBACK = path.join(RUNS, "global-feedback.jsonl");
const THUMBS = path.join(RUNS, ".thumbs");
const VALIDATIONS = path.join(RUNS, "validations");
const VALIDATION_REVIEW_METADATA = path.join(RUNS, "validation-review-metadata.jsonl");
const FEEDBACK_PROCESSING = path.join(RUNS, "feedback-processing.jsonl");
const REGRESSION_CASES = path.join(RUNS, "regression-cases.jsonl");
const SOLUTION_FEEDBACK = path.join(RUNS, "solution-feedback.jsonl");
const SOFTWARE_VALIDATION_FEEDBACK = path.join(RUNS, "software-validation-feedback.jsonl");
const REGRESSION_RECHECKS = path.join(RUNS, "regression-rechecks");
const CORRECTION_PROMOTIONS = path.join(RUNS, "correction-promotions.jsonl");
const CLOSED_LOOP_LEDGER = path.join(RUNS, "closed-loop-clean.jsonl");
const CLOSED_LOOP_STATUS = path.join(RUNS, "closed-loop-status.json");
const FEEDBACK_CORRECTION_STATUS = path.join(RUNS, "feedback-correction-status.json");
const DOCX_REVIEW_FEEDBACK = path.join(RUNS, "docx-review-feedback.jsonl");
const DOCX_CELL_LOCKS = path.join(RUNS, "docx-cell-locks.jsonl");
const DOCX_SOURCE_CORRECTIONS = path.join(RUNS, "docx-source-corrections.jsonl");
const DOCX_SOURCE_OF_TRUTH = path.join(RUNS, "docx-source-of-truth.json");
const IMAGE_LOAD_TELEMETRY = path.join(RUNS, "image-load-telemetry.jsonl");
const DOCX_REVIEW_SCRIPT = path.join(ROOT, "docx_review.py");
const DASHBOARD_VALIDATION_SCRIPT = path.join(ROOT, "dashboard_validation.py");
const MAPPING_AUDIT_SCRIPT = path.join(ROOT, "mapping_audit.py");
const PROMOTE_SOURCE_CORRECTION_SCRIPT = path.join(ROOT, "promote_source_correction.py");
const PUBLIC_CONFIG = readJsonFile(REPORT_SOURCE_OF_TRUTH, {});
const LOCAL_CONFIG = readJsonFile(process.env.CP_REPORT_CONFIG || LOCAL_REPORT_SOURCE_OF_TRUTH, PUBLIC_CONFIG);
const CONFIG = { ...PUBLIC_CONFIG, ...LOCAL_CONFIG };
const SBA_SRC = process.env.SBA_REPORT_TOOL_SRC || CONFIG.report_tool_src || "";
const SITE_ROOT = process.env.CP_REPORT_SITE_ROOT || CONFIG.site_root || path.join(ROOT, "site-photos");
const SOLUTION_DEFINITIONS = {
  "potential-minus-sign-discipline": {
    title: "Potential sign discipline",
    problem: "Potential readings can lose a faint LCD minus sign or get treated as positive when nearby CP readings are normally negative.",
    solution: "Extraction leaves must preserve visible minus signs, bias Table 3/Table 6 potentials negative when the local evidence supports it, and surface truly positive/no-minus readings as polarity anomalies instead of silently forcing them.",
    detection_rule: "Applies to Table 3/Table 6, V DC, minus/negative/positive/polarity notes, and sign-mixed potential evidence.",
  },
  "meter-orientation-seven-segment": {
    title: "Meter orientation / seven-segment discipline",
    problem: "Rotated or upside-down digital multimeter photos can make seven-segment LCD readings read as the wrong number, for example 90 instead of 6.0.",
    solution: "Extraction and validation leaves must inspect meter orientation before accepting LCD digits; if orientation is rotated/upside-down, mentally rotate the display, re-read decimal/unit indicators, and flag ambiguous cases instead of silently accepting the value.",
    detection_rule: "Applies to Table 4 shunt-voltage/current readings, upside-down/rotated meter notes, seven-segment LCD ambiguity, and Row 2 shunt values with mA-vs-mV/unit/orientation conflict.",
  },
  "table4-current-decimal-scale": {
    title: "Current decimal scale",
    problem: "LCD current values can be read as large un-decimaled numbers, for example 6369 instead of 63.69 mA or 295.1 instead of 29.51 mA.",
    solution: "Current-reading leaves must read displays as mA, inspect decimal points carefully, and compare magnitude against same-station current/shunt peers before accepting large number-like values.",
    detection_rule: "Applies to Table 4 current/shunt and Table 5 current readings with suspicious large magnitudes or missed decimal points.",
  },
  "table3-five-reading-completeness": {
    title: "Table 3 five-reading completeness",
    problem: "A Table 3 directional row can be accepted with only four values when the report expects five positions.",
    solution: "Shape validators and extraction leaves must require five Table 3 directional readings unless source evidence proves a value is missing, then keep the row flagged for review.",
    detection_rule: "Applies to Table 3 row-count, missing-value, and four-vs-five evidence anomalies.",
  },
  "station-pairing-coverage": {
    title: "Station/anode pairing coverage",
    problem: "Table 5 current and Table 6 potential groups can be paired to the wrong station/anode or lose coverage when images are close together.",
    solution: "Leaf nodes must group values by image proximity plus station/anode labels, then validate Table 5 and Table 6 coverage together before DOCX write.",
    detection_rule: "Applies to station/anode/MG coverage, Table 5/Table 6 pairing, and local image group boundary issues.",
  },
  "general-anomaly-review": {
    title: "General anomaly review loop",
    problem: "A reviewed anomaly does not yet match a more specific reusable error class.",
    solution: "Keep the exact evidence bundle replayable, ask the focused reviewer to extract lessons, and promote it into a narrower solution class once a pattern repeats.",
    detection_rule: "Fallback for recorded cases that do not match the current specific solution classes.",
  },
};

fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });
fs.mkdirSync(VALIDATIONS, { recursive: true });
fs.mkdirSync(REGRESSION_RECHECKS, { recursive: true });
fs.mkdirSync(path.join(RUNS, "audits"), { recursive: true });

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const imageExt = new Set([".jpg", ".jpeg", ".png", ".heic"]);
const POLL_EVENTS = [];
const IMAGE_LOAD_EVENTS = [];
let activeApiRequests = 0;
let imageLoadTelemetryLoaded = false;
const THUMB_BODY_CACHE = new Map();
let thumbBodyCacheBytes = 0;
const THUMB_BODY_CACHE_MAX_BYTES = 64 * 1024 * 1024;

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function recordApiPoll(pathname, method, statusCode, durationMs) {
  const event = {
    at: new Date().toISOString(),
    t: Date.now(),
    endpoint: pathname,
    method,
    status: statusCode,
    ok: statusCode >= 200 && statusCode < 400,
    duration_ms: Math.round(durationMs),
  };
  POLL_EVENTS.push(event);
  const cutoff = Date.now() - 5 * 60_000;
  while (POLL_EVENTS.length > 3000 || (POLL_EVENTS[0] && POLL_EVENTS[0].t < cutoff)) POLL_EVENTS.shift();
}

function pollTelemetry() {
  const nowMs = Date.now();
  const windows = {
    last_10s: POLL_EVENTS.filter((item) => item.t >= nowMs - 10_000),
    last_60s: POLL_EVENTS.filter((item) => item.t >= nowMs - 60_000),
    last_5m: POLL_EVENTS.filter((item) => item.t >= nowMs - 5 * 60_000),
  };
  const endpoints = {};
  for (const item of windows.last_60s) {
    const key = item.endpoint;
    const bucket = endpoints[key] || { endpoint: key, count: 0, failures: 0, last_at: null, last_status: null, avg_ms: 0, total_ms: 0 };
    bucket.count += 1;
    bucket.failures += item.ok ? 0 : 1;
    bucket.last_at = item.at;
    bucket.last_status = item.status;
    bucket.total_ms += item.duration_ms || 0;
    bucket.avg_ms = Math.round(bucket.total_ms / bucket.count);
    endpoints[key] = bucket;
  }
  return {
    updated_at: new Date().toISOString(),
    active_api_requests: activeApiRequests,
    last_event: POLL_EVENTS.at(-1) || null,
    counts: {
      last_10s: windows.last_10s.length,
      last_60s: windows.last_60s.length,
      last_5m: windows.last_5m.length,
      failures_60s: windows.last_60s.filter((item) => !item.ok).length,
    },
    endpoints: Object.values(endpoints).sort((a, b) => b.count - a.count).slice(0, 16),
    recent: POLL_EVENTS.slice(-24).reverse(),
  };
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

function ensureImageLoadTelemetryLoaded() {
  if (imageLoadTelemetryLoaded) return;
  imageLoadTelemetryLoaded = true;
  for (const item of readJsonLines(IMAGE_LOAD_TELEMETRY).slice(-3000)) {
    if (!item || typeof item !== "object") continue;
    IMAGE_LOAD_EVENTS.push({ ...item, persisted: true });
  }
}

function cleanTelemetryString(value, max = 240) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

function sanitizedImageLoadEvent(raw = {}) {
  const now = Date.now();
  const event = {
    at: new Date().toISOString(),
    t: now,
    session_id: cleanTelemetryString(raw.session_id, 80),
    load_id: cleanTelemetryString(raw.load_id, 120),
    preview_id: cleanTelemetryString(raw.preview_id, 120),
    kind: cleanTelemetryString(raw.kind || "image_load", 48),
    status: cleanTelemetryString(raw.status || "event", 48),
    role: cleanTelemetryString(raw.role || "unknown", 64),
    context: cleanTelemetryString(raw.context || "popup", 96),
    source_image: cleanTelemetryString(raw.source_image || "", 160),
    url: cleanTelemetryString(raw.url || "", 360),
    duration_ms: Math.max(0, Math.min(120_000, Math.round(Number(raw.duration_ms || 0)))),
    transfer_size: Math.max(0, Math.min(200_000_000, Math.round(Number(raw.transfer_size || 0)))),
    decoded_body_size: Math.max(0, Math.min(200_000_000, Math.round(Number(raw.decoded_body_size || 0)))),
    encoded_body_size: Math.max(0, Math.min(200_000_000, Math.round(Number(raw.encoded_body_size || 0)))),
    cached: Boolean(raw.cached),
    error: cleanTelemetryString(raw.error || "", 240),
  };
  return event;
}

function imageLoadSummaryFor(events) {
  const completed = events.filter((item) => ["load", "error", "complete", "fetch"].includes(item.status) && item.duration_ms >= 0);
  const successful = completed.filter((item) => item.status !== "error");
  const durations = successful.map((item) => item.duration_ms).filter((value) => Number.isFinite(value));
  const byRole = {};
  for (const item of successful) {
    const key = `${item.kind}:${item.role}`;
    const bucket = byRole[key] || {
      key,
      kind: item.kind,
      role: item.role,
      count: 0,
      total_ms: 0,
      avg_ms: 0,
      p50_ms: 0,
      p95_ms: 0,
      max_ms: 0,
      slow: 0,
      cached: 0,
      durations: [],
    };
    bucket.count += 1;
    bucket.total_ms += item.duration_ms || 0;
    bucket.durations.push(item.duration_ms || 0);
    bucket.max_ms = Math.max(bucket.max_ms, item.duration_ms || 0);
    bucket.slow += (item.duration_ms || 0) > 800 ? 1 : 0;
    bucket.cached += item.cached ? 1 : 0;
    byRole[key] = bucket;
  }
  for (const bucket of Object.values(byRole)) {
    bucket.avg_ms = Math.round(bucket.total_ms / Math.max(1, bucket.count));
    bucket.p50_ms = percentile(bucket.durations, 50);
    bucket.p95_ms = percentile(bucket.durations, 95);
    delete bucket.durations;
    delete bucket.total_ms;
  }
  return {
    count: completed.length,
    success: successful.length,
    errors: completed.filter((item) => item.status === "error").length,
    cached: successful.filter((item) => item.cached).length,
    slow: successful.filter((item) => item.duration_ms > 800).length,
    avg_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    max_ms: durations.length ? Math.max(...durations) : 0,
    by_role: Object.values(byRole).sort((a, b) => b.p95_ms - a.p95_ms).slice(0, 12),
  };
}

function imageLoadTelemetry() {
  ensureImageLoadTelemetryLoaded();
  const nowMs = Date.now();
  const allRecent = IMAGE_LOAD_EVENTS.filter((item) => item.t >= nowMs - 5 * 60_000);
  const recent = allRecent.filter((item) => !item.persisted);
  const last10s = recent.filter((item) => item.t >= nowMs - 10_000);
  const last60s = recent.filter((item) => item.t >= nowMs - 60_000);
  const starts = new Map();
  for (const item of recent.filter((event) => event.t >= nowMs - 120_000)) {
    if (item.persisted) continue;
    if (!item.load_id) continue;
    if (item.status === "start") starts.set(item.load_id, item);
    if (["load", "error", "complete", "fetch"].includes(item.status)) starts.delete(item.load_id);
  }
  const active = [...starts.values()]
    .map((item) => ({ ...item, age_ms: Math.max(0, nowMs - Number(item.t || nowMs)) }))
    .sort((a, b) => b.age_ms - a.age_ms)
    .slice(0, 12);
  return {
    updated_at: new Date().toISOString(),
    active_loads: starts.size,
    active,
    counts: {
      last_10s: last10s.length,
      last_60s: last60s.length,
      last_5m: recent.length,
    },
    last_10s: imageLoadSummaryFor(last10s),
    last_60s: imageLoadSummaryFor(last60s),
    last_5m: imageLoadSummaryFor(recent),
    slowest: recent
      .filter((item) => item.status !== "start")
      .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0))
      .slice(0, 10),
    historical_slowest: allRecent
      .filter((item) => item.persisted && item.status !== "start")
      .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0))
      .slice(0, 6),
    recent: recent.slice(-32).reverse(),
  };
}

function activeDocxSourceCorrections() {
  const active = {};
  for (const item of readJsonLines(DOCX_SOURCE_CORRECTIONS)) {
    const key = String(item.slot_key || "");
    if (!key) continue;
    if (item.action === "reset" || item.status === "reset") delete active[key];
    else active[key] = item;
  }
  return active;
}

function docxSourceOfTruthSnapshot(reason = "read") {
  const review = docxReviewPayload();
  const sourceTruth = reportSourceOfTruth();
  const activeRanges = activeDocxSourceCorrections();
  const ranges = Object.values(activeRanges).map((item) => ({
    correction_id: item.correction_id || "",
    at: item.at || "",
    slot_key: item.slot_key || "",
    lock_key: item.lock_key || "",
    structure: String(item.structure || ""),
    table_key: item.table_key || "",
    label: item.label || "",
    row_index: item.row_index,
    col_index: item.col_index,
    source_folder: item.source_folder || "",
    selected_source_refs: item.new_source_refs || [],
    previous_source_refs: item.old_source_refs || [],
    note: item.note || "",
    status: item.status || "active",
  }));
  const cells = [];
  for (const structure of review.structures || []) {
    for (const slot of structure.slots || []) {
      const slotKey = slot.slot_key || [
        structure.structure,
        slot.table_key,
        slot.label,
        slot.row_index,
        slot.col_index,
      ].join("|");
      const range = activeRanges[slotKey] || null;
      cells.push({
        slot_key: slotKey,
        structure: String(structure.structure || ""),
        table_key: slot.table_key || "",
        group: slot.group || "",
        label: slot.label || "",
        row_index: slot.row_index,
        col_index: slot.col_index,
        status: slot.status || "",
        actual: slot.actual || "",
        expected: slot.expected || "",
        source_refs: slot.source_refs || [],
        value_source_refs: slot.value_correction?.source_refs || [],
        corrected_range_refs: range?.new_source_refs || slot.source_correction?.new_source_refs || null,
        source_correction_id: range?.correction_id || slot.source_correction?.correction_id || "",
        value_promotion_id: slot.value_correction?.promotion_id || "",
      });
    }
  }
  return {
    updated_at: new Date().toISOString(),
    reason,
    invariant: "DOCX source-of-truth snapshot is derived from active DOCX Review readback plus append-only source/value correction ledgers. It is a materialized snapshot for humans and future agents; ledgers remain the audit trail.",
    active_docx_path: sourceTruth.active_docx || "",
    active_docx_exists: review.active_docx_exists,
    active_docx_mtime: review.active_docx_mtime || "",
    summary: review.summary || {},
    active_source_range_count: ranges.length,
    active_source_ranges: ranges.sort((a, b) => String(a.structure).localeCompare(String(b.structure), undefined, { numeric: true }) || String(a.slot_key).localeCompare(String(b.slot_key))),
    cells,
  };
}

function writeDocxSourceOfTruthSnapshot(reason = "updated") {
  try {
    const snapshot = docxSourceOfTruthSnapshot(reason);
    fs.writeFileSync(DOCX_SOURCE_OF_TRUTH, JSON.stringify(snapshot, null, 2) + "\n");
    return { ok: true, snapshot };
  } catch (error) {
    const item = {
      at: new Date().toISOString(),
      type: "docx_source_of_truth_snapshot_failed",
      reason,
      error: String(error.message || error),
    };
    fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify(item) + "\n");
    return { ok: false, error: item.error };
  }
}

function readDocxSourceOfTruth() {
  if (fs.existsSync(DOCX_SOURCE_OF_TRUTH)) return readJsonFile(DOCX_SOURCE_OF_TRUTH, {});
  return writeDocxSourceOfTruthSnapshot("initial_read").snapshot || {};
}

async function imageLoadTelemetryRoute(req, res) {
  ensureImageLoadTelemetryLoaded();
  if ((req.method || "GET").toUpperCase() === "POST") {
    const payload = JSON.parse((await readBody(req)) || "{}");
    const rawEvents = Array.isArray(payload.events) ? payload.events : [payload];
    const events = rawEvents.slice(0, 200).map(sanitizedImageLoadEvent);
    for (const event of events) {
      IMAGE_LOAD_EVENTS.push(event);
      fs.appendFileSync(IMAGE_LOAD_TELEMETRY, JSON.stringify(event) + "\n");
    }
    const cutoff = Date.now() - 5 * 60_000;
    while (IMAGE_LOAD_EVENTS.length > 5000 || (IMAGE_LOAD_EVENTS[0] && IMAGE_LOAD_EVENTS[0].t < cutoff)) IMAGE_LOAD_EVENTS.shift();
    return json(res, 200, { ok: true, accepted: events.length, telemetry: imageLoadTelemetry() });
  }
  return json(res, 200, imageLoadTelemetry());
}

function runIdFromUrl(url) {
  const requested = url.searchParams.get("run") || "current";
  if (requested !== "current") return requested.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!fs.existsSync(CURRENT)) return null;
  return fs.readFileSync(CURRENT, "utf8").trim() || null;
}

function runDir(runId) {
  if (!runId) return null;
  const dir = path.join(RUNS, runId);
  return dir.startsWith(RUNS) ? dir : null;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function reportSourceOfTruth() {
  const data = CONFIG;
  const role = data.active_output_role || "working_final_docx";
  const activeRaw = data[role] || data.working_final_docx || "";
  const originalRaw = data.original_docx || "";
  if (!activeRaw || !originalRaw) throw new Error("report-source-of-truth.json is missing report paths");
  const active = path.resolve(activeRaw);
  const original = path.resolve(originalRaw);
  if (data.never_write_original !== false && active === original) {
    throw new Error("Report source-of-truth misconfigured: active output equals original DOCX");
  }
  return {
    ...data,
    active_docx: active,
    original_docx: original,
    active_exists: fs.existsSync(active),
    original_exists: fs.existsSync(original),
  };
}

function openFinalReport(res) {
  const source = reportSourceOfTruth();
  if (!source.active_exists) return json(res, 404, { error: "active final DOCX does not exist", source });
  const child = spawn("open", ["-a", "Microsoft Word", source.active_docx], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  json(res, 202, { ok: true, opened: source.active_docx, source });
}

function docxReviewInputMtime() {
  let max = 0;
  const files = [REPORT_SOURCE_OF_TRUTH, CLOSED_LOOP_LEDGER, CLOSED_LOOP_STATUS, FEEDBACK_CORRECTION_STATUS];
  for (const file of files) {
    try { max = Math.max(max, fs.statSync(file).mtimeMs); } catch {}
  }
  for (const entry of fs.readdirSync(RUNS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || ["validations", "regression-rechecks", ".thumbs"].includes(entry.name)) continue;
    const dir = path.join(RUNS, entry.name);
    for (const name of ["state.json", "leaf-results.json", "docx-cell-patch.json", "docx-readback.json"]) {
      try { max = Math.max(max, fs.statSync(path.join(dir, name)).mtimeMs); } catch {}
    }
  }
  return max;
}

function docxReviewPayload() {
  const source = reportSourceOfTruth();
  const python = process.env.PYTHON || "python3";
  const result = spawnSync(python, [DOCX_REVIEW_SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 60 * 1024 * 1024,
    timeout: 25_000,
  });
  if (result.status !== 0) {
    return {
      updated_at: new Date().toISOString(),
      status: "failed",
      error: result.stderr || result.stdout || `docx_review.py exited ${result.status}`,
      source_of_truth: source,
      summary: {},
      structures: [],
    };
  }
  const payload = JSON.parse(result.stdout || "{}");
  return { ...payload, cached: false, source_of_truth_mode: "active_docx_readback_only" };
}

function dashboardValidationPayload(url) {
  const python = process.env.PYTHON || "python3";
  const args = [DASHBOARD_VALIDATION_SCRIPT];
  const selected = url.searchParams.get("case");
  if (selected) args.push("--case", String(selected).replace(/[^a-zA-Z0-9_.-]/g, ""));
  if (url.searchParams.get("record") === "1") args.push("--record");
  const result = spawnSync(python, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    timeout: 25_000,
  });
  if (result.status !== 0) {
    return {
      updated_at: new Date().toISOString(),
      status: "failed",
      error: result.stderr || result.stdout || `dashboard_validation.py exited ${result.status}`,
      summary: { total: 1, fail: 1, monitor: 0, pass: 0, active: 1 },
      cases: [{
        id: "software-validation-runtime-failed",
        title: "Software Validation Set failed to render",
        status: "fail",
        severity: "high",
        active: true,
        detail: result.stderr || result.stdout || `dashboard_validation.py exited ${result.status}`,
        evidence: [],
        feedback: [],
        updated_at: new Date().toISOString(),
      }],
    };
  }
  return JSON.parse(result.stdout || "{}");
}

function mappingAuditPayload(url) {
  const python = process.env.PYTHON || "python3";
  const args = [MAPPING_AUDIT_SCRIPT];
  if (url.searchParams.get("record") === "1") args.push("--record");
  else args.push("--latest");
  const result = spawnSync(python, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    timeout: 35_000,
  });
  if (result.status !== 0) {
    return {
      updated_at: new Date().toISOString(),
      status: "failed",
      error: result.stderr || result.stdout || `mapping_audit.py exited ${result.status}`,
      summary: { compared_slots: 0, issues: 1, high: 1, medium: 0, low: 0 },
      issues: [{
        severity: "high",
        status: "mapping_audit_failed",
        recommendation: "Inspect server logs or run python3 mapping_audit.py --record from the dashboard repo.",
      }],
    };
  }
  return JSON.parse(result.stdout || "{}");
}

function thumbFor(sourceFile, size = 720) {
  const source = path.resolve(sourceFile);
  if (!fs.existsSync(source)) return null;
  const boundedSize = Math.max(180, Math.min(1200, Number(size) || 720));
  const stat = fs.statSync(source);
  const key = crypto.createHash("sha1")
    .update(`${source}:${stat.size}:${stat.mtimeMs}:${boundedSize}`)
    .digest("hex");
  const out = path.join(THUMBS, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  const tmp = `${out}.tmp`;
  const result = spawnSync("sips", [
    "-s", "format", "jpeg",
    "-s", "formatOptions", "65",
    "-Z", String(boundedSize),
    source,
    "--out", tmp,
  ], { stdio: "ignore" });
  if (result.status === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, out);
    return out;
  }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  return source;
}

function sendThumb(res, file, size) {
  const thumb = thumbFor(file, size);
  if (!thumb) return send(res, 404, "not found", "text/plain");
  const stat = fs.statSync(thumb);
  const cacheKey = `${thumb}:${stat.size}:${stat.mtimeMs}`;
  let body = THUMB_BODY_CACHE.get(cacheKey);
  let memoryHit = true;
  if (!body) {
    memoryHit = false;
    body = fs.readFileSync(thumb);
    THUMB_BODY_CACHE.set(cacheKey, body);
    thumbBodyCacheBytes += body.length;
    while (thumbBodyCacheBytes > THUMB_BODY_CACHE_MAX_BYTES && THUMB_BODY_CACHE.size) {
      const [oldestKey, oldestBody] = THUMB_BODY_CACHE.entries().next().value;
      THUMB_BODY_CACHE.delete(oldestKey);
      thumbBodyCacheBytes -= oldestBody.length;
    }
  }
  /*
   * Popup review speed depends heavily on repeat thumbnail reads. The generated
   * thumbnail filename is keyed by source path, source size, source mtime, and
   * requested size, so a browser cache hit cannot hide a changed source image.
   * A small server-side body cache removes local disk reads from repeated hover
   * review. The key includes thumb mtime/size, so regenerated thumbnails cannot
   * silently serve stale bytes.
   */
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=86400, immutable",
    "Content-Length": body.length,
    "X-Thumb-Bytes": String(body.length),
    "X-Thumb-Source": path.basename(file),
    "X-Thumb-Memory-Cache": memoryHit ? "hit" : "miss",
  });
  res.end(body);
}

function maxEventSeq(dir) {
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split(/\n+/).reduce((max, line) => {
    if (!line.trim()) return max;
    try { return Math.max(max, Number(JSON.parse(line).seq || 0)); } catch { return max; }
  }, 0);
}

function appendRunEvent(runId, eventType, message, data = {}) {
  const dir = runDir(runId);
  if (!dir) return;
  const at = new Date().toISOString();
  const event = { seq: maxEventSeq(dir) + 1, at, type: eventType, message, data };
  fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
  const stateFile = path.join(dir, "state.json");
  const state = readJsonFile(stateFile, { run_id: runId, status: "running" });
  state.updated_at = at;
  state.messages = [...(state.messages || []), { at, type: eventType, message }].slice(-120);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

function updateRunState(runId, update) {
  const dir = runDir(runId);
  if (!dir) return null;
  const stateFile = path.join(dir, "state.json");
  const state = readJsonFile(stateFile, { run_id: runId, status: "starting" });
  update(state);
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  return state;
}

function finishStatus(event) {
  const explicit = String(event?.data?.status || "").toLowerCase();
  if (explicit) return explicit;
  const message = String(event?.message || "").toLowerCase();
  if (message.includes("failed") || message.includes("fail")) return "failed";
  if (message.includes("stopped") || message.includes("stop")) return "stopped";
  if (message.includes("complete") || message.includes("succeeded") || event?.data?.output_docx) return "complete";
  return null;
}

function readState(runId) {
  const dir = runDir(runId);
  if (!dir) return { run_id: runId, status: "starting" };
  const stateFile = path.join(dir, "state.json");
  const state = readJsonFile(stateFile, { run_id: runId, status: "starting" });
  const finishes = readJsonLines(path.join(dir, "events.jsonl")).filter((event) => event.type === "finish");
  const finish = finishes.at(-1);
  const reconciledStatus = finishStatus(finish);
  if (!finish || !reconciledStatus) return state;
  const at = finish.at || new Date().toISOString();
  const changed = state.status !== reconciledStatus
    || state.steps?.apply_docx?.status === "running"
    || state.agents?.["run-orchestrator"]?.status === "running";
  if (!changed) return state;
  state.status = reconciledStatus;
  state.finished_at = state.finished_at || at;
  state.updated_at = state.updated_at || at;
  if (finish.data?.output_docx) state.output_docx = state.output_docx || finish.data.output_docx;
  state.steps = state.steps || {};
  if (reconciledStatus === "complete" || state.steps.apply_docx?.status === "running") {
    state.steps.apply_docx = {
      ...(state.steps.apply_docx || { name: "apply_docx", events: [] }),
      name: "apply_docx",
      status: reconciledStatus === "complete" ? "complete" : reconciledStatus,
      message: reconciledStatus === "complete" ? "Shared DOCX write complete" : finish.message,
      updated_at: at,
      events: [...((state.steps.apply_docx || {}).events || []), { at, status: reconciledStatus, message: "Recovered from finish event" }].slice(-20),
    };
  }
  state.agents = state.agents || {};
  state.agents["run-orchestrator"] = {
    ...(state.agents["run-orchestrator"] || { name: "run-orchestrator", events: [] }),
    name: "run-orchestrator",
    status: reconciledStatus,
    message: finish.message || "End-to-end run complete",
    updated_at: at,
    events: [...((state.agents["run-orchestrator"] || {}).events || []), { at, status: reconciledStatus, message: "Recovered from finish event" }].slice(-20),
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  return state;
}

function listRuns() {
  return fs.readdirSync(RUNS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "validations")
    .map((d) => {
      const state = readState(d.name);
      return {
        run_id: d.name,
        status: state.status || "unknown",
        structure: state.structure || null,
        updated_at: state.updated_at || null,
      };
    })
    .sort((a, b) => {
      const at = Date.parse(a.updated_at || "") || 0;
      const bt = Date.parse(b.updated_at || "") || 0;
      return bt - at || String(b.run_id).localeCompare(String(a.run_id));
    });
}

function validationDirs() {
  return fs.readdirSync(VALIDATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(VALIDATIONS, entry.name))
    .sort((a, b) => String(path.basename(b)).localeCompare(String(path.basename(a))));
}

function validationTableName(agent) {
  if (agent === "table4-stations") return "Table 4";
  if (agent === "table5-currents") return "Table 5";
  if (agent === "table6-potentials") return "Table 6";
  if (String(agent || "").startsWith("table3-")) return `Table 3 ${String(agent).replace("table3-", "")}`;
  return agent || "Evidence";
}

function validationGroupLabel(value, fallbackWord) {
  const text = String(value || "").trim();
  if (!text) return "";
  let match = text.match(/(?:test\s*)?station\s*#?\s*(\d+)/i) || text.match(/\bts\s*#?\s*(\d+)/i);
  if (match) return `${fallbackWord} ${match[1]}`;
  match = text.match(/\b(?:anode|mg)\s*#?\s*(\d+)/i);
  if (match) return `Anode ${match[1]}`;
  match = text.match(/^#?\s*(\d+)$/);
  if (match) return `${fallbackWord} ${match[1]}`;
  return "";
}

function validationKind(agent, records) {
  if (agent === "table5-currents") return "current";
  if (agent === "table6-potentials") return "potential";
  if (agent === "table4-stations") {
    const names = [...new Set(records.map((record) => record.row || "").filter(Boolean).map((value) => String(value).replace(/^table\s*4\s*/i, "").replace(/[_-]+/g, " ").trim()).filter(Boolean))];
    return names.slice(0, 2).join(" + ") || "current + shunt";
  }
  return "";
}

function validationContextGroups(dir) {
  const records = readJsonFile(path.join(dir, "dataset.json"), []);
  const buckets = new Map();
  for (const record of records) {
    if (!record.source_image) continue;
    const fallbackWord = record.agent === "table4-stations" ? "Station" : "Anode";
    const station = validationGroupLabel(record.station, fallbackWord) || validationGroupLabel(record.row, fallbackWord);
    const key = `${record.structure}:${record.agent}:${station || "local"}:${record.row || ""}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  return [...buckets.values()].map((records) => {
    const first = records[0] || {};
    const fallbackWord = first.agent === "table4-stations" ? "Station" : "Anode";
    const station = validationGroupLabel(first.station, fallbackWord) || validationGroupLabel(first.row, fallbackWord);
    const kind = validationKind(first.agent, records);
    const parts = [validationTableName(first.agent), station, kind].filter(Boolean);
    return {
      structure: first.structure,
      agent: first.agent,
      title: parts.filter((part, index) => parts.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index).join(" · "),
      sources: [...new Set(records.map((record) => record.source_image).filter(Boolean))],
    };
  }).filter((group) => group.sources.length);
}

function validationState(dir) {
  const state = readJsonFile(path.join(dir, "state.json"), {});
  const notes = readJsonLines(path.join(dir, "notes.jsonl"));
  const events = readJsonLines(path.join(dir, "events.jsonl"));
  const noteMap = notes.reduce((map, note) => {
    if (note.anomaly_id) map[note.anomaly_id] = note;
    return map;
  }, {});
  state.notes = notes;
  state.events = events.slice(-160);
  state.context_groups = validationContextGroups(dir);
  state.anomalies = (state.anomalies || []).map((item) => ({ ...item, saved_note: noteMap[item.id] || null }));
  return state;
}

function validationPayload() {
  const dirs = validationDirs();
  return {
    validations: dirs.map((dir) => {
      const state = validationState(dir);
      return {
        validation_id: path.basename(dir),
        status: state.status || "unknown",
        started_at: state.started_at || null,
        updated_at: state.updated_at || null,
        finished_at: state.finished_at || null,
        metrics: state.metrics || {},
        summary: state.summary || "",
      };
    }),
    latest: dirs[0] ? validationState(dirs[0]) : null,
  };
}

function feedbackStatus() {
  const extraction = readJsonLines(GLOBAL_FEEDBACK);
  const validation = readJsonLines(VALIDATION_REVIEW_METADATA);
  const processed = readJsonLines(FEEDBACK_PROCESSING);
  return {
    updated_at: new Date().toISOString(),
    counts: {
      extraction_feedback: extraction.length,
      validation_reviews: validation.length,
      processed_events: processed.length,
    },
    recent_extraction: extraction.slice(-12).reverse(),
    recent_validation: validation.slice(-12).reverse(),
    recent_processed: processed.slice(-18).reverse(),
  };
}

function startValidation(req, res) {
  const python = process.env.PYTHON || "python3";
  const validationId = `${stamp()}-validation`;
  const dir = path.join(VALIDATIONS, validationId);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  env.PYTHONPATH = SBA_SRC + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "");
  const child = spawn(python, [path.join(ROOT, "validator.py"), "--validation-id", validationId], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = path.join(VALIDATIONS, "validation-spawn.log");
  fs.appendFileSync(log, `\n[start] pid=${child.pid} validation=${validationId} at=${new Date().toISOString()}\n`);
  child.stdout.on("data", (chunk) => fs.appendFileSync(log, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(log, chunk));
  fs.writeFileSync(path.join(dir, "server-control.json"), JSON.stringify({ pid: child.pid, validation_id: validationId, started_at: new Date().toISOString() }, null, 2) + "\n");
  child.on("exit", (code, signal) => {
    fs.appendFileSync(log, `[exit] pid=${child.pid} code=${code} signal=${signal}\n`);
  });
  json(res, 202, { ok: true, validation_id: validationId, pid: child.pid });
}

async function saveValidationNote(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const validationId = String(payload.validation_id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const dir = path.join(VALIDATIONS, validationId);
  if (!validationId || !dir.startsWith(VALIDATIONS) || !fs.existsSync(dir)) return json(res, 404, { error: "unknown validation" });
  const state = readJsonFile(path.join(dir, "state.json"), {});
  const anomaly = (state.anomalies || []).find((item) => item.id === String(payload.anomaly_id || "")) || {};
  const note = {
    at: new Date().toISOString(),
    validation_id: validationId,
    anomaly_id: String(payload.anomaly_id || ""),
    signature: anomaly.signature || null,
    evidence_hash: anomaly.evidence_hash || null,
    status: payload.status || "saved",
    note: payload.note || "",
  };
  fs.appendFileSync(path.join(dir, "notes.jsonl"), JSON.stringify(note) + "\n");
  fs.appendFileSync(VALIDATION_REVIEW_METADATA, JSON.stringify(note) + "\n");
  let regression_case = null;
  if (note.status === "reviewed" && noteLooksLikeErrorCase(note.note)) {
    regression_case = appendRegressionCaseFromAnomaly(validationId, note.anomaly_id, anomaly, note.note, "review_note");
  }
  json(res, 200, { ok: true, note, regression_case });
}

function regressionCases() {
  const cases = readJsonLines(REGRESSION_CASES);
  const latestBySignature = new Map();
  for (const item of cases) {
    latestBySignature.set(item.signature || item.case_id, item);
  }
  return [...latestBySignature.values()].reverse();
}

function solutionText(item, result = {}) {
  const evidence = item.anomaly?.evidence || [];
  return [
    item.title,
    item.kind,
    item.severity,
    item.note,
    item.next_step,
    result.summary,
    ...(result.agent_prompt_lessons || []),
    ...evidence.flatMap((entry) => [entry.agent, entry.row, entry.station, entry.value, entry.source_image]),
  ].filter(Boolean).join(" ").toLowerCase();
}

function solutionIdForCase(item, result = {}) {
  const caseText = [
    item.title,
    item.kind,
    item.severity,
    item.note,
    item.next_step,
    ...(item.anomaly?.evidence || []).flatMap((entry) => [entry.agent, entry.row, entry.station, entry.value, entry.source_image]),
  ].filter(Boolean).join(" ").toLowerCase();
  const agents = new Set((item.anomaly?.evidence || []).map((entry) => entry.agent).filter(Boolean));
  if ([...agents].some((agent) => agent === "table6-potentials")) {
    return "potential-minus-sign-discipline";
  }
  if ([...agents].some((agent) => String(agent).startsWith("table3-"))) {
    if (/(five\s+readings|5\s+readings|5\s+values|expected\s+five|expected\s+5|only\s+four|only\s+4|4\s+data|row\s+count|value\s+count|has\s+four)/.test(caseText)) {
      return "table3-five-reading-completeness";
    }
    return "potential-minus-sign-discipline";
  }
  if (/(upside|rotat|orientation|seven[- ]?segment|voltmeter|90\s+instead\s+of\s+6\.0|row\s*2.*\bma\b|shunt.*\bma\b)/.test(caseText)) {
    return "meter-orientation-seven-segment";
  }
  if ([...agents].some((agent) => agent === "table4-stations" || agent === "table5-currents")
    && /(current|shunt|\bma\b|\bmv\b|decimal|6369|4386|345\.7|295\.1|far from peer|outlier)/.test(caseText)) {
    return "table4-current-decimal-scale";
  }
  if ((/\btable\s*3\b|table3/.test(caseText)) && /(five\s+readings|5\s+readings|5\s+values|expected\s+five|expected\s+5|only\s+four|only\s+4|4\s+data|row\s+count|value\s+count|has\s+four)/.test(caseText)) {
    return "table3-five-reading-completeness";
  }
  if (/(station|anode|\bmg\b|pair|coverage|group)/.test(caseText) && /(\btable\s*5\b|table5|\btable\s*6\b|table6|potential|current)/.test(caseText)) {
    return "station-pairing-coverage";
  }
  if (/(minus|negative|positive|polarity|sign|potential|\bv\s*dc\b|\btable\s*3\b|table3|\btable\s*6\b|table6)/.test(caseText)) {
    return "potential-minus-sign-discipline";
  }
  return "general-anomaly-review";
}

function resultValueChanged(reading) {
  const oldValue = String(reading?.old_value ?? "").trim();
  const newValue = String(reading?.rechecked_value ?? "").trim();
  return Boolean(oldValue && newValue && oldValue !== newValue);
}

function solutionFeedbackItems(solutionId = null) {
  const items = readJsonLines(SOLUTION_FEEDBACK);
  return items
    .filter((item) => !solutionId || item.solution_id === solutionId)
    .slice(-200)
    .reverse();
}

function solutionOutcome(result, solutionId = "") {
  if (!result) return "not-run";
  const status = String(result.status || "").toLowerCase();
  const readings = Array.isArray(result.readings) ? result.readings : [];
  const changed = readings.some(resultValueChanged);
  const stillFlags = result.case_still_flags === true || readings.some((reading) => reading.issue_present === true);
  const resultText = [
    result.summary,
    ...(result.agent_prompt_lessons || []),
    ...readings.flatMap((reading) => [reading.notes, reading.rechecked_value, reading.unit]),
  ].filter(Boolean).join(" ").toLowerCase();
  if (solutionId === "potential-minus-sign-discipline"
    && ["reproduced", "needs_review"].includes(status)
    && /(positive|no[- ]?minus|no visible minus|source shows|polarity|true positive)/.test(resultText)) {
    return "accepted-source";
  }
  if (status === "fixed") return "solved";
  if (changed && status !== "needs_review" && !stillFlags) return "corrected";
  if (changed && status !== "needs_review") return "source-corrected";
  if (status === "needs_review") return "needs-review";
  if (status === "reproduced") return "still-reproduces";
  return status || "not-run";
}

function solutionOutcomeCounts(cases) {
  return cases.reduce((counts, item) => {
    const outcome = item.outcome || "not-run";
    counts.total += 1;
    if (["solved", "corrected", "source-corrected", "accepted-source"].includes(outcome)) counts.solved += 1;
    else if (outcome === "needs-review") counts.needs_review += 1;
    else if (outcome === "not-run") counts.not_run += 1;
    else counts.open += 1;
    return counts;
  }, { total: 0, solved: 0, open: 0, needs_review: 0, not_run: 0 });
}

function latestRecheckResultsByCase() {
  const results = new Map();
  const dirs = fs.readdirSync(REGRESSION_RECHECKS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REGRESSION_RECHECKS, entry.name))
    .sort((a, b) => String(path.basename(a)).localeCompare(String(path.basename(b))));
  for (const dir of dirs) {
    const state = readJsonFile(path.join(dir, "state.json"), {});
    const items = Array.isArray(state.results) && state.results.length
      ? state.results
      : readJsonFile(path.join(dir, "results.json"), []);
    for (const result of items || []) {
      const key = result.signature || result.case_id;
      if (!key) continue;
      results.set(key, { ...result, recheck_id: path.basename(dir), recheck_status: state.status || "unknown" });
    }
  }
  return results;
}

function evidenceSummary(item) {
  const evidence = item.anomaly?.evidence || [];
  const structures = [...new Set(evidence.map((entry) => entry.structure).filter(Boolean))];
  const agents = [...new Set(evidence.map((entry) => entry.agent).filter(Boolean))];
  return {
    structures,
    agents,
    items: evidence.map((entry) => ({
      structure: entry.structure || null,
      agent: entry.agent || null,
      row: entry.row || null,
      station: entry.station || null,
      source_image: entry.source_image || null,
      value: entry.value ?? null,
    })).filter((entry) => entry.source_image).slice(0, 12),
    images: evidence.map((entry) => entry.source_image).filter(Boolean).slice(0, 8),
    values: evidence.map((entry) => entry.value).filter((value) => value !== undefined && value !== null).slice(0, 8),
  };
}

function regressionSolutions() {
  const cases = regressionCases().slice().reverse();
  const resultByCase = latestRecheckResultsByCase();
  const groups = new Map();
  for (const item of cases) {
    const key = item.signature || item.case_id;
    const result = resultByCase.get(key);
    const solutionId = solutionIdForCase(item, result);
    const definition = SOLUTION_DEFINITIONS[solutionId] || SOLUTION_DEFINITIONS["general-anomaly-review"];
    if (!groups.has(solutionId)) {
      groups.set(solutionId, {
        solution_id: solutionId,
        ...definition,
        status: "not-run",
        cases: [],
        lessons: [],
        agent_graph: [
          "validation-reviewer captures anomaly from extracted leaf values",
          "regression-case recorder freezes source images, old values, and reviewer note",
          "focused-recheck leaf reopens exact evidence through OpenAI vision",
          "solution lessons feed future extraction/validation leaf prompts",
          "replay verifies whether this error class is now solved across recorded examples",
        ],
      });
    }
    const group = groups.get(solutionId);
    const outcome = solutionOutcome(result, solutionId);
    const lessons = (result?.agent_prompt_lessons || []).filter(Boolean);
    for (const lesson of lessons) {
      if (!group.lessons.includes(lesson)) group.lessons.push(lesson);
    }
    group.cases.push({
      case_id: item.case_id,
      signature: item.signature,
      title: item.title,
      kind: item.kind,
      severity: item.severity,
      note: item.note || "",
      status: item.status || "recorded",
      outcome,
      evidence: evidenceSummary(item),
      result: result ? {
        recheck_id: result.recheck_id,
        status: result.status,
        summary: result.summary,
        case_still_flags: result.case_still_flags,
        readings: (result.readings || []).slice(0, 10),
      } : null,
    });
  }
  const solutions = [...groups.values()].map((group) => {
    const counts = solutionOutcomeCounts(group.cases);
    const latestResult = group.cases.map((item) => item.result).filter(Boolean).sort((a, b) => String(b.recheck_id).localeCompare(String(a.recheck_id)))[0] || null;
    const status = counts.total && counts.solved === counts.total ? "solved"
      : counts.open || counts.needs_review ? "open"
      : counts.solved ? "partial"
      : "not-run";
    return {
      ...group,
      status,
      counts,
      latest_recheck_id: latestResult?.recheck_id || null,
      feedback: solutionFeedbackItems(group.solution_id).slice(0, 8),
      cases: group.cases.sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""))),
      lessons: group.lessons.slice(0, 12),
    };
  }).sort((a, b) => {
    const rank = { open: 0, partial: 1, "not-run": 2, solved: 3 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.counts.total - a.counts.total;
  });
  const replayState = regressionRechecks().latest;
  return {
    updated_at: new Date().toISOString(),
    live_replay: replayState || null,
    solutions,
    totals: solutions.reduce((acc, solution) => {
      acc.solutions += 1;
      acc.cases += solution.counts.total;
      acc.solved += solution.counts.solved;
      acc.open += solution.counts.open;
      acc.needs_review += solution.counts.needs_review;
      acc.not_run += solution.counts.not_run;
      return acc;
    }, { solutions: 0, cases: 0, solved: 0, open: 0, needs_review: 0, not_run: 0 }),
  };
}

async function saveSolutionFeedback(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const solutionId = String(payload.solution_id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!solutionId || !SOLUTION_DEFINITIONS[solutionId]) return json(res, 404, { error: "unknown solution" });
  const item = {
    at: new Date().toISOString(),
    solution_id: solutionId,
    status: "active",
    feedback: String(payload.feedback || "").trim(),
    source: "solution_replay_suite",
  };
  if (!item.feedback) return json(res, 400, { error: "empty feedback" });
  fs.appendFileSync(SOLUTION_FEEDBACK, JSON.stringify(item) + "\n");
  fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
    at: item.at,
    kind: "solution_feedback_saved",
    solution_id: solutionId,
    value: item.feedback,
  }) + "\n");
  json(res, 200, { ok: true, item });
}

async function saveSoftwareValidationFeedback(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const caseId = String(payload.case_id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const feedback = String(payload.feedback || "").trim();
  if (!caseId) return json(res, 400, { error: "missing case_id" });
  if (!feedback) return json(res, 400, { error: "empty feedback" });
  const item = {
    at: new Date().toISOString(),
    case_id: caseId,
    status: "active",
    feedback,
    source: "software_validation_set",
  };
  fs.appendFileSync(SOFTWARE_VALIDATION_FEEDBACK, JSON.stringify(item) + "\n");
  fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
    at: item.at,
    kind: "software_validation_feedback_saved",
    case_id: caseId,
    value: feedback,
  }) + "\n");
  json(res, 200, { ok: true, item });
}

async function saveDocxReviewFeedback(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const slotKey = String(payload.slot_key || "").slice(0, 500);
  const feedback = String(payload.feedback || "").trim();
  const status = String(payload.status || "reviewed").replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!slotKey) return json(res, 400, { error: "missing slot_key" });
  if (!feedback) return json(res, 400, { error: "empty feedback" });
  const item = {
    at: new Date().toISOString(),
    slot_key: slotKey,
    status: status || "reviewed",
    feedback,
    structure: payload.structure || null,
    table_key: payload.table_key || null,
    label: payload.label || null,
    cell_status: payload.cell_status || null,
    actual: payload.actual || "",
    expected: payload.expected || "",
    source: "docx_review",
  };
  fs.appendFileSync(DOCX_REVIEW_FEEDBACK, JSON.stringify(item) + "\n");
  fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
    at: item.at,
    kind: "docx_review_feedback_saved",
    structure: item.structure,
    title: `${item.table_key || "docx"} ${item.label || ""}`.trim(),
    status: item.status,
    value: item.feedback,
  }) + "\n");
  json(res, 200, { ok: true, item });
}

async function saveDocxCellLock(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const lockKey = String(payload.lock_key || "").slice(0, 500);
  const action = String(payload.action || "lock").replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!lockKey) return json(res, 400, { error: "missing lock_key" });
  const item = {
    at: new Date().toISOString(),
    action: action === "unlock" ? "unlock" : "lock",
    lock_key: lockKey,
    slot_key: String(payload.slot_key || "").slice(0, 500),
    locked_value: String(payload.locked_value ?? payload.actual ?? ""),
    structure: payload.structure || null,
    table_key: payload.table_key || null,
    label: payload.label || null,
    row_index: payload.row_index ?? null,
    col_index: payload.col_index ?? null,
    source_refs: Array.isArray(payload.source_refs) ? payload.source_refs.slice(0, 12) : [],
    note: payload.note || (action === "unlock" ? "Unlocked from DOCX Review" : "Locked from DOCX Review"),
    source: "docx_review_lock",
  };
  fs.appendFileSync(DOCX_CELL_LOCKS, JSON.stringify(item) + "\n");
  fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
    at: item.at,
    kind: item.action === "unlock" ? "docx_cell_unlocked" : "docx_cell_locked",
    structure: item.structure,
    title: `${item.table_key || "docx"} ${item.label || ""}`.trim(),
    value: item.locked_value,
    lock_key: item.lock_key,
  }) + "\n");
  json(res, 200, { ok: true, item });
}

function regressionRechecks() {
  const dirs = fs.readdirSync(REGRESSION_RECHECKS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REGRESSION_RECHECKS, entry.name))
    .sort((a, b) => String(path.basename(b)).localeCompare(String(path.basename(a))));
  return {
    latest: dirs[0] ? {
      ...readJsonFile(path.join(dirs[0], "state.json"), {}),
      events: readJsonLines(path.join(dirs[0], "events.jsonl")).slice(-120),
    } : null,
    rechecks: dirs.map((dir) => {
      const state = readJsonFile(path.join(dir, "state.json"), {});
      return {
        recheck_id: path.basename(dir),
        status: state.status || "unknown",
        started_at: state.started_at || null,
        updated_at: state.updated_at || null,
        finished_at: state.finished_at || null,
        cases_total: state.cases_total || 0,
        cases_done: state.cases_done || 0,
      };
    }),
  };
}

function startRegressionRecheck(req, res, url) {
  const python = process.env.PYTHON || "python3";
  const solutionId = String(url.searchParams.get("solution") || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const caseKey = String(url.searchParams.get("case") || "").replace(/[^a-zA-Z0-9_.:-]/g, "");
  const recheckId = `${stamp()}-regression-recheck`;
  const dir = path.join(REGRESSION_RECHECKS, recheckId);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  env.PYTHONPATH = SBA_SRC + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "");
  const args = [path.join(ROOT, "regression_recheck.py"), "--recheck-id", recheckId];
  if (solutionId) args.push("--solution-id", solutionId, "--limit", "32");
  if (caseKey) args.push("--case-key", caseKey, "--limit", "1");
  const child = spawn(python, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = path.join(REGRESSION_RECHECKS, "recheck-spawn.log");
  fs.appendFileSync(log, `\n[start] pid=${child.pid} recheck=${recheckId} solution=${solutionId || "all"} case=${caseKey || "all"} at=${new Date().toISOString()}\n`);
  child.stdout.on("data", (chunk) => fs.appendFileSync(log, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(log, chunk));
  fs.writeFileSync(path.join(dir, "server-control.json"), JSON.stringify({ pid: child.pid, recheck_id: recheckId, solution_id: solutionId || null, case_key: caseKey || null, started_at: new Date().toISOString() }, null, 2) + "\n");
  child.on("exit", (code, signal) => {
    fs.appendFileSync(log, `[exit] pid=${child.pid} code=${code} signal=${signal}\n`);
  });
  json(res, 202, { ok: true, recheck_id: recheckId, solution_id: solutionId || null, case_key: caseKey || null, pid: child.pid });
}

function noteLooksLikeErrorCase(note) {
  return /\b(error|bug|wrong|incorrect|bad|repeat|repeated|regression|fix|should|missing|mismatch|anomaly|problem|issue)\b/i.test(String(note || ""));
}

async function recordRegressionCase(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const validationId = String(payload.validation_id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const anomalyId = String(payload.anomaly_id || "");
  const dir = path.join(VALIDATIONS, validationId);
  if (!validationId || !dir.startsWith(VALIDATIONS) || !fs.existsSync(dir)) return json(res, 404, { error: "unknown validation" });
  const state = readJsonFile(path.join(dir, "state.json"), {});
  const anomaly = (state.anomalies || []).find((item) => item.id === anomalyId);
  if (!anomaly) return json(res, 404, { error: "unknown anomaly" });
  const item = appendRegressionCaseFromAnomaly(validationId, anomalyId, anomaly, payload.note || "", "manual_record");
  json(res, 200, { ok: true, item });
}

function appendRegressionCaseFromAnomaly(validationId, anomalyId, anomaly, note, source = "review_note") {
  const item = {
    at: new Date().toISOString(),
    case_id: `${validationId}:${anomalyId}`,
    validation_id: validationId,
    anomaly_id: anomalyId,
    signature: anomaly.signature || null,
    evidence_hash: anomaly.evidence_hash || null,
    status: "recorded",
    source,
    title: anomaly.title,
    kind: anomaly.kind,
    severity: anomaly.severity,
    note: note || "",
    anomaly,
    next_step: "Focused rerun target: reproduce this scenario and verify whether a later extraction/validation still flags it.",
  };
  fs.appendFileSync(REGRESSION_CASES, JSON.stringify(item) + "\n");
  fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
    at: item.at,
    kind: "regression_case_recorded",
    source,
    validation_id: validationId,
    anomaly_id: anomalyId,
    signature: item.signature,
    title: item.title,
  }) + "\n");
  return item;
}

function secondsBetween(a, b) {
  const start = Date.parse(a || "");
  const end = Date.parse(b || "");
  return start && end ? Math.max(0, Math.round((end - start) / 100) / 10) : null;
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function emptyUsageBucket(name) {
  return {
    name,
    requests: 0,
    successes: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    input_images: 0,
    input_text_chars: 0,
    api_seconds: 0,
  };
}

function addUsage(bucket, entry, call) {
  const usage = entry.usage || {};
  const payload = entry.payload_stats || {};
  bucket.requests += 1;
  bucket.successes += entry.request_status === "ok" ? 1 : 0;
  bucket.errors += entry.request_status === "ok" ? 0 : 1;
  bucket.input_tokens += Number(usage.input_tokens || 0);
  bucket.output_tokens += Number(usage.output_tokens || 0);
  bucket.total_tokens += Number(usage.total_tokens || 0);
  bucket.cached_input_tokens += Number(usage.cached_input_tokens || 0);
  bucket.reasoning_output_tokens += Number(usage.reasoning_output_tokens || 0);
  bucket.input_images += Number(payload.input_images || 0);
  bucket.input_text_chars += Number(payload.input_text_chars || 0);
  bucket.api_seconds += Number(call?.elapsed_seconds || 0);
}

function finishUsage(bucket) {
  return {
    ...bucket,
    api_seconds: Math.round(bucket.api_seconds * 10) / 10,
    avg_seconds_per_request: bucket.requests ? Math.round((bucket.api_seconds / bucket.requests) * 10) / 10 : null,
    avg_tokens_per_request: bucket.requests ? Math.round(bucket.total_tokens / bucket.requests) : null,
    tokens_per_image: bucket.input_images ? Math.round(bucket.total_tokens / bucket.input_images) : null,
    input_output_ratio: bucket.output_tokens ? Math.round((bucket.input_tokens / bucket.output_tokens) * 10) / 10 : null,
  };
}

function usageDetails(dir, state) {
  const entries = readJsonLines(path.join(dir, "llm-usage", "llm-usage.jsonl"));
  const callsByResponse = new Map((state.api_calls || []).filter((call) => call.response_id).map((call) => [call.response_id, call]));
  const total = emptyUsageBucket("total");
  const byAgent = new Map();
  const byPhase = new Map();
  const byModel = new Map();
  const calls = [];
  for (const entry of entries) {
    const call = callsByResponse.get(entry.response_id) || {};
    const agent = call.agent || "unknown";
    const phase = agent === "image-router" ? "image-router"
      : String(agent).startsWith("table3") ? "table3"
      : String(agent).startsWith("table4") ? "table4"
      : String(agent).startsWith("table5") ? "table5"
      : String(agent).startsWith("table6") ? "table6"
      : String(agent).includes("reuse") ? "reuse"
      : "other";
    const model = entry.model || "unknown";
    if (!byAgent.has(agent)) byAgent.set(agent, emptyUsageBucket(agent));
    if (!byPhase.has(phase)) byPhase.set(phase, emptyUsageBucket(phase));
    if (!byModel.has(model)) byModel.set(model, emptyUsageBucket(model));
    addUsage(total, entry, call);
    addUsage(byAgent.get(agent), entry, call);
    addUsage(byPhase.get(phase), entry, call);
    addUsage(byModel.get(model), entry, call);
    const usage = entry.usage || {};
    const payload = entry.payload_stats || {};
    calls.push({
      agent,
      phase,
      model,
      response_id: entry.response_id || null,
      seconds: Number(call.elapsed_seconds || 0),
      input_tokens: Number(usage.input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0),
      cached_input_tokens: Number(usage.cached_input_tokens || 0),
      reasoning_output_tokens: Number(usage.reasoning_output_tokens || 0),
      input_images: Number(payload.input_images || 0),
      request_status: entry.request_status || "unknown",
    });
  }
  return {
    total: finishUsage(total),
    by_agent: [...byAgent.values()].map(finishUsage).sort((a, b) => b.total_tokens - a.total_tokens),
    by_phase: [...byPhase.values()].map(finishUsage).sort((a, b) => b.total_tokens - a.total_tokens),
    by_model: [...byModel.values()].map(finishUsage).sort((a, b) => b.total_tokens - a.total_tokens),
    slowest_calls: calls.slice().sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    largest_token_calls: calls.slice().sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 5),
  };
}

function stats() {
  const latest = listRuns().reduce((map, run) => {
    const key = String(run.structure);
    if (!map.has(key)) map.set(key, run);
    return map;
  }, new Map());
  const perRun = [...latest.values()].map((run) => {
    const dir = runDir(run.run_id);
    const state = readState(run.run_id);
    const agents = Object.values(state.agents || {});
    const steps = Object.values(state.steps || {});
    const api = state.api_calls || [];
    const apiDone = api.filter((call) => call.status === "complete");
    const apiSeconds = apiDone.map((call) => Number(call.elapsed_seconds || 0)).filter(Boolean);
    const leafAgents = agents.filter((agent) => String(agent.name || "").startsWith("table"));
    const router = state.agents?.["image-router"];
    const usage = readJsonFile(path.join(dir, "llm-usage", "llm-usage.summary.json"), {});
    const usageDetail = usageDetails(dir, state);
    const tokens = usage.token_totals || usageDetail.total || {};
    const payload = usage.payload_totals || usageDetail.total || {};
    return {
      run_id: run.run_id,
      structure: run.structure,
      status: state.status || run.status,
      ordinal: state.target?.ordinal || null,
      active_step: steps.find((step) => step.status === "running")?.name || null,
      started_at: state.started_at || null,
      updated_at: state.updated_at || run.updated_at || null,
      finished_at: state.finished_at || state.finished_apply_at || null,
      duration_seconds: secondsBetween(state.started_at, state.finished_at || state.finished_apply_at || state.updated_at),
      api_calls_total: api.length,
      api_calls_complete: apiDone.length,
      api_seconds_total: Math.round(apiSeconds.reduce((a, b) => a + b, 0) * 10) / 10,
      api_seconds_avg: apiSeconds.length ? Math.round((apiSeconds.reduce((a, b) => a + b, 0) / apiSeconds.length) * 10) / 10 : null,
      images_total: agents.reduce((sum, agent) => sum + Number(agent.image_count || 0), 0),
      leaf_complete: leafAgents.filter((agent) => agent.status === "complete").length,
      leaf_total: leafAgents.length,
      router_used: Boolean(router && Number(router.image_count || 0) > 0),
      router_images: Number(router?.image_count || 0),
      warnings_total: agents.reduce((sum, agent) => sum + (Array.isArray(agent.unresolved) ? agent.unresolved.length : 0), 0),
      artifacts_total: (state.artifacts || []).length,
      model_requests: usage.request_count || 0,
      model_success: usage.success_count || 0,
      token_input: tokens.input_tokens || 0,
      token_output: tokens.output_tokens || 0,
      token_total: tokens.total_tokens || 0,
      token_cached_input: tokens.cached_input_tokens || 0,
      token_reasoning_output: tokens.reasoning_output_tokens || 0,
      payload_images: payload.input_images || 0,
      cost_proxy: usageDetail.total,
      usage_by_agent: usageDetail.by_agent,
      usage_by_phase: usageDetail.by_phase,
      usage_by_model: usageDetail.by_model,
      slowest_model_calls: usageDetail.slowest_calls,
      largest_token_calls: usageDetail.largest_token_calls,
      slowest_api: apiDone
        .slice()
        .sort((a, b) => Number(b.elapsed_seconds || 0) - Number(a.elapsed_seconds || 0))
        .slice(0, 3)
        .map((call) => ({ agent: call.agent, seconds: call.elapsed_seconds, images: call.image_count })),
    };
  }).sort((a, b) => Number(a.ordinal || 999) - Number(b.ordinal || 999));
  const statuses = perRun.reduce((acc, run) => {
    acc[run.status || "unknown"] = (acc[run.status || "unknown"] || 0) + 1;
    return acc;
  }, {});
  const completeRuns = perRun.filter((run) => run.status === "complete");
  const aggregateBuckets = (key) => {
    const map = new Map();
    for (const run of perRun) {
      for (const bucket of run[key] || []) {
        if (!map.has(bucket.name)) map.set(bucket.name, emptyUsageBucket(bucket.name));
        const target = map.get(bucket.name);
        target.requests += Number(bucket.requests || 0);
        target.successes += Number(bucket.successes || 0);
        target.errors += Number(bucket.errors || 0);
        target.input_tokens += Number(bucket.input_tokens || 0);
        target.output_tokens += Number(bucket.output_tokens || 0);
        target.total_tokens += Number(bucket.total_tokens || 0);
        target.cached_input_tokens += Number(bucket.cached_input_tokens || 0);
        target.reasoning_output_tokens += Number(bucket.reasoning_output_tokens || 0);
        target.input_images += Number(bucket.input_images || 0);
        target.input_text_chars += Number(bucket.input_text_chars || 0);
        target.api_seconds += Number(bucket.api_seconds || 0);
      }
    }
    return [...map.values()].map(finishUsage).sort((a, b) => b.total_tokens - a.total_tokens);
  };
  return {
    updated_at: new Date().toISOString(),
    folders_total: listStructures().length,
    latest_runs_total: perRun.length,
    statuses,
    running_structures: perRun.filter((run) => run.status === "running").map((run) => run.structure),
    api_calls_total: perRun.reduce((sum, run) => sum + run.api_calls_total, 0),
    api_seconds_total: Math.round(perRun.reduce((sum, run) => sum + run.api_seconds_total, 0) * 10) / 10,
    images_total: perRun.reduce((sum, run) => sum + run.images_total, 0),
    model_requests_total: perRun.reduce((sum, run) => sum + run.model_requests, 0),
    token_input_total: perRun.reduce((sum, run) => sum + run.token_input, 0),
    token_output_total: perRun.reduce((sum, run) => sum + run.token_output, 0),
    token_total: perRun.reduce((sum, run) => sum + run.token_total, 0),
    token_cached_input_total: perRun.reduce((sum, run) => sum + run.token_cached_input, 0),
    token_reasoning_output_total: perRun.reduce((sum, run) => sum + run.token_reasoning_output, 0),
    usage_by_agent: aggregateBuckets("usage_by_agent"),
    usage_by_phase: aggregateBuckets("usage_by_phase"),
    usage_by_model: aggregateBuckets("usage_by_model"),
    largest_token_calls: perRun
      .flatMap((run) => (run.largest_token_calls || []).map((call) => ({ structure: run.structure, run_id: run.run_id, ...call })))
      .sort((a, b) => Number(b.total_tokens || 0) - Number(a.total_tokens || 0))
      .slice(0, 10),
    avg_complete_duration_seconds: completeRuns.length
      ? Math.round((completeRuns.reduce((sum, run) => sum + Number(run.duration_seconds || 0), 0) / completeRuns.length) * 10) / 10
      : null,
    bottlenecks: perRun
      .flatMap((run) => run.slowest_api.map((apiCall) => ({ structure: run.structure, run_id: run.run_id, ...apiCall })))
      .sort((a, b) => Number(b.seconds || 0) - Number(a.seconds || 0))
      .slice(0, 10),
    per_run: perRun,
  };
}

function activityFeed() {
  const events = [];
  const active_runs = [];
  const pushEvent = (event) => {
    events.push({
      run_id: event.run_id || "system",
      structure: event.structure || null,
      status: event.status || "unknown",
      seq: Number(event.seq || 0),
      at: event.at || null,
      type: event.type || "event",
      message: event.message || "",
    });
  };
  try {
    const review = docxReviewPayload();
    const lockedIssues = Number(review.summary?.locked_drift || 0) + Number(review.summary?.locked_write_attempt || 0);
    if (lockedIssues) {
      active_runs.push({
        run_id: "locked-docx-monitor",
        structure: "DOCX",
        status: "failed",
        active_step: "locked-cell-drift",
        active_agent: "software-validation-lock-monitor",
        updated_at: review.updated_at || new Date().toISOString(),
        api_calls: 0,
        artifacts: lockedIssues,
      });
      pushEvent({
        run_id: "locked-docx-monitor",
        structure: "DOCX",
        status: "failed",
        seq: 10_100_000,
        at: new Date().toISOString(),
        type: "locked-cell-drift",
        message: `${lockedIssues} locked DOCX cell issue(s): drift or attempted overwrite`,
      });
    }
  } catch {}
  const closedLoop = readJsonFile(CLOSED_LOOP_STATUS, null);
  if (closedLoop) {
    active_runs.push({
      run_id: closedLoop.loop_id || "closed-loop-clean",
      structure: "closed-loop",
      status: closedLoop.status || "running",
      active_step: closedLoop.stage || null,
      active_agent: closedLoop.agent || "closed-loop-orchestrator",
      updated_at: closedLoop.updated_at || closedLoop.at || null,
      api_calls: closedLoop.api_calls || 0,
      artifacts: closedLoop.artifacts || 0,
    });
    pushEvent({
      run_id: closedLoop.loop_id || "closed-loop-clean",
      structure: "closed-loop",
      status: closedLoop.status || "running",
      seq: 10_000_000,
      at: closedLoop.updated_at || closedLoop.at,
      type: "closed-loop",
      message: `${closedLoop.stage || "closed loop"}: ${closedLoop.message || ""}`.trim(),
    });
  }
  const feedbackCorrection = readJsonFile(FEEDBACK_CORRECTION_STATUS, null);
  if (feedbackCorrection) {
    const updatedAt = feedbackCorrection.updated_at || feedbackCorrection.at || null;
    const recent = updatedAt && Date.now() - (Date.parse(updatedAt) || 0) < 90_000;
    if (feedbackCorrection.status === "running" || recent) {
      active_runs.push({
        run_id: "feedback-correction-agent",
        structure: "feedback",
        status: feedbackCorrection.status || "unknown",
        active_step: "human-feedback-correction",
        active_agent: feedbackCorrection.agent || "feedback-correction-orchestrator",
        updated_at: updatedAt,
        api_calls: 0,
        artifacts: Number(feedbackCorrection.processed || 0),
      });
    }
    pushEvent({
      run_id: "feedback-correction-agent",
      structure: "feedback",
      status: feedbackCorrection.status || "unknown",
      seq: 9_950_000,
      at: updatedAt,
      type: "feedback-correction",
      message: `feedback correction: ${feedbackCorrection.status || "unknown"}; processed=${feedbackCorrection.processed ?? feedbackCorrection.pending ?? 0}`,
    });
  }
  for (const item of readJsonLines(CLOSED_LOOP_LEDGER).slice(-12)) {
    pushEvent({
      run_id: "closed-loop-clean",
      structure: "closed-loop",
      status: item.status || "ledger",
      seq: 9_900_000,
      at: item.at,
      type: "closed-loop-ledger",
      message: `iteration ${item.iteration || "?"}: ${item.status || "recorded"}; anomalies=${item.anomaly_count ?? "?"}; readback mismatches=${item.readback?.mismatch_count ?? "?"}`,
    });
  }
  for (const dir of validationDirs().slice(0, 8)) {
    const validationId = path.basename(dir);
    const state = readJsonFile(path.join(dir, "state.json"), {});
    const validationEvents = readJsonLines(path.join(dir, "events.jsonl")).slice(-18);
    if (state.status === "running" && controlProcessAlive(dir, state.updated_at || state.started_at)) {
      const runningAgent = Object.values(state.agents || {}).find((agent) => agent.status === "running");
      active_runs.push({
        run_id: validationId,
        structure: "validation",
        status: state.status,
        active_step: runningAgent?.name || "validation",
        active_agent: runningAgent?.name || "validation-orchestrator",
        updated_at: state.updated_at || state.started_at || null,
        active_api_calls: runningAgent?.name === "llm-reviewer" ? 1 : 0,
        api_calls: 0,
        artifacts: state.anomalies?.length || 0,
      });
    }
    for (const event of validationEvents) {
      pushEvent({
        run_id: validationId,
        structure: "validation",
        status: state.status || "unknown",
        seq: Number(event.seq || 0),
        at: event.at,
        type: `validation:${event.type || "event"}`,
        message: event.message || "",
      });
    }
  }
  const recheckDirs = fs.readdirSync(REGRESSION_RECHECKS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(REGRESSION_RECHECKS, entry.name))
    .sort((a, b) => String(path.basename(b)).localeCompare(String(path.basename(a))))
    .slice(0, 8);
  for (const dir of recheckDirs) {
    const recheckId = path.basename(dir);
    const state = readJsonFile(path.join(dir, "state.json"), {});
    const recheckEvents = readJsonLines(path.join(dir, "events.jsonl")).slice(-22);
    if (state.status === "running" && controlProcessAlive(dir, state.updated_at || state.started_at)) {
      active_runs.push({
        run_id: recheckId,
        structure: "recheck",
        status: state.status,
        active_step: state.active_node || "focused replay",
        active_agent: state.active_node || "focused-openai-leaf",
        updated_at: state.updated_at || state.started_at || null,
        active_api_calls: Number(state.active_api_calls || 0),
        api_calls: state.cases_done || 0,
        artifacts: state.cases_total || 0,
      });
    }
    for (const event of recheckEvents) {
      pushEvent({
        run_id: recheckId,
        structure: "recheck",
        status: state.status || "unknown",
        seq: Number(event.seq || 0),
        at: event.at,
        type: `recheck:${event.type || "event"}`,
        message: event.message || "",
      });
    }
  }
  for (const item of readJsonLines(CORRECTION_PROMOTIONS).slice(-16)) {
    const writes = item.docx_writes || [];
    const failed = writes.filter((write) => write.docx_write === "failed").length;
    pushEvent({
      run_id: "correction-promoter",
      structure: "DOCX",
      status: failed ? "failed" : "complete",
      seq: 9_800_000,
      at: item.at,
      type: "docx-promotion",
      message: `promoted ${item.candidate_count || 0} correction(s) across ${item.run_count || 0} run(s); docx writes=${writes.length}; failed=${failed}`,
    });
  }
  for (const item of readJsonLines(DOCX_SOURCE_CORRECTIONS).slice(-16)) {
    pushEvent({
      run_id: "docx-source-corrections",
      structure: item.structure || "DOCX",
      status: item.status || "active",
      seq: 9_790_000,
      at: item.at,
      type: "docx-source-correction",
      message: `${item.action || "correction"} ${item.table_key || "docx"} ${item.label || ""}: ${(item.new_source_refs || []).join(" -> ") || "reset"}`,
    });
  }
  const runs = listRuns();
  const runningIds = new Set();
  for (const run of runs) {
    if (run.status !== "running") continue;
    runningIds.add(run.run_id);
    const state = readState(run.run_id);
    const steps = Object.values(state.steps || {});
    const agents = Object.values(state.agents || {});
    active_runs.push({
      run_id: run.run_id,
      structure: run.structure,
      status: state.status || run.status,
      active_step: steps.find((step) => step.status === "running")?.name || null,
      active_agent: agents.find((agent) => agent.status === "running")?.name || null,
      updated_at: state.updated_at || run.updated_at || null,
      api_calls: (state.api_calls || []).length,
      artifacts: (state.artifacts || []).length,
    });
  }
  const sourceRuns = runningIds.size ? runs.filter((run) => runningIds.has(run.run_id)) : runs.slice(0, 24);
  for (const run of sourceRuns.slice(0, 60)) {
    const dir = runDir(run.run_id);
    const file = dir ? path.join(dir, "events.jsonl") : null;
    if (!file || !fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).slice(-32);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push({
          run_id: run.run_id,
          structure: run.structure,
          status: run.status,
          seq: event.seq || 0,
          at: event.at || null,
          type: event.type || "event",
          message: event.message || "",
        });
      } catch {}
    }
  }
  return {
    active_runs,
    concurrency: activityConcurrency(active_runs),
    events: events
      .sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0) || Number(b.seq || 0) - Number(a.seq || 0))
      .slice(0, 80),
  };
}

function activityConcurrency(activeRuns) {
  const counters = {
    total_active: activeRuns.length,
    api_calls_active: 0,
    docx_writes_active: 0,
    validations_active: 0,
    rechecks_active: 0,
    cleanup_active: 0,
    str_runs_active: 0,
  };
  for (const item of activeRuns) {
    const structure = String(item.structure || "");
    const step = String(item.active_step || item.active_agent || "").toLowerCase();
    if (structure === "validation") counters.validations_active += 1;
    else if (structure === "recheck") counters.rechecks_active += 1;
    else if (structure === "closed-loop") counters.cleanup_active += 1;
    else counters.str_runs_active += 1;
    const activeApi = Number(item.active_api_calls || 0);
    if (activeApi > 0) counters.api_calls_active += activeApi;
    else if (structure !== "closed-loop" && (step.includes("openai") || step.includes("llm") || step.includes("focused") || step.includes("reviewer"))) counters.api_calls_active += 1;
    if (step.includes("docx") || step.includes("write")) counters.docx_writes_active += 1;
  }
  return counters;
}

function controlProcessAlive(dir, updatedAt = null) {
  const control = readJsonFile(path.join(dir, "server-control.json"), {});
  const pid = Number(control.pid || 0);
  if (!pid) {
    const age = Date.now() - (Date.parse(updatedAt || "") || 0);
    return Number.isFinite(age) && age >= 0 && age < 45_000;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function sanitizeStructure(value) {
  return String(value || "").replace(/[^0-9A-Za-z_-]/g, "").trim();
}

function listStructures() {
  return fs.readdirSync(SITE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = entry.name.match(/^(\d+)\s+-\s+(\d+)/);
      if (!match) return null;
      return {
        ordinal: Number(match[1]),
        structure: match[2],
        folder: entry.name,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ordinal - b.ordinal);
}

function imageNeighborhood(req, res, url) {
  const folder = url.searchParams.get("folder") || "";
  const image = url.searchParams.get("image") || "";
  const limit = Math.max(1, Math.min(24, Number(url.searchParams.get("limit") || "9")));
  const dir = path.resolve(SITE_ROOT, folder);
  if (!dir.startsWith(path.resolve(SITE_ROOT)) || !fs.existsSync(dir)) return json(res, 404, { error: "folder not found" });
  const files = fs.readdirSync(dir)
    .filter((name) => imageExt.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const found = files.indexOf(image);
  const index = found >= 0 ? found : 0;
  const anchorImage = files[index] || "";
  const start = Math.max(0, Math.min(files.length, index - Math.floor(limit / 2)));
  const selected = files.slice(start, start + limit);
  const payload = {
    folder,
    image: image || anchorImage,
    index,
    total: files.length,
    images: selected.map((name) => ({
      name,
      href: `/api/thumb/site/${encodeURIComponent(folder)}/${encodeURIComponent(name)}?size=260`,
      current: name === (image || anchorImage),
    })),
  };
  /*
   * Neighborhood JSON is only folder image order plus immutable thumbnail URLs.
   * Caching it makes hover strips appear immediately after the first read while
   * the correction ledger remains authoritative for which images are selected.
   */
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
    "Content-Length": Buffer.byteLength(body),
  });
  return res.end(body);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const clean = String(value || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function siteImageListForStructure(structure) {
  const match = listStructures().find((item) => String(item.structure) === String(structure));
  if (!match) return { folder: "", images: [] };
  const dir = path.resolve(SITE_ROOT, match.folder);
  if (!dir.startsWith(path.resolve(SITE_ROOT)) || !fs.existsSync(dir)) return { folder: match.folder, images: [] };
  const images = fs.readdirSync(dir)
    .filter((name) => imageExt.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { folder: match.folder, images };
}

function clampRangeStart(start, count, total) {
  const safeCount = Math.max(1, Math.min(Number(count) || 1, Math.max(1, total)));
  return Math.max(0, Math.min(Number(start) || 0, Math.max(0, total - safeCount)));
}

function resolveDocxSourceCorrectionRange(payload) {
  const structure = String(payload.structure || "").replace(/[^0-9A-Za-z_-]/g, "");
  const action = String(payload.action || "shift_next").replace(/[^a-zA-Z0-9_.-]/g, "");
  const current = uniqueStrings(payload.source_refs || payload.sourceRefs || []);
  const { folder, images } = siteImageListForStructure(structure);
  const oldSourceRefs = current.filter((name) => images.includes(name));
  const fallbackStart = oldSourceRefs.length ? images.indexOf(oldSourceRefs[0]) : 0;
  const startIndex = Math.max(0, fallbackStart);
  const oldCount = Math.max(1, oldSourceRefs.length || Number(payload.count || 1) || 1);
  let nextStart = startIndex;
  let nextCount = oldCount;

  if (action === "shift_prev") nextStart -= 1;
  else if (action === "shift_next") nextStart += 1;
  else if (action === "extend_start") { nextStart -= 1; nextCount += 1; }
  else if (action === "extend_end") nextCount += 1;
  else if (action === "trim_start") { nextStart += 1; nextCount = Math.max(1, nextCount - 1); }
  else if (action === "trim_end") nextCount = Math.max(1, nextCount - 1);
  else if (action === "reset") return { structure, folder, images, oldSourceRefs, newSourceRefs: [], action };
  else if (action === "set_explicit") {
    const explicit = uniqueStrings(payload.new_source_refs || payload.newSourceRefs || []).filter((name) => images.includes(name));
    return { structure, folder, images, oldSourceRefs, newSourceRefs: explicit, action };
  }

  const boundedCount = Math.max(1, Math.min(nextCount, Math.max(1, images.length)));
  const boundedStart = clampRangeStart(nextStart, boundedCount, images.length);
  const newSourceRefs = images.slice(boundedStart, boundedStart + boundedCount);
  return { structure, folder, images, oldSourceRefs, newSourceRefs, action };
}

async function saveDocxSourceCorrection(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const slotKey = String(payload.slot_key || "").slice(0, 500);
  if (!slotKey) return json(res, 400, { error: "missing slot_key" });
  const resolved = resolveDocxSourceCorrectionRange(payload);
  if (resolved.action !== "reset" && !resolved.newSourceRefs.length) {
    return json(res, 400, { error: "no corrected source range available", resolved });
  }
  const item = {
    at: new Date().toISOString(),
    correction_id: crypto.createHash("sha1").update(`${Date.now()}:${slotKey}:${Math.random()}`).digest("hex").slice(0, 16),
    slot_key: slotKey,
    lock_key: String(payload.lock_key || "").slice(0, 500),
    action: resolved.action,
    status: resolved.action === "reset" ? "reset" : "active",
    structure: resolved.structure,
    table_key: payload.table_key || null,
    label: payload.label || null,
    row_index: payload.row_index ?? null,
    col_index: payload.col_index ?? null,
    old_source_refs: resolved.oldSourceRefs,
    new_source_refs: resolved.newSourceRefs,
    source_folder: resolved.folder,
    actual: payload.actual || "",
    expected: payload.expected || "",
    cell_status: payload.cell_status || null,
    note: String(payload.note || "").slice(0, 1200),
    source: "docx_review_source_range",
  };
  /*
   * This append-only ledger is the source-of-truth boundary for reviewer-side
   * evidence-range corrections. The browser can offer convenient buttons now
   * and drag handles later, but every correction must become one ledger event.
   * `docx_review.py` replays the latest active event for each slot before the
   * UI renders, which prevents the dangerous split-brain state where the cell
   * visually appears corrected but validation/agents still see the old image
   * range.
   */
  fs.appendFileSync(DOCX_SOURCE_CORRECTIONS, JSON.stringify(item) + "\n");
  fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
    at: item.at,
    kind: "docx_source_range_corrected",
    structure: item.structure,
    title: `${item.table_key || "docx"} ${item.label || ""}`.trim(),
    action: item.action,
    value: item.new_source_refs.join(", "),
    slot_key: item.slot_key,
  }) + "\n");
  const sourceTruth = writeDocxSourceOfTruthSnapshot("source_range_saved");
  json(res, 200, {
    ok: true,
    item,
    source_truth: {
      ok: sourceTruth.ok,
      path: DOCX_SOURCE_OF_TRUTH,
      error: sourceTruth.error || null,
      active_source_range_count: sourceTruth.snapshot?.active_source_range_count,
    },
  });
}

async function promoteDocxSourceCorrection(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const slotKey = String(payload.slot_key || "").slice(0, 500);
  if (!slotKey) return json(res, 400, { error: "missing slot_key" });
  const python = process.env.PYTHON || "python3";
  const args = [PROMOTE_SOURCE_CORRECTION_SCRIPT, "--slot-key", slotKey];
  const note = String(payload.note || "").trim();
  if (note) args.push("--note", note.slice(0, 1200));
  const result = spawnSync(python, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `promote_source_correction.py exited ${result.status}`;
    fs.appendFileSync(FEEDBACK_PROCESSING, JSON.stringify({
      at: new Date().toISOString(),
      kind: "docx_source_correction_promotion_failed",
      slot_key: slotKey,
      error: detail.slice(-4000),
    }) + "\n");
    return json(res, 500, { ok: false, error: detail });
  }
  const payloadOut = JSON.parse(result.stdout || "{}");
  const sourceTruth = writeDocxSourceOfTruthSnapshot("source_range_promoted_to_docx");
  return json(res, 200, {
    ...payloadOut,
    source_truth: {
      ok: sourceTruth.ok,
      path: DOCX_SOURCE_OF_TRUTH,
      error: sourceTruth.error || null,
      active_source_range_count: sourceTruth.snapshot?.active_source_range_count,
    },
  });
}

function latestCompleteRunForStructure(structure) {
  return listRuns().find((run) => String(run.structure) === String(structure) && run.status === "complete") || null;
}

function spawnRun(structure, offset, mode = "reuse") {
  const python = process.env.PYTHON || "python3";
  const runner = path.join(ROOT, "runner.py");
  const runId = `${stamp()}-${String(offset + 1).padStart(2, "0")}-str${structure}`;
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  env.PYTHONPATH = SBA_SRC + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "");
  const args = [runner, "--structure", structure, "--run-id", runId];
  if (mode === "reuse") args.push("--reuse-from", "latest");
  const child = spawn(python, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = path.join(RUNS, "server-spawn.log");
  fs.appendFileSync(serverLog, `\n[start] pid=${child.pid} run=${runId} structure=${structure} at=${new Date().toISOString()}\n`);
  child.stdout.on("data", (chunk) => fs.appendFileSync(serverLog, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(serverLog, chunk));
  fs.writeFileSync(path.join(dir, "server-control.json"), JSON.stringify({ pid: child.pid, run_id: runId, structure, started_at: new Date().toISOString() }, null, 2) + "\n");
  child.on("exit", (code, signal) => {
    fs.appendFileSync(serverLog, `[exit] pid=${child.pid} code=${code} signal=${signal}\n`);
    updateRunState(runId, (state) => {
      state.process = { pid: child.pid, code, signal, exited_at: new Date().toISOString() };
      if (signal === "SIGTERM" && state.status === "running") state.status = "stopped";
    });
  });
  return { pid: child.pid, run_id: runId, structure, mode };
}

function startRun(req, res, url) {
  const requested = url.searchParams.get("structures") || url.searchParams.get("structure") || "193";
  const mode = url.searchParams.get("mode") === "fresh" ? "fresh" : "reuse";
  const structures = [...new Set(requested.split(",").map(sanitizeStructure).filter(Boolean))];
  const runs = structures.map((structure, index) => spawnRun(structure, index, mode));
  json(res, 202, { ok: true, runs });
}

function stopRun(req, res, url) {
  const runId = runIdFromUrl(url);
  const dir = runDir(runId);
  if (!dir) return json(res, 404, { error: "unknown run" });
  const control = readJsonFile(path.join(dir, "server-control.json"), {});
  const pid = Number(control.pid || 0);
  let stopped = false;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch (error) {
      stopped = false;
    }
  }
  updateRunState(runId, (state) => {
    state.status = "stopped";
    state.steps = state.steps || {};
    state.steps.user_control = {
      name: "user_control",
      status: "stopped",
      message: "Stopped from dashboard",
      updated_at: new Date().toISOString(),
      events: [{ at: new Date().toISOString(), status: "stopped", message: "Stopped from dashboard" }],
    };
  });
  appendRunEvent(runId, "control", "Stopped from dashboard", { pid, signal_sent: stopped });
  json(res, 200, { ok: true, run_id: runId, pid, signal_sent: stopped });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function feedback(req, res) {
  const payload = JSON.parse((await readBody(req)) || "{}");
  const runId = String(payload.run_id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const agent = String(payload.agent || "human-feedback").replace(/[^a-zA-Z0-9_.-]/g, "");
  const item = {
    at: new Date().toISOString(),
    run_id: runId,
    structure: payload.structure || null,
    agent,
    field: payload.field || "label",
    previous: payload.previous || "",
    value: payload.value || "",
    reading: payload.reading || null,
  };
  fs.appendFileSync(GLOBAL_FEEDBACK, JSON.stringify(item) + "\n");
  const dir = runDir(runId);
  if (!dir) return json(res, 404, { error: "unknown run" });
  fs.appendFileSync(path.join(dir, "feedback.jsonl"), JSON.stringify(item) + "\n");
  updateRunState(runId, (state) => {
    state.feedback = [...(state.feedback || []), item].slice(-100);
    state.agents = state.agents || {};
    const leaf = state.agents[agent] || { name: agent, status: "pending", events: [] };
    leaf.feedback = [...(leaf.feedback || []), item].slice(-30);
    leaf.message = "Human feedback attached";
    state.agents[agent] = leaf;
    state.agents["human-feedback"] = {
      name: "human-feedback",
      status: "complete",
      message: `${state.feedback.length} feedback item${state.feedback.length === 1 ? "" : "s"} captured for future agent prompts`,
      updated_at: item.at,
      feedback_count: state.feedback.length,
      feedback: state.feedback,
      events: [{ at: item.at, status: "complete", message: "Feedback captured" }],
    };
  });
  appendRunEvent(runId, "feedback", `Human feedback captured for ${agent}`, item);
  json(res, 200, { ok: true, item });
}

async function api(req, res, url) {
  if (url.pathname === "/api/runs") return json(res, 200, { runs: listRuns() });
  if (url.pathname === "/api/report/source-of-truth") return json(res, 200, reportSourceOfTruth());
  if (url.pathname === "/api/docx-source-of-truth") return json(res, 200, readDocxSourceOfTruth());
  if (url.pathname === "/api/report/open-final") return openFinalReport(res);
  if (url.pathname === "/api/docx-review") return json(res, 200, docxReviewPayload());
  if (url.pathname === "/api/docx-review/feedback") return saveDocxReviewFeedback(req, res);
  if (url.pathname === "/api/docx-review/lock") return saveDocxCellLock(req, res);
  if (url.pathname === "/api/docx-review/correction") return saveDocxSourceCorrection(req, res);
  if (url.pathname === "/api/docx-review/apply-source-correction") return promoteDocxSourceCorrection(req, res);
  if (url.pathname === "/api/docx-review/corrections") return json(res, 200, { corrections: readJsonLines(DOCX_SOURCE_CORRECTIONS).slice(-200).reverse() });
  if (url.pathname === "/api/poll-telemetry") return json(res, 200, pollTelemetry());
  if (url.pathname === "/api/image-load-telemetry") return imageLoadTelemetryRoute(req, res);
  if (url.pathname === "/api/mapping-audit") return json(res, 200, mappingAuditPayload(url));
  if (url.pathname === "/api/dashboard-validation") return json(res, 200, dashboardValidationPayload(url));
  if (url.pathname === "/api/software-validation/feedback" || url.pathname === "/api/dashboard-validation/feedback") return saveSoftwareValidationFeedback(req, res);
  if (url.pathname === "/api/stats") return json(res, 200, stats());
  if (url.pathname === "/api/activity") return json(res, 200, { updated_at: new Date().toISOString(), ...activityFeed() });
  if (url.pathname === "/api/validation") return json(res, 200, validationPayload());
  if (url.pathname === "/api/validation/start") return startValidation(req, res);
  if (url.pathname === "/api/validation/save") return saveValidationNote(req, res);
  if (url.pathname === "/api/regression/record") return recordRegressionCase(req, res);
  if (url.pathname === "/api/regression") return json(res, 200, { updated_at: new Date().toISOString(), cases: regressionCases() });
  if (url.pathname === "/api/regression/solutions") return json(res, 200, regressionSolutions());
  if (url.pathname === "/api/regression/solutions/feedback") return saveSolutionFeedback(req, res);
  if (url.pathname === "/api/regression/rechecks") return json(res, 200, { updated_at: new Date().toISOString(), ...regressionRechecks() });
  if (url.pathname === "/api/regression/recheck/start") return startRegressionRecheck(req, res, url);
  if (url.pathname === "/api/feedback/status") return json(res, 200, feedbackStatus());
  if (url.pathname === "/api/structures") return json(res, 200, { structures: listStructures() });
  if (url.pathname === "/api/image-neighborhood") return imageNeighborhood(req, res, url);
  if (url.pathname === "/api/start") return startRun(req, res, url);
  if (url.pathname === "/api/stop") return stopRun(req, res, url);
  if (url.pathname === "/api/feedback") return feedback(req, res);
  if (url.pathname === "/api/state") {
    const id = runIdFromUrl(url);
    const dir = runDir(id);
    if (!dir) return json(res, 404, { error: "no current run" });
    return json(res, 200, readState(id));
  }
  if (url.pathname === "/api/events") {
    const id = runIdFromUrl(url);
    const dir = runDir(id);
    if (!dir) return json(res, 404, { error: "no current run" });
    const since = Number(url.searchParams.get("since") || "0");
    const file = path.join(dir, "events.jsonl");
    let events = [];
    if (fs.existsSync(file)) {
      events = fs.readFileSync(file, "utf8")
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .filter((event) => Number(event.seq || 0) > since);
    }
    return json(res, 200, { run_id: id, events });
  }
  if (url.pathname.startsWith("/api/artifact/")) {
    const [, , , runId, ...rest] = url.pathname.split("/");
    const dir = runDir(runId);
    const file = dir ? path.join(dir, rest.join("/")) : null;
    if (!file || !file.startsWith(dir) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), mime[path.extname(file)] || "application/octet-stream");
  }
  if (url.pathname.startsWith("/api/thumb/artifact/")) {
    const [, , , , runId, ...rest] = url.pathname.split("/");
    const dir = runDir(runId);
    const file = dir ? path.join(dir, rest.join("/")) : null;
    if (!file || !file.startsWith(dir) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return sendThumb(res, file, url.searchParams.get("size") || 720);
  }
  if (url.pathname.startsWith("/api/thumb/site/")) {
    const [, , , , folder, ...rest] = url.pathname.split("/");
    const dir = path.resolve(SITE_ROOT, decodeURIComponent(folder || ""));
    const file = path.resolve(dir, decodeURIComponent(rest.join("/") || ""));
    if (!file.startsWith(path.resolve(SITE_ROOT)) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return sendThumb(res, file, url.searchParams.get("size") || 420);
  }
  if (url.pathname.startsWith("/api/site-image/")) {
    const [, , , folder, ...rest] = url.pathname.split("/");
    const dir = path.resolve(SITE_ROOT, decodeURIComponent(folder || ""));
    const file = path.resolve(dir, decodeURIComponent(rest.join("/") || ""));
    if (!file.startsWith(path.resolve(SITE_ROOT)) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), mime[path.extname(file).toLowerCase()] || "application/octet-stream");
  }
  return json(res, 404, { error: "unknown api route" });
}

function staticFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(PUBLIC, requested);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "not found", "text/plain; charset=utf-8");
  }
  send(res, 200, fs.readFileSync(file), mime[path.extname(file)] || "application/octet-stream");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const started = Date.now();
    activeApiRequests += 1;
    res.on("finish", () => {
      activeApiRequests = Math.max(0, activeApiRequests - 1);
      recordApiPoll(url.pathname, req.method || "GET", res.statusCode || 0, Date.now() - started);
    });
    return api(req, res, url).catch((error) => json(res, 500, { error: String(error.message || error) }));
  }
  return staticFile(req, res, url);
});

const port = Number(process.env.PORT || 4873);
server.listen(port, "127.0.0.1", () => {
  console.log(`subagent dashboard http://127.0.0.1:${port}`);
});
