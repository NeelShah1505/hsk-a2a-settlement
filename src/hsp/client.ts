import type {
  ChainConfig,
  CreateOrderResult,
  FinalizePaymentResult,
  PreparePaymentResult,
  QueryPaymentResult,
  SubmitPaymentResult,
} from "../types.js";

/**
 * The eight HSP Agentic Payment tools, as a typed interface.
 *
 * The MCP-backed implementation (mcp-client.ts) forwards these to the live tools.
 * A mock implementation (mock-client.ts) drives the orchestrator offline.
 *
 * Argument shapes here follow the HSP guide, but the LIVE input schemas are
 * authoritative. mcp-client validates that all eight tools exist before use and
 * surfaces each tool's real schema so you can confirm argument names/types.
 */
export interface HspClient {
  getChainConfig(): Promise<ChainConfig>;

  createOrder(args: {
    merchant_name: string;
    pay_to: string;
    cart_mandate: unknown; // built by src/mandate/cart-mandate.ts, shaped to the live schema
  }): Promise<CreateOrderResult>;

  getOrder(args: { flow_id: string }): Promise<unknown>;

  prepare_payment(args: {
    flow_id: string;
    payer: string;
    protocol: "eip3009" | "permit2";
  }): Promise<PreparePaymentResult>;

  estimateFee(args: { flow_id: string }): Promise<unknown>;

  finalize_payment(args: {
    signature: string;
    payment_payload: unknown; // from prepare_payment, UNCHANGED
    payment_mandate_contents: unknown; // from prepare_payment, UNCHANGED
    cart_hash: string;
  }): Promise<FinalizePaymentResult>;

  submit_payment(args: {
    payment_mandate_json: unknown; // from finalize_payment, UNCHANGED
  }): Promise<SubmitPaymentResult>;

  queryPayment(args: {
    flow_id?: string;
    payment_request_id?: string;
    expected_merchant_name: string;
  }): Promise<QueryPaymentResult>;

  /** Release any underlying transport. */
  close?(): Promise<void>;
}

/** The canonical tool names that MUST be present on the HSP MCP server. */
export const REQUIRED_HSP_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;
