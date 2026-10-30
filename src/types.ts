/**
 * Shared types for the HSP Agentic Payment flow.
 *
 * These mirror the fields documented in the HSP Agentic Payment guide. The HSP
 * tools return richer objects than we model here; we keep unknown fields opaque
 * (`Record<string, unknown>`) and pass server-returned objects through UNCHANGED
 * where the guide requires it (payment_payload, payment_mandate_contents,
 * payment_mandate_json). Do NOT reshape those.
 *
 * IMPORTANT: Before calling the live tools, inspect each tool's real input schema
 * (via the MCP client) and adapt argument assembly to it. The guide warns against
 * inventing arguments or treating example placeholders as real inputs.
 */

/** One EIP-712 typed-data object as returned by prepare_payment. Sign this as-is. */
export interface Eip712Payload {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  // "TransferWithAuthorization" (eip3009) or "PermitTransferFrom" (permit2)
  primaryType: string;
  message: Record<string, unknown>;
}

/** The token's on-chain payment protocol, taken from get_chain_config. */
export type PaymentProtocol = "eip3009" | "permit2";

/** A single supported token entry from get_chain_config. */
export interface ChainTokenConfig {
  address: string;
  decimals: number;
  symbol?: string;
  payment_protocol: PaymentProtocol;
  [k: string]: unknown;
}

/** One supported network/token combination from get_chain_config. */
export interface ChainNetworkConfig {
  network: string;
  chain_id: number | string;
  tokens: ChainTokenConfig[];
  [k: string]: unknown;
}

export interface ChainConfig {
  networks?: ChainNetworkConfig[];
  // Some deployments return a flat shape; keep raw for schema-faithful access.
  [k: string]: unknown;
}

/** Result of create_order. */
export interface CreateOrderResult {
  flow_id: string;
  payment_request_id: string;
  payment_url?: string;
  [k: string]: unknown;
}

/** Result of prepare_payment. The amount is already embedded in eip712. */
export interface PreparePaymentResult {
  eip712: Eip712Payload;
  cart_hash: string;
  token_total_raw: string;
  quote_expires_at: string; // RFC3339
  pay_to: string;
  payer: string;
  payment_request_id: string;
  payment_payload: Record<string, unknown>;
  payment_mandate_contents: Record<string, unknown>;
  [k: string]: unknown;
}

/** Result of finalize_payment: the only input to submit_payment. */
export interface FinalizePaymentResult {
  payment_mandate_json: unknown; // pass UNCHANGED to submit_payment
  [k: string]: unknown;
}

export interface SubmitPaymentResult {
  status: string; // expected "payment-submitted"
  [k: string]: unknown;
}

/** Documented HSP payment statuses. */
export type PaymentStatus =
  | "payment-submitted"
  | "payment-verified"
  | "payment-processing"
  | "payment-included"
  | "payment-timeout"
  | "payment-safe"
  | "payment-finalized"
  | "payment-failed"
  | string; // tolerate unknown statuses — never fabricate success

export interface QueryPaymentResult {
  status: PaymentStatus;
  attribution_verified?: boolean;
  payment?: {
    status_reason?: string;
    network?: string;
    to_pay_address?: string;
    payer_address?: string;
    tx_signature?: string; // on-chain tx hash; empty before broadcast
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
