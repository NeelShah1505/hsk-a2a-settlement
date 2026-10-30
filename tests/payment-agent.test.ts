import { describe, it, expect } from "vitest";
import { PaymentAgent } from "../src/agent/payment-agent.js";
import { MockHspClient } from "../src/hsp/mock-client.js";
import { AutoApprove, type ApprovalGate, type ApprovalRequest } from "../src/agent/approvals.js";
import { BurnerSigner } from "../src/signer/burner.js";
import { ReceivingAgent } from "../src/a2a/receiving-agent.js";
import type { FlowEvent } from "../src/agent/events.js";

const DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function makeRequest(amountUsd = "1") {
  return new ReceivingAgent("demo-team", "0x" + "2".repeat(40)).requestPayment({ amountUsd });
}

function agent(
  hsp: MockHspClient,
  approvals: ApprovalGate,
  events: FlowEvent[] = [],
  maxTokenTotalRaw = 2_000_000n,
) {
  return new PaymentAgent(
    hsp,
    new BurnerSigner(DEMO_KEY),
    approvals,
    { merchantName: "demo-team", pollIntervalMs: 1, maxTokenTotalRaw, allowAmbiguousOption: true },
    (e) => events.push(e),
  );
}

describe("PaymentAgent happy path", () => {
  it("drives create→prepare→sign→finalize→submit→query to payment-finalized", async () => {
    const events: FlowEvent[] = [];
    const qa = await agent(new MockHspClient(), new AutoApprove(), events).run(makeRequest());

    expect(qa.paymentStatus).toBe("payment-finalized");
    expect(qa.hackathonTeam).toBe("demo-team");
    expect(qa.attributionVerified).toBe("true");
    expect(qa.transactionHash).toMatch(/^0x/);

    const types = events.map((e) => e.type);
    expect(types).toContain("order_created");
    expect(types).toContain("quote_prepared");
    expect(types).toContain("signed");
    expect(types).toContain("finalized");
    expect(types).toContain("submitted");
    expect(types.filter((t) => t === "approval_requested")).toHaveLength(2); // sign + submit
    expect(types[types.length - 1]).toBe("terminal");
  });

  it("stops at payment-safe and reports it honestly (not finalized)", async () => {
    const hsp = new MockHspClient({ pollsBeforeTerminal: 1, terminal: "payment-safe" });
    const qa = await agent(hsp, new AutoApprove()).run(makeRequest());
    expect(qa.paymentStatus).toBe("payment-safe");
    expect(qa.paymentStatus).not.toBe("payment-finalized");
  });
});

describe("PaymentAgent safety", () => {
  it("refuses to sign above the raw-units spend cap", async () => {
    const hsp = new MockHspClient({ tokenTotalRaw: "5000000" });
    await expect(agent(hsp, new AutoApprove(), [], 1_000_000n).run(makeRequest())).rejects.toThrow(
      /exceeds the spend cap/,
    );
  });

  it("refuses to sign above the human-amount cap, decimals-correct", async () => {
    // Mock token is 6-decimals USDC; quote is 5.0 (5_000_000 raw). Cap of "2" tokens
    // = 2_000_000 raw < 5_000_000, so it must refuse.
    const hsp = new MockHspClient({ tokenTotalRaw: "5000000" });
    const agentP = new PaymentAgent(
      hsp,
      new BurnerSigner(DEMO_KEY),
      new AutoApprove(),
      { merchantName: "demo-team", pollIntervalMs: 1, maxTokenAmount: "2", allowAmbiguousOption: true },
      () => {},
    );
    await expect(agentP.run(makeRequest())).rejects.toThrow(/exceeds the spend cap/);
  });

  it("stops when the user rejects signing", async () => {
    const reject: ApprovalGate = { async requestApproval(_r: ApprovalRequest) { return false; } };
    await expect(agent(new MockHspClient(), reject).run(makeRequest())).rejects.toThrow(
      /rejected signing/i,
    );
  });

  it("reports payment-failed with the status reason", async () => {
    const hsp = new MockHspClient({ failWith: "insufficient allowance" });
    const qa = await agent(hsp, new AutoApprove()).run(makeRequest());
    expect(qa.paymentStatus).toBe("payment-failed");
  });

  it("rejects an already-expired A2A request", async () => {
    const req = makeRequest();
    req.expiry = new Date(Date.now() - 1000).toISOString();
    await expect(agent(new MockHspClient(), new AutoApprove()).run(req)).rejects.toThrow(/expired/i);
  });
});
