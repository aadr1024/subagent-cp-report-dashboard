const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const REPORT_SOURCE_OF_TRUTH = path.join(ROOT, "report-source-of-truth.json");
const RUNS = path.join(ROOT, "runs");
const CURRENT = path.join(RUNS, "current-run.txt");
const GLOBAL_FEEDBACK = path.join(RUNS, "global-feedback.jsonl");
const THUMBS = path.join(RUNS, ".thumbs");
const VALIDATIONS = path.join(RUNS, "validations");
const VALIDATION_REVIEW_METADATA = path.join(RUNS, "validation-review-metadata.jsonl");
const FEEDBACK_PROCESSING = path.join(RUNS, "feedback-processing.jsonl");
const REGRESSION_CASES = path.join(RUNS, "regression-cases.jsonl");
const SOLUTION_FEEDBACK = path.join(RUNS, "solution-feedback.jsonl");
const REGRESSION_RECHECKS = path.join(RUNS, "regression-rechecks");
const CORRECTION_PROMOTIONS = path.join(RUNS, "correction-promotions.jsonl");
const CLOSED_LOOP_LEDGER = path.join(RUNS, "closed-loop-clean.jsonl");
const CLOSED_LOOP_STATUS = path.join(RUNS, "closed-loop-status.json");
const FEEDBACK_CORRECTION_STATUS = path.join(RUNS, "feedback-correction-status.json");
const DOCX_REVIEW_SCRIPT = path.join(ROOT, "docx_review.py");
const DASHBOARD_VALIDATION_SCRIPT = path.join(ROOT, "dashboard_validation.py");
const SBA_SRC = "/Users/aadityarajesh/Downloads/MT/us-mike-carose-soil-data-2026/J260106 - SBA (anchor inspections Y-2026) -- in process/src";
const SITE_ROOT = "/Users/aadityarajesh/Downloads/MT/j260101 local/site-photos";
const SOLUTION_DEFINITIONS = {
  "potential-minus-sign-discipline": {
    title: "Potential sign discipline",
    problem: "Potential readings can lose a faint LCD minus sign or get treated as positive when nearby CP readings are normally negative.",
    solution: "Extraction leaves must preserve visible minus signs, bias Table 3/Table 6 potentials negative when the local evidence supports it, and surface truly positive/no-minus readings as polarity anomalies instead of silently forcing them.",
    detection_rule: "Applies to Table 3/Table 6, V DC, minus/negative/positive/polarity notes, and sign-mixed potential evidence.",
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

let docxReviewCache = { key: "", at: 0, payload: null };

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

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
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
  const data = readJsonFile(REPORT_SOURCE_OF_TRUTH, {});
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
  const docxMtime = source.active_exists ? fs.statSync(source.active_docx).mtimeMs : 0;
  const inputMtime = docxReviewInputMtime();
  const key = `${docxMtime}:${inputMtime}`;
  if (docxReviewCache.payload && docxReviewCache.key === key && Date.now() - docxReviewCache.at < 2500) {
    return { ...docxReviewCache.payload, cached: true };
  }
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
  docxReviewCache = { key, at: Date.now(), payload };
  return { ...payload, cached: false };
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
      summary: {},
      cases: [],
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
  send(res, 200, fs.readFileSync(thumb), "image/jpeg");
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
  const start = Math.max(0, Math.min(files.length, index - Math.floor(limit / 2)));
  const selected = files.slice(start, start + limit);
  return json(res, 200, {
    folder,
    image,
    index,
    total: files.length,
    images: selected.map((name) => ({
      name,
      href: `/api/thumb/site/${encodeURIComponent(folder)}/${encodeURIComponent(name)}?size=420`,
      current: name === image,
    })),
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
  if (url.pathname === "/api/report/open-final") return openFinalReport(res);
  if (url.pathname === "/api/docx-review") return json(res, 200, docxReviewPayload());
  if (url.pathname === "/api/dashboard-validation") return json(res, 200, dashboardValidationPayload(url));
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
  if (url.pathname.startsWith("/api/")) return api(req, res, url).catch((error) => json(res, 500, { error: String(error.message || error) }));
  return staticFile(req, res, url);
});

const port = Number(process.env.PORT || 4873);
server.listen(port, "127.0.0.1", () => {
  console.log(`subagent dashboard http://127.0.0.1:${port}`);
});
