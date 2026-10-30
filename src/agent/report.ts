import type { QueryPaymentResult, PaymentStatus } from "../types.js";

/**
 * The "HSP Agentic Payment — QA Result" report. Uses only actual returned/retained
 * values. token_total_raw stays labeled as raw units; a human-readable amount is
 * optional and never replaces the raw amount. Never fabricate a status, signature,
 * tx hash, attribution, or final confirmation — missing values are reported as
 * unavailable.
 */
export interface QaResultInput {
  merchantName: string;
  tokenTotalRaw: string;
  tokenTotalHuman?: string;
  final: QueryPaymentResult;
}

export interface QaResult {
  paymentStatus: PaymentStatus;
  hackathonTeam: string;
  attributionVerified: string;
  network: string;
  rawAuthorizationAmount: string;
  tokenTotalHuman: string;
  recipientAddress: string;
  payerAddress: string;
  transactionHash: string;
}

const NA = "unavailable";

export function buildQaResult(input: QaResultInput): QaResult {
  const p = input.final.payment ?? {};
  return {
    paymentStatus: input.final.status,
    hackathonTeam: input.merchantName,
    attributionVerified:
      input.final.attribution_verified === undefined
        ? NA
        : String(input.final.attribution_verified),
    network: p.network ?? NA,
    rawAuthorizationAmount: input.tokenTotalRaw,
    tokenTotalHuman: input.tokenTotalHuman ?? NA,
    recipientAddress: p.to_pay_address ?? NA,
    payerAddress: p.payer_address ?? NA,
    transactionHash: p.tx_signature && p.tx_signature.length > 0 ? p.tx_signature : NA,
  };
}

export function formatQaResult(r: QaResult): string {
  return [
    "HSP Agentic Payment — QA Result",
    `Payment status: ${r.paymentStatus}`,
    `Hackathon team: ${r.hackathonTeam}`,
    `Team attribution verified: ${r.attributionVerified}`,
    `Network: ${r.network}`,
    `Raw authorization amount (raw units): ${r.rawAuthorizationAmount}`,
    `Human-readable amount: ${r.tokenTotalHuman}`,
    `Recipient address: ${r.recipientAddress}`,
    `Payer address: ${r.payerAddress}`,
    `Transaction hash: ${r.transactionHash}`,
  ].join("\n");
}
