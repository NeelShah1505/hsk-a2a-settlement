import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { REQUIRED_HSP_TOOLS, type HspClient } from "./client.js";
import type {
  ChainConfig,
  CreateOrderResult,
  FinalizePaymentResult,
  PreparePaymentResult,
  QueryPaymentResult,
  SubmitPaymentResult,
} from "../types.js";

/**
 * MCP-backed HSP client over Streamable HTTP.
 *
 * App Key/Secret are managed by the HSP server — nothing to configure here.
 * Prerequisite: your public egress IP must be allowlisted by HSP, or every call
 * is blocked at the edge.
 *
 * NOTE on schemas: the guide insists you inspect the LIVE input schema of each
 * tool and pass the exact parameter names/types it requires. `listToolSchemas()`
 * returns them so you can verify before the signing/submission flow. Do not invent
 * arguments or treat example placeholders as real inputs.
 */
export class McpHspClient implements HspClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(url: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client(
      { name: "hsp-a2a-payment-agent", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** List available tools and confirm all eight HSP tools are present. */
  async verifyTools(): Promise<{ name: string; inputSchema: unknown }[]> {
    await this.connect();
    const { tools } = await this.client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const missing = REQUIRED_HSP_TOOLS.filter((t) => !names.has(t));
    if (missing.length > 0) {
      throw new Error(
        `HSP MCP server is missing required tool(s): ${missing.join(", ")}. ` +
          `Do not proceed without finalize_payment. Stop and report.`,
      );
    }
    return tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema }));
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const res = await this.client.callTool({ name, arguments: args });
    if ((res as { isError?: boolean }).isError) {
      throw new Error(`HSP tool ${name} returned an error: ${JSON.stringify(res.content)}`);
    }
    return extractToolResult<T>(res);
  }

  getChainConfig(): Promise<ChainConfig> {
    return this.call<ChainConfig>("get_chain_config", {});
  }

  createOrder(args: {
    merchant_name: string;
    pay_to: string;
    cart_mandate: unknown;
  }): Promise<CreateOrderResult> {
    return this.call<CreateOrderResult>("create_order", args);
  }

  getOrder(args: { flow_id: string }): Promise<unknown> {
    return this.call("get_order", args);
  }

  prepare_payment(args: {
    flow_id: string;
    payer: string;
    protocol: "eip3009" | "permit2";
  }): Promise<PreparePaymentResult> {
    return this.call<PreparePaymentResult>("prepare_payment", args);
  }

  estimateFee(args: { flow_id: string }): Promise<unknown> {
    return this.call("estimate_fee", args);
  }

  finalize_payment(args: {
    signature: string;
    payment_payload: unknown;
    payment_mandate_contents: unknown;
    cart_hash: string;
  }): Promise<FinalizePaymentResult> {
    return this.call<FinalizePaymentResult>("finalize_payment", args);
  }

  submit_payment(args: { payment_mandate_json: unknown }): Promise<SubmitPaymentResult> {
    return this.call<SubmitPaymentResult>("submit_payment", args);
  }

  queryPayment(args: {
    flow_id?: string;
    payment_request_id?: string;
    expected_merchant_name: string;
  }): Promise<QueryPaymentResult> {
    return this.call<QueryPaymentResult>("query_payment", args);
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.transport.close();
      this.connected = false;
    }
  }
}

/**
 * MCP tool results carry content blocks. HSP returns structured JSON; prefer
 * `structuredContent` when present, else parse the first text block as JSON.
 */
function extractToolResult<T>(res: unknown): T {
  const r = res as {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
  if (r.structuredContent !== undefined) return r.structuredContent as T;
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) {
    throw new Error("HSP tool result had no structuredContent or text block");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some tools may return a bare string; hand it back as-is.
    return text as unknown as T;
  }
}
