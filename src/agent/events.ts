import type { PaymentStatus } from "../types.js";

/**
 * Typed flow events emitted by the Payment Agent. The CLI prints them; the web
 * server streams them to the UI over SSE so the whole A2A + HSP flow animates live.
 */
export type FlowEvent =
  | { type: "a2a_request_received"; at: string; requestId: string; merchantName: string; payTo: string; amountUsd: string; description?: string }
  | { type: "chain_config"; at: string; network: string; chainId: number | string; tokenSymbol: string; tokenAddress: string; decimals: number; protocol: string; ambiguous: boolean }
  | { type: "order_created"; at: string; flowId: string; paymentRequestId: string; paymentUrl?: string }
  | { type: "quote_prepared"; at: string; payer: string; payTo: string; tokenTotalRaw: string; tokenTotalHuman: string; quoteExpiresAt: string; protocol: string; primaryType: string }
  | { type: "approval_requested"; at: string; stage: "sign" | "submit"; payer: string; payTo: string; tokenTotalRaw: string; tokenTotalHuman: string }
  | { type: "approval_resolved"; at: string; stage: "sign" | "submit"; approved: boolean }
  | { type: "signed"; at: string; signaturePreview: string }
  | { type: "finalized"; at: string }
  | { type: "submitted"; at: string; status: string }
  | { type: "status_poll"; at: string; status: PaymentStatus; attributionVerified?: boolean; txSignature?: string }
  | { type: "quote_reprepared"; at: string; reason: string }
  | { type: "terminal"; at: string; status: PaymentStatus; message: string }
  | { type: "service_requested"; at: string; serviceId: string; name: string; priceUsd: string; description: string }
  | { type: "resource_delivered"; at: string; serviceId: string; title: string; contentType: string; body: unknown }
  | { type: "resource_denied"; at: string; serviceId: string; reason: string }
  | { type: "onchain_tx"; at: string; label: string; hash: string; network: string; explorerUrl?: string }
  | { type: "error"; at: string; message: string }
  | { type: "log"; at: string; message: string };

export type FlowListener = (event: FlowEvent) => void;

export function now(): string {
  return new Date().toISOString();
}
