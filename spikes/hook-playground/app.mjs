import {
  modules,
  fields,
  initialState,
  simulate,
  disconnect,
  exportScenario,
  importScenario,
} from "./model.mjs";
import {
  createDraftStore,
  DRAFT_KEY,
  parseDraft,
  serializeDraft,
} from "./draft.mjs";
import { createPlainDraft } from "./plain-draft.mjs";

let state = initialState(),
  selected = "curve",
  expert = false,
  toastTimer,
  confirmAction,
  plainEnvelope = null,
  saveStatus = "empty",
  pendingSaves = 0,
  generation = 0;
const store = createDraftStore();
const draft = () => ({ state, selected, expert });
const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const fmt = (n, digits = 2) =>
  Number(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const paths = {
  curve: '<path d="M4 3v17h17M7 16c6 0 3-11 13-12"/>',
  split:
    '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="m7 11 10-5M7 13l10 5"/>',
  bank: '<path d="m3 8 9-5 9 5H3Zm2 3v7m7-7v7m7-7v7M3 21h18M3 18h18"/>',
  flag: '<path d="M5 22V3c6-5 8 5 15 0v10c-7 5-9-5-15 0"/>',
  users:
    '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
  shield:
    '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
};
const icon = (key) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[key]}</svg>`;
const connected = (id) => state.connected.includes(id);
function storageStatus(status) {
  if (status === "blocked") return;
  saveStatus = status;
  const problem = ["unreadable", "unavailable", "conflict"].includes(status);
  $("#save-status").textContent =
    {
      saved: "Saved on this browser",
      restored: "Restored from this browser",
      empty: "Example · saved after your first edit",
    }[status] || "Not saved · recovery needed";
  $("#storage-warning").hidden = !problem;
  $("#storage-message").textContent =
    {
      unreadable:
        "The saved draft is damaged or from an unsupported version. It has not been overwritten. Back up your current work and download the saved data before replacing it.",
      unavailable:
        "Browser storage is unavailable or full. Your edits work in this tab but may be lost on reload. Back up your draft to a file; saving is not guaranteed in private browsing.",
      conflict:
        "Another tab changed the saved draft. Automatic saving is paused to protect both versions. Back up this tab before loading the saved version or choosing to replace it.",
    }[status] || "";
  $("#recover-raw").hidden = status === "unavailable";
}
async function persist(replace = false) {
  // Serialize compare-and-write across tabs. Without Web Locks, offer file
  // backups rather than silently risking a last-writer-wins overwrite.
  if (!navigator.locks) {
    storageStatus("unavailable");
    return;
  }
  if (replace) generation++;
  const version = generation,
    snapshot = structuredClone(draft());
  pendingSaves++;
  try {
    await navigator.locks.request(DRAFT_KEY, () => {
      if (version !== generation) return;
      storageStatus(
        (replace ? store.replace(snapshot) : store.save(snapshot)).status,
      );
    });
  } catch {
    storageStatus("unavailable");
  } finally {
    pendingSaves--;
  }
}
function restore() {
  generation++;
  const result = store.load();
  if (result.draft) ({ state, selected, expert } = result.draft);
  else if (result.status === "empty") {
    state = initialState();
    selected = "curve";
    expert = false;
  }
  storageStatus(result.status);
}
function downloadText(text, name) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function confirmChange(title, description, action) {
  confirmAction = action;
  modal(
    `<h2 id="dialog-title">${title}</h2><p>${description} Back up the current draft first if you want to keep both versions.</p><div class="recovery-actions"><button id="cancel-change" autofocus>Keep current draft</button><button id="confirm-change" class="primary">Confirm replacement</button></div>`,
  );
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  toastTimer = setTimeout(() => ($("#toast").textContent = ""), 4000);
}
function summary(id) {
  const v = state.values;
  if (!connected(id)) return "+ Connect module";
  return {
    curve: `${v.reserve ?? "—"} SOL* virtual reserve`,
    fees: `${v.fee ?? "—"}% fee · creator routing`,
    treasury: `${v.share ?? "—"}% share · ${v.lock ?? "—"}d lock`,
    graduation: `${v.target ?? "—"} SOL* net target`,
    governance: `${v.delay ?? "—"}h admin delay`,
    safety: `${v.limit ?? "—"} SOL* max buy`,
  }[id];
}
function field(key, disabled = false) {
  const f = fields[key],
    value = state.values[key],
    invalid = value === null || value < f.min || value > f.max;
  return `<div class="field"><label for="${key}-number">${f.label}<span class="number"><input id="${key}-number" data-field="${key}" type="number" min="${f.min}" max="${f.max}" step="any" value="${value ?? ""}" aria-invalid="${invalid}" aria-describedby="${key}-error${f.hint ? ` ${key}-hint` : ""}" ${disabled ? "disabled" : ""}><span>${f.unit}</span></span></label><input id="${key}-range" data-field="${key}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${value ?? f.min}" aria-label="${f.label} slider (${f.unit})" ${disabled ? "disabled" : ""}><small class="field-error" id="${key}-error">${invalid ? `Enter ${f.min}–${f.max} ${f.unit}.` : ""}</small>${f.hint ? `<small id="${key}-hint">${f.hint}</small>` : ""}</div>`;
}
function renderLibrary() {
  $("#library-list").innerHTML = Object.entries(modules)
    .map(
      ([id, m]) =>
        `<button class="module-item ${connected(id) ? "connected" : ""}" data-module="${id}" aria-label="${connected(id) ? "Edit" : "Add"} ${m.title}">${icon(m.icon)}<span><strong>${m.title}</strong><small>${m.kind === "Concept" ? "Concept only" : "Illustrative model"}</small></span><span aria-hidden="true">${connected(id) ? "✓" : "+"}</span></button>`,
    )
    .join("");
}
function renderCanvas() {
  $("#connected-count").textContent =
    `${state.connected.length} of 6 modules connected`;
  if (!state.connected.length) {
    $("#canvas").innerHTML =
      `<div class="empty-canvas">${icon("curve")}<h3>Every launch starts somewhere.</h3><p>Add a bonding curve to bring your simulation to life. Or start with our illustrative example.</p><button class="primary" data-module="curve">+ Add bonding curve</button><button id="restore-example" class="quiet">Use example</button></div>`;
    return;
  }
  // Fixed positions communicate dependencies, not arbitrary executable hook ordering.
  const order = [
    "curve",
    "fees",
    "graduation",
    "treasury",
    "safety",
    "governance",
  ];
  $("#canvas").innerHTML =
    '<svg class="flow-lines" aria-hidden="true"></svg>' +
    order
      .map(
        (id) =>
          `<button class="node ${connected(id) ? "" : "off"} ${selected === id ? "selected" : ""}" id="node-${id}" data-module="${id}" aria-pressed="${selected === id}" aria-label="${connected(id) ? "Edit" : "Add"} ${modules[id].title} on canvas"><span class="port"></span><span class="node-top">${icon(modules[id].icon)}<strong>${modules[id].title}</strong><span class="node-tag">${modules[id].kind === "Concept" ? "◇" : ""}</span></span><small>${escape(summary(id))}</small></button>`,
      )
      .join("");
  requestAnimationFrame(drawConnections);
}
function drawConnections() {
  const svg = $(".flow-lines");
  if (!svg) return;
  const bounds = $("#canvas").getBoundingClientRect();
  svg.innerHTML = Object.entries(modules)
    .filter(([, m]) => m.parent)
    .map(([id, m]) => {
      const a = $(`#node-${m.parent}`).getBoundingClientRect(),
        b = $(`#node-${id}`).getBoundingClientRect();
      const sameColumn = Math.abs(a.left - b.left) < 5;
      const x1 = (sameColumn ? a.left + a.width / 2 : a.right) - bounds.left;
      const y1 = (sameColumn ? a.bottom : a.top + a.height / 2) - bounds.top;
      const x2 = (sameColumn ? b.left + b.width / 2 : b.left) - bounds.left;
      const y2 = (sameColumn ? b.top : b.top + b.height / 2) - bounds.top;
      // Route the curve → safety branch around graduation, never through it.
      const d =
        id === "safety"
          ? `M${a.left - bounds.left},${a.top + a.height / 2 - bounds.top} H${a.left - bounds.left - 12} V${b.top + b.height / 2 - bounds.top} H${b.left - bounds.left}`
          : sameColumn
            ? `M${x1},${y1} V${y2}`
            : `M${x1},${y1} H${(x1 + x2) / 2} V${y2} H${x2}`;
      return `<path d="${d}" fill="none" stroke="${connected(id) ? "#81e6ad" : "#39413e"}" stroke-width="1.5" ${connected(id) ? "" : 'stroke-dasharray="4 5"'}/>`;
    })
    .join("");
}
function renderInspector() {
  const m = modules[selected],
    on = connected(selected),
    parent = m.parent && modules[m.parent];
  $("#inspector").innerHTML =
    `<div class="section-label">${expert ? "MODULE PARAMETERS" : "MAKE IT YOURS"} <span>${Object.keys(modules).indexOf(selected) + 1} / 6</span></div><div class="inspector-head">${icon(m.icon)}<div><h2>${m.title}</h2><span class="type-label">${m.kind === "Concept" ? "CONCEPT ONLY · NOT LAUNCHABLE" : "ILLUSTRATIVE MODEL"}</span></div></div><p>${m.description} ${!expert ? "Try a change and watch the simulation below." : "Values are local model inputs, not protocol parameters."}</p>${Object.entries(
      fields,
    )
      .filter(([, f]) => f.module === selected)
      .map(([key]) => field(key, !on))
      .join(
        "",
      )}${expert ? `<pre class="expert-data">${escape(`module: ${selected}\nconnected: ${on}\ninput: ${m.parent || "scenario demand"}\n${selected === "curve" ? "invariant: x × y = k\nsupply: 1,000,000,000\nprice: quote / tokens" : selected === "fees" ? "protocol_fee: 100 bps (toy)\ncreator + treasury = fee pool" : "execution: unsupported"}`)}</pre>` : ""}<button class="module-action ${on ? "disconnect" : "primary"}" id="module-action">${on ? "Disconnect module" : `Connect ${m.title.toLowerCase()}`}</button><div class="mini-note">${on ? "Disconnecting also removes dependent modules. Settings stay here for reconnecting." : parent && !connected(m.parent) ? `Connect ${parent.title} first. Dependencies are never added silently.` : "Connecting includes this module in the local simulation."}<br><br>${selected === "safety" ? "This guard does not prevent losses, bots, or repeated purchases." : "No connection here installs a token hook or changes a deployed contract."}</div>`;
  $("#module-action").disabled =
    !on && Boolean(m.parent) && !connected(m.parent);
  $("#module-action").insertAdjacentHTML(
    "beforebegin",
    '<div id="live-impact" class="live-impact" role="status"></div>',
  );
  $(".inspector h2").tabIndex = -1;
}
function drawChart(result) {
  const width = Math.max(250, $("#chart").clientWidth),
    height = 163,
    left = 39,
    right = width - 14,
    bottom = 133;
  const max = result.price * 1e6 * 1.18;
  const x = (value) => left + (value / result.gross) * (right - left),
    y = (value) => bottom - ((value * 1e6) / max) * 115;
  const grid = [0, 1, 2, 3]
    .map((i) => {
      const value = (max * i) / 3,
        py = bottom - (i / 3) * 115;
      return `<line x1="${left}" x2="${right}" y1="${py}" y2="${py}" stroke="#2d3335"/><text x="0" y="${py + 3}">${value.toFixed(2)}</text>`;
    })
    .join("");
  $("#chart").innerHTML =
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Simulated price rises from ${fmt(result.startPrice * 1e6, 3)} to ${fmt(result.price * 1e6, 3)} micro SOL per token over ${fmt(result.gross)} SOL of buy demand. Not a price forecast.">${grid}<path d="${result.points.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.y)}`).join(" ")}" fill="none" stroke="#81e6ad" stroke-width="2"/><circle cx="${x(result.gross)}" cy="${y(result.price)}" r="3" fill="#81e6ad"/><text x="${left}" y="156">0</text><text x="${(left + right) / 2}" y="156" text-anchor="middle">${fmt(result.gross / 2, 0)}</text><text x="${right}" y="156" text-anchor="end">${fmt(result.gross, 1)} SOL* demand</text></svg>`;
}
function renderSimulation() {
  const r = simulate(state),
    errors = r.errors;
  $("#live-impact").innerHTML = errors.length
    ? `<span class="negative">Simulation paused</span><p>${escape(errors[0])}</p>`
    : r.empty
      ? "Connect a curve to see the impact here."
      : `<span class="impact-title">LIVE IMPACT <span class="status-dot"></span></span><p>Spot <b>${fmt(r.price * 1e6, 3)} µSOL*</b> · Creator <b>${fmt(r.creator)} SOL*</b></p><p>Buyer exit <b>${r.buyerBlocked ? "Blocked" : fmt(r.buyerExit) + " SOL*"}</b></p><p>Graduation <b>${Number.isFinite(r.target) ? fmt(r.progress, 1) + "%" : "Not set"}</b> · Risk <b>${r.risk}</b></p><a href="#simulation-title">Explore the full simulation ↓</a>`;
  $("#validation").innerHTML = errors.length
    ? `<div class="validation"><strong>Simulation paused — check your inputs</strong><ul>${errors.map((e) => `<li>${escape(e)}</li>`).join("")}</ul><span>No stale results are shown. Fix the field or reset the example.</span></div>`
    : "";
  $("#export").disabled = Boolean(errors.length);
  $("#export").title = errors.length
    ? "Fix invalid inputs to export a scenario. Back up draft preserves incomplete edits."
    : "Export a simulation-only scenario";
  if (errors.length || r.empty) {
    $("#spot-price").textContent = "—";
    $("#chart").innerHTML =
      `<div class="sim-empty">${r.empty ? "Your curve will appear here.<br>Connect a bonding curve to start." : "Waiting for valid inputs.<br>Your scenario is still editable."}</div>`;
    $("#results").innerHTML =
      `<div class="sim-empty">${r.empty ? "A blank canvas, not a zero-value launch.<br>Add modules to explore outcomes." : "Price, revenue, buyer outcome, and risk<br>are unavailable until inputs are valid."}</div>`;
    return;
  }
  $("#spot-price").innerHTML =
    `${fmt(r.price * 1e6, 3)} <small>µSOL* / token</small>`;
  drawChart(r);
  const returnPct = (r.buyerExit / state.values.buyer - 1) * 100;
  $("#results").innerHTML =
    `<div class="metric"><span class="metric-label">Launch price</span><strong>${fmt(r.startPrice * 1e6, 3)} <small>µSOL*</small></strong><small>Per token · ${fmt(r.price / r.startPrice, 2)}× spot-price change</small></div><div class="metric"><span class="metric-label">Creator revenue</span><strong id="creator-revenue">${fmt(r.creator)} <small>SOL*</small></strong><small>${fmt(r.treasury)} to treasury · ${fmt(r.locked)} locked<br>Trading fees only, before costs</small></div><div class="metric"><span class="metric-label">First buyer’s modeled exit</span><strong id="buyer-outcome" class="${r.buyerBlocked || returnPct < 0 ? "negative" : "mint"}">${r.buyerBlocked ? "Blocked" : `${fmt(r.buyerExit)} <small>SOL*</small>`}</strong><small>${r.buyerBlocked ? `Purchase exceeds the ${state.values.limit} SOL* guard.<br>No buyer trade is simulated.` : `${returnPct >= 0 ? "+" : ""}${fmt(returnPct, 1)}% vs ${fmt(state.values.buyer)} spent<br>Includes exit price impact and fees`}</small></div><div class="metric"><span class="metric-label">Graduation point</span><strong>${Number.isFinite(r.target) ? `${fmt(r.target, 0)} <small>SOL* net</small>` : "Not set"}</strong><small>${r.graduated ? `Endpoint reached · stops at ${fmt(r.gross)} gross` : Number.isFinite(r.target) ? `${fmt(r.progress, 1)}% there · ${fmt(r.target - r.net)} net to go` : "Connect graduation to set an endpoint"}</small>${Number.isFinite(r.target) ? `<div class="progress" role="meter" aria-label="Graduation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.progress.toFixed(1)}"><span style="width:${r.progress}%"></span></div>` : ""}</div><div class="metric risk"><div><span class="metric-label">Risk signals</span><strong>${r.risk}</strong><small>Not a safety rating</small></div><ul>${r.risks.map((text) => `<li>${text}</li>`).join("")}<li>All scenarios carry loss and implementation risk.</li></ul></div>${expert ? `<pre class="expert-data" style="grid-column:1/-1">${escape(`net quote: ${fmt(r.net, 4)} | gross modeled: ${fmt(r.gross, 4)}\nbuyer tokens: ${r.buyerBlocked ? "blocked" : fmt(r.buyerTokens, 0)}\nfee pool: ${fmt(r.feeTotal, 4)} | protocol: ${fmt(r.gross * 0.01, 4)}\nStops at graduation; no post-migration quote.`)}</pre>` : ""}`;
}
function render() {
  renderLibrary();
  renderCanvas();
  renderInspector();
  $("#scenario-controls").innerHTML = field("demand") + field("buyer");
  $("#beginner").setAttribute("aria-pressed", String(!expert));
  $("#expert").setAttribute("aria-pressed", String(expert));
  renderSimulation();
}
function selectModule(id) {
  selected = id;
  if (!connected(id)) {
    const parent = modules[id].parent;
    if (parent && !connected(parent))
      toast(`Connect ${modules[parent].title} before ${modules[id].title}.`);
    else {
      state.connected.push(id);
      toast(`${modules[id].title} connected. Simulation updated.`);
    }
  }
  render();
  persist();
  if (matchMedia("(max-width: 940px)").matches) {
    $("#inspector").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  }
  // Heading focus announces the selected module without opening a mobile keyboard.
  $(".inspector h2").focus({ preventScroll: true });
}
function modal(html) {
  $("#dialog-content").innerHTML = html;
  if (!$("#dialog").open) $("#dialog").showModal();
  const focus = $("#dialog [autofocus]") || $("#dialog-title");
  if (focus.id === "dialog-title") focus.tabIndex = -1;
  focus.focus();
}
const boundaries = `<h2 id="dialog-title">An idea is not an executable Hook.</h2><p>This standalone playground explores a plain launch shape. Every parameter and outcome is hypothetical, including the example defaults. Nothing is a recommended financial setting.</p><h3>What works here</h3><p>Connect six modules, edit their assumptions, inspect a deterministic curve, and export a local scenario. Governance and treasury locks change control disclosures, not market prices.</p><h3>What is not supported</h3><p>Fee splitting, recipient routing, treasury locks, governance, and safety modules are design concepts, not supported plain-Hook launch settings. Arbitrary custom hooks, Kit rules, Half-Life, burns, bytecode, and transaction imports are refused. The current repo.ing consumer remains gated and plain-only.</p><h3>Absolutely no chain actions</h3><p>No wallet connection, account storage, RPC requests, transaction construction, signing, deployment, or production imports. Scenario exports use a separate <code>repoing-playground/1</code> format; they cannot be used as Hook recipes.</p><h3>A separate metadata draft</h3><p>You can start a blank name and ticker draft for later review. No modules, settings or predicted returns carry over. This does not convert your experiment, choose a network, or enable a launch.</p><button id="plain-draft">Start separate plain draft</button><h3>Before any integration</h3><p>Reconcile each field with the approved SDK contract, independently review the economics and security, and explicitly authorize a separate integration. A green connection is not launch approval.</p>`;
const method = `<h2 id="dialog-title">A model you can inspect.</h2><p>The chart is a buy-only thought experiment, not a forecast or live quote. SOL* means illustrative SOL-equivalent quote units; actual Hook bridged-SOL is a custom token, not native SOL or SPL WSOL.</p><h3>Constant-product curve</h3><p>Start with 1 billion virtual tokens and your virtual quote reserve R. For cumulative gross demand D and total fee f (1% toy protocol fee + your trading fee), net quote Q = D × (1 − f). Remaining tokens = 1 billion × R / (R + Q). Spot price = (R + Q) / remaining tokens. These are not fresh Hook launch economics.</p><h3>Fees and first-buyer exit</h3><p>Creator revenue = D × trading fee × (1 − treasury share). The first buyer enters at launch and is included in D. Their tokens = 1 billion × net buy / (R + net buy). Their hypothetical exit sells all those tokens into the end-of-scenario reserves, subtracting both fees and price impact. It is not a guaranteed profit. Other buyers never sell in this model.</p><h3>Graduation and guards</h3><p>Demand is capped when net quote reaches the graduation target. No post-graduation market is modeled; buyer exit is immediately before migration. A blocked first-buyer purchase has no personal outcome; aggregate demand remains an independent scenario assumption, spread across other permitted buys.</p><h3>Risk and omissions</h3><p>Elevated means at least three flagged conditions; otherwise Moderate. Neither means safe. Delay and lock settings affect disclosures only. No sniper fee, fee tiers, supply allocations, gas, rent, priority fees, MEV, actual liquidity migration, or adversarial selling. The real protocol has additional fees and restrictions. Negative returns are possible even in this toy model.</p>`;
document.addEventListener("click", (event) => {
  const moduleButton = event.target.closest("[data-module]");
  if (moduleButton) {
    selectModule(moduleButton.dataset.module);
    return;
  }
  const id = event.target.closest("button")?.id;
  if (["boundary", "learn", "custom"].includes(id)) modal(boundaries);
  if (id === "method") modal(method);
  if (id === "close-dialog") $("#dialog").close();
  if (id === "plain-draft") {
    plainEnvelope = null;
    modal(`<h2 id="dialog-title">A new draft. A separate idea.</h2><p>No simulation settings carry over. Your canvas and saved experiment stay unchanged. This file contains a name and ticker only, with no rules or custom Hooks.</p><form id="plain-form" novalidate><label for="plain-name">Coin name</label><input id="plain-name" name="name" autocomplete="off" aria-describedby="plain-name-hint plain-name-error"><small id="plain-name-hint">1–32 UTF-8 bytes. Surrounding spaces are trimmed.</small><p class="error" id="plain-name-error"></p><label for="plain-ticker">Ticker</label><input id="plain-ticker" name="ticker" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="plain-ticker-hint plain-ticker-error"><small id="plain-ticker-hint">1–10 ASCII letters or digits. Exported as uppercase.</small><p class="error" id="plain-ticker-error"></p><label class="plain-confirm"><input id="plain-ack" type="checkbox" aria-describedby="plain-ack-error"><span>I understand this is metadata only, not launch approval or a conversion of my simulation.</span></label><p class="error" id="plain-ack-error"></p><p>Not saved in this browser. Download the file to keep it. No wallet, network, fees, mint or transaction is selected.</p><div class="recovery-actions"><button type="submit" class="primary">Review metadata</button><button type="button" id="cancel-change">Cancel</button></div></form><section id="plain-preview" hidden aria-labelledby="plain-review-title"><h3 id="plain-review-title" tabindex="-1">Metadata reviewed · execution unavailable</h3><p>Format checks only. Production preparation needs separately verified deployment, economics, identities and permission. Plain is not fee-free and is not a custom Hook.</p><textarea id="plain-json" aria-label="Plain metadata draft JSON" readonly></textarea><button id="download-plain">Download metadata draft ↓</button></section>`);
  }
  if (id === "download-plain" && plainEnvelope) {
    downloadText(JSON.stringify(plainEnvelope, null, 2), "hook-plain-metadata-draft.json");
    toast("Metadata draft downloaded. Simulation unchanged; no launch enabled.");
  }
  if (id === "cancel-change") $("#dialog").close();
  if (id === "confirm-change") {
    const action = confirmAction;
    confirmAction = null;
    $("#dialog").close();
    action?.();
  }
  if (id === "backup-draft") {
    downloadText(serializeDraft(draft()), "hook-playground-draft.json");
    toast(
      "Draft backup downloaded, including incomplete inputs. Keep it somewhere safe.",
    );
  }
  if (id === "recover-raw") {
    try {
      const raw = store.raw();
      if (raw === null)
        toast("No saved data is present. Back up this tab’s draft instead.");
      else downloadText(raw, "hook-playground-saved-data.json");
    } catch {
      storageStatus("unavailable");
    }
  }
  if (id === "reload-draft")
    confirmChange(
      "Load the saved draft?",
      "This replaces the work currently visible in this tab.",
      () => {
        restore();
        render();
      },
    );
  if (id === "replace-draft")
    confirmChange(
      "Replace saved data?",
      "This overwrites the saved version with this tab’s draft, including any incomplete inputs.",
      () => persist(true),
    );
  if (id === "beginner" || id === "expert") {
    expert = id === "expert";
    render();
    persist();
  }
  if (id === "module-action") {
    if (connected(selected)) {
      disconnect(state, selected);
      toast(`${modules[selected].title} and its dependents disconnected.`);
      render();
      persist();
      $("#module-action").focus();
    } else selectModule(selected);
  }
  if (id === "clear") {
    confirmChange(
      "Clear the canvas?",
      "All modules will be disconnected. Their settings are retained.",
      () => {
        state.connected = [];
        selected = "curve";
        render();
        persist();
        toast("Canvas cleared. Your module settings are retained.");
      },
    );
  }
  if (id === "reset" || id === "restore-example") {
    confirmChange(
      "Replace with the example?",
      "This resets all module settings and connections to the illustrative defaults.",
      () => {
        state = initialState();
        selected = "curve";
        render();
        persist();
        toast("Illustrative example restored.");
      },
    );
  }
  if (id === "export") {
    const json = exportScenario(state);
    modal(
      '<h2 id="dialog-title">Take the idea with you.</h2><p>A simulation-only scenario, not a launch recipe or transaction. Browser storage can be cleared; keep a downloaded copy of work you want to retain.</p><textarea id="export-json" aria-label="Exported scenario JSON" readonly></textarea><button class="primary" id="download">Download scenario</button>',
    );
    $("#export-json").value = json;
  }
  if (id === "download") {
    downloadText(exportScenario(state), "hook-playground-scenario.json");
    toast("Scenario downloaded. No Hook recipe or transaction was created.");
  }
  if (id === "import")
    modal(
      '<h2 id="dialog-title">Bring back an experiment.</h2><p>Paste a Playground scenario or draft backup (up to 32 KB). A draft can contain incomplete inputs. Custom hooks and production recipes are not supported.</p><textarea id="import-json" aria-label="Scenario or draft JSON" placeholder="Paste your Playground JSON…" spellcheck="false" maxlength="32768"></textarea><div id="import-error" class="error" role="alert"></div><button class="primary" id="apply-import">Validate & import</button>',
    );
  if (id === "apply-import") {
    try {
      const raw = $("#import-json").value;
      let next;
      try {
        next = parseDraft(raw);
      } catch {
        const imported = importScenario(raw);
        next = {
          state: imported,
          selected: imported.connected[0] || "curve",
          expert,
        };
      }
      confirmChange(
        "Replace with imported work?",
        "The file is recognized. Your current canvas and inputs will be replaced.",
        () => {
          ({ state, selected, expert } = next);
          render();
          persist();
          toast("Imported. Incomplete inputs must be fixed before simulation.");
        },
      );
    } catch (error) {
      $("#import-error").textContent = error.message;
      $("#import-json").setAttribute("aria-invalid", "true");
      $("#import-json").setAttribute("aria-describedby", "import-error");
    }
  }
});
document.addEventListener("submit", (event) => {
  if (event.target.id !== "plain-form") return;
  event.preventDefault();
  plainEnvelope = null;
  $("#plain-preview").hidden = true;
  for (const field of ["name", "ticker", "ack"]) {
    $(`#plain-${field}`).removeAttribute("aria-invalid");
    $(`#plain-${field}-error`).textContent = "";
  }
  try {
    const envelope = createPlainDraft({ name: $("#plain-name").value, ticker: $("#plain-ticker").value });
    if (!$("#plain-ack").checked)
      throw Object.assign(new Error("Confirm that this draft is separate from your simulation."), { field: "ack" });
    plainEnvelope = envelope;
    $("#plain-json").value = JSON.stringify(envelope, null, 2);
    $("#plain-preview").hidden = false;
    $("#plain-review-title").focus();
  } catch (error) {
    $(`#plain-${error.field}-error`).textContent = error.message;
    $(`#plain-${error.field}`).setAttribute("aria-invalid", "true");
    $(`#plain-${error.field}`).focus();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.closest("#plain-form")) {
    plainEnvelope = null;
    $("#plain-preview").hidden = true;
  }
  const key = event.target.dataset.field;
  if (!key) return;
  state.values[key] =
    event.target.value === "" ? null : Number(event.target.value);
  const f = fields[key],
    invalid =
      state.values[key] === null ||
      state.values[key] < f.min ||
      state.values[key] > f.max;
  for (const input of document.querySelectorAll(`[data-field="${key}"]`)) {
    if (input !== event.target) input.value = state.values[key] ?? "";
    input.setAttribute("aria-invalid", String(invalid));
  }
  $(`#${key}-error`).textContent = invalid
    ? `Enter ${f.min}–${f.max} ${f.unit}.`
    : "";
  const text = $(`#node-${f.module} small`);
  if (text) text.textContent = summary(f.module);
  renderSimulation();
  persist();
});
window.addEventListener("storage", (event) => {
  if (event.key === DRAFT_KEY || event.key === null) {
    store.block();
    storageStatus("conflict");
  }
});
window.addEventListener("beforeunload", (event) => {
  if (
    pendingSaves ||
    ["unavailable", "unreadable", "conflict"].includes(saveStatus)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
new ResizeObserver(() => {
  drawConnections();
  const r = simulate(state);
  if (!r.errors.length && !r.empty) drawChart(r);
}).observe($("#canvas"));
restore();
render();
$("#startup-error").hidden = true;
