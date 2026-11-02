// HSP A2A Settlement Terminal — client controller.
// Drives the pipeline, the two authorization gates, the event tape, and the receipt
// from the server's SSE flow events. No build step; plain ES modules.

// Same nine stage ids for both rails; the labels describe what each rail actually does.
const STAGE_SETS = {
  hsp: [
    { id: "a2a", title: "A2A request", detail: "Receiving agent transmits conditions" },
    { id: "config", title: "Chain config", detail: "get_chain_config — authoritative" },
    { id: "order", title: "Create order", detail: "x402 cart mandate" },
    { id: "quote", title: "Prepare quote", detail: "EIP-712 + token_total_raw" },
    { id: "sign", title: "Authorize & sign", detail: "human key · 1 of 2" },
    { id: "finalize", title: "Finalize", detail: "payment mandate (JWT)" },
    { id: "submit", title: "Authorize & submit", detail: "human key · 2 of 2 → Gateway" },
    { id: "settle", title: "Settle on-chain", detail: "query_payment" },
    { id: "deliver", title: "Deliver resource", detail: "service released on settlement" },
  ],
  onchain: [
    { id: "a2a", title: "A2A request", detail: "Receiving agent transmits conditions" },
    { id: "config", title: "Read service on-chain", detail: "price, token, payout from A2ASettlement" },
    { id: "order", title: "Bind request on-chain", detail: "request id → escrow key" },
    { id: "quote", title: "EIP-3009 authorization", detail: "nonce bound to this request + service" },
    { id: "sign", title: "Authorize & sign", detail: "human key · 1 of 2 · payer needs no gas" },
    { id: "finalize", title: "Hand to receiving agent", detail: "signed authorization over A2A" },
    { id: "submit", title: "Authorize relay", detail: "human key · 2 of 2 → escrow on HSK Chain" },
    { id: "settle", title: "Escrow verified on-chain", detail: "receiving agent reads the escrow state" },
    { id: "deliver", title: "Deliver & release", detail: "resource hash anchored, funds released" },
  ],
};

const $ = (sel) => document.querySelector(sel);
const el = {
  pipeline: $("#pipeline"),
  tape: $("#tape"),
  tapeEmpty: $("#tape-empty"),
  form: $("#pay-form"),
  initiateBtn: $("#btn-initiate"),
  initiateNote: $("#initiate-note"),
  clearBtn: $("#btn-clear"),
  gate: $("#gate"),
  gateTitle: $("#gate-title"),
  gateSub: $("#gate-sub"),
  gatePayto: $("#gate-payto"),
  gatePayer: $("#gate-payer"),
  gateRaw: $("#gate-raw"),
  gateHuman: $("#gate-human"),
  gateApprove: $("#gate-approve"),
  gateApproveLabel: $("#gate-approve-label"),
  gateReject: $("#gate-reject"),
  receipt: $("#receipt"),
  receiptBody: $("#receipt-body"),
  receiptFoot: $("#receipt-foot"),
  services: $("#services"),
  servicesLoading: $("#services-loading"),
  serviceBanner: $("#service-banner"),
  serviceBannerText: $("#service-banner-text"),
  resource: $("#resource"),
  resourceTitle: $("#resource-title"),
  resourceSub: $("#resource-sub"),
  resourceBody: $("#resource-body"),
  modeBadge: $("#mode-badge"),
  modeLabel: $("#mode-label"),
  footerModeNote: $("#footer-mode-note"),
  // agents
  recv: $("#agent-recv"),
  pay: $("#agent-pay"),
  wire: $(".wire"),
  factMerchant: $("#fact-merchant"),
  factPayto: $("#fact-payto"),
  factAmount: $("#fact-amount"),
  factPayer: $("#fact-payer"),
  factNetwork: $("#fact-network"),
  factProtocol: $("#fact-protocol"),
  paytoInput: $("#in-payto"),
  paytoHint: $("#payto-hint"),
  railToggle: $("#rail-toggle"),
  railNote: $("#rail-note"),
  receiptTitle: $("#receipt-title"),
};

let mode = "mock";
let rail = "hsp"; // "onchain" | "hsp"
let railInfo = { onchain: { available: false }, hsp: { mode: "mock" } };
let running = false;
let session = null;
let evtSource = null;
let pendingTimer = null;
let currentApprovalStage = null;
let lastLiveStage = null;
let completed = false;

// ───────────────────────── init ─────────────────────────

function buildPipeline() {
  el.pipeline.innerHTML = "";
  for (const s of STAGE_SETS[rail]) {
    const li = document.createElement("li");
    li.className = "stage-row";
    li.id = `stage-${s.id}`;
    li.dataset.state = "idle";
    li.innerHTML = `
      <span class="stage-node" aria-hidden="true"></span>
      <div class="stage-main">
        <div class="stage-title">${s.title}</div>
        <div class="stage-detail">${s.detail}</div>
      </div>
      <span class="stage-chip">idle</span>`;
    el.pipeline.appendChild(li);
  }
}

function setStage(id, state, { detail, chip } = {}) {
  const row = document.getElementById(`stage-${id}`);
  if (!row) return;
  row.dataset.state = state;
  if (detail !== undefined) row.querySelector(".stage-detail").textContent = detail;
  const chipEl = row.querySelector(".stage-chip");
  chipEl.textContent = chip ?? state;
  if (state === "active" || state === "awaiting") lastLiveStage = id;
}

function resetRun() {
  completed = false;
  lastLiveStage = null;
  currentApprovalStage = null;
  buildPipeline();
  hideGate();
  el.receipt.hidden = true;
  el.resource.hidden = true;
  el.resource.classList.remove("is-denied");
  el.serviceBanner.hidden = true;
  el.tape.querySelectorAll(".tape-line").forEach((n) => n.remove());
  el.tapeEmpty.hidden = true;
  el.clearBtn.disabled = false;
  for (const a of [el.recv, el.pay]) {
    a.classList.remove("is-active");
    a.querySelector(".agent-status").dataset.state = "idle";
    a.querySelector(".agent-status").textContent = "idle";
  }
  [el.factMerchant, el.factPayto, el.factAmount, el.factPayer, el.factNetwork, el.factProtocol].forEach(
    (n) => (n.textContent = "·"),
  );
}

function setAgent(which, state) {
  const a = which === "recv" ? el.recv : el.pay;
  const s = a.querySelector(".agent-status");
  s.dataset.state = state;
  s.textContent = state;
  a.classList.toggle("is-active", state === "active");
}

function fireWire() {
  el.wire.classList.remove("is-firing");
  void el.wire.offsetWidth; // reflow to restart animation
  el.wire.classList.add("is-firing");
}

// ───────────────────────── tape ─────────────────────────

const TONE = {
  ok: new Set(["order_created", "signed", "finalized", "submitted", "onchain_tx", "resource_delivered"]),
  warn: new Set(["quote_reprepared", "resource_denied"]),
  fail: new Set(["error"]),
  auth: new Set(["approval_requested"]),
};

function toneFor(e) {
  if (e.type === "terminal") {
    if (e.status === "payment-finalized" || e.status === "payment-escrowed") return "ok";
    if (e.status === "payment-failed") return "fail";
    return "warn";
  }
  for (const [tone, set] of Object.entries(TONE)) if (set.has(e.type)) return tone;
  return "info";
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}

function tape(e, msg) {
  el.tapeEmpty.hidden = true;
  const li = document.createElement("li");
  li.className = "tape-line";
  li.dataset.tone = toneFor(e);
  li.innerHTML = `
    <span class="tape-time">${fmtTime(e.at)}</span>
    <span class="tape-body"><span class="tape-kind">${e.type}</span>
    <span class="tape-msg"></span></span>`;
  li.querySelector(".tape-msg").textContent = msg ? ` ${msg}` : "";
  el.tape.appendChild(li);
  el.tape.scrollTop = el.tape.scrollHeight;
  return li;
}

/** A tape line for a real transaction, linking to the block explorer when known. */
function tapeTx(e) {
  const li = tape(e, `${e.label} · ${e.network}`);
  const body = li.querySelector(".tape-body");
  const node = e.explorerUrl ? document.createElement("a") : document.createElement("span");
  node.className = "tape-tx";
  node.textContent = `${short(e.hash)}${e.explorerUrl ? " ↗" : ""}`;
  if (e.explorerUrl) {
    node.href = e.explorerUrl;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    node.title = `View ${e.label} transaction on the explorer`;
  }
  body.append(" ", node);
}

function short(addr) {
  if (!addr || addr.length < 12) return addr ?? "·";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ───────────────────────── event handling ─────────────────────────

function applyEvent(e) {
  switch (e.type) {
    case "service_requested":
      el.serviceBannerText.textContent = `Buying: ${e.name} · ${e.priceUsd} USD`;
      el.serviceBanner.hidden = false;
      tape(e, `${e.name} (${e.priceUsd} USD)`);
      break;

    case "a2a_request_received":
      el.factMerchant.textContent = e.merchantName;
      el.factPayto.textContent = short(e.payTo);
      el.factPayto.title = e.payTo;
      el.factAmount.textContent = `${e.amountUsd} USD`;
      setAgent("recv", "active");
      setAgent("pay", "active");
      fireWire();
      setStage("a2a", "done", { chip: "sent" });
      setStage("config", "active");
      tape(e, `${e.merchantName} → ${e.amountUsd} USD`);
      break;

    case "chain_config":
      el.factNetwork.textContent = `${e.network} (${e.chainId})`;
      el.factProtocol.textContent = `${e.tokenSymbol || "token"} · ${e.protocol}`;
      setStage("config", "done", { detail: `${e.network} · ${e.tokenSymbol} · ${e.protocol}`, chip: "read" });
      setStage("order", "active");
      tape(e, `${e.network} · ${e.tokenSymbol} · ${e.protocol}${e.ambiguous ? " (ambiguous)" : ""}`);
      break;

    case "order_created":
      if (rail === "onchain") {
        setStage("order", "done", { detail: `request ${short(e.flowId)} · escrow ${short(e.paymentRequestId)}`, chip: "bound" });
        tape(e, `request=${e.flowId}`);
      } else {
        setStage("order", "done", { detail: `flow_id ${short(e.flowId)}`, chip: "created" });
        tape(e, `flow_id=${e.flowId}`);
      }
      setStage("quote", "active");
      break;

    case "quote_prepared":
      el.factPayer.textContent = short(e.payer);
      el.factPayer.title = e.payer;
      setStage("quote", "done", { detail: `${e.tokenTotalHuman} · ${e.primaryType}`, chip: "locked" });
      setStage("sign", "active");
      tape(e, `${e.tokenTotalHuman} (raw ${e.tokenTotalRaw})`);
      break;

    case "approval_requested":
      currentApprovalStage = e.stage;
      setStage(e.stage, "awaiting", { chip: "awaiting you" });
      showGate(e);
      tape(e, `${e.stage} · ${e.tokenTotalHuman}`);
      break;

    case "approval_resolved":
      hideGate();
      if (e.approved) {
        setStage(e.stage, "active", { chip: "authorized" });
        tape(e, `${e.stage} authorized`);
      } else {
        tape(e, `${e.stage} rejected`);
      }
      break;

    case "signed":
      setStage("sign", "active", { detail: `signature ${e.signaturePreview}`, chip: "signed" });
      tape(e, e.signaturePreview);
      break;

    case "finalized":
      setStage("sign", "done", { chip: "signed" });
      setStage("finalize", "done", { chip: rail === "onchain" ? "handed over" : "finalized" });
      setStage("submit", "active");
      tape(e, rail === "onchain" ? "signed authorization handed to the receiving agent" : "payment mandate assembled");
      break;

    case "onchain_tx":
      tapeTx(e);
      if (e.label === "escrow") {
        setStage("submit", "done", { detail: `escrow tx ${short(e.hash)}`, chip: "relayed" });
        setStage("settle", "active", { detail: "verifying escrow on-chain…" });
      } else if (e.label === "release") {
        setStage("deliver", "active", { detail: `release tx ${short(e.hash)}`, chip: "releasing" });
      }
      break;

    case "submitted":
      setStage("submit", "done", { chip: rail === "onchain" ? "relayed" : "submitted" });
      setStage("settle", "active", { detail: e.status });
      tape(e, e.status);
      break;

    case "status_poll": {
      const tx = e.txSignature ? ` · ${short(e.txSignature)}` : "";
      setStage("settle", "active", { detail: `${e.status}${tx}`, chip: e.status.replace("payment-", "") });
      tape(e, `${e.status}${e.attributionVerified !== undefined ? ` · attribution=${e.attributionVerified}` : ""}`);
      break;
    }

    case "quote_reprepared":
      setStage("sign", "active", { chip: "re-quoting" });
      tape(e, e.reason);
      break;

    case "terminal": {
      const st = e.status;
      const ok = st === "payment-finalized" || st === "payment-escrowed";
      const settleState = ok ? "done" : st === "payment-failed" ? "fail" : "warn";
      setStage("settle", settleState, { detail: st, chip: st.replace("payment-", "") });
      // The delivery step now runs: the Receiving Agent verifies and releases (or not).
      setStage("deliver", "active", { chip: "verifying" });
      setAgent("recv", "done");
      setAgent("pay", "done");
      tape(e, e.message);
      break;
    }

    case "resource_delivered":
      setStage("deliver", "done", { detail: e.title, chip: rail === "onchain" ? "released" : "delivered" });
      renderResource(e, false);
      tape(e, e.title);
      break;

    case "resource_denied":
      setStage("deliver", "warn", { detail: "withheld", chip: "withheld" });
      renderResource(e, true);
      tape(e, e.reason);
      break;

    case "error":
      if (lastLiveStage) setStage(lastLiveStage, "fail", { chip: "error" });
      tape(e, e.message);
      finishRun();
      el.initiateNote.textContent = e.message;
      el.initiateNote.classList.add("is-error");
      break;

    case "log":
      if (e.message === "__flow_complete__") {
        finishRun();
      } else {
        tape(e, e.message);
      }
      break;

    default:
      tape(e, JSON.stringify(e));
  }
}

// ───────────────────────── authorization gate ─────────────────────────

let authFill = null;
let holdRAF = null;
let holdStart = 0;
let holdResolved = false;
const HOLD_MS = 650;

function ensureAuthFill() {
  if (!authFill) {
    authFill = document.createElement("span");
    authFill.className = "auth-fill";
    el.gateApprove.prepend(authFill);
  }
}

const AUTOPLAY = new URLSearchParams(location.search).has("autoplay");

function showGate(e) {
  ensureAuthFill();
  holdResolved = false;
  const isSign = e.stage === "sign";
  const onchain = rail === "onchain";
  el.gateTitle.textContent = isSign ? "Authorize to sign" : onchain ? "Authorize the escrow relay" : "Authorize to submit";
  el.gateSub.textContent = isSign
    ? onchain
      ? "You are signing a gasless EIP-3009 authorization bound to this exact request. Review before you hold."
      : "You are authorizing the EIP-712 signature. Review before you hold."
    : onchain
      ? "The receiving agent will relay your signature and lock the funds in escrow on HSK Chain."
      : "You are authorizing submission to the HSP Gateway. Review once more.";
  el.gatePayto.textContent = e.payTo;
  el.gatePayer.textContent = e.payer;
  el.gateRaw.textContent = e.tokenTotalRaw;
  el.gateHuman.textContent = e.tokenTotalHuman;
  el.gateApproveLabel.textContent = "Hold to authorize";
  setHold(0);
  el.gate.hidden = false;
  el.gateApprove.focus({ preventScroll: true });
  // Hands-free demo: auto-authorize after a beat so judges can watch the flow run.
  // Track the timer so a prior gate's timer can't fire against a later gate.
  if (AUTOPLAY) {
    if (autoplayTimer) clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => completeApprove(), 1400);
  }
}

let autoplayTimer = null;

function hideGate() {
  cancelHold();
  if (autoplayTimer) {
    clearTimeout(autoplayTimer);
    autoplayTimer = null;
  }
  el.gate.hidden = true;
}

function setHold(p) {
  el.gateApprove.style.setProperty("--hold", String(p));
  const knob = el.gateApprove.querySelector(".auth-knob");
  if (knob) knob.style.left = `${2 + p * 20}px`;
}

function beginHold() {
  if (holdResolved) return;
  holdStart = performance.now();
  const tick = () => {
    const p = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
    setHold(p);
    if (p >= 1) return completeApprove();
    holdRAF = requestAnimationFrame(tick);
  };
  holdRAF = requestAnimationFrame(tick);
}

function cancelHold() {
  if (holdRAF) cancelAnimationFrame(holdRAF);
  holdRAF = null;
  if (!holdResolved) setHold(0);
}

async function completeApprove() {
  if (holdResolved) return;
  holdResolved = true;
  cancelHold();
  setHold(1);
  el.gateApproveLabel.textContent = "Authorized";
  await resolveApproval(true);
}

async function resolveApproval(approved) {
  const stage = currentApprovalStage;
  if (!stage || !session) return;
  currentApprovalStage = null;
  el.gate.hidden = true;
  try {
    await fetch(`/api/approve/${session}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, approved }),
    });
  } catch (err) {
    el.initiateNote.textContent = `Could not send approval: ${err}`;
    el.initiateNote.classList.add("is-error");
  }
}

// ───────────────────────── receipt ─────────────────────────

function renderReceipt(qaText) {
  if (!qaText) return;
  const [title, ...rest] = qaText.split("\n");
  el.receiptTitle.textContent = title || "Settlement receipt";
  const lines = rest.filter((l) => l.includes(":"));
  el.receiptBody.innerHTML = "";
  let status = "";
  for (const line of lines) {
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    if (/^https?:\/\//.test(val)) {
      const a = document.createElement("a");
      a.href = val;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `${val} ↗`;
      dd.appendChild(a);
    } else {
      dd.textContent = val || "unavailable";
    }
    if (/payment status/i.test(key)) {
      status = val;
      if (val === "payment-finalized" || val === "payment-released") dd.className = "status-finalized";
      else if (val === "payment-safe") dd.className = "status-safe";
      else if (val === "payment-failed") dd.className = "status-failed";
    }
    div.append(dt, dd);
    el.receiptBody.appendChild(div);
  }
  const net = railInfo.onchain?.label ?? "HSK Chain";
  el.receiptFoot.textContent =
    status === "payment-released"
      ? `Real transactions on ${net}. The receiving agent verified the escrow on-chain before delivering; the delivery hash is anchored in the release transaction.`
      : mode === "mock"
        ? "Mock run — offline simulation of the HSP flow. Not a real on-chain payment. Use the HSK Chain escrow rail for real transactions, or HSP_MODE=live (allowlisted IP + funded wallet)."
        : status === "payment-finalized"
          ? "Final confirmation reached on HashKey via the HSP Gateway."
          : "Live HSP result. Status is reported exactly as returned — never inferred.";
  el.receipt.hidden = false;
  el.receipt.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderResource(e, denied) {
  el.resource.classList.toggle("is-denied", denied);
  if (denied) {
    el.resourceTitle.textContent = "Resource withheld";
    el.resourceSub.textContent = e.reason ?? "The resource was not released.";
    el.resourceBody.textContent = "";
  } else {
    el.resourceTitle.textContent = e.title ?? "Resource delivered";
    el.resourceSub.textContent =
      rail === "onchain"
        ? "The Receiving Agent verified the escrow on HSK Chain, delivered this resource, and anchored its hash to release the funds."
        : "The Receiving Agent verified settlement and released the resource to the Payment Agent.";
    el.resourceBody.textContent = formatResourceBody(e.contentType, e.body);
  }
  el.resource.hidden = false;
  el.resource.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function formatResourceBody(contentType, body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

// ───────────────────────── services ─────────────────────────

async function loadServices() {
  let services = [];
  try {
    const data = await fetch("/api/services").then((r) => r.json());
    services = Array.isArray(data.services) ? data.services : [];
  } catch {
    /* fall through to empty */
  }
  if (services.length === 0) {
    el.servicesLoading.textContent = "No services available.";
    return;
  }
  el.servicesLoading.remove();
  services.forEach((s, i) => {
    const label = document.createElement("label");
    label.className = "service-card";
    label.innerHTML = `
      <input type="radio" name="service" value="${s.id}" ${i === 0 ? "checked" : ""} />
      <span class="svc-text">
        <span class="svc-name"></span>
        <span class="svc-desc"></span>
      </span>
      <span class="svc-price"></span>`;
    label.querySelector(".svc-name").textContent = s.name;
    label.querySelector(".svc-desc").textContent = s.description;
    label.querySelector(".svc-price").textContent = `${s.priceUsd} USD`;
    el.services.appendChild(label);
  });
}

function selectedServiceId() {
  const checked = el.services.querySelector('input[name="service"]:checked');
  return checked ? checked.value : "hsk-market-snapshot";
}

// ───────────────────────── run lifecycle ─────────────────────────

function finishRun() {
  if (completed) return;
  completed = true;
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }
  setBusy(false);
  // Fetch the final QA result + any error.
  if (session) {
    fetch(`/api/pending/${session}`)
      .then((r) => r.json())
      .then((s) => {
        if (s.qa) renderReceipt(s.qa);
        if (s.error && !el.initiateNote.textContent) {
          el.initiateNote.textContent = s.error;
          el.initiateNote.classList.add("is-error");
        }
      })
      .catch(() => {});
  }
  if (pendingTimer) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
}

function setBusy(busy) {
  running = busy;
  el.initiateBtn.disabled = busy;
  el.initiateBtn.classList.toggle("is-busy", busy);
  el.initiateBtn.querySelector(".btn-label").textContent = busy ? "Running…" : "Initiate payment";
  el.form.querySelectorAll("input").forEach((i) => (i.disabled = busy));
  // The on-chain rail pays the provider registered in the contract, so pay_to stays locked.
  if (!busy && rail === "onchain") el.paytoInput.disabled = true;
}

async function startRun(evt) {
  evt.preventDefault();
  if (!el.form.reportValidity()) return;
  el.initiateNote.textContent = "";
  el.initiateNote.classList.remove("is-error");

  const body = {
    rail,
    merchantName: $("#in-merchant").value.trim(),
    payTo: el.paytoInput.value.trim(),
    serviceId: selectedServiceId(),
  };

  setBusy(true);
  resetRun();

  let res;
  try {
    res = await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  } catch (err) {
    el.initiateNote.textContent = `Could not start: ${err}`;
    el.initiateNote.classList.add("is-error");
    setBusy(false);
    return;
  }

  if (res.error) {
    el.initiateNote.textContent = res.error;
    el.initiateNote.classList.add("is-error");
    setBusy(false);
    return;
  }

  session = res.sessionId;
  subscribe(session);
  // Safety net: poll pending for terminal state even if SSE drops.
  pendingTimer = setInterval(() => {
    if (!session) return;
    fetch(`/api/pending/${session}`)
      .then((r) => r.json())
      .then((s) => {
        // Fallback: if an approval is pending but the gate was never opened
        // (missed SSE frame), open it from the poll.
        if (s.pending && el.gate.hidden && !completed) openGateFromPending(s.pending);
        if (s.done) finishRun();
      })
      .catch(() => {});
  }, 1500);
}

function openGateFromPending(p) {
  if (!p) return;
  currentApprovalStage = p.key || p.stage;
  showGate({
    stage: currentApprovalStage,
    payTo: p.payTo,
    payer: p.payer,
    tokenTotalRaw: p.tokenTotalRaw,
    tokenTotalHuman: p.tokenTotalHuman,
  });
}

function subscribe(id) {
  evtSource = new EventSource(`/api/stream/${id}`);
  evtSource.onmessage = (msg) => {
    try {
      applyEvent(JSON.parse(msg.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  // Named reconnect frame: open the gate if a request is pending on (re)connect.
  evtSource.addEventListener("approval", (msg) => {
    try {
      if (el.gate.hidden) openGateFromPending(JSON.parse(msg.data));
    } catch {
      /* ignore */
    }
  });
  evtSource.onerror = () => {
    // The browser auto-reconnects; if the run already finished, stop.
    if (completed && evtSource) {
      evtSource.close();
      evtSource = null;
    }
  };
}

// ───────────────────────── wiring ─────────────────────────

async function loadMode() {
  let defaultRail = "hsp";
  try {
    const data = await fetch("/api/mode").then((r) => r.json());
    mode = data.mode || "mock";
    railInfo = data.rails ?? railInfo;
    defaultRail = data.defaultRail === "onchain" ? "onchain" : "hsp";
  } catch {
    mode = "mock";
  }
  const onchainRadio = el.railToggle.querySelector('input[value="onchain"]');
  const onchainOpt = onchainRadio.closest(".rail-opt");
  const oc = railInfo.onchain ?? {};
  onchainRadio.disabled = !oc.available;
  onchainOpt.classList.toggle("is-unavailable", !oc.available);
  onchainOpt.querySelector("small").textContent = oc.available ? `${oc.label} · real tx` : "unavailable";
  el.railToggle.querySelector('input[value="hsp"] ~ small').textContent =
    mode === "live" ? "HSP MCP · live" : "HSP MCP · mock";
  applyRail(defaultRail);
}

/** Switch the active settlement rail and update everything that depends on it. */
function applyRail(next) {
  rail = next;
  const radio = el.railToggle.querySelector(`input[value="${next}"]`);
  if (radio) radio.checked = true;
  const oc = railInfo.onchain ?? {};

  if (next === "onchain") {
    el.paytoInput.value = oc.payTo ?? el.paytoInput.value;
    el.paytoInput.disabled = true;
    el.paytoHint.classList.remove("is-error");
    el.paytoHint.textContent = "Locked: the provider's payout address registered in the escrow contract.";
    el.railNote.innerHTML = "";
    el.railNote.append(`Escrow on ${oc.label}: `);
    const link = document.createElement(oc.settlementUrl ? "a" : "span");
    link.textContent = short(oc.settlement);
    if (oc.settlementUrl) {
      link.href = oc.settlementUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    el.railNote.append(link, `. Payer ${short(oc.payer)} signs; it never needs gas.`);
  } else {
    el.paytoInput.disabled = running;
    el.paytoHint.textContent = "42-char EVM address, 0x…";
    el.railNote.textContent =
      mode === "live"
        ? "Live HSP Gateway via MCP. Approvals gate real signatures."
        : "HSP Gateway flow against a faithful mock (the QA endpoint needs an allowlisted IP).";
  }

  $("#pipeline-sub").textContent =
    next === "onchain"
      ? "services → authorizationNonce → sign EIP-3009 → settleWithAuthorization → getPayment → confirmDelivery"
      : "get_chain_config → create_order → prepare → sign → finalize → submit → query → deliver";
  $("#pay-sub").textContent =
    next === "onchain"
      ? "Signs a gasless EIP-3009 authorization; funds lock in escrow on HSK Chain."
      : "Builds the x402 mandate, signs, settles via HSP Gateway.";

  const live = next === "onchain" ? oc.network !== "local" : mode === "live";
  el.modeLabel.textContent =
    next === "onchain" ? (oc.network === "local" ? "local chain" : `live · ${oc.label ?? "HSK Chain"}`) : mode;
  el.modeBadge.classList.toggle("mode-live", live);
  el.modeBadge.classList.toggle("mode-mock", !live);
  el.footerModeNote.textContent =
    next === "onchain"
      ? `On-chain rail — real transactions on ${oc.label ?? "HSK Chain"}.`
      : mode === "live"
        ? "Live mode — real HSP MCP server. Approvals gate real signatures."
        : "Mock mode — offline simulation. Not a real on-chain payment.";

  if (!running) buildPipeline();
}

function wireRailToggle() {
  el.railToggle.addEventListener("change", (e) => {
    if (e.target?.name === "rail" && !running) applyRail(e.target.value);
  });
}

function wireGate() {
  el.gateApprove.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    beginHold();
  });
  el.gateApprove.addEventListener("pointerup", cancelHold);
  el.gateApprove.addEventListener("pointerleave", cancelHold);
  el.gateApprove.addEventListener("pointercancel", cancelHold);
  // Keyboard accessibility: Enter/Space authorizes immediately.
  el.gateApprove.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      completeApprove();
    }
  });
  el.gateReject.addEventListener("click", () => resolveApproval(false));
}

function wirePaytoValidation() {
  el.paytoInput.addEventListener("input", () => {
    const ok = /^0x[0-9a-fA-F]{40}$/.test(el.paytoInput.value.trim());
    el.paytoHint.textContent = ok || el.paytoInput.value === ""
      ? "42-char EVM address, 0x…"
      : "Not a valid 0x EVM address (need 0x + 40 hex)";
    el.paytoHint.classList.toggle("is-error", !ok && el.paytoInput.value !== "");
  });
}

el.form.addEventListener("submit", startRun);
el.clearBtn.addEventListener("click", () => {
  el.tape.querySelectorAll(".tape-line").forEach((n) => n.remove());
  el.tapeEmpty.hidden = false;
  el.clearBtn.disabled = true;
});

buildPipeline();
wireGate();
wirePaytoValidation();
wireRailToggle();
loadServices();
loadMode().then(() => {
  // Hands-free demo mode (?autoplay=1): kick off a run once the rail is known.
  if (AUTOPLAY) setTimeout(() => el.form.requestSubmit(), 600);
});
