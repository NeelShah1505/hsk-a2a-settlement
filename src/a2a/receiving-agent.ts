import { randomUUID } from "node:crypto";
import type { PaymentRequest } from "./schema.js";

/**
 * A resource the Receiving Agent sells. `deliver` is only called by the agent
 * itself after it has verified a settlement proof — the payload never leaves the
 * agent until payment is confirmed (this is the x402 "402 → pay → deliver" loop).
 */
export interface Service {
  id: string;
  name: string;
  description: string;
  priceUsd: string; // decimal string
  deliver: () => ResourcePayload;
}

export interface ResourcePayload {
  contentType: string; // e.g. "application/json" | "text/plain"
  title: string;
  /** Synthetic demo content, authored at full fidelity and labeled as such. */
  body: unknown;
}

/** What the Payment Agent hands back so the service can verify settlement. */
export interface SettlementProof {
  status: string; // payment status from query_payment
  attributionVerified: boolean;
  flowId?: string;
  paymentRequestId?: string;
  txSignature?: string;
}

export interface FulfillResult {
  delivered: boolean;
  resource?: ResourcePayload;
  reason?: string;
}

/** A terminal status the service treats as "settled enough" to release a resource. */
const DELIVERABLE_STATUSES = new Set(["payment-finalized"]);

/**
 * The Receiving Agent (merchant side). It owns a catalog of services, transmits
 * payment conditions for a requested service (A2A), and — only after verifying a
 * settlement proof — delivers the resource.
 */
export class ReceivingAgent {
  private readonly services: Map<string, Service>;

  constructor(
    private readonly merchantName: string,
    private readonly payTo: string,
    services: Service[] = defaultCatalog(),
  ) {
    this.services = new Map(services.map((s) => [s.id, s]));
  }

  listServices(): Service[] {
    return [...this.services.values()];
  }

  getService(serviceId: string): Service {
    const s = this.services.get(serviceId);
    if (!s) throw new Error(`unknown service: ${serviceId}`);
    return s;
  }

  /** Ad-hoc payment conditions (no catalog service). Kept for direct payments. */
  requestPayment(params: {
    amountUsd: string;
    description?: string;
    ttlSeconds?: number;
    constraints?: PaymentRequest["constraints"];
  }): PaymentRequest {
    return this.buildRequest(params.amountUsd, params.description, params.ttlSeconds, params.constraints);
  }

  /** Emit the x402-style payment conditions for a catalog service (the "402"). */
  quoteService(
    serviceId: string,
    opts: { ttlSeconds?: number; constraints?: PaymentRequest["constraints"] } = {},
  ): PaymentRequest {
    const svc = this.getService(serviceId);
    return this.buildRequest(
      svc.priceUsd,
      `${svc.name} — ${svc.description}`,
      opts.ttlSeconds ?? 300,
      opts.constraints,
    );
  }

  /**
   * Deliver a resource after the caller has verified settlement independently (e.g. the
   * on-chain escrow rail reads the escrow state from HSK Chain rather than trusting the payer).
   */
  deliver(serviceId: string): ResourcePayload {
    return this.getService(serviceId).deliver();
  }

  /** Verify the settlement proof and release the resource if it checks out. */
  fulfill(serviceId: string, proof: SettlementProof): FulfillResult {
    const svc = this.getService(serviceId);
    if (!proof.attributionVerified) {
      return { delivered: false, reason: "attribution not verified; withholding resource" };
    }
    if (!DELIVERABLE_STATUSES.has(proof.status)) {
      return {
        delivered: false,
        reason: `status "${proof.status}" is not final; resource released only on payment-finalized`,
      };
    }
    return { delivered: true, resource: svc.deliver() };
  }

  private buildRequest(
    amountUsd: string,
    description?: string,
    ttlSeconds = 300,
    constraints?: PaymentRequest["constraints"],
  ): PaymentRequest {
    const expiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return {
      id: randomUUID(),
      merchantName: this.merchantName,
      payTo: this.payTo,
      amount: { value: amountUsd, currency: "USD" },
      expiry,
      description,
      ...(constraints ? { constraints } : {}),
    };
  }
}

/**
 * Default catalog. Content is SYNTHETIC demo data (clearly labeled) — authored at
 * full fidelity so the delivered resource is tangible in the demo.
 */
export function defaultCatalog(): Service[] {
  return [
    {
      id: "hsk-market-snapshot",
      name: "HashKey Swap market snapshot",
      description: "Live pool snapshot for HSK/USDT with depth and 24h stats",
      priceUsd: "1",
      deliver: () => ({
        contentType: "application/json",
        title: "HSK/USDT — market snapshot",
        body: {
          _note: "SYNTHETIC demo data — not a real market feed",
          pair: "HSK/USDT",
          venue: "HashKey Swap",
          price: 0.1427,
          change24hPct: 3.82,
          liquidityUsd: 2_418_903,
          volume24hUsd: 512_774,
          depth: {
            bids: [[0.1425, 48213], [0.1421, 102934], [0.1410, 274500]],
            asks: [[0.1429, 51120], [0.1433, 98740], [0.1445, 233110]],
          },
          asOf: new Date().toISOString(),
        },
      }),
    },
    {
      id: "settlement-receipt-api",
      name: "Premium settlement attestation",
      description: "Signed attestation that a payment reached final confirmation",
      priceUsd: "2",
      deliver: () => ({
        contentType: "text/plain",
        title: "Settlement attestation",
        body:
          "ATTESTATION (synthetic demo): the referenced HSP payment reached " +
          "payment-finalized and is attributed to the requesting team.",
      }),
    },
  ];
}
