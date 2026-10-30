import type { HspClient } from "./client.js";
import type {
  ChainConfig,
  CreateOrderResult,
  FinalizePaymentResult,
  PreparePaymentResult,
  QueryPaymentResult,
  SubmitPaymentResult,
} from "../types.js";

/**
 * In-memory mock of the HSP server for offline development and tests.
 *
 * It reproduces the DOCUMENTED flow and status progression so the orchestrator
 * can be exercised end-to-end without the live endpoint:
 *   submit -> submitted -> processing -> safe -> finalized
 *
 * It is NOT a faithful emulation of HSP cryptography. Never treat a mock run as a
 * real payment. Swap in McpHspClient against the live server for real settlement.
 */
export interface MockOptions {
  /** Non-terminal (verified/processing/included) polls before a terminal status. */
  pollsBeforeTerminal?: number;
  /**
   * Terminal status to settle on. Default payment-finalized. Note that the agent
   * STOPS at payment-safe per the HSP spec, so a safe mock ends on safe — model
   * the two outcomes with separate mocks rather than chaining safe → finalized.
   */
  terminal?: "payment-finalized" | "payment-safe";
  /** Force a terminal failure with this reason. */
  failWith?: string;
  /** token_total_raw the mock quotes. */
  tokenTotalRaw?: string;
}

export class MockHspClient implements HspClient {
  private orders = new Map<string, { merchant_name: string; pay_to: string }>();
  private queryCount = 0;
  private readonly opts: Required<Omit<MockOptions, "failWith">> & { failWith?: string };

  constructor(opts: MockOptions = {}) {
    this.opts = {
      pollsBeforeTerminal: opts.pollsBeforeTerminal ?? 2,
      terminal: opts.terminal ?? "payment-finalized",
      tokenTotalRaw: opts.tokenTotalRaw ?? "1000000",
      failWith: opts.failWith,
    };
  }

  async getChainConfig(): Promise<ChainConfig> {
    return {
      networks: [
        {
          network: "hashkey-testnet",
          chain_id: 133,
          tokens: [
            {
              address: "0x1111111111111111111111111111111111111111",
              decimals: 6,
              symbol: "USDC",
              payment_protocol: "eip3009",
            },
          ],
        },
      ],
    };
  }

  async createOrder(args: {
    merchant_name: string;
    pay_to: string;
    cart_mandate: unknown;
  }): Promise<CreateOrderResult> {
    const flow_id = `mock-flow-${Math.random().toString(36).slice(2, 10)}`;
    const payment_request_id = `mock-prq-${Math.random().toString(36).slice(2, 10)}`;
    this.orders.set(flow_id, { merchant_name: args.merchant_name, pay_to: args.pay_to });
    return {
      flow_id,
      payment_request_id,
      payment_url: `https://example.invalid/pay/${flow_id}`,
    };
  }

  async getOrder(args: { flow_id: string }): Promise<unknown> {
    return { flow_id: args.flow_id, gas_fee_advanced: true };
  }

  async prepare_payment(args: {
    flow_id: string;
    payer: string;
    protocol: "eip3009" | "permit2";
  }): Promise<PreparePaymentResult> {
    const order = this.orders.get(args.flow_id);
    if (!order) throw new Error(`mock: unknown flow_id ${args.flow_id}`);
    const primaryType =
      args.protocol === "permit2" ? "PermitTransferFrom" : "TransferWithAuthorization";
    return {
      eip712: {
        domain: { name: "USDC", version: "2", chainId: 133 },
        types: { [primaryType]: [{ name: "from", type: "address" }] },
        primaryType,
        message: { from: args.payer, to: order.pay_to, value: this.opts.tokenTotalRaw },
      },
      cart_hash: "a".repeat(64),
      token_total_raw: this.opts.tokenTotalRaw,
      quote_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      pay_to: order.pay_to,
      payer: args.payer,
      payment_request_id: "mock-prq",
      payment_payload: { payload: { signature: "" } },
      payment_mandate_contents: {},
    };
  }

  async estimateFee(_args: { flow_id: string }): Promise<unknown> {
    return { gas_fee: "0", gas_fee_advanced: true };
  }

  async finalize_payment(args: {
    signature: string;
    payment_payload: unknown;
    payment_mandate_contents: unknown;
    cart_hash: string;
  }): Promise<FinalizePaymentResult> {
    if (!args.signature.startsWith("0x")) {
      throw new Error("mock: signature must be a 0x hex string");
    }
    return { payment_mandate_json: { jwt: "mock.jwt.value", cart_hash: args.cart_hash } };
  }

  async submit_payment(_args: { payment_mandate_json: unknown }): Promise<SubmitPaymentResult> {
    this.queryCount = 0;
    return { status: "payment-submitted" };
  }

  async queryPayment(args: {
    flow_id?: string;
    payment_request_id?: string;
    expected_merchant_name: string;
  }): Promise<QueryPaymentResult> {
    this.queryCount += 1;
    const base = {
      network: "hashkey-testnet",
      to_pay_address: "0x" + "2".repeat(40),
      payer_address: "0x" + "3".repeat(40),
      tx_signature: "0x" + "d".repeat(64),
    };

    if (this.opts.failWith) {
      return {
        status: "payment-failed",
        attribution_verified: true,
        payment: { ...base, status_reason: this.opts.failWith },
      };
    }
    // A few realistic non-terminal polls, then the configured terminal status.
    const progressing = ["payment-verified", "payment-processing", "payment-included"] as const;
    if (this.queryCount <= this.opts.pollsBeforeTerminal) {
      const status = progressing[Math.min(this.queryCount - 1, progressing.length - 1)]!;
      return { status, attribution_verified: true, payment: base };
    }
    return { status: this.opts.terminal, attribution_verified: true, payment: base };
  }

  async close(): Promise<void> {}
}
