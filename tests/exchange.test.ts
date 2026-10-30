import { describe, it, expect } from "vitest";
import { A2AExchange } from "../src/a2a/exchange.js";
import { ReceivingAgent } from "../src/a2a/receiving-agent.js";
import { MockHspClient } from "../src/hsp/mock-client.js";
import { AutoApprove } from "../src/agent/approvals.js";
import { BurnerSigner } from "../src/signer/burner.js";
import type { FlowEvent } from "../src/agent/events.js";

const DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function exchange(hsp: MockHspClient, events: FlowEvent[] = []) {
  return new A2AExchange(
    new ReceivingAgent("demo-team", "0x" + "2".repeat(40)),
    hsp,
    new BurnerSigner(DEMO_KEY),
    new AutoApprove(),
    { merchantName: "demo-team", pollIntervalMs: 1, maxTokenTotalRaw: 2_000_000n, allowAmbiguousOption: true },
    (e) => events.push(e),
  );
}

describe("A2AExchange purchase loop", () => {
  it("delivers the resource when payment is finalized", async () => {
    const events: FlowEvent[] = [];
    const { qa, fulfill, proof } = await exchange(
      new MockHspClient({ pollsBeforeTerminal: 2, terminal: "payment-finalized" }),
      events,
    ).purchase("hsk-market-snapshot");

    expect(qa.paymentStatus).toBe("payment-finalized");
    expect(proof.flowId).toBeTruthy();
    expect(proof.attributionVerified).toBe(true);
    expect(fulfill.delivered).toBe(true);
    expect(fulfill.resource?.title).toContain("HSK/USDT");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("service_requested");
    expect(types).toContain("resource_delivered");
  });

  it("withholds the resource when settlement only reaches payment-safe", async () => {
    const { fulfill } = await exchange(
      new MockHspClient({ pollsBeforeTerminal: 1, terminal: "payment-safe" }),
    ).purchase("hsk-market-snapshot");
    expect(fulfill.delivered).toBe(false);
    expect(fulfill.reason).toMatch(/not final|payment-finalized/i);
  });

  it("withholds the resource and surfaces resource_denied when payment fails", async () => {
    const events: FlowEvent[] = [];
    const { fulfill } = await exchange(
      new MockHspClient({ failWith: "insufficient allowance" }),
      events,
    ).purchase("settlement-receipt-api");
    expect(fulfill.delivered).toBe(false);
    expect(events.map((e) => e.type)).toContain("resource_denied");
  });

  it("emits resource_denied and rethrows when the user rejects approval", async () => {
    const events: FlowEvent[] = [];
    const ex = new A2AExchange(
      new ReceivingAgent("demo-team", "0x" + "2".repeat(40)),
      new MockHspClient(),
      new BurnerSigner(DEMO_KEY),
      { async requestApproval() { return false; } },
      { merchantName: "demo-team", pollIntervalMs: 1, allowAmbiguousOption: true },
      (e) => events.push(e),
    );
    await expect(ex.purchase("hsk-market-snapshot")).rejects.toThrow(/rejected/i);
    expect(events.map((e) => e.type)).toContain("resource_denied");
  });
});
