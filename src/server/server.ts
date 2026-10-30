/**
 * HTTP + SSE server backing the web UI. It wires a Receiving Agent and a Payment
 * Agent, streams the live flow to the browser, and collects the two human
 * approvals through the UI (DeferredApprovalGate).
 *
 * Runs against the mock by default; set HSP_MODE=live to use the real HSP MCP
 * server (requires an allowlisted egress IP + a funded, approved wallet).
 *
 * Run: `pnpm dev`  →  http://localhost:4100
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express, { type Request, type Response } from "express";
import { ReceivingAgent, defaultCatalog } from "../a2a/receiving-agent.js";
import { A2AExchange } from "../a2a/exchange.js";
import { DeferredApprovalGate, type ApprovalRequest } from "../agent/approvals.js";
import { MockHspClient } from "../hsp/mock-client.js";
import { McpHspClient } from "../hsp/mcp-client.js";
import { BurnerSigner } from "../signer/burner.js";
import { formatQaResult } from "../agent/report.js";
import type { HspClient } from "../hsp/client.js";
import type { PaymentSigner } from "../signer/signer.js";
import type { FlowEvent } from "../agent/events.js";
import { now } from "../agent/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "..", "public");
const PORT = Number(process.env.PORT ?? 4100);
const MODE = (process.env.HSP_MODE ?? "mock").toLowerCase(); // "mock" | "live"

// Hardhat account #0 — throwaway demo key, mock/testnet only.
const DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface Session {
  id: string;
  events: FlowEvent[];
  clients: Set<Response>;
  gate: DeferredApprovalGate;
  pendingApproval: (ApprovalRequest & { key: string }) | null;
  done: boolean;
  qa?: string;
  error?: string;
}

const sessions = new Map<string, Session>();

function broadcast(session: Session, event: FlowEvent): void {
  const id = session.events.push(event); // 1-based index == SSE event id
  const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of session.clients) res.write(frame);
}

function buildHspClient(): HspClient {
  if (MODE === "live") {
    const url = process.env.HSP_MCP_URL?.trim() || "https://mcp-qa.hashkeymerchant.com/";
    return new McpHspClient(url);
  }
  return new MockHspClient({ pollsBeforeTerminal: 3, terminal: "payment-finalized" });
}

function buildSigner(): PaymentSigner {
  const key = process.env.BURNER_PRIVATE_KEY?.trim();
  if (MODE === "live" && !key) {
    throw new Error("HSP_MODE=live requires BURNER_PRIVATE_KEY (or wire the OKX signer).");
  }
  return new BurnerSigner(key && key.length > 0 ? key : DEMO_KEY);
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/api/mode", (_req, res) => {
  res.json({ mode: MODE });
});

/** The Receiving Agent's service catalog (what the Payment Agent can buy). */
app.get("/api/services", (_req, res) => {
  res.json({
    services: defaultCatalog().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      priceUsd: s.priceUsd,
    })),
  });
});

/** Start an A2A purchase. Returns a session id the UI subscribes to over SSE. */
app.post("/api/pay", async (req: Request, res: Response) => {
  const merchantName = String(req.body?.merchantName ?? "demo-team").trim() || "demo-team";
  const payTo = String(req.body?.payTo ?? "0x" + "2".repeat(40)).trim();
  const serviceId = String(req.body?.serviceId ?? "hsk-market-snapshot").trim();

  const network = req.body?.network ? String(req.body.network).trim() : undefined;
  const tokenSymbol = req.body?.tokenSymbol ? String(req.body.tokenSymbol).trim() : undefined;
  const constraints = network || tokenSymbol ? { network, tokenSymbol } : undefined;

  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    res.status(400).json({ error: "payTo must be a 0x EVM address (42 chars)" });
    return;
  }
  if (!defaultCatalog().some((s) => s.id === serviceId)) {
    res.status(400).json({ error: `unknown serviceId: ${serviceId}` });
    return;
  }

  const id = `sess-${Math.random().toString(36).slice(2, 10)}`;
  const gate = new DeferredApprovalGate();
  const session: Session = {
    id,
    events: [],
    clients: new Set(),
    gate,
    pendingApproval: null,
    done: false,
  };
  sessions.set(id, session);

  gate.setOnRequest((approvalReq, key) => {
    session.pendingApproval = { ...approvalReq, key };
  });

  res.json({ sessionId: id });

  // Run the flow asynchronously; events stream over SSE.
  void (async () => {
    const hsp = buildHspClient();
    try {
      let signer: PaymentSigner;
      try {
        signer = buildSigner();
      } catch (e) {
        broadcast(session, { type: "error", at: now(), message: String((e as Error).message) });
        session.error = String((e as Error).message);
        session.done = true;
        return;
      }

      if (MODE === "live" && hsp instanceof McpHspClient) {
        await hsp.verifyTools();
      }

      const receiving = new ReceivingAgent(merchantName, payTo);
      const exchange = new A2AExchange(
        receiving,
        hsp,
        signer,
        gate,
        {
          merchantName,
          pollIntervalMs: MODE === "live" ? 15_000 : 900,
          // Human token amount; converted to raw units with the live token decimals.
          maxTokenAmount: process.env.MAX_TOKEN_AMOUNT?.trim() || "5",
          // Proceed on ambiguity (picking the first match, with a loud warning); pin
          // a specific option by passing network/tokenSymbol constraints.
          allowAmbiguousOption: true,
        },
        (event) => broadcast(session, event),
      );

      const { qa } = await exchange.purchase(serviceId, constraints);
      session.qa = formatQaResult(qa);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      broadcast(session, { type: "error", at: now(), message });
      session.error = message;
    } finally {
      session.pendingApproval = null;
      session.done = true;
      broadcast(session, { type: "log", at: now(), message: "__flow_complete__" });
      await hsp.close?.();
      // Free the session after a grace period for late UI polls/receipt fetch.
      setTimeout(() => sessions.delete(session.id), 5 * 60_000).unref?.();
    }
  })();
});

/** SSE stream of flow events for a session. */
app.get("/api/stream/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  // Resume from Last-Event-ID on reconnect so events are never duplicated; a
  // fresh subscriber (no id) gets the full buffered history.
  const lastId = Number.parseInt(String(req.headers["last-event-id"] ?? "0"), 10) || 0;
  for (let i = lastId; i < session.events.length; i++) {
    res.write(`id: ${i + 1}\ndata: ${JSON.stringify(session.events[i])}\n\n`);
  }
  if (session.pendingApproval) {
    res.write(`event: approval\ndata: ${JSON.stringify(session.pendingApproval)}\n\n`);
  }
  session.clients.add(res);
  req.on("close", () => session.clients.delete(res));
});

/** The UI polls this to learn about a pending approval (robust alongside SSE). */
app.get("/api/pending/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "unknown session" });
    return;
  }
  res.json({
    pending: session.pendingApproval,
    done: session.done,
    qa: session.qa ?? null,
    error: session.error ?? null,
  });
});

/** Resolve a pending approval. */
app.post("/api/approve/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "unknown session" });
    return;
  }
  const stage = String(req.body?.stage ?? "");
  const approved = Boolean(req.body?.approved);
  const ok = session.gate.resolve(stage, approved);
  if (ok && session.pendingApproval?.key === stage) session.pendingApproval = null;
  res.json({ ok });
});

app.listen(PORT, () => {
  console.log(`\n  HSP A2A Payment Agent`);
  console.log(`  mode:   ${MODE}${MODE === "mock" ? "  (offline — not a real payment)" : ""}`);
  console.log(`  UI:     http://localhost:${PORT}\n`);
});
