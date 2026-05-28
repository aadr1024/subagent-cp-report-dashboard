const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const RUNS = path.join(ROOT, "runs");
const CURRENT = path.join(RUNS, "current-run.txt");
const GLOBAL_FEEDBACK = path.join(RUNS, "global-feedback.jsonl");
const THUMBS = path.join(RUNS, ".thumbs");
const VALIDATIONS = path.join(RUNS, "validations");
const VALIDATION_REVIEW_METADATA = path.join(RUNS, "validation-review-metadata.jsonl");
const FEEDBACK_PROCESSING = path.join(RUNS, "feedback-processing.jsonl");
const REGRESSION_CASES = path.join(RUNS, "regression-cases.jsonl");
const REGRESSION_RECHECKS = path.join(RUNS, "regression-rechecks");
const SBA_SRC = "/Users/aadityarajesh/Downloads/MT/us-mike-carose-soil-data-2026/J260106 - SBA (anchor inspections Y-2026) -- in process/src";
const SITE_ROOT = "/Users/aadityarajesh/Downloads/MT/j260101 local/site-photos";

fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });
fs.mkdirSync(VALIDATIONS, { recursive: true });
fs.mkdirSync(REGRESSION_RECHECKS, { recursive: true });

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

function startRegressionRecheck(req, res) {
  const python = process.env.PYTHON || "python3";
  const recheckId = `${stamp()}-regression-recheck`;
  const dir = path.join(REGRESSION_RECHECKS, recheckId);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  env.PYTHONPATH = SBA_SRC + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : "");
  const child = spawn(python, [path.join(ROOT, "regression_recheck.py"), "--recheck-id", recheckId], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = path.join(REGRESSION_RECHECKS, "recheck-spawn.log");
  fs.appendFileSync(log, `\n[start] pid=${child.pid} recheck=${recheckId} at=${new Date().toISOString()}\n`);
  child.stdout.on("data", (chunk) => fs.appendFileSync(log, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(log, chunk));
  fs.writeFileSync(path.join(dir, "server-control.json"), JSON.stringify({ pid: child.pid, recheck_id: recheckId, started_at: new Date().toISOString() }, null, 2) + "\n");
  child.on("exit", (code, signal) => {
    fs.appendFileSync(log, `[exit] pid=${child.pid} code=${code} signal=${signal}\n`);
  });
  json(res, 202, { ok: true, recheck_id: recheckId, pid: child.pid });
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
    events: events
      .sort((a, b) => (Date.parse(b.at || "") || 0) - (Date.parse(a.at || "") || 0) || Number(b.seq || 0) - Number(a.seq || 0))
      .slice(0, 80),
  };
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
  if (url.pathname === "/api/stats") return json(res, 200, stats());
  if (url.pathname === "/api/activity") return json(res, 200, { updated_at: new Date().toISOString(), ...activityFeed() });
  if (url.pathname === "/api/validation") return json(res, 200, validationPayload());
  if (url.pathname === "/api/validation/start") return startValidation(req, res);
  if (url.pathname === "/api/validation/save") return saveValidationNote(req, res);
  if (url.pathname === "/api/regression/record") return recordRegressionCase(req, res);
  if (url.pathname === "/api/regression") return json(res, 200, { updated_at: new Date().toISOString(), cases: regressionCases() });
  if (url.pathname === "/api/regression/rechecks") return json(res, 200, { updated_at: new Date().toISOString(), ...regressionRechecks() });
  if (url.pathname === "/api/regression/recheck/start") return startRegressionRecheck(req, res);
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
