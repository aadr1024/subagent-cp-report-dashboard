const selectedStructures = new Set();
const selectedRunIds = new Set();
const lastSeqByRun = new Map();
const eventsByRun = new Map();
const stateEventsByRun = new Map();
let knownRuns = [];
let knownStructures = [];
let openLimit = 4;
let focusedRunId = null;
let deferRenderUntil = 0;
let pendingStates = null;
const manualOpenRunIds = new Set();
let lastRailIndex = null;
let latestStats = null;
let feedbackConsoleCollapsed = false;
let scrollablePanelQuietUntil = 0;
let pendingRailRender = false;
let pendingLauncherRender = false;
let pendingStatsRender = null;
let pendingValidationRender = null;
let pendingDocxReviewRender = null;
let pendingDashboardValidationRender = null;
let pendingFeedbackRender = null;
let pendingSolutionRender = null;
let pendingRegressionRender = null;
let activityEvents = [];
let activityRuns = [];
let activityConcurrency = null;
let activityUpdatedAt = null;
let latestValidation = null;
let latestDocxReview = null;
let latestDashboardValidation = null;
let activeSoftwareValidationCase = "";
const docxOpenStructures = new Set();
const softwareValidationDrafts = new Map();
const docxReviewDrafts = new Map();
let docxReviewFilter = "";
let lastSolutionRenderKey = "";
let activeFloatingPreview = null;
let floatingPreviewHideTimer = null;
let latestFeedbackStatus = null;
let latestRegressionCases = [];
let latestRegressionSolutions = [];
let latestSolutionReplay = null;
let optimisticCaseReplay = null;
let reportSourceTruth = null;
let anomalyFloatingPreview = null;
const anomalyNoteDrafts = new Map();
let validationEditLockUntil = 0;

function loadFeedbackConsole() {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return JSON.parse(localStorage.getItem("subagentFeedbackConsole") || "[]")
      .filter((item) => Date.parse(item.at || "") > cutoff)
      .slice(-150);
  } catch {
    return [];
  }
}

let feedbackConsoleItems = loadFeedbackConsole();

const $ = (id) => document.getElementById(id);

function cls(status) {
  return status || "pending";
}

function fmtTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function renderState(state) {
  renderRunBoards([state]);
}

function statusDot(status) {
  return `<span class="dot ${cls(status)}"></span>`;
}

function renderSteps(steps) {
  const order = ["discover_site", "load_annotations", "target_section", "run_leaves", "apply_docx", "fatal"];
  const keys = [...order.filter((key) => steps[key]), ...Object.keys(steps).filter((key) => !order.includes(key))];
  $("steps").innerHTML = keys.length
    ? keys.map((key) => {
        const step = steps[key];
        return `<div class="step">
          <div class="step-title">${statusDot(step.status)}<span>${key.replaceAll("_", " ")}</span></div>
          <div class="message">${escapeHtml(step.message || "")}</div>
        </div>`;
      }).join("")
    : `<div class="message">No pipeline state yet.</div>`;
}

function artifactHref(runId, artifactPath) {
  return `/api/artifact/${encodeURIComponent(runId)}/${String(artifactPath).split("/").map(encodeURIComponent).join("/")}`;
}

function artifactThumbHref(runId, artifactPath, size = 720) {
  return `/api/thumb/artifact/${encodeURIComponent(runId)}/${String(artifactPath).split("/").map(encodeURIComponent).join("/")}?size=${encodeURIComponent(size)}`;
}

function folderNameForState(state) {
  const source = state?.target?.source_folder || "";
  return source.split("/").filter(Boolean).at(-1) || "";
}

function readingLabel(reading) {
  if (!reading) return "";
  const value = reading.visible_value ?? reading.value ?? "";
  const unit = reading.unit_seen ? ` ${reading.unit_seen}` : "";
  const source = reading.source_image ? ` · ${reading.source_image}` : "";
  const confidence = reading.confidence !== undefined ? ` · c=${reading.confidence}` : "";
  const prefix = reading.mg || reading.test_station || reading.row_name || `#${reading.sequence_index || ""}`;
  return `${prefix}: ${value}${unit}${source}${confidence}`;
}

function imageForReading(reading, images) {
  if (!reading || !images.length) return null;
  return images.find((image) => image.source_image === reading.source_image)
    || images.find((image) => String(image.sequence_index) === String(reading.sequence_index))
    || images[0];
}

function confidenceText(value) {
  if (value === undefined || value === null || value === "") return "conf --";
  const n = Number(value);
  if (Number.isFinite(n) && n <= 1) return `conf ${Math.round(n * 100)}%`;
  return `conf ${value}`;
}

function tagClassForReading(reading) {
  const label = `${reading?.annotation_label || ""} ${reading?.row_name || ""}`.toLowerCase();
  if (label.includes("table 3")) return "tag-value table3";
  if (label.includes("table 4")) return "tag-value table4";
  if (label.includes("table 5")) return "tag-value table5";
  if (label.includes("table 6")) return "tag-value table6";
  return "tag-value";
}

function editableText(value, runId, agent, reading, field) {
  return `<span class="editable-label" contenteditable="true" spellcheck="false"
    data-run-id="${escapeHtml(runId)}"
    data-agent="${escapeHtml(agent)}"
    data-field="${escapeHtml(field)}"
    data-previous="${escapeHtml(value || "")}"
    data-reading="${escapeHtml(JSON.stringify(reading || {}))}">${escapeHtml(value || "add label")}</span>`;
}

function evidenceGroupForReading(reading, images, readings, agent) {
  const station = reading.station || reading.test_station || "";
  let sourceNames = [];
  if (station) {
    sourceNames = readings
      .filter((item) => (item.station || item.test_station || "") === station)
      .map((item) => item.source_image)
      .filter(Boolean);
  }
  if (!sourceNames.length && String(agent || "").startsWith("table3-")) {
    sourceNames = images.map((image) => image.source_image).filter(Boolean);
  }
  if (!sourceNames.length && reading.annotation_label) {
    sourceNames = readings
      .filter((item) => item.annotation_label === reading.annotation_label)
      .map((item) => item.source_image)
      .filter(Boolean);
  }
  if (!sourceNames.length) sourceNames = images.map((image) => image.source_image).filter(Boolean);
  const set = new Set(sourceNames);
  return images.filter((image) => set.has(image.source_image));
}

function renderReadingChip(reading, images, runId, agent, folderName, readings, contextGroups = []) {
  const image = imageForReading(reading, images);
  const img = image ? artifactThumbHref(runId, image.artifact, 900) : "";
  const groupImages = evidenceGroupForReading(reading, images, readings, agent);
  const groupSources = groupImages.map((item) => item.source_image);
  const groupSet = new Set(groupSources);
  const hoverGroups = contextGroups.map((group) => ({
    title: group.title,
    sources: group.sources,
    agent: group.agent,
    current: (group.sources || []).some((source) => groupSet.has(source)),
  })).filter((group) => group.title && Array.isArray(group.sources) && group.sources.length);
  const neighborhood = folderName && reading.source_image
    ? `/api/image-neighborhood?folder=${encodeURIComponent(folderName)}&image=${encodeURIComponent(reading.source_image)}&limit=21`
    : "";
  const value = reading.visible_value ?? reading.value ?? "";
  const unit = reading.unit_seen || "";
  const label = reading.annotation_label || reading.row_name || reading.mg || reading.test_station || `reading ${reading.sequence_index || ""}`;
  return `<div class="reading-chip ${tagClassForReading(reading)}" tabindex="0"
    data-run-id="${escapeHtml(runId)}"
    data-agent="${escapeHtml(agent)}"
    data-field="value_feedback"
    data-label="${escapeHtml(label)}"
    data-previous="${escapeHtml(String(value))}"
    data-reading="${escapeHtml(JSON.stringify(reading || {}))}">
    <div class="reading-main">
      <strong class="reading-value">${escapeHtml(value)}</strong>
      ${unit ? `<span class="data-tag unit">${escapeHtml(unit)}</span>` : ""}
      ${reading.source_image ? `<span class="data-tag source">${escapeHtml(reading.source_image)}</span>` : ""}
      <span class="data-tag confidence">${escapeHtml(confidenceText(reading.confidence))}</span>
    </div>
    <div class="reading-label-row">${editableText(label, runId, agent, reading, "label")}</div>
    ${img ? `<div class="hover-preview" data-neighborhood="${escapeHtml(neighborhood)}" data-group-sources="${escapeHtml(JSON.stringify(groupSources))}">
      <div class="hover-current">
        <img data-src="${img}" alt="${escapeHtml(reading.source_image || label)}" decoding="async" fetchpriority="low" />
        <div>${escapeHtml(label)}</div>
      </div>
      <div class="neighbor-strip" data-context-groups="${escapeHtml(JSON.stringify(hoverGroups))}">
        <div class="neighbor-loading">hover: loading before/current/after images</div>
      </div>
    </div>` : ""}
  </div>`;
}

function tableDisplayName(agentKey) {
  if (agentKey === "table4-stations") return "Table 4";
  if (agentKey === "table5-currents") return "Table 5";
  if (agentKey === "table6-potentials") return "Table 6";
  if (String(agentKey).startsWith("table3-")) {
    const direction = String(agentKey).replace("table3-", "");
    return `Table 3 ${direction.slice(0, 1).toUpperCase()}${direction.slice(1)}`;
  }
  return agentKey;
}

function normalizedStationLabel(value, fallbackWord = "Station", allowRaw = true) {
  const text = String(value || "").trim();
  if (!text) return "";
  let match = text.match(/(?:test\s*)?station\s*#?\s*(\d+)/i) || text.match(/\bts\s*#?\s*(\d+)/i);
  if (match) return `${fallbackWord} ${match[1]}`;
  match = text.match(/\b(?:anode|mg)\s*#?\s*(\d+)/i);
  if (match) return `Anode ${match[1]}`;
  match = text.match(/^#?\s*(\d+)$/);
  if (match) return `${fallbackWord} ${match[1]}`;
  if (!allowRaw) return "";
  return text.replaceAll("_", " ").replace(/\s+/g, " ");
}

function stationLabelForReading(reading, agentKey) {
  const fallbackWord = agentKey === "table4-stations" ? "Station" : "Anode";
  for (const candidate of [reading.station, reading.test_station, reading.mg]) {
    const label = normalizedStationLabel(candidate, fallbackWord, true);
    if (label && !/^table\s+\d+$/i.test(label)) return label;
  }
  for (const candidate of [reading.annotation_label, reading.row_name]) {
    const label = normalizedStationLabel(candidate, fallbackWord, false);
    if (label && !/^table\s+\d+$/i.test(label)) return label;
  }
  return "";
}

function sourceOrder(reading, index) {
  const explicit = Number(reading.sequence_index);
  if (Number.isFinite(explicit)) return explicit;
  const numbers = String(reading.source_image || "").match(/\d+/g);
  if (numbers?.length) return Number(numbers[numbers.length - 1]);
  return index;
}

function imageProximityGroups(readings, agentKey) {
  const ordered = readings
    .map((reading, index) => ({ reading, index, order: sourceOrder(reading, index) }))
    .sort((a, b) => a.order - b.order || a.index - b.index);
  if (ordered.length < 4) return [{ title: "", readings }];
  const gaps = [];
  for (let index = 1; index < ordered.length; index += 1) {
    gaps.push({ index, gap: ordered[index].order - ordered[index - 1].order });
  }
  const largest = gaps.sort((a, b) => b.gap - a.gap)[0];
  if (!largest || largest.gap < 3) return [{ title: "", readings }];
  const table = tableDisplayName(agentKey);
  return [
    { title: `${table} · local group 1`, readings: ordered.slice(0, largest.index).map((item) => item.reading) },
    { title: `${table} · local group 2`, readings: ordered.slice(largest.index).map((item) => item.reading) },
  ].filter((group) => group.readings.length);
}

function displayGroupsForReadings(agentKey, readings) {
  if (!["table4-stations", "table5-currents", "table6-potentials"].includes(agentKey)) {
    return [{ title: "", readings }];
  }
  const table = tableDisplayName(agentKey);
  const groups = new Map();
  let labeled = 0;
  for (const reading of readings) {
    const station = stationLabelForReading(reading, agentKey);
    if (station) labeled += 1;
    const key = station || "__unlabeled__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(reading);
  }
  if (labeled >= Math.max(1, Math.ceil(readings.length / 2))) {
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([station, items]) => ({
        title: station === "__unlabeled__" ? `${table} · unlabeled local group` : `${table} · ${station}`,
        readings: items,
      }));
  }
  return imageProximityGroups(readings, agentKey);
}

function renderReadingGroups(agentKey, readings, images, runId, folderName, contextGroups = []) {
  const groups = displayGroupsForReadings(agentKey, readings);
  if (groups.length === 1 && !groups[0].title) {
    return readings.map((reading) => renderReadingChip(reading, images, runId, agentKey, folderName, readings, contextGroups)).join("");
  }
  return groups.map((group) => `<section class="reading-group">
    <div class="reading-group-head">
      <strong>${escapeHtml(group.title)}</strong>
      <small>${group.readings.length} value${group.readings.length === 1 ? "" : "s"}</small>
    </div>
    <div class="reading-group-values">${group.readings.map((reading) => renderReadingChip(reading, images, runId, agentKey, folderName, readings, contextGroups)).join("")}</div>
  </section>`).join("");
}

function readingKind(agentKey, readings) {
  if (agentKey === "table5-currents") return "current";
  if (agentKey === "table6-potentials") return "potential";
  if (agentKey === "table4-stations") {
    const names = [...new Set(readings.map((reading) => reading.row_name || reading.annotation_label || reading.row || "").filter(Boolean).map((value) => String(value).replace(/^table\s*4\s*/i, "").replace(/[_-]+/g, " ").trim()).filter(Boolean))];
    const compact = names.filter((name) => !/^table\s*4$/i.test(name)).slice(0, 2);
    return compact.length ? compact.join(" + ") : "current + shunt";
  }
  if (String(agentKey).startsWith("table3-")) return agentKey.replace("table3-", "table 3 ");
  return "";
}

function hoverTitleForGroup(agentKey, group) {
  const base = group.title || tableDisplayName(agentKey);
  const kind = readingKind(agentKey, group.readings || []);
  return kind && !base.toLowerCase().includes(kind.toLowerCase()) ? `${base} · ${kind}` : base;
}

function hoverContextGroupsForAgents(agents) {
  const groups = [];
  for (const [agentKey, agent] of Object.entries(agents || {})) {
    const readings = Array.isArray(agent.readings) ? agent.readings : [];
    if (!readings.length) continue;
    for (const group of displayGroupsForReadings(agentKey, readings)) {
      const sources = [...new Set((group.readings || []).map((reading) => reading.source_image).filter(Boolean))];
      if (!sources.length) continue;
      groups.push({
        agent: agentKey,
        title: hoverTitleForGroup(agentKey, group),
        sources,
      });
    }
  }
  return groups;
}

function renderLeaf(agentKey, agent, runId, folderName, contextGroups = []) {
  const readings = Array.isArray(agent.readings) ? agent.readings : [];
  const images = Array.isArray(agent.image_refs) ? agent.image_refs : [];
  const unresolved = Array.isArray(agent.unresolved) ? agent.unresolved : [];
  const values = readings.length
    ? renderReadingGroups(agentKey, readings, images, runId, folderName, contextGroups)
    : `<div class="message">Values pending. Source packet visible below when prepared.</div>`;
  const feedback = Array.isArray(agent.feedback) ? agent.feedback : [];
  const prompt = agent.prompt_summary ? `<div class="prompt-box">${escapeHtml(agent.prompt_summary)}</div>` : "";
  const feedbackHtml = feedback.length
    ? `<div class="feedback-stack">${feedback.slice(-4).map((item) => `<div class="feedback-pill">
        <strong>${escapeHtml(item.field || "feedback")}</strong>
        <span>${escapeHtml(item.value || "")}</span>
      </div>`).join("")}</div>`
    : "";
  const thumbs = images.length
    ? images.map((image) => `<figure class="thumb">
        <img src="${artifactThumbHref(runId, image.artifact, 360)}" alt="${escapeHtml(image.source_image || "")}" loading="lazy" decoding="async" fetchpriority="low" />
        <figcaption>${escapeHtml(image.source_image || "")}<br>${escapeHtml(image.annotation_label || "")}</figcaption>
      </figure>`).join("")
    : `<div class="message">No source images attached yet.</div>`;
  return `<article class="agent leaf-card ${cls(agent.status)}">
    <div class="agent-title">${statusDot(agent.status)}<span>${escapeHtml(agentKey)}</span></div>
    <div class="message">${escapeHtml(agent.message || "")}</div>
    <div class="agent-meta">
      <span>status: ${escapeHtml(agent.status || "pending")}</span>
      <span>images: ${agent.image_count ?? images.length}</span>
      ${agent.elapsed_seconds ? `<span>${agent.elapsed_seconds}s</span>` : ""}
    </div>
    ${prompt}
    <div class="derived-values">${values}</div>
    ${feedbackHtml}
    ${unresolved.length ? `<div class="warning-line">${escapeHtml(unresolved.join(" | "))}</div>` : ""}
    <div class="evidence-strip">${thumbs}</div>
  </article>`;
}

function renderAgents(agents, runId, folderName) {
  const parentOrder = ["run-orchestrator", "target-mapper", "annotation-loader", "image-router", "human-feedback", "docx-writer"];
  const keys = [
    ...parentOrder.filter((key) => agents[key]),
    ...Object.keys(agents).filter((key) => !parentOrder.includes(key)).sort(),
  ];
  const contextGroups = hoverContextGroupsForAgents(agents);
  return keys.length
    ? keys.map((key) => renderLeaf(key, agents[key], runId, folderName, contextGroups)).join("")
    : `<div class="message">Parent agents will appear as soon as the run state is created.</div>`;
}

function synthesizeParentAgents(agents, steps) {
  const out = { ...(agents || {}) };
  const mappings = [
    ["target-mapper", "discover_site", "Map STR number to source folder ordinal and DOCX table block."],
    ["annotation-loader", "load_annotations", "Load human annotations, or invoke the OpenAI image-router fallback."],
    ["image-router", "image_router", "Parent planner: classify unannotated folder images into Table 3/4/5/6 evidence groups."],
    ["docx-writer", "apply_docx", "Parent writer: translate leaf outputs into cell patch and shared final DOCX."],
  ];
  if (!out["run-orchestrator"] && Object.keys(steps || {}).length) {
    out["run-orchestrator"] = {
      name: "run-orchestrator",
      status: Object.values(steps).some((step) => step.status === "failed") ? "failed" : "running",
      message: "Parent agent coordinating the run",
      prompt_summary: "Coordinate target mapping, evidence routing, leaf extraction, and shared DOCX write.",
    };
  }
  for (const [agent, step, prompt] of mappings) {
    if (!out[agent] && steps?.[step]) {
      out[agent] = {
        name: agent,
        status: steps[step].status,
        message: steps[step].message,
        prompt_summary: prompt,
      };
    }
  }
  return out;
}

function renderApi(calls) {
  return calls.length
    ? calls.slice(-8).reverse().map((call) => `<div class="api">
        <strong>${escapeHtml(call.agent || "api")} · ${escapeHtml(call.status || "")}</strong>
        <span>${fmtTime(call.at)} · ${escapeHtml(call.message || "")}</span>
        ${call.response_id ? `<div class="message">response: ${escapeHtml(call.response_id)}</div>` : ""}
      </div>`).join("")
    : `<div class="message">No API calls yet.</div>`;
}

function renderArtifactsPanel(runId, artifacts) {
  $("artifacts").innerHTML = artifacts.length
    ? artifacts.slice().reverse().map((artifact) => {
        const href = artifactHref(runId, artifact.path);
        return `<div class="artifact"><a href="${href}" target="_blank">${escapeHtml(artifact.label)}</a><div class="message">${escapeHtml(artifact.path)}</div></div>`;
      }).join("")
    : `<div class="message">No artifacts yet.</div>`;
}

function renderRunBoards(states) {
  if (document.querySelector(".leaf-card:hover, .reading-chip:hover, .hover-preview:hover, .editable-label:focus")) {
    pendingStates = states;
    return;
  }
  if (Date.now() < deferRenderUntil) {
    pendingStates = states;
    return;
  }
  pendingStates = null;
  const scrollY = window.scrollY;
  const expanded = expandedRunIds(states);
  $("runBoards").innerHTML = states.length
    ? states.map((state) => {
        const target = state.target || {};
        const tables = target.target_tables ? `${target.target_tables.table3}-${target.target_tables.table6}` : "mapping pending";
        const steps = state.steps || {};
        const artifacts = state.artifacts || [];
        const folderName = folderNameForState(state);
        const runEvents = (stateEventsByRun.get(state.run_id) || []).slice(-12).reverse();
        const output = state.output_docx ? `<div class="output-path">DOCX: ${escapeHtml(state.output_docx)}</div>` : "";
        const version = runVersionInfo(state.structure, state.run_id);
        const versionText = version.total ? `run ${version.index}/${version.total} · latest ${version.latest?.run_id || "?"}` : "run 0/0";
        const isLatestRun = version.latest?.run_id === state.run_id;
        const isOpen = expanded.has(state.run_id);
        return `<article class="run-board ${cls(state.status)} ${isOpen ? "expanded" : "folded"}" data-run-id="${escapeHtml(state.run_id)}">
          <header class="run-head focus-run" data-run-id="${escapeHtml(state.run_id)}">
            <div>
              <div class="eyebrow">STR ${escapeHtml(state.structure || "?")} · ${escapeHtml(state.run_id || "")}</div>
              <h2>${escapeHtml(target.heading_to_write || `962L/986L STR ${state.structure || "?"}`)}</h2>
              <div class="message">ordinal ${target.ordinal || "?"} · ${escapeHtml(versionText)}${isLatestRun ? "" : " · viewing older run"} · tables ${tables} · folder ${escapeHtml(folderName || "?")} · updated ${fmtTime(state.updated_at)}</div>
              ${output}
            </div>
            <div class="run-actions">
              <strong class="pill ${cls(state.status)}">${escapeHtml(state.status || "waiting")}</strong>
              <button class="small-btn start-one" data-structure="${escapeHtml(state.structure || "")}">Start again</button>
              ${state.status === "running" ? `<button class="small-btn stop-one" data-run-id="${escapeHtml(state.run_id)}">Stop</button>` : ""}
            </div>
          </header>
          <div class="run-layout">
            <div>
              <div class="mini-title">Leaf nodes</div>
              <div class="agents">${renderAgents(synthesizeParentAgents(state.agents || {}, steps), state.run_id, folderName)}</div>
            </div>
            <aside class="run-side">
              <div class="mini-title">Pipeline</div>
              <div class="steps compact">${renderStepCards(steps)}</div>
              <div class="mini-title">API requests</div>
              <div class="api-list compact">${renderApi(state.api_calls || [])}</div>
              <div class="mini-title">Artifacts</div>
              <div class="artifact-count">${artifacts.length} files</div>
              <div class="mini-title">Live movement</div>
              <div class="movement-log">${renderMovementLog(runEvents, state)}</div>
            </aside>
          </div>
        </article>`;
      }).join("")
    : `<div class="message">Select one or more structures and start runs.</div>`;
  if (Math.abs(window.scrollY - scrollY) > 4) window.scrollTo({ top: scrollY, left: 0, behavior: "instant" });
}

function renderMovementLog(events, state) {
  const latest = events[0];
  const rows = events.length
    ? events.map((event) => `<div class="movement-row ${escapeHtml(event.type || "")}">
        <span>${fmtTime(event.at)}</span>
        <strong>${escapeHtml(event.type || "event")}</strong>
        <em>${escapeHtml(event.message || "")}</em>
      </div>`).join("")
    : `<div class="movement-row"><span>now</span><strong>${escapeHtml(state.status || "waiting")}</strong><em>Waiting for next event...</em></div>`;
  return `${state.status === "running" ? `<div class="heartbeat"><strong>${fmtTime(latest?.at)}</strong><span>${escapeHtml(latest?.message || "waiting for next event")}</span></div>` : ""}${rows}`;
}

function expandedRunIds(states) {
  const manuallyOpen = states.filter((state) => manualOpenRunIds.has(state.run_id)).map((state) => state.run_id);
  if (openLimit === "all") return new Set(manuallyOpen);
  const limit = Number(openLimit) || 4;
  return new Set(manuallyOpen.slice(0, limit));
}

function renderStepCards(steps) {
  const order = ["discover_site", "load_annotations", "load_feedback", "target_section", "run_leaves", "apply_docx", "build_patch", "write_docx", "readback", "package_check", "user_control", "fatal"];
  const keys = [...order.filter((key) => steps[key]), ...Object.keys(steps).filter((key) => !order.includes(key))];
  return keys.length
    ? keys.map((key) => {
        const step = steps[key];
        return `<div class="step">
          <div class="step-title">${statusDot(step.status)}<span>${key.replaceAll("_", " ")}</span></div>
          <div class="message">${escapeHtml(step.message || "")}</div>
        </div>`;
      }).join("")
    : `<div class="message">No pipeline state yet.</div>`;
}

function renderLauncher() {
  const panel = $("reportLauncher");
  if (scrollablePanelBusy() && panel?.innerHTML.trim()) {
    pendingLauncherRender = true;
    return;
  }
  const scrollSnapshot = captureScrollPositions("#reportLauncher");
  const latestByStructure = new Map();
  for (const run of knownRuns) {
    const key = String(run.structure);
    if (!latestByStructure.has(key)) latestByStructure.set(key, run);
  }
  $("reportLauncher").innerHTML = knownStructures.length
    ? `<div class="launcher-table">${knownStructures.map((item) => {
        const latest = latestByStructure.get(String(item.structure));
        const version = runVersionInfo(item.structure, latest?.run_id || "");
        return `<article class="report-card ${cls(latest?.status || "pending")}">
          <div>
            <strong>${String(item.ordinal).padStart(3, "0")} · STR ${escapeHtml(item.structure)}</strong>
            <div class="message">${escapeHtml(item.folder)}</div>
            ${latest ? `<div class="message">latest: ${escapeHtml(latest.run_id)} · ${escapeHtml(latest.status)} · run ${version.index}/${version.total}</div>` : `<div class="message">not run yet · run 0/0</div>`}
          </div>
          <div class="report-actions">
            <button class="small-btn start-one" data-structure="${escapeHtml(item.structure)}">Start</button>
            ${latest ? `<button class="small-btn view-one" data-run-id="${escapeHtml(latest.run_id)}" data-structure="${escapeHtml(item.structure)}">View</button>` : ""}
            ${latest?.status === "running" ? `<button class="small-btn stop-one" data-run-id="${escapeHtml(latest.run_id)}">Stop</button>` : ""}
          </div>
        </article>`;
      }).join("")}</div>`
    : `<div class="message">Loading report list...</div>`;
  restoreScrollPositions(scrollSnapshot);
}

function latestRunMap() {
  const map = new Map();
  for (const run of knownRuns) {
    const key = String(run.structure);
    if (!map.has(key)) map.set(key, run);
  }
  return map;
}

function runVersionInfo(structure, runId = "") {
  const runs = knownRuns
    .filter((run) => String(run.structure) === String(structure))
    .slice()
    .sort((a, b) => (Date.parse(a.updated_at || "") || 0) - (Date.parse(b.updated_at || "") || 0) || String(a.run_id).localeCompare(String(b.run_id)));
  const total = runs.length;
  const index = runId ? runs.findIndex((run) => run.run_id === runId) + 1 : total;
  const latest = runs.at(-1) || null;
  return { total, index: index || total, latest };
}

function captureScrollPositions(selector) {
  return [...document.querySelectorAll(selector)].map((node, index) => ({
    selector,
    index,
    key: node.id || node.dataset.scrollKey || node.getAttribute("aria-label") || "",
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
}

function restoreScrollPositions(snapshot) {
  if (!snapshot.length) return;
  requestAnimationFrame(() => {
    for (const item of snapshot) {
      const node = document.querySelectorAll(item.selector)[item.index];
      if (!node) continue;
      node.scrollTop = item.top;
      node.scrollLeft = item.left;
    }
  });
}

function dashboardScrollSnapshot() {
  return [
    ...captureScrollPositions("#foldRail .rail-list"),
    ...captureScrollPositions("#reportLauncher"),
    ...captureScrollPositions("#statsPanel .health-list"),
    ...captureScrollPositions("#validationPanel .validation-list"),
    ...captureScrollPositions("#validationPanel .validation-event-log"),
    ...captureScrollPositions("#docxReviewPanel .docx-structure-list"),
    ...captureScrollPositions("#docxReviewPanel .docx-cell-grid"),
    ...captureScrollPositions("#dashboardValidationPanel .dashboard-validation-list"),
    ...captureScrollPositions("#feedbackLifecycle .feedback-life-list"),
    ...captureScrollPositions("#solutionSuite .solution-list"),
    ...captureScrollPositions("#regressionLedger .regression-list"),
    ...captureScrollPositions("#events"),
    ...captureScrollPositions("#artifacts"),
  ];
}

function scrollablePanelBusy() {
  return Date.now() < scrollablePanelQuietUntil
    || Date.now() < validationEditLockUntil
    || anomalyNoteDrafts.size > 0
    || Boolean(document.querySelector("#solutionSuite:hover, #solutionSuite:focus-within, #docxReviewPanel:hover, #docxReviewPanel:focus-within, #dashboardValidationPanel:hover, #dashboardValidationPanel:focus-within, #validationPanel:hover, #validationPanel:focus-within"))
    || editingDashboardPanel();
}

function editingDashboardPanel() {
  const active = document.activeElement;
  if (!active) return false;
  if (!active.closest?.("#validationPanel, #docxReviewPanel, #dashboardValidationPanel, #feedbackLifecycle, #regressionLedger, #runBoards")) return false;
  return active.matches("input, textarea, select, [contenteditable='true']");
}

function lockValidationEditing(ms = 30_000) {
  validationEditLockUntil = Math.max(validationEditLockUntil, Date.now() + ms);
  scrollablePanelQuietUntil = Math.max(scrollablePanelQuietUntil, Date.now() + ms);
}

function rememberAnomalyDraft(input) {
  const card = input?.closest?.(".anomaly-card");
  if (!card?.dataset.anomalyId) return;
  if (input.value) anomalyNoteDrafts.set(card.dataset.anomalyId, input.value);
  else anomalyNoteDrafts.delete(card.dataset.anomalyId);
}

function markScrollablePanelBusy(event) {
  const target = event.target.closest("#foldRail .rail-list, #reportLauncher, #statsPanel .health-list, #validationPanel .validation-list, #validationPanel .validation-event-log, #docxReviewPanel .docx-structure-list, #docxReviewPanel .docx-cell-grid, #dashboardValidationPanel .dashboard-validation-list, #feedbackLifecycle .feedback-life-list, #solutionSuite .solution-list, #regressionLedger .regression-list, #events, #artifacts");
  if (!target) return;
  const quietMs = target.closest("#solutionSuite .solution-list, #docxReviewPanel, #dashboardValidationPanel, #validationPanel") ? 6000 : 2600;
  scrollablePanelQuietUntil = Date.now() + quietMs;
}

function renderFoldRail() {
  const rail = $("foldRail");
  if (!rail) return;
  if (scrollablePanelBusy() && rail.querySelector(".rail-list")) {
    pendingRailRender = true;
    return;
  }
  const scrollSnapshot = captureScrollPositions("#foldRail .rail-list");
  const latest = latestRunMap();
  const visible = new Set(visibleRunIds());
  rail.innerHTML = `<div class="rail-head">
      <strong>STR Fold Rail</strong>
      <span>${knownStructures.length} folders</span>
    </div>
    <div class="rail-list">${knownStructures.map((item, index) => {
      const run = latest.get(String(item.structure));
      const open = run && (manualOpenRunIds.has(run.run_id) || visible.has(run.run_id));
      const status = run?.status || "not-running";
      const label = run?.status || "not running";
      return `<button class="rail-item ${cls(run?.status || "pending")} ${open ? "open" : ""}"
        data-index="${index}"
        data-structure="${escapeHtml(item.structure)}"
        data-run-id="${escapeHtml(run?.run_id || "")}">
        <em>${open ? "v" : "^"}</em>
        <span>${String(item.ordinal).padStart(3, "0")}</span>
        <strong>${escapeHtml(item.structure)}</strong>
        <small><mark class="${cls(status)}">${escapeHtml(label)}</mark></small>
      </button>`;
    }).join("")}</div>`;
  restoreScrollPositions(scrollSnapshot);
}

function preserveViewport(work) {
  const y = window.scrollY;
  work();
  requestAnimationFrame(() => window.scrollTo({ top: y, left: 0, behavior: "instant" }));
}

function scrollToRunBoard(runId) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const board = document.querySelector(`.run-board[data-run-id="${CSS.escape(runId)}"]`);
      if (board) {
        board.scrollIntoView({ behavior: "smooth", block: "start" });
        board.classList.remove("arrival-pulse");
        setTimeout(() => board.classList.add("arrival-pulse"), 260);
        setTimeout(() => board.classList.remove("arrival-pulse"), 1500);
      }
    });
  });
}

function railRangeRunIds(fromIndex, toIndex) {
  const latest = latestRunMap();
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return knownStructures.slice(start, end + 1)
    .map((item) => latest.get(String(item.structure))?.run_id)
    .filter(Boolean);
}

function handleRailClick(button, event) {
  const index = Number(button.dataset.index);
  const runId = button.dataset.runId;
  const structure = button.dataset.structure;
  if (!runId) {
    selectedStructures.add(String(structure));
    startOne(structure);
    lastRailIndex = index;
    return;
  }
  let shouldScroll = false;
  preserveViewport(() => {
    if (event.shiftKey && lastRailIndex !== null) {
      const range = railRangeRunIds(lastRailIndex, index);
      const allOpen = range.length && range.every((id) => manualOpenRunIds.has(id));
      if (allOpen) range.forEach((id) => manualOpenRunIds.delete(id));
      else {
        manualOpenRunIds.clear();
        range.forEach((id) => manualOpenRunIds.add(id));
      }
      focusedRunId = runId;
      shouldScroll = true;
    } else if (event.metaKey || event.ctrlKey) {
      if (manualOpenRunIds.has(runId)) manualOpenRunIds.delete(runId);
      else {
        manualOpenRunIds.add(runId);
        shouldScroll = true;
      }
      focusedRunId = runId;
    } else {
      if (manualOpenRunIds.has(runId) && manualOpenRunIds.size === 1) {
        manualOpenRunIds.clear();
        if (focusedRunId === runId) focusedRunId = null;
      } else {
        manualOpenRunIds.clear();
        manualOpenRunIds.add(runId);
        focusedRunId = runId;
        shouldScroll = true;
      }
    }
    selectedRunIds.add(runId);
    prewarmRailNeighbors(index);
    lastRailIndex = index;
    renderFoldRail();
    poll();
  });
  if (shouldScroll) scrollToRunBoard(runId);
}

function prewarmRailNeighbors(index) {
  const latest = latestRunMap();
  knownStructures.slice(Math.max(0, index - 5), index + 6).forEach((item) => {
    const run = latest.get(String(item.structure));
    if (run?.run_id) fetch(`/api/state?run=${encodeURIComponent(run.run_id)}`, { cache: "no-store" }).catch(() => {});
  });
}

function renderEvents() {
  const events = [...eventsByRun.entries()].flatMap(([runId, items]) => items.map((event) => ({ ...event, runId })));
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  $("eventCount").textContent = String(events.length);
  $("events").innerHTML = events.slice(-160).reverse().map((event) => `<div class="event">
    <div><strong>${escapeHtml(event.runId)}</strong> · <strong>${escapeHtml(event.type)}</strong> <span class="event-time">${fmtTime(event.at)}</span></div>
    <div>${escapeHtml(event.message || "")}</div>
  </div>`).join("");
}

function timeAgo(value) {
  const at = Date.parse(value || "");
  if (!at) return "--";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function ensureActivityTicker() {
  let box = $("activityTicker");
  if (!box) {
    box = document.createElement("aside");
    box.id = "activityTicker";
    box.className = "activity-ticker";
    document.body.appendChild(box);
  }
  return box;
}

function renderActivityTicker() {
  const box = ensureActivityTicker();
  const latest = activityEvents[0];
  const active = activityRuns.length;
  const c = activityConcurrency || {};
  const statusText = active ? `${active} active run${active === 1 ? "" : "s"}` : "no active runs";
  const headline = latest
    ? `STR ${latest.structure || "?"} · ${latest.type || "event"} · ${timeAgo(latest.at)}`
    : "waiting for run activity";
  const message = latest?.message || (active ? "active runs detected, waiting for next event" : "no active run movement right now");
  box.innerHTML = `<div class="activity-head">
      <strong>Active run monitor</strong>
      <mark class="${active ? "running" : "pending"}">${escapeHtml(statusText)}</mark>
    </div>
    <div class="activity-current">
      <span>${escapeHtml(headline)}</span>
      <em>${escapeHtml(message)}</em>
    </div>
    <div class="activity-concurrency">
      <span class="activity-tag hot">active ${Number(c.total_active || 0)}</span>
      <span class="activity-tag api">API now ${Number(c.api_calls_active || 0)}</span>
      <span class="activity-tag write">DOCX ${Number(c.docx_writes_active || 0)}</span>
      <span class="activity-tag validate">validation ${Number(c.validations_active || 0)}</span>
      <span class="activity-tag replay">recheck ${Number(c.rechecks_active || 0)}</span>
    </div>
    <div class="activity-run-list">${activityRuns.slice(0, 6).map((run) => `<div class="activity-run">
      <strong>STR ${escapeHtml(run.structure || "?")}</strong>
      <span>${escapeHtml(run.active_step || run.active_agent || "running")} · ${escapeHtml(timeAgo(run.updated_at))}</span>
      <small>${Number(run.api_calls || 0)} api · ${Number(run.artifacts || 0)} files</small>
    </div>`).join("") || `<div class="activity-run muted">No running STRs. Showing newest historical event.</div>`}</div>
    <div class="activity-tail">${activityEvents.slice(0, 8).map((event) => `<div>
      <span>${escapeHtml(fmtTime(event.at))}</span>
      <strong>STR ${escapeHtml(event.structure || "?")}</strong>
      <em>${escapeHtml(event.message || "")}</em>
    </div>`).join("")}</div>
    <small class="activity-updated">sidebar refresh ${escapeHtml(timeAgo(activityUpdatedAt))}</small>`;
}

async function pollActivity() {
  try {
    const res = await fetch("/api/activity", { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    activityEvents = payload.events || [];
    activityRuns = payload.active_runs || [];
    activityConcurrency = payload.concurrency || null;
    activityUpdatedAt = payload.updated_at || new Date().toISOString();
    renderActivityTicker();
  } catch {}
}

function renderValidation(validation) {
  latestValidation = validation;
  const panel = $("validationPanel");
  if (!panel) return;
  if (scrollablePanelBusy() && panel.innerHTML.trim()) {
    pendingValidationRender = validation;
    return;
  }
  const scrollSnapshot = dashboardScrollSnapshot();
  const latest = validation?.latest || null;
  const rows = latest?.anomalies || [];
  $("validationStatus").textContent = latest ? `${latest.status || "unknown"} · ${rows.length} anomalies` : "not started";
  if (!latest) {
    panel.innerHTML = `<div class="message">Run validation agent to scan extracted values for missing counts, sign/magnitude outliers, station pairing issues, and other review-worthy abnormalities.</div>`;
    restoreScrollPositions(scrollSnapshot);
    return;
  }
  const metrics = latest.metrics || {};
  const events = latest.events || [];
  const activeAgent = Object.values(latest.agents || {}).find((agent) => agent.status === "running");
  const latestEvent = events.at(-1);
  panel.innerHTML = `<div class="validation-summary">
    <div class="stat-card"><span>Structures</span><strong>${metrics.structures ?? "--"}</strong><small>latest extracted runs</small></div>
    <div class="stat-card"><span>Readings</span><strong>${metrics.readings ?? "--"}</strong><small>values reviewed</small></div>
    <div class="stat-card"><span>Anomalies</span><strong>${rows.length}</strong><small><mark class="bad">${metrics.high || 0} high</mark> <mark class="hot">${metrics.medium || 0} med</mark> <mark>${metrics.low || 0} low</mark> <mark class="ok">${metrics.suppressed || 0} accepted</mark></small></div>
    <div class="stat-card"><span>Accuracy proxy</span><strong>${metrics.review_accuracy_proxy_percent ?? "--"}%</strong><small>anomaly-density estimate</small></div>
  </div>
  ${latest.summary ? `<div class="validation-note">${escapeHtml(latest.summary)}</div>` : ""}
  <div class="validation-live">
    <div class="validation-live-head">
      <strong>${escapeHtml(activeAgent ? `Active: ${activeAgent.name}` : `Validation ${latest.status || "unknown"}`)}</strong>
      <span>${escapeHtml(activeAgent?.message || latestEvent?.message || "Waiting for validation movement")}</span>
    </div>
    <div class="validation-explain">
      <div><strong>shape-validator</strong><span>checks missing/extra table values, especially Table 3 rows that should usually have five readings.</span></div>
      <div><strong>range-sign-validator</strong><span>checks sign flips and magnitude outliers against same-table peers across STRs.</span></div>
      <div><strong>station-pair-validator</strong><span>checks whether Table 5 current readings and Table 6 potential readings have matching station/anode coverage.</span></div>
      <div><strong>llm-reviewer</strong><span>asks OpenAI to review the extracted dataset as a whole and explain suspicious patterns.</span></div>
    </div>
    <div class="validation-event-log">${events.slice(-18).reverse().map((event) => `<div class="validation-event ${escapeHtml(event.type || "")}">
      <span>${fmtTime(event.at)}</span>
      <strong>${escapeHtml(event.type || "event")}</strong>
      <em>${escapeHtml(event.message || "")}</em>
    </div>`).join("") || `<div class="message">Validation events will appear here live.</div>`}</div>
  </div>
  <div class="validation-agents">${Object.values(latest.agents || {}).map((agent) => `<div class="validation-agent ${cls(agent.status)}">
    ${statusDot(agent.status)}<strong>${escapeHtml(agent.name || "")}</strong><span>${escapeHtml(agent.message || "")}</span>
  </div>`).join("")}</div>
  <div class="validation-list">${rows.length ? rows.map((item) => renderAnomalyCard(latest.validation_id, item, latest.context_groups || [])).join("") : `<div class="message">No anomaly cards yet. If the validation is running, cards will appear when the reviewer finishes.</div>`}</div>`;
  restoreScrollPositions(scrollSnapshot);
}

function renderAnomalyCard(validationId, item, contextGroups = []) {
  const evidence = item.evidence || [];
  const reviewedStatus = item.saved_note?.status || "";
  const reviewedClass = ["good", "reviewed", "saved"].includes(reviewedStatus) ? "reviewed" : "";
  const reviewedLabel = reviewedStatus === "good" ? "looks good" : reviewedStatus === "reviewed" ? "reviewed" : reviewedStatus === "saved" ? "saved" : "";
  const draftNote = anomalyNoteDrafts.has(item.id) ? anomalyNoteDrafts.get(item.id) : item.saved_note?.note || "";
  return `<article class="anomaly-card ${escapeHtml(item.severity || "medium")} ${reviewedClass}" data-anomaly-id="${escapeHtml(item.id || "")}">
    <div class="anomaly-head">
      <div>
        <strong>${escapeHtml(item.title || "Validation anomaly")}</strong>
        <div class="message">${escapeHtml(item.why || "")}</div>
      </div>
      <div class="anomaly-tags">
        ${reviewedLabel ? `<mark class="reviewed">${escapeHtml(reviewedLabel)}</mark>` : ""}
        <mark class="${escapeHtml(item.severity || "medium")}">${escapeHtml(item.severity || "medium")}</mark>
        <mark>${escapeHtml(item.kind || "review")}</mark>
        <mark>conf ${Math.round(Number(item.confidence || 0) * 100)}%</mark>
      </div>
    </div>
    <div class="anomaly-evidence">${evidence.map((evidenceItem) => renderAnomalyEvidence(evidenceItem, evidence, contextGroups)).join("")}</div>
    <div class="anomaly-actions">
      <input class="anomaly-note-input" placeholder="Add reviewer note before saving" value="${escapeHtml(draftNote)}" />
      <button class="small-btn save-anomaly" data-validation-id="${escapeHtml(validationId || "")}" data-anomaly-id="${escapeHtml(item.id || "")}">${item.saved_note ? "Saved review" : "Save review"}</button>
      <button class="small-btn good-anomaly" data-validation-id="${escapeHtml(validationId || "")}" data-anomaly-id="${escapeHtml(item.id || "")}">Looks good</button>
      <small class="anomaly-route">Saved here as validation metadata. It does not edit the DOCX; run-board value feedback is stored separately for future agent prompts.</small>
    </div>
  </article>`;
}

function anomalyContextGroups(evidence) {
  const groups = new Map();
  for (const item of evidence || []) {
    if (!item.source_image) continue;
    const agent = item.agent || "";
    const fallbackWord = agent === "table4-stations" ? "Station" : "Anode";
    const station = normalizedStationLabel(item.station, fallbackWord, true) || normalizedStationLabel(item.row, fallbackWord, false);
    const kind = readingKind(agent, [{
      row: item.row,
      row_name: item.row,
      annotation_label: item.row,
      station: item.station,
      test_station: item.station,
      mg: item.station,
    }]);
    const parts = [tableDisplayName(agent), station, kind].filter(Boolean);
    const title = parts.filter((part, index) => parts.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index).join(" · ");
    const key = `${agent}:${station}:${kind}`;
    if (!groups.has(key)) groups.set(key, { agent, title: title || agent || "evidence group", sources: [] });
    const group = groups.get(key);
    if (!group.sources.includes(item.source_image)) group.sources.push(item.source_image);
  }
  return [...groups.values()];
}

function renderAnomalyEvidence(item, allEvidence = [], validationContextGroups = []) {
  const folder = knownStructures.find((entry) => String(entry.structure) === String(item.structure))?.folder || "";
  const image = item.source_image || "";
  const href = folder && image ? `/api/thumb/site/${encodeURIComponent(folder)}/${encodeURIComponent(image)}?size=760` : "";
  const neighborhood = folder && image
    ? `/api/image-neighborhood?folder=${encodeURIComponent(folder)}&image=${encodeURIComponent(image)}&limit=21`
    : "";
  const mergedGroups = [
    ...validationContextGroups.filter((group) => String(group.structure) === String(item.structure)),
    ...anomalyContextGroups(allEvidence),
  ];
  const seenGroups = new Set();
  const contextGroups = mergedGroups.filter((group) => {
    const key = `${group.agent}:${group.title}:${(group.sources || []).join(",")}`;
    if (seenGroups.has(key)) return false;
    seenGroups.add(key);
    return true;
  }).map((group) => ({
    ...group,
    current: group.sources.includes(image),
  }));
  const previewTitle = `STR ${item.structure || "?"} · ${item.agent || ""} · ${item.value ?? ""}`;
  return `<div class="anomaly-chip ${href ? "has-preview" : "no-preview"}" tabindex="0"
    data-preview-src="${escapeHtml(href)}"
    data-preview-title="${escapeHtml(previewTitle)}"
    data-neighborhood="${escapeHtml(neighborhood)}"
    data-context-groups="${escapeHtml(JSON.stringify(contextGroups))}">
    <strong>STR ${escapeHtml(item.structure || "?")}</strong>
    <span>${escapeHtml(item.agent || "")}</span>
    <mark>${escapeHtml(item.value ?? "")}</mark>
    ${image ? `<small>${escapeHtml(image)}</small>` : ""}
  </div>`;
}

async function pollValidation() {
  try {
    const res = await fetch("/api/validation", { cache: "no-store" });
    if (!res.ok) return;
    renderValidation(await res.json());
  } catch {}
}

function docxStatusClass(status) {
  if (["missing_write", "mismatch", "patch_error", "derived_mismatch", "needs_attention"].includes(status)) return "bad";
  if (["blank", "partial_or_blank"].includes(status)) return "blank";
  if (["matched", "complete"].includes(status)) return "ok";
  if (["docx_only"].includes(status)) return "docx-only";
  return "idle";
}

function docxReviewLine(summary = {}) {
  return `${Number(summary.filled || 0)}/${Number(summary.total || 0)} filled · ${Number(summary.blank || 0)} blank · ${Number(summary.mismatch || 0) + Number(summary.missing_write || 0) + Number(summary.patch_error || 0) + Number(summary.derived_mismatch || 0)} blocking`;
}

function groupDocxSlots(slots = []) {
  const groups = new Map();
  for (const slot of slots) {
    const key = slot.group || slot.table_key || "DOCX";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

function imageLike(value) {
  return /\.(jpe?g|png|heic)$/i.test(String(value || ""));
}

function docxContextGroups(slots = []) {
  const groups = new Map();
  for (const slot of slots) {
    const sources = [slot.source_ref, ...(slot.source_refs || [])].filter(imageLike);
    if (!sources.length) continue;
    const title = slot.group || slot.table_key || "DOCX evidence";
    if (!groups.has(title)) groups.set(title, new Set());
    for (const source of sources) groups.get(title).add(source);
  }
  return [...groups.entries()].map(([title, sources]) => ({ title, sources: [...sources], agent: title }));
}

function docxSlotKey(structure, slot) {
  return slot.feedback_key || [structure, slot.table_key || "", slot.label || "", slot.row_index || "", slot.col_index || ""].join("|");
}

function docxRiskForSlot(slot) {
  const status = slot.status || "blank";
  if (["missing_write", "mismatch", "patch_error", "derived_mismatch"].includes(status)) return "blocking";
  if (["blank", "not_started"].includes(status)) return "low_blank";
  if (status === "docx_only") return "docx_only";
  if (status === "matched") return "matched";
  return "other";
}

function docxRiskSummary(structures = []) {
  const counts = { blocking: 0, low_blank: 0, docx_only: 0, matched: 0, other: 0 };
  for (const item of structures) {
    for (const slot of item.slots || []) counts[docxRiskForSlot(slot)] += 1;
  }
  return counts;
}

function renderDocxRiskControls(structures = []) {
  const counts = docxRiskSummary(structures);
  const rows = [
    ["blocking", "Danger", "write/readback mismatches", "bad"],
    ["low_blank", "Low-risk partial blank", "blank/not-started slots", "blank"],
    ["docx_only", "DOCX-only", "manual/unexpected content", "docx-only"],
    ["matched", "Matched", "expected cells correct", "ok"],
  ];
  return `<div class="docx-risk-controls">
    ${rows.map(([filter, label, hint, clsName]) => `<button class="docx-risk-filter ${escapeHtml(clsName)} ${docxReviewFilter === filter ? "active" : ""}" data-filter="${escapeHtml(filter)}" type="button">
      <span>${escapeHtml(label)}</span>
      <strong>${Number(counts[filter] || 0)}</strong>
      <small>${escapeHtml(hint)}</small>
    </button>`).join("")}
    <button class="docx-risk-filter idle ${docxReviewFilter === "" ? "active" : ""}" data-filter="" type="button">
      <span>All</span><strong>${Object.values(counts).reduce((a, b) => a + b, 0)}</strong><small>clear review list filter</small>
    </button>
  </div>`;
}

function renderDocxCell(slot, structureItem, contextGroups = []) {
  const actual = String(slot.actual || "").trim();
  const expected = String(slot.expected || "").trim();
  const status = slot.status || "blank";
  const structure = String(structureItem?.structure || "");
  const folder = knownStructures.find((entry) => String(entry.structure) === structure)?.folder || "";
  const sources = [slot.source_ref, ...(slot.source_refs || [])].filter(imageLike);
  const image = sources[0] || "";
  const previewHref = folder && image ? `/api/thumb/site/${encodeURIComponent(folder)}/${encodeURIComponent(image)}?size=760` : "";
  const neighborhood = folder && image ? `/api/image-neighborhood?folder=${encodeURIComponent(folder)}&image=${encodeURIComponent(image)}&limit=21` : "";
  const previewTitle = `STR ${structure || "?"} · ${slot.group || slot.table_key || "DOCX"} · ${slot.label || "cell"} · ${actual || "blank"}`;
  const groups = contextGroups.map((group) => ({ ...group, current: (group.sources || []).some((source) => sources.includes(source)) }));
  const slotKey = docxSlotKey(structure, slot);
  const feedback = slot.feedback || [];
  const reviewed = feedback.some((item) => ["good", "reviewed", "ok"].includes(String(item.status || "").toLowerCase()));
  const draft = docxReviewDrafts.has(slotKey) ? docxReviewDrafts.get(slotKey) : "";
  const meta = [
    expected ? `expected ${expected}` : "no extracted value",
    slot.derived_expected ? `derived ${slot.derived_expected}` : "",
    slot.writer_expected ? `writer expected ${slot.writer_expected}` : "",
    slot.source_ref ? `source ${slot.source_ref}` : "",
    slot.confidence !== null && slot.confidence !== undefined ? `conf ${Math.round(Number(slot.confidence) * 100)}%` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="docx-cell ${docxStatusClass(status)} ${previewHref ? "has-preview" : ""} ${reviewed ? "reviewed" : ""}" title="${escapeHtml(meta)}"
    data-slot-key="${escapeHtml(slotKey)}"
    data-structure="${escapeHtml(structure)}"
    data-table-key="${escapeHtml(slot.table_key || "")}"
    data-label="${escapeHtml(slot.label || "")}"
    data-cell-status="${escapeHtml(status)}"
    data-actual="${escapeHtml(actual)}"
    data-expected="${escapeHtml(expected)}"
    data-preview-src="${escapeHtml(previewHref)}"
    data-preview-title="${escapeHtml(previewTitle)}"
    data-neighborhood="${escapeHtml(neighborhood)}"
    data-context-groups="${escapeHtml(JSON.stringify(groups))}">
    <span>${escapeHtml(slot.label || "cell")}</span>
    <strong>${escapeHtml(actual || "blank")}</strong>
    <small>${escapeHtml(status.replaceAll("_", " "))}${expected && actual !== expected ? ` · should be ${escapeHtml(expected)}` : ""}</small>
    <div class="docx-cell-actions">
      <button class="docx-good small-btn" type="button">Good TY</button>
      <button class="docx-toggle-review small-btn" type="button">Review</button>
    </div>
    <div class="docx-cell-feedback">
      <textarea class="docx-review-input" rows="2" placeholder="Review this DOCX cell">${escapeHtml(draft)}</textarea>
      <button class="save-docx-review small-btn" type="button">Save review</button>
    </div>
    ${feedback.length ? `<div class="docx-feedback-history">${feedback.slice().reverse().map((entry) => `<div><b>${escapeHtml(entry.status || "reviewed")}</b><span>${escapeHtml(entry.feedback || "")}</span></div>`).join("")}</div>` : ""}
  </div>`;
}

function renderDocxFilterResults(structures = []) {
  if (!docxReviewFilter) return "";
  const label = {
    blocking: "Danger cells",
    low_blank: "Low-risk partial blank cells",
    docx_only: "DOCX-only cells",
    matched: "Matched cells",
  }[docxReviewFilter] || "Filtered cells";
  const blocks = [];
  for (const item of structures) {
    const slots = (item.slots || []).filter((slot) => docxRiskForSlot(slot) === docxReviewFilter);
    if (!slots.length) continue;
    const contextGroups = docxContextGroups(item.slots || []);
    blocks.push(`<section class="docx-filter-block">
      <div class="docx-table-head"><strong>STR ${escapeHtml(item.structure || "?")} · ${escapeHtml(label)}</strong><span>${slots.length} cell${slots.length === 1 ? "" : "s"}</span></div>
      <div class="docx-cell-grid">${slots.map((slot) => renderDocxCell(slot, item, contextGroups)).join("")}</div>
    </section>`);
  }
  return `<div class="docx-filter-results">
    <div class="docx-filter-head">
      <strong>${escapeHtml(label)}</strong>
      <button class="small-btn docx-clear-filter" type="button">Clear</button>
    </div>
    ${blocks.join("") || `<div class="message">No cells in this review bucket.</div>`}
  </div>`;
}

function renderDocxStructure(item, index) {
  const structure = String(item.structure || "?");
  const summary = item.summary || {};
  const shouldOpen = docxOpenStructures.has(structure) || (!docxOpenStructures.size && index < 1 && item.status !== "complete");
  const groups = groupDocxSlots(item.slots || []);
  const contextGroups = docxContextGroups(item.slots || []);
  return `<details class="docx-structure ${docxStatusClass(item.status)}" data-structure="${escapeHtml(structure)}" ${shouldOpen ? "open" : ""}>
    <summary>
      <div>
        <strong>STR ${escapeHtml(structure)}</strong>
        <span>${escapeHtml(item.source_folder_name || item.run_id || "no source folder")}</span>
      </div>
      <div class="docx-summary-tags">
        <mark class="${docxStatusClass(item.status)}">${escapeHtml((item.status || "unknown").replaceAll("_", " "))}</mark>
        <mark>run ${escapeHtml(item.run_version_label || `${item.run_count || 0}/${item.run_count || 0}`)}</mark>
        <mark>${escapeHtml(docxReviewLine(summary))}</mark>
        ${summary.expected ? `<mark>${Number(summary.expected)} extracted</mark>` : ""}
        ${item.patch_error ? `<mark class="bad">patch issue</mark>` : ""}
      </div>
    </summary>
    ${item.patch_error ? `<div class="docx-warning">${escapeHtml(item.patch_error)}</div>` : ""}
    <div class="docx-table-list">
      ${groups.map((group) => `<section class="docx-table-block">
        <div class="docx-table-head"><strong>${escapeHtml(group.title)}</strong><span>${Number(group.items.filter((slot) => String(slot.actual || "").trim()).length)}/${group.items.length} filled</span></div>
        <div class="docx-cell-grid">${group.items.map((slot) => renderDocxCell(slot, item, contextGroups)).join("")}</div>
      </section>`).join("")}
    </div>
  </details>`;
}

function renderDocxReview(payload) {
  latestDocxReview = payload;
  const panel = $("docxReviewPanel");
  if (!panel) return;
  if (scrollablePanelBusy() && panel.innerHTML.trim()) {
    pendingDocxReviewRender = payload;
    return;
  }
  const status = $("docxReviewStatus");
  const scrollSnapshot = dashboardScrollSnapshot();
  if (!payload || payload.status === "failed") {
    if (status) status.textContent = "DOCX review failed";
    panel.innerHTML = `<div class="message">DOCX review unavailable: ${escapeHtml(payload?.error || "no payload")}</div>`;
    restoreScrollPositions(scrollSnapshot);
    return;
  }
  const summary = payload.summary || {};
  const structures = payload.structures || [];
  if (status) status.textContent = `${docxReviewLine(summary)} · ${Number(payload.structure_count || structures.length)} STRs`;
  panel.innerHTML = `<div class="docx-review-summary">
    <div class="stat-card"><span>Single source</span><strong>${escapeHtml(payload.active_docx_exists ? "active DOCX" : "missing")}</strong><small>${escapeHtml(payload.active_docx_mtime || "no mtime")}</small></div>
    <div class="stat-card"><span>Cells</span><strong>${Number(summary.filled || 0)}/${Number(summary.total || 0)}</strong><small>actual DOCX filled</small></div>
    <div class="stat-card"><span>Blanks</span><strong>${Number(summary.blank || 0)}</strong><small>visible empty slots</small></div>
    <div class="stat-card"><span>Blocking</span><strong>${Number(summary.problem || 0)}</strong><small>missing write / mismatch / patch issue</small></div>
  </div>
  ${renderDocxRiskControls(structures)}
  <div class="validation-note">This panel reads the final DOCX file and compares it against the same cell patches used by the DOCX writer. If Word saves a manual change, the next refresh reflects the saved document state.</div>
  <div class="docx-legend">
    <mark class="ok">matched</mark><mark class="blank">blank</mark><mark class="bad">blocking / derived mismatch</mark><mark class="docx-only">docx-only</mark><mark class="idle">not started</mark>
  </div>
  ${renderDocxFilterResults(structures)}
  <div class="docx-structure-list">${structures.map(renderDocxStructure).join("") || `<div class="message">No DOCX targets known yet.</div>`}</div>`;
  restoreScrollPositions(scrollSnapshot);
}

async function pollDocxReview() {
  try {
    const res = await fetch("/api/docx-review", { cache: "no-store" });
    if (!res.ok) return;
    renderDocxReview(await res.json());
  } catch {}
}

function dashboardValidationClass(status) {
  if (status === "fail") return "bad";
  if (status === "pass") return "ok";
  return "monitor";
}

function renderDashboardValidationCase(item) {
  const statusClass = dashboardValidationClass(item.status);
  const draft = softwareValidationDrafts.has(item.id) ? softwareValidationDrafts.get(item.id) : "";
  const feedback = item.feedback || [];
  const liveLog = item.live_log || [];
  const evidence = item.evidence?.length
    ? `<details><summary>evidence</summary><pre>${escapeHtml(JSON.stringify(item.evidence.slice(0, 3), null, 2))}</pre></details>`
    : "";
  return `<article class="dashboard-validation-case ${statusClass} ${item.active ? "active" : ""}">
    <div class="dashboard-validation-case-head">
      <div>
        <strong>${escapeHtml(item.title || item.id || "validation case")}</strong>
        <span>${escapeHtml(item.id || "")}</span>
      </div>
      <div class="docx-summary-tags">
        <mark class="${statusClass}">${escapeHtml(item.status || "monitor")}</mark>
        <mark>${escapeHtml(item.severity || "medium")}</mark>
        ${item.active ? `<mark class="bad">active</mark>` : ""}
      </div>
    </div>
    <p>${escapeHtml(item.detail || "")}</p>
    <div class="dashboard-validation-actions">
      <button class="small-btn replay-dashboard-case" data-case-id="${escapeHtml(item.id || "")}" type="button">Play / pin live</button>
      <span>${escapeHtml(item.updated_at ? timeAgo(item.updated_at) : "")}</span>
    </div>
    ${(item.status === "fail" || item.active || activeSoftwareValidationCase === item.id) ? `<div class="software-live-log">
      <div class="software-live-head">
        <strong>${escapeHtml(item.active || activeSoftwareValidationCase === item.id ? "Live work log" : "Failure monitor log")}</strong>
        <span>refreshes every 2s</span>
      </div>
      <div class="software-live-rows">${liveLog.length ? liveLog.slice().reverse().map((entry) => `<div class="software-live-row ${escapeHtml(entry.kind || "")}">
        <span>${escapeHtml(fmtTime(entry.at))}</span>
        <strong>${escapeHtml(entry.source || "system")}</strong>
        <mark>${escapeHtml(entry.kind || "event")}</mark>
        <em>${escapeHtml(entry.message || "")}</em>
      </div>`).join("") : `<div class="message">No backend movement attached yet. Press Play / pin live to keep this case active while work starts.</div>`}</div>
    </div>` : ""}
    <div class="software-validation-feedback">
      <textarea class="software-validation-feedback-input" rows="2" data-case-id="${escapeHtml(item.id || "")}" placeholder="Give feedback for this software validation case">${escapeHtml(draft)}</textarea>
      <button class="small-btn save-software-validation-feedback" data-case-id="${escapeHtml(item.id || "")}" type="button">Save feedback</button>
      <small>Saved to software-validation feedback; used by future dashboard/pipeline fix loops.</small>
    </div>
    ${feedback.length ? `<div class="software-validation-feedback-history">${feedback.slice().reverse().map((entry) => `<div><strong>${escapeHtml(fmtTime(entry.at))}</strong><span>${escapeHtml(entry.feedback || "")}</span></div>`).join("")}</div>` : ""}
    ${evidence}
  </article>`;
}

function renderDashboardValidation(payload) {
  const panel = $("dashboardValidationPanel");
  if (!panel) return;
  if (scrollablePanelBusy() && panel.innerHTML.trim()) {
    pendingDashboardValidationRender = payload;
    return;
  }
  const scrollSnapshot = dashboardScrollSnapshot();
  const failed = !payload || payload.status === "failed";
  const fallbackCase = failed ? [{
    id: "software-validation-ui-empty-guard",
    title: "Software Validation Set did not return renderable content",
    status: "fail",
    severity: "high",
    active: true,
    detail: payload?.error || "No software validation payload was returned. This card prevents silent empty-state failure.",
    evidence: [],
    feedback: [],
    updated_at: new Date().toISOString(),
  }] : [];
  const cases = (payload?.cases?.length ? payload.cases : fallbackCase);
  const summary = payload?.summary || {
    fail: cases.filter((item) => item.status === "fail").length,
    monitor: cases.filter((item) => item.status === "monitor").length,
    pass: cases.filter((item) => item.status === "pass").length,
    active: cases.filter((item) => item.active).length,
  };
  latestDashboardValidation = { ...(payload || {}), cases, summary };
  const status = $("dashboardValidationStatus");
  if (status) status.textContent = `${Number(summary.fail || 0)} failing · ${Number(summary.monitor || 0)} monitor · ${Number(summary.pass || 0)} passing`;
  panel.innerHTML = `<div class="dashboard-validation-summary">
    <div class="stat-card"><span>Failing</span><strong>${Number(summary.fail || 0)}</strong><small>shown first</small></div>
    <div class="stat-card"><span>Monitoring</span><strong>${Number(summary.monitor || 0)}</strong><small>known bug classes</small></div>
    <div class="stat-card"><span>Passing</span><strong>${Number(summary.pass || 0)}</strong><small>regression checks</small></div>
    <div class="stat-card"><span>Active</span><strong>${Number(summary.active || 0)}</strong><small>currently being replayed/worked</small></div>
  </div>
  <div class="validation-note">Software Validation Set for this dashboard/pipeline. Product bugs we identify become replayable checks here; failing and active checks are pinned to the top.</div>
  <div class="dashboard-validation-list">${cases.map(renderDashboardValidationCase).join("") || `<div class="message">No software validation cases yet.</div>`}</div>`;
  restoreScrollPositions(scrollSnapshot);
}

async function pollDashboardValidation(caseId = "", record = false) {
  try {
    const query = new URLSearchParams();
    if (!caseId && activeSoftwareValidationCase) caseId = activeSoftwareValidationCase;
    if (caseId) query.set("case", caseId);
    if (record) query.set("record", "1");
    const url = `/api/dashboard-validation${query.toString() ? `?${query}` : ""}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    renderDashboardValidation(await res.json());
  } catch {}
}

async function startValidation() {
  const button = $("startValidationBtn");
  button.disabled = true;
  button.textContent = "Starting validation";
  await fetch("/api/validation/start", { method: "POST" });
  setTimeout(() => {
    button.disabled = false;
    button.textContent = "Run validation agent";
  }, 1400);
  pollValidation();
}

async function saveAnomaly(button, status = "saved") {
  const card = button.closest(".anomaly-card");
  const note = card?.querySelector(".anomaly-note-input")?.value || "";
  const payload = {
    validation_id: button.dataset.validationId,
    anomaly_id: button.dataset.anomalyId,
    status: status === "saved" ? "reviewed" : status,
    note,
  };
  const res = await fetch("/api/validation/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    anomalyNoteDrafts.delete(payload.anomaly_id);
    validationEditLockUntil = Date.now() + 1000;
    const effectiveStatus = payload.status;
    const label = effectiveStatus === "reviewed" ? "reviewed" : effectiveStatus === "good" ? "looks good" : "saved";
    button.textContent = effectiveStatus === "reviewed" ? "Saved review" : effectiveStatus === "good" ? "Looks good" : "Saved";
    card?.classList.add("reviewed");
    const tags = card?.querySelector(".anomaly-tags");
    if (tags && !tags.querySelector("mark.reviewed")) {
      tags.insertAdjacentHTML("afterbegin", `<mark class="reviewed">${escapeHtml(label)}</mark>`);
    } else {
      const reviewed = tags?.querySelector("mark.reviewed");
      if (reviewed) reviewed.textContent = label;
    }
    const route = card?.querySelector(".anomaly-route");
    if (route) route.textContent = `${label} · persisted as validation metadata; error-case ledger is updated automatically when your note describes a repeatable issue.`;
    pollValidation();
    pollFeedbackStatus();
    pollRegressionSolutions();
    pollRegressionLedger();
pollDocxReview();
pollDashboardValidation();
  }
}

function renderFeedbackLifecycle(status) {
  latestFeedbackStatus = status;
  const panel = $("feedbackLifecycle");
  if (!panel) return;
  if (scrollablePanelBusy() && panel.innerHTML.trim()) {
    pendingFeedbackRender = status;
    return;
  }
  const scrollSnapshot = dashboardScrollSnapshot();
  $("feedbackLifecycleUpdated").textContent = `updated ${fmtTime(status.updated_at)}`;
  const counts = status.counts || {};
  panel.innerHTML = `<div class="feedback-life-cards">
    <div class="stat-card"><span>Run feedback</span><strong>${counts.extraction_feedback || 0}</strong><small>feeds future extraction leaf prompts by STR</small></div>
    <div class="stat-card"><span>Validation reviews</span><strong>${counts.validation_reviews || 0}</strong><small>good/reviewed notes suppress unchanged repeats</small></div>
    <div class="stat-card"><span>Processed</span><strong>${counts.processed_events || 0}</strong><small>agent/subagent consumption events</small></div>
  </div>
  <div class="feedback-life-grid">
    <div>
      <div class="mini-title">Recently processed by agents</div>
      <div class="feedback-life-list">${(status.recent_processed || []).map((item) => `<div class="feedback-life-row">
        <strong>${escapeHtml(item.kind || "processed")}</strong>
        <span>${escapeHtml(item.structure ? `STR ${item.structure}` : item.validation_id || "")} ${escapeHtml(item.agent || item.prior_status || "")}</span>
        <em>${escapeHtml(item.value || item.title || item.prior_note || "")}</em>
      </div>`).join("") || `<div class="message">No feedback has been consumed by a later run yet.</div>`}</div>
    </div>
    <div>
      <div class="mini-title">Latest validation decisions</div>
      <div class="feedback-life-list">${(status.recent_validation || []).map((item) => `<div class="feedback-life-row">
        <strong>${escapeHtml(item.status || "saved")}</strong>
        <span>${escapeHtml(item.validation_id || "")}</span>
        <em>${escapeHtml(item.note || item.anomaly_id || "")}</em>
      </div>`).join("") || `<div class="message">No validation notes yet.</div>`}</div>
    </div>
  </div>`;
  restoreScrollPositions(scrollSnapshot);
}

async function pollFeedbackStatus() {
  try {
    const res = await fetch("/api/feedback/status", { cache: "no-store" });
    if (!res.ok) return;
    renderFeedbackLifecycle(await res.json());
  } catch {}
}

function solutionRenderKey(payload) {
  return JSON.stringify({
    totals: payload.totals || {},
    live: payload.live_replay ? {
      id: payload.live_replay.recheck_id,
      status: payload.live_replay.status,
      done: payload.live_replay.cases_done,
      total: payload.live_replay.cases_total,
      case_key: payload.live_replay.case_key,
      active_node: payload.live_replay.active_node,
      node_events: (payload.live_replay.node_events || []).length,
    } : null,
    solutions: (payload.solutions || []).map((solution) => ({
      id: solution.solution_id,
      status: solution.status,
      counts: solution.counts,
      latest: solution.latest_recheck_id,
      feedback: (solution.feedback || []).map((item) => `${item.at}:${item.feedback}`),
      cases: (solution.cases || []).map((item) => ({
        signature: item.signature,
        outcome: item.outcome,
        recheck: item.result?.recheck_id || null,
        result_status: item.result?.status || null,
      })),
    })),
  });
}

function renderSolutionSuite(payload) {
  latestRegressionSolutions = payload.solutions || [];
  latestSolutionReplay = payload.live_replay || null;
  const panel = $("solutionSuite");
  if (!panel) return;
  const renderKey = solutionRenderKey(payload);
  const totals = payload.totals || {};
  $("solutionSuiteUpdated").textContent = `${totals.solutions || 0} solution class${totals.solutions === 1 ? "" : "es"} · ${totals.solved || 0}/${totals.cases || 0} solved`;
  if (panel.innerHTML.trim() && renderKey === lastSolutionRenderKey) return;
  if (scrollablePanelBusy() && panel.innerHTML.trim()) {
    pendingSolutionRender = payload;
    return;
  }
  const scrollSnapshot = dashboardScrollSnapshot();
  lastSolutionRenderKey = renderKey;
  panel.innerHTML = latestRegressionSolutions.length ? `<div class="solution-summary">
      <div class="stat-card"><span>Solution classes</span><strong>${totals.solutions || 0}</strong><small>general reusable fixes</small></div>
      <div class="stat-card"><span>Replay cases</span><strong>${totals.cases || 0}</strong><small><mark class="ok">${totals.solved || 0} solved</mark> <mark class="bad">${totals.open || 0} open</mark> <mark class="hot">${totals.needs_review || 0} review</mark></small></div>
      <div class="stat-card"><span>Not replayed</span><strong>${totals.not_run || 0}</strong><small>recorded but not tested under latest solution</small></div>
    </div>
    <div class="solution-list">${latestRegressionSolutions.map(renderSolutionCard).join("")}</div>`
    : `<div class="message">No solution classes yet. Save anomaly reviews that describe repeatable errors; they become replayable general solution tests here.</div>`;
  restoreScrollPositions(scrollSnapshot);
}

function renderSolutionCard(solution) {
  const counts = solution.counts || {};
  const statusLabel = solution.status || "not-run";
  const lessons = solution.lessons || [];
  const graph = solution.agent_graph || [];
  return `<article class="solution-card ${escapeHtml(statusLabel)}" data-solution-id="${escapeHtml(solution.solution_id || "")}">
    <div class="solution-head">
      <div>
        <strong>${escapeHtml(solution.title || "General solution")}</strong>
        <div class="message">${escapeHtml(solution.problem || "")}</div>
      </div>
      <div class="solution-tags">
        <mark class="${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}</mark>
        <mark>${counts.solved || 0}/${counts.total || 0} solved</mark>
        ${counts.open ? `<mark class="bad">${counts.open} open</mark>` : ""}
        ${counts.needs_review ? `<mark class="hot">${counts.needs_review} review</mark>` : ""}
      </div>
    </div>
    <div class="solution-agent-map">
      ${renderSolutionAgentNode("1", "Detector agent", "When does this rule wake up?", solution.detection_rule || "", "input")}
      ${renderSolutionAgentNode("2", "Evidence leaf", "What does the image actually show?", "Open the source photo, zoom the meter/LCD, and read only visible evidence.", "leaf")}
      ${renderSolutionAgentNode("3", "Rule gate", "Which reusable rule wins?", solution.solution || "", "gate")}
      ${renderSolutionAgentNode("4", "Replay verifier", "Did the old error disappear?", solution.latest_recheck_id ? `Latest replay: ${solution.latest_recheck_id}` : "Waiting for replay proof.", "verify")}
      ${renderSolutionAgentNode("5", "Prompt memory", "What changes next run?", "Lessons and your guidance are injected into future extraction/validation leaves.", "memory")}
    </div>
    ${renderSolutionProof(solution)}
    ${lessons.length ? `<div class="solution-lessons">${lessons.map((lesson) => `<mark>${escapeHtml(lesson)}</mark>`).join("")}</div>` : ""}
    <div class="solution-cases">${(solution.cases || []).map((item) => renderSolutionCase(item, solution)).join("")}</div>
    <div class="solution-feedback-box">
      <textarea rows="2" placeholder="Give guidance for this general solution. Example: assume faint Table 3 LCD minus unless source clearly proves positive.">${escapeHtml("")}</textarea>
      <button class="small-btn save-solution-feedback" data-solution-id="${escapeHtml(solution.solution_id || "")}">Save guidance</button>
      <small>Saved guidance is injected into future OpenAI focused replays for this solution class.</small>
    </div>
    ${solution.feedback?.length ? `<div class="solution-feedback-history">${solution.feedback.map((item) => `<div>
      <strong>${escapeHtml(fmtTime(item.at))}</strong>
      <span>${escapeHtml(item.feedback || "")}</span>
    </div>`).join("")}</div>` : ""}
    <div class="solution-actions">
      <button class="small-btn replay-solution" data-solution-id="${escapeHtml(solution.solution_id || "")}">Replay this solution</button>
      <small>Runs only matching recorded cases through the focused OpenAI recheck leaf.</small>
    </div>
  </article>`;
}

function renderSolutionAgentNode(index, title, question, answer, kind) {
  return `<div class="agent-flow-node ${escapeHtml(kind || "")}">
    <b>${escapeHtml(index)}</b>
    <div>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(question)}</span>
      <p>${escapeHtml(answer)}</p>
    </div>
  </div>`;
}

function representativeSolutionCase(solution) {
  const cases = solution.cases || [];
  return cases.find((item) => ["solved", "corrected", "source-corrected", "accepted-source"].includes(item.outcome) && item.result?.readings?.length)
    || cases.find((item) => item.result?.readings?.length)
    || cases[0]
    || null;
}

function evidenceItemForReading(caseItem, reading) {
  const items = caseItem?.evidence?.items || [];
  return items.find((item) => item.source_image === reading?.source_image) || items[0] || null;
}

function siteThumbForEvidence(item, size = 620) {
  if (!item?.structure || !item?.source_image) return "";
  const folder = knownStructures.find((entry) => String(entry.structure) === String(item.structure))?.folder || "";
  return folder ? `/api/thumb/site/${encodeURIComponent(folder)}/${encodeURIComponent(item.source_image)}?size=${encodeURIComponent(size)}` : "";
}

function logicForSolutionReading(solution, caseItem, reading) {
  const result = caseItem?.result || {};
  const parts = [
    solution.title ? `${solution.title}: ${solution.solution}` : solution.solution,
    result.summary,
    reading?.notes,
    reading?.issue_present === true ? "This reading remains flagged for review/evidence attention." : "This reading is accepted under the current replay logic.",
  ].filter(Boolean);
  return parts.join(" ");
}

function logicTreeForSolutionReading(solution, caseItem, reading, evidence) {
  const result = caseItem?.result || {};
  const oldValue = reading?.old_value ?? evidence?.value ?? "";
  const newValue = reading?.rechecked_value ?? "";
  return [
    {
      node: "Old extraction leaf",
      role: "suspect output",
      value: `${oldValue}`,
      note: "This is the value that created or belonged to the recorded error case.",
    },
    {
      node: "Evidence leaf",
      role: "source image check",
      value: reading?.source_image || evidence?.source_image || "source image",
      note: "Open the photo and inspect the LCD/sign/decimal directly.",
    },
    {
      node: "Rule gate",
      role: solution.title || "reusable solution",
      value: solution.solution || "",
      note: "Apply the general rule only when the detector conditions match.",
    },
    {
      node: "Replay verifier",
      role: "current result",
      value: `${newValue} ${reading?.unit || ""}`.trim(),
      note: result.summary || "Focused replay decides whether the old error is solved.",
    },
    {
      node: "Prompt memory",
      role: "future prevention",
      value: "lesson injected",
      note: "The reusable lesson and your guidance are available to future extraction/validation leaves.",
    },
  ];
}

function renderLogicTreeTooltip(tree, raw) {
  return `<div class="logic-popover">
    <div class="logic-popover-head">Agent logic trace</div>
    <div class="logic-tree">${tree.map((item, index) => `<div class="logic-node">
      <b>${index + 1}</b>
      <div>
        <strong>${escapeHtml(item.node)}</strong>
        <span>${escapeHtml(item.role)}</span>
        <em>${escapeHtml(item.value)}</em>
        <p>${escapeHtml(item.note)}</p>
      </div>
    </div>`).join("")}</div>
    <details>
      <summary>Raw trace text</summary>
      <p>${escapeHtml(raw || "")}</p>
    </details>
  </div>`;
}

function renderSolutionProof(solution) {
  const item = representativeSolutionCase(solution);
  const readings = item?.result?.readings || [];
  const reading = readings.find((entry) => String(entry.old_value ?? "") !== String(entry.rechecked_value ?? "")) || readings[0];
  const evidence = evidenceItemForReading(item, reading);
  const thumb = siteThumbForEvidence(evidence, 720);
  if (!item || !reading) return "";
  const logic = logicForSolutionReading(solution, item, reading);
  const logicTree = renderLogicTreeTooltip(logicTreeForSolutionReading(solution, item, reading, evidence), logic);
  const oldValue = reading.old_value ?? evidence?.value ?? "";
  const newValue = reading.rechecked_value ?? "";
  const caseKey = item.signature || item.case_id || "";
  return `<div class="solution-proof">
    <div class="proof-head">
      <div>
        <strong>Trace one replay case</strong>
        <span>click play, then watch the agent tree move live</span>
      </div>
      <button class="small-btn play-proof-case" data-solution-id="${escapeHtml(solution.solution_id || "")}" data-case-key="${escapeHtml(caseKey)}">Play this trace</button>
    </div>
    ${renderProofLiveReplay(item)}
    <div class="proof-grid">
      <figure class="proof-image">
        ${thumb ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(reading.source_image || evidence?.source_image || "evidence")}" loading="lazy" decoding="async" fetchpriority="low" />` : `<div class="proof-image-missing">image unavailable</div>`}
        <figcaption>STR ${escapeHtml(evidence?.structure || item.evidence?.structures?.[0] || "?")} · ${escapeHtml(reading.source_image || evidence?.source_image || "")}</figcaption>
      </figure>
      <div class="proof-trace">
        <div class="trace-case-title">${escapeHtml(item.title || "")}</div>
        <div class="trace-row">
          <div class="trace-step old logic-chip ${escapeHtml(replayNodeStatus(item, "detector-agent").status)}">
            <span>old leaf output</span>
            <strong>${escapeHtml(oldValue)}</strong>
            ${logicTree}
          </div>
          <i></i>
          <div class="trace-step inspect logic-chip ${escapeHtml(replayNodeStatus(item, "evidence-leaf").status)}">
            <span>evidence leaf checks</span>
            <strong>${escapeHtml(reading.source_image || evidence?.source_image || "source")}</strong>
            ${logicTree}
          </div>
          <i></i>
          <div class="trace-step rule logic-chip ${escapeHtml(replayNodeStatus(item, "rule-gate").status)}">
            <span>rule gate decides</span>
            <strong>${escapeHtml(solution.title || "rule")}</strong>
            ${logicTree}
          </div>
          <i></i>
          <div class="trace-step corrected logic-chip ${escapeHtml(replayNodeStatus(item, "replay-verifier").status)}">
            <span>replay result</span>
            <strong>${escapeHtml(newValue)} ${escapeHtml(reading.unit || "")}</strong>
            ${logicTree}
          </div>
        </div>
        <div class="trace-summary logic-chip">
          <span>Why this passes now</span>
          <p>${escapeHtml(item.result?.summary || solution.solution || "")}</p>
          ${logicTree}
        </div>
      </div>
    </div>
  </div>`;
}

function caseReplayFor(item) {
  const keys = [item?.case_id, item?.signature].map(String);
  if (optimisticCaseReplay && keys.includes(String(optimisticCaseReplay.case_key))) return optimisticCaseReplay;
  const replay = latestSolutionReplay;
  if (!replay) return null;
  const key = replay.case_key || replay.active_signature || replay.active_case_id || "";
  const matches = key && keys.includes(String(key));
  if (!matches) return null;
  if (optimisticCaseReplay && String(optimisticCaseReplay.case_key) === String(key) && replay.status !== "running") optimisticCaseReplay = null;
  return replay;
}

function replayNodeStatus(item, node) {
  const replay = caseReplayFor(item);
  if (!replay) return { status: "", message: "" };
  const keys = [item?.case_id, item?.signature].map(String);
  const events = (replay.node_events || []).filter((event) => keys.includes(String(event.case_id)) || keys.includes(String(event.signature)));
  const event = events.filter((entry) => entry.node === node).at(-1);
  const activeNode = replay.status === "running" ? (replay.active_node || events.at(-1)?.node || "") : "";
  return {
    status: event?.status || event?.node_status || (node === activeNode ? "running" : "pending"),
    message: event?.message || (node === activeNode ? "active now" : ""),
  };
}

function renderLiveCaseReplay(item) {
  const replay = caseReplayFor(item);
  if (!replay) return "";
  const nodes = ["detector-agent", "evidence-leaf", "rule-gate", "focused-openai-leaf", "replay-verifier", "prompt-memory"];
  const events = (replay.node_events || []).filter((event) => [item.case_id, item.signature].map(String).includes(String(event.case_id)) || [item.case_id, item.signature].map(String).includes(String(event.signature)));
  const latestByNode = new Map(events.map((event) => [event.node, event]));
  const activeNode = replay.status === "running" ? (replay.active_node || events.at(-1)?.node || "") : "";
  return `<div class="case-live-replay ${escapeHtml(replay.status || "")}">
    <div class="case-live-head">
      <strong>${replay.status === "running" ? "Live replay running" : "Latest case replay"}</strong>
      <span>${escapeHtml(replay.recheck_id || "")}</span>
    </div>
    <div class="case-live-nodes">${nodes.map((node, index) => {
      const event = latestByNode.get(node);
      const status = event?.status || event?.node_status || (node === activeNode ? "running" : "pending");
      return `<div class="case-live-node ${escapeHtml(status)} ${node === activeNode ? "active" : ""}">
        <b>${index + 1}</b>
        <strong>${escapeHtml(node.replaceAll("-", " "))}</strong>
        <span>${escapeHtml(event?.message || (node === activeNode ? "active now" : "waiting"))}</span>
      </div>`;
    }).join("")}</div>
    <div class="case-live-log">${events.slice(-8).reverse().map((event) => `<div>
      <span>${fmtTime(event.at)}</span>
      <strong>${escapeHtml(String(event.node || "").replaceAll("-", " "))}</strong>
      <em>${escapeHtml(event.message || "")}</em>
    </div>`).join("") || `<div class="message">Replay events will appear here after you press play.</div>`}</div>
  </div>`;
}

function renderProofLiveReplay(item) {
  const replay = caseReplayFor(item);
  const nodes = [
    ["detector-agent", "Detector"],
    ["evidence-leaf", "Evidence"],
    ["rule-gate", "Rule"],
    ["focused-openai-leaf", "OpenAI leaf"],
    ["replay-verifier", "Verifier"],
    ["prompt-memory", "Memory"],
  ];
  const keys = [item?.case_id, item?.signature].map(String);
  const events = replay
    ? (replay.node_events || []).filter((event) => keys.includes(String(event.case_id)) || keys.includes(String(event.signature)))
    : [];
  const latestEvent = events.at(-1);
  const activeNode = replay?.status === "running" ? (replay.active_node || latestEvent?.node || "") : "";
  const headline = replay
    ? replay.status === "running"
      ? `${String(activeNode || "starting").replaceAll("-", " ")} is happening now`
      : `Replay ended: ${replay.status || "complete"}`
    : "Press play to run this one case live";
  return `<div class="proof-live ${escapeHtml(replay?.status || "idle")}">
    <div class="proof-live-head">
      <strong>${escapeHtml(headline)}</strong>
      <span>${escapeHtml(replay?.recheck_id || "ready")}</span>
    </div>
    <div class="proof-live-nodes">${nodes.map(([node, label], index) => {
      const state = replayNodeStatus(item, node);
      const isActive = node === activeNode;
      return `<div class="proof-live-node ${escapeHtml(state.status || "pending")} ${isActive ? "active" : ""}">
        <b>${index + 1}</b>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(isActive ? "happening now" : state.message || state.status || "waiting")}</span>
      </div>`;
    }).join("")}</div>
    <div class="proof-live-current">
      <strong>${escapeHtml(latestEvent ? String(latestEvent.node || "").replaceAll("-", " ") : "waiting")}</strong>
      <span>${escapeHtml(latestEvent?.message || "No live replay has started for this case yet.")}</span>
    </div>
  </div>`;
}

function renderSolutionCase(item, solution) {
  const result = item.result || null;
  const readings = result?.readings || [];
  const evidence = item.evidence || {};
  return `<div class="solution-case ${escapeHtml(item.outcome || "not-run")}">
    <div>
      <strong>${escapeHtml(item.title || "Replay case")}</strong>
      <span>${escapeHtml((evidence.structures || []).map((s) => `STR ${s}`).join(", ") || item.kind || "")}</span>
    </div>
    <mark>${escapeHtml(item.outcome || "not-run")}</mark>
    ${result?.summary ? `<em>${escapeHtml(result.summary)}</em>` : `<em>${escapeHtml(item.note || "Recorded case waiting for replay.")}</em>`}
    ${readings.length ? `<div class="solution-readings">${readings.slice(0, 6).map((reading) => `<span>${escapeHtml(reading.source_image || "")}: ${escapeHtml(reading.old_value || "")} -> ${escapeHtml(reading.rechecked_value || "")} ${escapeHtml(reading.unit || "")}</span>`).join("")}</div>` : ""}
  </div>`;
}

async function pollRegressionSolutions() {
  try {
    const res = await fetch("/api/regression/solutions", { cache: "no-store" });
    if (!res.ok) return;
    renderSolutionSuite(await res.json());
  } catch {}
}

async function saveSolutionFeedback(button) {
  const card = button.closest(".solution-card");
  const textarea = card?.querySelector(".solution-feedback-box textarea");
  const feedback = textarea?.value?.trim() || "";
  if (!feedback) return;
  button.disabled = true;
  button.textContent = "Saving";
  const res = await fetch("/api/regression/solutions/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      solution_id: button.dataset.solutionId,
      feedback,
    }),
  });
  button.disabled = false;
  button.textContent = res.ok ? "Saved" : "Save failed";
  if (res.ok && textarea) textarea.value = "";
  setTimeout(() => { button.textContent = "Save guidance"; }, 1200);
  pollRegressionSolutions();
  pollFeedbackStatus();
}

async function saveSoftwareValidationFeedback(button) {
  const card = button.closest(".dashboard-validation-case");
  const input = card?.querySelector(".software-validation-feedback-input");
  const feedback = input?.value?.trim() || "";
  if (!feedback) return;
  button.disabled = true;
  button.textContent = "Saving";
  const res = await fetch("/api/software-validation/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      case_id: button.dataset.caseId,
      feedback,
    }),
  });
  button.disabled = false;
  button.textContent = res.ok ? "Saved" : "Save failed";
  if (res.ok && input) {
    softwareValidationDrafts.delete(button.dataset.caseId || "");
    input.value = "";
  }
  setTimeout(() => { button.textContent = "Save feedback"; }, 1200);
  pollDashboardValidation();
  pollFeedbackStatus();
}

async function saveDocxReviewFeedback(button, status = "reviewed", fallbackText = "") {
  const cell = button.closest(".docx-cell");
  if (!cell) return;
  const input = cell.querySelector(".docx-review-input");
  const feedback = (fallbackText || input?.value || "").trim();
  if (!feedback) return;
  button.disabled = true;
  button.textContent = "Saving";
  const res = await fetch("/api/docx-review/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slot_key: cell.dataset.slotKey,
      status,
      feedback,
      structure: cell.dataset.structure,
      table_key: cell.dataset.tableKey,
      label: cell.dataset.label,
      cell_status: cell.dataset.cellStatus,
      actual: cell.dataset.actual,
      expected: cell.dataset.expected,
    }),
  });
  button.disabled = false;
  button.textContent = res.ok ? "Saved" : "Save failed";
  if (res.ok) {
    cell.classList.add("reviewed");
    docxReviewDrafts.delete(cell.dataset.slotKey || "");
    if (input) input.value = "";
  }
  setTimeout(() => { button.textContent = button.classList.contains("docx-good") ? "Good TY" : "Save review"; }, 1200);
  pollDocxReview();
  pollFeedbackStatus();
}

function renderRegressionLedger(payload) {
  latestRegressionCases = payload.cases || [];
  const latestRecheck = payload.recheck?.latest || null;
  const resultByCase = new Map((latestRecheck?.results || []).map((result) => [result.signature || result.case_id, result]));
  const panel = $("regressionLedger");
  if (!panel) return;
  if (scrollablePanelBusy() && panel.innerHTML.trim()) {
    pendingRegressionRender = payload;
    return;
  }
  const scrollSnapshot = dashboardScrollSnapshot();
  $("regressionUpdated").textContent = `${latestRegressionCases.length} recorded case${latestRegressionCases.length === 1 ? "" : "s"} · updated ${fmtTime(payload.updated_at)}`;
  const recheckHtml = latestRecheck ? `<div class="regression-recheck">
    <div>
      <strong>Focused recheck: ${escapeHtml(latestRecheck.status || "running")}</strong>
      <span>${Number(latestRecheck.cases_done || 0)} / ${Number(latestRecheck.cases_total || 0)} cases processed</span>
    </div>
    <div class="validation-event-log">${(latestRecheck.events || []).slice(-8).reverse().map((event) => `<div class="validation-event ${escapeHtml(event.type || "")}">
      <span>${fmtTime(event.at)}</span><strong>${escapeHtml(event.type || "event")}</strong><em>${escapeHtml(event.message || "")}</em>
    </div>`).join("")}</div>
  </div>` : "";
  panel.innerHTML = `${recheckHtml}${latestRegressionCases.length
    ? `<div class="regression-list">${latestRegressionCases.map((item) => {
        const result = resultByCase.get(item.signature || item.case_id);
        return `<article class="regression-case ${escapeHtml(item.severity || "")} ${result ? escapeHtml(result.status || "") : ""}">
        <div>
          <strong>${escapeHtml(item.title || "Recorded anomaly")}</strong>
          <div class="message">${escapeHtml(result?.summary || item.next_step || "")}</div>
        </div>
        <div class="regression-meta">
          <mark>${escapeHtml(result ? `recheck: ${result.status}` : item.status || "recorded")}</mark>
          <mark>${escapeHtml(item.kind || "anomaly")}</mark>
          <mark>${escapeHtml(item.severity || "medium")}</mark>
        </div>
        <div class="regression-evidence">${(item.anomaly?.evidence || []).slice(0, 6).map((ev) => `<span>STR ${escapeHtml(ev.structure || "?")} · ${escapeHtml(ev.agent || "")} · ${escapeHtml(ev.value ?? "")}</span>`).join("")}</div>
        ${result?.readings?.length ? `<div class="regression-results">${result.readings.slice(0, 6).map((reading) => `<span>${escapeHtml(reading.source_image || "")}: ${escapeHtml(reading.old_value || "")} -> ${escapeHtml(reading.rechecked_value || "")} ${escapeHtml(reading.unit || "")}</span>`).join("")}</div>` : ""}
        <div class="regression-actions">
          <small>Case signature: ${escapeHtml(String(item.signature || "").slice(0, 12))}</small>
        </div>
      </article>`;
      }).join("")}</div>`
    : `<div class="message">No regression cases recorded yet. Save review notes that describe repeatable errors to create durable repeat-check targets.</div>`}`;
  restoreScrollPositions(scrollSnapshot);
}

async function pollRegressionLedger() {
  try {
    const [casesRes, recheckRes] = await Promise.all([
      fetch("/api/regression", { cache: "no-store" }),
      fetch("/api/regression/rechecks", { cache: "no-store" }),
    ]);
    if (!casesRes.ok) return;
    const payload = await casesRes.json();
    payload.recheck = recheckRes.ok ? await recheckRes.json() : null;
    renderRegressionLedger(payload);
  } catch {}
}

async function startRegressionRecheck(solutionId = "", caseKey = "") {
  const button = caseKey
    ? document.querySelector(`.play-proof-case[data-case-key="${CSS.escape(caseKey)}"], .play-case[data-case-key="${CSS.escape(caseKey)}"]`)
    : solutionId ? document.querySelector(`.replay-solution[data-solution-id="${CSS.escape(solutionId)}"]`) : $("startRegressionRecheckBtn");
  if (button) {
    button.disabled = true;
    button.textContent = caseKey ? "Playing" : solutionId ? "Replaying" : "Starting rechecks";
  }
  const params = new URLSearchParams();
  if (solutionId) params.set("solution", solutionId);
  if (caseKey) params.set("case", caseKey);
  const suffix = params.toString() ? `?${params}` : "";
  if (caseKey) {
    optimisticCaseReplay = {
      status: "running",
      recheck_id: "starting",
      case_key: caseKey,
      active_node: "detector-agent",
      node_events: [{
        at: new Date().toISOString(),
        case_id: caseKey,
        signature: caseKey,
        node: "detector-agent",
        status: "running",
        message: "Detector agent is starting this single-case replay.",
      }],
    };
    pollRegressionSolutions();
  }
  await fetch(`/api/regression/recheck/start${suffix}`, { method: "POST" });
  setTimeout(() => {
    if (button) {
      button.disabled = false;
      button.textContent = caseKey ? "Play this case" : solutionId ? "Replay this solution" : "Run focused rechecks";
    }
  }, 1600);
  pollRegressionSolutions();
  pollRegressionLedger();
}

async function recordRegressionCase(button) {
  const card = button.closest(".anomaly-card");
  const note = card?.querySelector(".anomaly-note-input")?.value || "";
  const res = await fetch("/api/regression/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      validation_id: button.dataset.validationId,
      anomaly_id: button.dataset.anomalyId,
      note,
    }),
  });
  if (res.ok) {
    button.textContent = "Recorded";
    pollRegressionLedger();
    pollFeedbackStatus();
  }
}

function persistFeedbackConsole() {
  localStorage.setItem("subagentFeedbackConsole", JSON.stringify(feedbackConsoleItems.slice(-150)));
}

function addFeedbackConsoleItem(item) {
  feedbackConsoleItems.push({ at: new Date().toISOString(), ...item });
  feedbackConsoleItems = feedbackConsoleItems.slice(-150);
  persistFeedbackConsole();
  renderFeedbackConsole();
}

function renderFeedbackConsole() {
  const box = $("feedbackConsole");
  if (!box) return;
  box.className = `feedback-console ${feedbackConsoleCollapsed ? "collapsed" : ""}`;
  box.innerHTML = `<button class="feedback-toggle" type="button">${feedbackConsoleCollapsed ? "Feedback" : "Hide"}</button>
    ${feedbackConsoleCollapsed ? "" : `<div class="feedback-console-head">
      <strong>Feedback Console</strong>
      <span>30-day local view · server audit persists</span>
    </div>
    <div class="feedback-console-list">${feedbackConsoleItems.slice(-20).reverse().map((item) => `<div class="feedback-console-item ${escapeHtml(item.status || "captured")}">
      <strong>${escapeHtml(item.title || "Feedback captured")}</strong>
      <span>${escapeHtml(item.value || "")}</span>
      <small>${escapeHtml(item.route || "")}</small>
    </div>`).join("") || `<div class="message">Click any value chip, type feedback, Enter to save, Escape to cancel.</div>`}</div>`}`;
}

function openQuickFeedback(chip) {
  if (!chip || chip.querySelector(".quick-feedback")) return;
  document.querySelectorAll(".quick-feedback").forEach((node) => node.remove());
  const editor = document.createElement("div");
  editor.className = "quick-feedback";
  editor.innerHTML = `<textarea rows="2" placeholder="Type feedback for this value. Enter saves, Esc cancels. Shift+Enter newline."></textarea>
    <div class="quick-feedback-hint">Route: ${escapeHtml(chip.dataset.agent || "leaf")} -> human-feedback -> next run prompt</div>`;
  chip.appendChild(editor);
  deferRenderUntil = Date.now() + 60_000;
  editor.querySelector("textarea").focus();
}

async function submitChipFeedback(chip, value) {
  if (!chip || !value.trim()) return;
  let reading = {};
  try { reading = JSON.parse(chip.dataset.reading || "{}"); } catch {}
  const runId = chip.dataset.runId;
  const agent = chip.dataset.agent;
  const payload = {
    run_id: runId,
    structure: (knownRuns.find((run) => run.run_id === runId) || {}).structure,
    agent,
    field: chip.dataset.field || "value_feedback",
    previous: chip.dataset.previous || chip.dataset.label || "",
    value: value.trim(),
    reading,
  };
  addFeedbackConsoleItem({ status: "sending", title: `STR ${payload.structure || "?"} · ${agent}`, value: payload.value, route: "sending to /api/feedback" });
  const res = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  addFeedbackConsoleItem({
    status: res.ok ? "captured" : "failed",
    title: `STR ${payload.structure || "?"} · ${agent}`,
    value: payload.value,
    route: res.ok ? "captured -> human-feedback leaf -> future agent prompts" : "failed to save feedback",
  });
  chip.querySelector(".quick-feedback")?.remove();
  deferRenderUntil = Date.now() + 900;
  poll();
}

function renderStats(stats) {
  latestStats = stats;
  $("statsUpdated").textContent = `updated ${fmtTime(stats.updated_at)}`;
  if (scrollablePanelBusy() && $("statsPanel")?.innerHTML.trim()) {
    pendingStatsRender = stats;
    return;
  }
  const scrollSnapshot = captureScrollPositions("#statsPanel .health-list");
  const statuses = stats.statuses || {};
  $("statsPanel").innerHTML = `<div class="stat-cards">
    <div class="stat-card"><span>Folders</span><strong>${stats.folders_total}</strong><small><mark>${stats.latest_runs_total}</mark> started</small></div>
    <div class="stat-card"><span>Runs</span><strong>${statuses.complete || 0}</strong><small><mark class="ok">${statuses.complete || 0} complete</mark> <mark class="hot">${statuses.running || 0} running</mark> <mark class="bad">${statuses.failed || 0} failed</mark></small></div>
    <div class="stat-card"><span>API</span><strong>${stats.api_calls_total}</strong><small><mark class="api-tag">${stats.api_seconds_total}s</mark> aggregate time</small></div>
    <div class="stat-card"><span>Tokens</span><strong>${formatCompact(stats.token_total || 0)}</strong><small><mark class="api-tag">${formatCompact(stats.token_input_total || 0)} in</mark> <mark>${formatCompact(stats.token_output_total || 0)} out</mark></small></div>
    <div class="stat-card"><span>Images</span><strong>${stats.images_total}</strong><small><mark class="image-tag">visual/router</mark> inputs</small></div>
    <div class="stat-card"><span>Avg complete</span><strong>${stats.avg_complete_duration_seconds ?? "--"}s</strong><small><mark>end-to-end</mark> per STR</small></div>
  </div>
  <div class="stats-grid">
    <div>
      <div class="mini-title">Running now</div>
      <div class="health-list">${(stats.per_run || []).filter((run) => run.status === "running").map(renderRunStat).join("") || `<div class="message">No active runs.</div>`}</div>
    </div>
    <div>
      <div class="mini-title">Slowest API calls</div>
      <div class="health-list">${(stats.bottlenecks || []).map((item) => `<div class="health-row">
        <strong>STR ${escapeHtml(item.structure)}</strong>
        <span><mark class="api-tag">${escapeHtml(item.agent)}</mark> <mark class="hot">${item.seconds}s</mark> <mark class="image-tag">${item.images ?? 0} imgs</mark></span>
      </div>`).join("") || `<div class="message">No completed API calls yet.</div>`}</div>
    </div>
    <div>
      <div class="mini-title">Per-STR health</div>
      <div class="health-list compact-health">${(stats.per_run || []).map(renderRunStat).join("")}</div>
    </div>
    <div>
      <div class="mini-title">Token cost proxy by agent</div>
      <div class="health-list compact-health">${(stats.usage_by_agent || []).slice(0, 12).map(renderUsageBucket).join("") || `<div class="message">No usage logs yet.</div>`}</div>
    </div>
    <div>
      <div class="mini-title">Token cost proxy by phase</div>
      <div class="health-list">${(stats.usage_by_phase || []).map(renderUsageBucket).join("") || `<div class="message">No phase usage yet.</div>`}</div>
    </div>
    <div>
      <div class="mini-title">Largest token calls</div>
      <div class="health-list">${(stats.largest_token_calls || []).map((item) => `<div class="health-row">
        <strong>STR ${escapeHtml(item.structure)} · ${escapeHtml(item.agent)}</strong>
        <span><mark class="api-tag">${formatCompact(item.total_tokens)} tok</mark> <mark>${formatCompact(item.input_tokens)} in</mark> <mark>${formatCompact(item.output_tokens)} out</mark> <mark class="image-tag">${item.input_images ?? 0} imgs</mark></span>
      </div>`).join("") || `<div class="message">No token calls yet.</div>`}</div>
    </div>
  </div>`;
  restoreScrollPositions(scrollSnapshot);
}

function renderRunStat(run) {
  return `<div class="health-row ${cls(run.status)}">
    <strong>STR ${escapeHtml(run.structure)}</strong>
    <span><mark class="${run.status === "complete" ? "ok" : run.status === "running" ? "hot" : run.status === "failed" ? "bad" : ""}">${escapeHtml(run.status)}</mark> <mark>${run.duration_seconds ?? "--"}s</mark> <mark class="api-tag">API ${run.api_calls_complete}/${run.api_calls_total}</mark> <mark class="api-tag">${formatCompact(run.token_total || 0)} tok</mark> <mark class="image-tag">${run.images_total} imgs</mark> <mark>leaves ${run.leaf_complete}/${run.leaf_total}</mark>${run.active_step ? ` <mark class="hot">${escapeHtml(run.active_step)}</mark>` : ""}</span>
  </div>`;
}

function renderUsageBucket(bucket) {
  return `<div class="health-row">
    <strong>${escapeHtml(bucket.name)}</strong>
    <span><mark class="api-tag">${formatCompact(bucket.total_tokens)} tok</mark> <mark>${formatCompact(bucket.input_tokens)} in</mark> <mark>${formatCompact(bucket.output_tokens)} out</mark> <mark>${bucket.requests} req</mark> <mark class="image-tag">${bucket.input_images} imgs</mark> <mark>${bucket.avg_tokens_per_request ?? "--"} tok/req</mark> <mark>${bucket.tokens_per_image ?? "--"} tok/img</mark> <mark class="hot">${bucket.api_seconds}s</mark></span>
  </div>`;
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function renderStructurePicker() {
  $("structurePickerBtn").textContent = selectedStructures.size
    ? [...selectedStructures].map((s) => `STR ${s}`).join(", ")
    : "Select STRs";
  $("structureOptions").innerHTML = knownStructures.length
    ? knownStructures.map((item) => {
        const checked = selectedStructures.has(String(item.structure)) ? "checked" : "";
        return `<label class="structure-option">
          <input type="checkbox" value="${escapeHtml(item.structure)}" ${checked} />
          <span>STR ${escapeHtml(item.structure)}</span>
          <small>${String(item.ordinal).padStart(3, "0")} · ${escapeHtml(item.folder)}</small>
        </label>`;
      }).join("")
    : `<div class="message">Loading structures...</div>`;
}

async function loadStructures() {
  const res = await fetch("/api/structures", { cache: "no-store" });
  if (!res.ok) return;
  const payload = await res.json();
  knownStructures = payload.structures || [];
  renderStructurePicker();
  renderFoldRail();
}

async function loadReportSourceTruth() {
  try {
    const res = await fetch("/api/report/source-of-truth", { cache: "no-store" });
    if (!res.ok) return;
    reportSourceTruth = await res.json();
    const button = $("openFinalReportBtn");
    if (button) {
      button.title = `Active final DOCX: ${reportSourceTruth.active_docx}`;
      button.classList.toggle("missing", !reportSourceTruth.active_exists);
      button.textContent = reportSourceTruth.active_exists ? "Open Final DOCX" : "Final DOCX missing";
    }
  } catch {}
}

function visibleRunIds() {
  return [...manualOpenRunIds].slice(0, 12);
}

function summarize(states) {
  const running = states.filter((state) => state.status === "running").length;
  const failed = states.filter((state) => state.status === "failed").length;
  const complete = states.filter((state) => state.status === "complete").length;
  $("runId").textContent = [...selectedStructures].map((s) => `STR ${s}`).join(", ") || "none selected";
  const status = running ? "running" : failed ? "failed" : complete ? "complete" : "pending";
  $("runStatus").textContent = running ? `${running} running` : failed ? `${failed} failed` : complete ? `${complete} complete` : "waiting";
  $("runStatus").className = `pill ${status}`;
  $("targetText").textContent = states.length ? `${states.length} run board${states.length === 1 ? "" : "s"} visible` : "no run loaded";
  const latest = states.map((state) => state.updated_at).filter(Boolean).sort().at(-1);
  $("updatedAt").textContent = fmtTime(latest);
  const mostRecentWithArtifacts = states.find((state) => (state.artifacts || []).length);
  renderArtifactsPanel(mostRecentWithArtifacts?.run_id, mostRecentWithArtifacts?.artifacts || []);
  renderLauncher();
  renderFoldRail();
}

async function poll() {
  try {
    const runsRes = await fetch("/api/runs", { cache: "no-store" });
    if (runsRes.ok) {
      knownRuns = (await runsRes.json()).runs || [];
      renderFoldRail();
      fetch("/api/stats", { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((stats) => { if (stats) renderStats(stats); })
        .catch(() => {});
      const ids = visibleRunIds();
      const states = [];
      for (const runId of ids) {
        const stateRes = await fetch(`/api/state?run=${encodeURIComponent(runId)}`, { cache: "no-store" });
        if (stateRes.ok) states.push(await stateRes.json());
        const since = lastSeqByRun.get(runId) || 0;
        const eventRes = await fetch(`/api/events?run=${encodeURIComponent(runId)}&since=${since}`, { cache: "no-store" });
      if (eventRes.ok) {
        const payload = await eventRes.json();
          const bucket = eventsByRun.get(runId) || [];
        for (const event of payload.events || []) {
            bucket.push(event);
            lastSeqByRun.set(runId, Math.max(lastSeqByRun.get(runId) || 0, Number(event.seq || 0)));
        }
          eventsByRun.set(runId, bucket.slice(-180));
          stateEventsByRun.set(runId, bucket.slice(-80));
        }
      }
      renderRunBoards(states);
      summarize(states);
        renderEvents();
      $("pollState").textContent = "live";
    } else {
      $("pollState").textContent = "waiting";
    }
  } catch (error) {
    $("pollState").textContent = "offline";
  }
}

async function startRun() {
  const structures = [...selectedStructures];
  if (!structures.length) return;
  $("startBtn").disabled = true;
  $("startBtn").textContent = "Starting";
  const mode = $("runMode")?.value || "reuse";
  const res = await fetch(`/api/start?structures=${encodeURIComponent(structures.join(","))}&mode=${encodeURIComponent(mode)}`, { method: "POST" });
  if (res.ok) {
    const payload = await res.json();
    const runs = payload.runs || [];
    for (const run of runs) selectedRunIds.add(run.run_id);
    if (runs[0]?.run_id) {
      manualOpenRunIds.clear();
      manualOpenRunIds.add(runs[0].run_id);
      focusedRunId = runs[0].run_id;
    }
  }
  setTimeout(() => {
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Start Selected";
  }, 1200);
  poll();
}

async function startOne(structure) {
  const mode = $("runMode")?.value || "reuse";
  const res = await fetch(`/api/start?structures=${encodeURIComponent(structure)}&mode=${encodeURIComponent(mode)}`, { method: "POST" });
  if (res.ok) {
    const payload = await res.json();
    for (const run of payload.runs || []) {
      selectedRunIds.add(run.run_id);
      selectedStructures.add(String(run.structure));
      manualOpenRunIds.clear();
      manualOpenRunIds.add(run.run_id);
      focusedRunId = run.run_id;
    }
    renderStructurePicker();
    poll();
  }
}

async function stopOne(runId) {
  await fetch(`/api/stop?run=${encodeURIComponent(runId)}`, { method: "POST" });
  poll();
}

async function openFinalReport() {
  const button = $("openFinalReportBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Opening final";
  }
  const res = await fetch("/api/report/open-final", { method: "POST" });
  if (res.ok) await loadReportSourceTruth();
  if (button) {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = reportSourceTruth?.active_exists ? "Open Final DOCX" : "Final DOCX missing";
    }, 900);
  }
}

async function submitFeedback(node) {
  const value = node.textContent.trim();
  const previous = node.dataset.previous || "";
  if (!value || value === previous) return;
  let reading = {};
  try { reading = JSON.parse(node.dataset.reading || "{}"); } catch {}
  const runId = node.dataset.runId;
  const agent = node.dataset.agent;
  const res = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      structure: (knownRuns.find((run) => run.run_id === runId) || {}).structure,
      agent,
      field: node.dataset.field || "label",
      previous,
      value,
      reading,
    }),
  });
  addFeedbackConsoleItem({
    status: res.ok ? "captured" : "failed",
    title: `${agent} label feedback`,
    value,
    route: res.ok ? "captured -> human-feedback leaf -> future agent prompts" : "failed to save feedback",
  });
  node.dataset.previous = value;
  node.classList.add("saved");
  setTimeout(() => node.classList.remove("saved"), 700);
  poll();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("startBtn").addEventListener("click", startRun);
$("openFinalReportBtn")?.addEventListener("click", openFinalReport);
$("startValidationBtn")?.addEventListener("click", startValidation);
$("startRegressionRecheckBtn")?.addEventListener("click", () => startRegressionRecheck());
$("structurePickerBtn").addEventListener("click", () => {
  $("structurePicker").hidden = !$("structurePicker").hidden;
});
$("structureOptions").addEventListener("change", (event) => {
  if (event.target.tagName !== "INPUT") return;
  if (event.target.checked) selectedStructures.add(event.target.value);
  else selectedStructures.delete(event.target.value);
  renderStructurePicker();
});
document.addEventListener("toggle", (event) => {
  const details = event.target.closest?.(".docx-structure");
  if (!details?.dataset.structure) return;
  if (details.open) docxOpenStructures.add(details.dataset.structure);
  else docxOpenStructures.delete(details.dataset.structure);
}, true);

document.addEventListener("click", (event) => {
  const start = event.target.closest(".start-one");
  if (start) startOne(start.dataset.structure);
  const stop = event.target.closest(".stop-one");
  if (stop) stopOne(stop.dataset.runId);
  const view = event.target.closest(".view-one");
  if (view) {
    selectedRunIds.add(view.dataset.runId);
    selectedStructures.add(String(view.dataset.structure));
    manualOpenRunIds.clear();
    manualOpenRunIds.add(view.dataset.runId);
    focusedRunId = view.dataset.runId;
    renderStructurePicker();
    poll();
  }
  const focus = event.target.closest(".focus-run");
  if (focus) {
    const runId = focus.dataset.runId;
    if (manualOpenRunIds.has(runId)) {
      manualOpenRunIds.delete(runId);
      if (focusedRunId === runId) focusedRunId = null;
    } else {
      manualOpenRunIds.add(runId);
      focusedRunId = runId;
    }
    poll();
  }
  const density = event.target.closest(".density-btn");
  if (density) {
    openLimit = density.dataset.openLimit === "all" ? "all" : Number(density.dataset.openLimit);
    document.querySelectorAll(".density-btn").forEach((button) => button.classList.toggle("active", button === density));
    poll();
  }
  const rail = event.target.closest(".rail-item");
  if (rail) handleRailClick(rail, event);
  const feedbackToggle = event.target.closest(".feedback-toggle");
  if (feedbackToggle) {
    feedbackConsoleCollapsed = !feedbackConsoleCollapsed;
    renderFeedbackConsole();
  }
  const save = event.target.closest(".save-anomaly");
  if (save) saveAnomaly(save, "saved");
  const good = event.target.closest(".good-anomaly");
  if (good) saveAnomaly(good, "good");
  const replaySolution = event.target.closest(".replay-solution");
  if (replaySolution) startRegressionRecheck(replaySolution.dataset.solutionId || "");
  const playProof = event.target.closest(".play-proof-case");
  if (playProof) startRegressionRecheck(playProof.dataset.solutionId || "", playProof.dataset.caseKey || "");
  const playCase = event.target.closest(".play-case");
  if (playCase) startRegressionRecheck(playCase.dataset.solutionId || "", playCase.dataset.caseKey || "");
  const solutionFeedback = event.target.closest(".save-solution-feedback");
  if (solutionFeedback) saveSolutionFeedback(solutionFeedback);
  const replayDashboard = event.target.closest(".replay-dashboard-case");
  if (replayDashboard) {
    activeSoftwareValidationCase = replayDashboard.dataset.caseId || "";
    pollDashboardValidation(activeSoftwareValidationCase, true);
  }
  const softwareFeedback = event.target.closest(".save-software-validation-feedback");
  if (softwareFeedback) saveSoftwareValidationFeedback(softwareFeedback);
  const docxFilter = event.target.closest(".docx-risk-filter");
  if (docxFilter) {
    docxReviewFilter = docxFilter.dataset.filter || "";
    renderDocxReview(latestDocxReview);
  }
  const clearDocxFilter = event.target.closest(".docx-clear-filter");
  if (clearDocxFilter) {
    docxReviewFilter = "";
    renderDocxReview(latestDocxReview);
  }
  const docxToggle = event.target.closest(".docx-toggle-review");
  if (docxToggle) docxToggle.closest(".docx-cell")?.classList.toggle("review-open");
  const docxGood = event.target.closest(".docx-good");
  if (docxGood) saveDocxReviewFeedback(docxGood, "good", "Good TY");
  const docxSave = event.target.closest(".save-docx-review");
  if (docxSave) saveDocxReviewFeedback(docxSave, "reviewed");
  const chip = event.target.closest(".reading-chip");
  if (chip && !event.target.closest(".hover-preview, .quick-feedback, .editable-label")) openQuickFeedback(chip);
});
document.addEventListener("input", (event) => {
  const input = event.target.closest(".anomaly-note-input");
  const softwareInput = event.target.closest(".software-validation-feedback-input");
  const docxInput = event.target.closest(".docx-review-input");
  if (docxInput) {
    const key = docxInput.closest(".docx-cell")?.dataset.slotKey || "";
    if (docxInput.value) docxReviewDrafts.set(key, docxInput.value);
    else docxReviewDrafts.delete(key);
    lockValidationEditing();
    return;
  }
  if (softwareInput) {
    if (softwareInput.value) softwareValidationDrafts.set(softwareInput.dataset.caseId || "", softwareInput.value);
    else softwareValidationDrafts.delete(softwareInput.dataset.caseId || "");
    lockValidationEditing();
    return;
  }
  if (!input) return;
  rememberAnomalyDraft(input);
  lockValidationEditing();
});
document.addEventListener("focusin", (event) => {
  if (event.target.closest?.(".anomaly-note-input, .software-validation-feedback-input, .docx-review-input")) lockValidationEditing();
});
document.addEventListener("focusout", (event) => {
  const input = event.target.closest?.(".anomaly-note-input");
  if (!input) return;
  rememberAnomalyDraft(input);
  validationEditLockUntil = Math.max(validationEditLockUntil, Date.now() + 5000);
});
document.addEventListener("paste", (event) => {
  const input = event.target.closest?.(".anomaly-note-input, .software-validation-feedback-input, .docx-review-input");
  if (!input) return;
  lockValidationEditing();
  setTimeout(() => {
    rememberAnomalyDraft(input);
    lockValidationEditing();
  }, 0);
}, true);
document.addEventListener("beforeinput", (event) => {
  if (event.target.closest?.(".anomaly-note-input, .software-validation-feedback-input, .docx-review-input")) lockValidationEditing();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.target.closest?.(".anomaly-note-input, .software-validation-feedback-input, .docx-review-input")) lockValidationEditing();
  const quick = event.target.closest(".quick-feedback textarea");
  if (quick) {
    if (event.key === "Escape") {
      event.preventDefault();
      quick.closest(".quick-feedback")?.remove();
      deferRenderUntil = Date.now() + 600;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitChipFeedback(quick.closest(".reading-chip"), quick.value);
      return;
    }
  }
  const editable = event.target.closest(".editable-label");
  if (!editable) return;
  if (event.key === "Enter") {
    event.preventDefault();
    editable.blur();
    submitFeedback(editable);
  }
});
document.addEventListener("blur", (event) => {
  const editable = event.target.closest(".editable-label");
  if (editable) submitFeedback(editable);
}, true);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".picker")) $("structurePicker").hidden = true;
});
async function hydrateHoverPreview(preview) {
  if (!preview || preview.dataset.loaded === "1" || !preview.dataset.neighborhood) return;
  preview.dataset.loaded = "1";
  preview.querySelectorAll("img[data-src]").forEach((img) => {
    img.src = img.dataset.src;
    img.removeAttribute("data-src");
  });
  try {
    const res = await fetch(preview.dataset.neighborhood, { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    const strip = preview.querySelector(".neighbor-strip");
    let contextGroups = [];
    try { contextGroups = JSON.parse(strip.dataset.contextGroups || "[]"); } catch {}
    const figures = (images) => images.map((image) => `<figure class="neighbor ${image.current ? "current" : ""}">
      <img src="${escapeHtml(image.href)}" alt="${escapeHtml(image.name)}" loading="lazy" decoding="async" fetchpriority="low" />
      <figcaption>${escapeHtml(image.name)}</figcaption>
    </figure>`).join("");
    const groupForImage = (image) => {
      const matches = contextGroups.filter((group) => (group.sources || []).includes(image.name));
      return matches.find((group) => group.current) || matches[0] || null;
    };
    const sameGroup = (a, b) => a && b && a.title === b.title && a.agent === b.agent && Boolean(a.current) === Boolean(b.current);
    const parts = [];
    const sourceImages = payload.images || [];
    for (let index = 0; index < sourceImages.length; index += 1) {
      const image = sourceImages[index];
      const matchedGroup = groupForImage(image);
      if (!matchedGroup) {
        parts.push(figures([image]));
        continue;
      }
      const group = [];
      while (index < sourceImages.length && sameGroup(matchedGroup, groupForImage(sourceImages[index]))) {
        group.push(sourceImages[index]);
        index += 1;
      }
      index -= 1;
      parts.push(`<div class="neighbor-context-group ${matchedGroup.current ? "used" : ""}">
        <div class="neighbor-context-images">${figures(group)}</div>
        <small>${escapeHtml(matchedGroup.title)}</small>
      </div>`);
    }
    strip.innerHTML = parts.join("");
    requestAnimationFrame(() => {
      const current = strip.querySelector(".neighbor.current");
      if (current) {
        const left = current.offsetLeft - (strip.clientWidth - current.clientWidth) / 2;
        strip.scrollLeft = Math.max(0, left);
      }
    });
  } catch {}
}

function hideFloatingPreview() {
  if (floatingPreviewHideTimer) {
    clearTimeout(floatingPreviewHideTimer);
    floatingPreviewHideTimer = null;
  }
  if (!activeFloatingPreview) return;
  activeFloatingPreview.classList.remove("is-visible");
  activeFloatingPreview.style.display = "none";
  activeFloatingPreview = null;
}

function scheduleFloatingPreviewHide() {
  if (floatingPreviewHideTimer) clearTimeout(floatingPreviewHideTimer);
  floatingPreviewHideTimer = setTimeout(hideFloatingPreview, 650);
}

function cancelFloatingPreviewHide() {
  if (!floatingPreviewHideTimer) return;
  clearTimeout(floatingPreviewHideTimer);
  floatingPreviewHideTimer = null;
}

function positionFloatingPreview(preview, anchor, pointer) {
  const width = Math.min(860, window.innerWidth - 28);
  const height = Math.min(620, window.innerHeight - 72);
  const margin = 14;
  const rect = anchor?.getBoundingClientRect?.();
  const x = rect ? rect.right : Number(pointer?.clientX || window.innerWidth / 2);
  const y = rect ? rect.top : Number(pointer?.clientY || window.innerHeight / 3);
  let left = x + margin;
  if (left + width > window.innerWidth - margin) left = (rect ? rect.left : x) - width - margin;
  left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
  let top = y;
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
  top = Math.max(margin, Math.min(window.innerHeight - height - margin, top));
  preview.style.width = `${width}px`;
  preview.style.maxHeight = `${height}px`;
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}

function ensureAnomalyFloatingPreview() {
  if (anomalyFloatingPreview) return anomalyFloatingPreview;
  const node = document.createElement("div");
  node.id = "anomalyFloatingPreview";
  node.className = "hover-preview anomaly-preview floating-preview";
  node.style.display = "none";
  node.addEventListener("mouseenter", cancelFloatingPreviewHide);
  node.addEventListener("mouseleave", scheduleFloatingPreviewHide);
  document.body.appendChild(node);
  anomalyFloatingPreview = node;
  return node;
}

function showAnomalyFloatingPreview(chip, event) {
  if (!chip?.dataset.previewSrc) return null;
  if (!chip.dataset.previewAnchor) chip.dataset.previewAnchor = `anomaly-${Math.random().toString(36).slice(2)}`;
  const node = ensureAnomalyFloatingPreview();
  delete node.dataset.loaded;
  node.dataset.neighborhood = chip.dataset.neighborhood || "";
  node.innerHTML = `<div class="hover-current">
      <img data-src="${escapeHtml(chip.dataset.previewSrc)}" alt="${escapeHtml(chip.dataset.previewTitle || "validation evidence")}" decoding="async" fetchpriority="low" />
      <div>${escapeHtml(chip.dataset.previewTitle || "validation evidence")}</div>
    </div>
    <div class="neighbor-strip" data-context-groups="${escapeHtml(chip.dataset.contextGroups || "[]")}">
      <div class="neighbor-loading">hover: loading validation image context</div>
    </div>`;
  node.dataset.anchorId = chip.dataset.previewAnchor;
  activeFloatingPreview = node;
  node.style.display = "block";
  node.classList.add("is-visible");
  positionFloatingPreview(node, chip, event);
  hydrateHoverPreview(node);
  return node;
}

function handlePreviewHover(event) {
  const chip = event.target.closest(".reading-chip");
  const anomalyChip = event.target.closest(".anomaly-chip");
  const docxChip = event.target.closest(".docx-cell.has-preview");
  if (anomalyChip || docxChip) cancelFloatingPreviewHide();
  const preview = chip ? chip.querySelector(".hover-preview") : anomalyChip ? showAnomalyFloatingPreview(anomalyChip, event) : docxChip ? showAnomalyFloatingPreview(docxChip, event) : event.target.closest(".hover-preview");
  const leaf = event.target.closest(".leaf-card");
  if (leaf || chip || preview || anomalyChip || docxChip) deferRenderUntil = Date.now() + 1800;
  hydrateHoverPreview(preview);
}

document.addEventListener("pointerover", handlePreviewHover, true);
document.addEventListener("mouseover", handlePreviewHover);
document.addEventListener("mousemove", (event) => {
  const anomalyChip = event.target.closest(".anomaly-chip");
  if (anomalyChip && activeFloatingPreview) cancelFloatingPreviewHide();
});
document.addEventListener("mouseout", (event) => {
  if (!activeFloatingPreview) return;
  const next = event.relatedTarget;
  if (next && (next.closest?.(".anomaly-chip") || next.closest?.(".docx-cell.has-preview") || next.closest?.(".floating-preview"))) return;
  scheduleFloatingPreviewHide();
});
window.addEventListener("resize", hideFloatingPreview, { passive: true });
loadStructures();
loadReportSourceTruth();
renderFeedbackConsole();
poll();
pollActivity();
pollValidation();
pollFeedbackStatus();
pollRegressionSolutions();
pollRegressionLedger();
setInterval(poll, 600);
setInterval(pollActivity, 2000);
setInterval(pollValidation, 2500);
setInterval(pollDocxReview, 3000);
setInterval(() => pollDashboardValidation(), 2000);
setInterval(pollFeedbackStatus, 3500);
setInterval(pollRegressionSolutions, 1000);
setInterval(pollRegressionLedger, 3500);
setInterval(() => {
  if (pendingStates && Date.now() >= deferRenderUntil) renderRunBoards(pendingStates);
}, 500);
setInterval(() => {
  if (scrollablePanelBusy()) return;
  if (pendingRailRender) {
    pendingRailRender = false;
    renderFoldRail();
  }
  if (pendingLauncherRender) {
    pendingLauncherRender = false;
    renderLauncher();
  }
  if (pendingStatsRender) {
    const stats = pendingStatsRender;
    pendingStatsRender = null;
    renderStats(stats);
  }
  if (pendingValidationRender) {
    const validation = pendingValidationRender;
    pendingValidationRender = null;
    renderValidation(validation);
  }
  if (pendingDocxReviewRender) {
    const review = pendingDocxReviewRender;
    pendingDocxReviewRender = null;
    renderDocxReview(review);
  }
  if (pendingDashboardValidationRender) {
    const dashboardValidation = pendingDashboardValidationRender;
    pendingDashboardValidationRender = null;
    renderDashboardValidation(dashboardValidation);
  }
  if (pendingFeedbackRender) {
    const feedback = pendingFeedbackRender;
    pendingFeedbackRender = null;
    renderFeedbackLifecycle(feedback);
  }
  if (pendingSolutionRender) {
    const solutions = pendingSolutionRender;
    pendingSolutionRender = null;
    renderSolutionSuite(solutions);
  }
  if (pendingRegressionRender) {
    const regression = pendingRegressionRender;
    pendingRegressionRender = null;
    renderRegressionLedger(regression);
  }
}, 250);
["scroll", "pointerdown", "wheel", "keydown"].forEach((eventName) => {
  window.addEventListener(eventName, () => {
    deferRenderUntil = Date.now() + 1200;
  }, { passive: true });
});
document.addEventListener("wheel", markScrollablePanelBusy, { passive: true });
document.addEventListener("pointerdown", markScrollablePanelBusy, { passive: true });
document.addEventListener("scroll", markScrollablePanelBusy, { passive: true, capture: true });
