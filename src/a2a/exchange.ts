import { PaymentAgent, type PaymentAgentOptions } from "../agent/payment-agent.js";
import type { HspClient } from "../hsp/client.js";
import type { PaymentSigner } from "../signer/signer.js";
import type { ApprovalGate } from "../agent/approvals.js";
import type { QaResult } from "../agent/report.js";
import { now, type FlowEvent, type FlowListener } from "../agent/events.js";
import { ReceivingAgent, type FulfillResult, type SettlementProof } from "./receiving-agent.js";
import type { PaymentRequest } from "./schema.js";

export interface PurchaseResult {
  qa: QaResult;
  fulfill: FulfillResult;
  proof: SettlementProof;
}

/**
 * The A2A exchange: closes the full agent-to-agent loop.
 *
 *   1. The Payment Agent requests a service from the Receiving Agent.
 *   2. The Receiving Agent returns x402-style payment conditions (the "402").
 *   3. The Payment Agent settles them through HSP (create → sign → submit → query).
 *   4. The Payment Agent hands back a settlement proof; the Receiving Agent verifies
 *      it and delivers the resource — or withholds it.
 *
 * This is the win condition the payment exists for: one agent autonomously buying
 * something from another, with a human holding the two authorization keys.
 */
export class A2AExchange {
  constructor(
    private readonly receiving: ReceivingAgent,
    private readonly hsp: HspClient,
    private readonly signer: PaymentSigner,
    private readonly approvals: ApprovalGate,
    private readonly paymentOpts: PaymentAgentOptions,
    private readonly listener: FlowListener = () => {},
  ) {}

  private emit(e: FlowEvent): void {
    this.listener(e);
  }

  async purchase(
    serviceId: string,
    constraints?: PaymentRequest["constraints"],
  ): Promise<PurchaseResult> {
    const svc = this.receiving.getService(serviceId);
    this.emit({
      type: "service_requested",
      at: now(),
      serviceId: svc.id,
      name: svc.name,
      priceUsd: svc.priceUsd,
      description: svc.description,
    });

    // The Receiving Agent transmits the payment conditions (A2A "402").
    const request = this.receiving.quoteService(serviceId, { constraints });

    // Capture the order identifiers for the settlement proof, while still
    // forwarding every event to the caller's listener.
    let flowId: string | undefined;
    let paymentRequestId: string | undefined;
    const capturing: FlowListener = (e) => {
      if (e.type === "order_created") {
        flowId = e.flowId;
        paymentRequestId = e.paymentRequestId;
      }
      this.listener(e);
    };

    const agent = new PaymentAgent(
      this.hsp,
      this.signer,
      this.approvals,
      this.paymentOpts,
      capturing,
    );

    let qa: QaResult;
    try {
      qa = await agent.run(request);
    } catch (err) {
      // Payment did not complete (rejected approval, exception, etc.). The resource
      // is withheld; surface it and propagate so the caller can report the failure.
      this.emit({
        type: "resource_denied",
        at: now(),
        serviceId,
        reason: `payment did not complete: ${String((err as Error)?.message ?? err)}`,
      });
      throw err;
    }

    const proof: SettlementProof = {
      status: qa.paymentStatus,
      attributionVerified: qa.attributionVerified === "true",
      flowId,
      paymentRequestId,
      txSignature: qa.transactionHash !== "unavailable" ? qa.transactionHash : undefined,
    };

    const fulfill = this.receiving.fulfill(serviceId, proof);
    if (fulfill.delivered && fulfill.resource) {
      this.emit({
        type: "resource_delivered",
        at: now(),
        serviceId,
        title: fulfill.resource.title,
        contentType: fulfill.resource.contentType,
        body: fulfill.resource.body,
      });
    } else {
      this.emit({
        type: "resource_denied",
        at: now(),
        serviceId,
        reason: fulfill.reason ?? "resource withheld",
      });
    }

    return { qa, fulfill, proof };
  }
}
