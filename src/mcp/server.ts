/**
 * MCP server exposing the on-chain A2A escrow (A2ASettlement on HSK Chain) as tools, so
 * any MCP client can drive a purchase end to end:
 *
 *   claude mcp add --transport http a2a-escrow http://localhost:4200/mcp
 *
 * The server holds the relayer / receiving-agent key and pays gas. It never holds or
 * signs for the payer: `build_authorization` returns the EIP-712 typed data and the
 * client signs it with its own wallet, then hands the signature to `relay_settlement`.
 *
 * Streamable HTTP, stateless: every POST gets a fresh McpServer + transport bound to one
 * shared HskEscrowRail. The network/deployment are resolved exactly like server.ts
 * (deployments/<chainId>.json: hsk-testnet preferred, then local; ONCHAIN_NETWORK forces).
 *
 * Run: `pnpm mcp`  →  http://localhost:4200/mcp
 */
import "../env.js"; // load .env before anything reads process.env
import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  getAddress,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defaultCatalog, type Service } from "../a2a/receiving-agent.js";
import { HskEscrowRail, toBytes32Id, type OnchainPayment, type OnchainService, type TxResult } from "../onchain/escrow-rail.js";
import {
  addressUrl,
  getNetwork,
  loadDeployment,
  parseNetworkName,
  txUrl,
  type Network,
  type NetworkName,
} from "../onchain/networks.js";

export const MCP_TOOL_NAMES = [
  "get_chain_config",
  "list_services",
  "get_service",
  "build_authorization",
  "relay_settlement",
  "get_payment",
  "confirm_delivery",
  "refund",
  "anchor_external_settlement",
] as const;

export interface McpServerDeps {
  network: Network;
  settlement: Address;
  /** Relayer = service provider (receiving agent). Pays gas; the payer never needs any. */
  relayer: Account;
  /** Settlement token. Derived from the first registered catalog service when omitted. */
  token?: Address;
  catalog?: Service[];
}

// Anvil/Hardhat dev account #0 — throwaway key, used only for local anvil.
const DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ─────────────────────────── input schemas ───────────────────────────

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte hex address")
  .transform((v) => getAddress(v));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x-prefixed 32-byte hex");
const signature = z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/, "0x-prefixed 64/65-byte ECDSA signature");
/** uint256 as a decimal string (preferred) or a safe integer. */
const uint = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));
const serviceId = z.string().min(1).describe("Off-chain service id, e.g. hsk-market-snapshot. Hashed with keccak256 on-chain.");
const requestId = z.string().min(1).describe("Off-chain A2A request id (any unique string). Hashed with keccak256 on-chain.");

// ─────────────────────────── helpers ───────────────────────────

/** JSON with bigint → decimal string, so raw token amounts survive serialization. */
function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

function ok(result: Record<string, unknown>): CallToolResult {
  const structured = toJson(result) as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** The contract's custom error name (e.g. PaymentNotEscrowed) when a call reverts, else viem's short message. */
export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason;
      const args = revert.data?.args?.length ? `(${revert.data.args.map(String).join(", ")})` : "";
      return name ? `contract reverted: ${name}${args}` : revert.shortMessage;
    }
    return e.shortMessage;
  }
  return String((e as Error)?.message ?? e);
}

/** Run a tool body; anything thrown becomes an MCP tool error carrying the revert reason. */
async function guard(tool: string, body: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await body());
  } catch (e) {
    return fail(`${tool} failed: ${describeError(e)}`);
  }
}

function catalogMeta(svc: Service) {
  return { id: svc.id, name: svc.name, description: svc.description, priceUsd: svc.priceUsd };
}

// ─────────────────────────── server ───────────────────────────

/**
 * Build an McpServer bound to one escrow rail. Both the CLI entrypoint and the tests use
 * this, injecting the network/deployment instead of reading deployments/ from disk.
 */
export function createMcpServer(deps: McpServerDeps, rail: HskEscrowRail = new HskEscrowRail(deps.network, deps.settlement, deps.relayer)): McpServer {
  const { network } = deps;
  const catalog = deps.catalog ?? defaultCatalog();
  const server = new McpServer({ name: "a2a-escrow", version: "0.1.0" });

  const onchainView = (hash: Hex, svc: OnchainService, decimals: number) => ({
    serviceIdHash: hash,
    provider: svc.provider,
    payTo: svc.payTo,
    token: svc.token,
    priceRaw: svc.price,
    price: formatUnits(svc.price, decimals),
    deliveryWindowSeconds: svc.deliveryWindow,
    active: svc.active,
  });

  const paymentView = (p: OnchainPayment, decimals: number) => ({
    ...p,
    amountRaw: p.amount,
    amount: formatUnits(p.amount, decimals),
  });

  const txView = (tx: TxResult) => ({
    txHash: tx.hash,
    explorerUrl: txUrl(network, tx.hash) ?? null,
    blockNumber: tx.receipt.blockNumber,
    gasUsed: tx.receipt.gasUsed,
  });

  /** The settlement token: configured, else the token of the first registered catalog service. */
  async function resolveToken(): Promise<Address> {
    if (deps.token) return deps.token;
    for (const svc of catalog) {
      const onchain = await rail.getService(toBytes32Id(svc.id));
      if (onchain.provider !== zeroAddress) return onchain.token;
    }
    throw new Error("no catalog service is registered on-chain, so the settlement token is unknown");
  }

  async function registeredService(id: string): Promise<{ hash: Hex; svc: OnchainService }> {
    const hash = toBytes32Id(id);
    const svc = await rail.getService(hash);
    if (svc.provider === zeroAddress) throw new Error(`service "${id}" is not registered on-chain (${hash})`);
    return { hash, svc };
  }

  async function paymentWithDecimals(payer: Address, requestIdHash: Hex, serviceIdHash: Hex) {
    const p = await rail.getPayment(payer, requestIdHash, serviceIdHash);
    const decimals = p.token === zeroAddress ? 0 : (await rail.getTokenInfo(p.token)).decimals;
    return paymentView(p, decimals);
  }

  server.registerTool(
    "get_chain_config",
    {
      title: "Chain config",
      description:
        "Network, A2ASettlement escrow address, settlement token (symbol/decimals read on-chain) and the relayer/provider address this server pays gas from. Read-only.",
      inputSchema: {},
    },
    () =>
      guard("get_chain_config", async () => {
        const token = await resolveToken();
        const info = await rail.getTokenInfo(token);
        return {
          network: {
            name: network.name,
            label: network.label,
            chainId: network.chain.id,
            rpcUrl: network.rpcUrl,
            explorer: network.explorer ?? null,
          },
          settlement: { address: deps.settlement, url: addressUrl(network, deps.settlement) ?? null },
          token: { address: token, symbol: info.symbol, decimals: info.decimals, url: addressUrl(network, token) ?? null },
          relayer: { address: rail.relayerAddress, url: addressUrl(network, rail.relayerAddress) ?? null },
        };
      }),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "The receiving agent's catalog (off-chain id/name/description/priceUsd) merged with each service's on-chain record (provider, payTo, token, price, deliveryWindow, active). Services missing on-chain are flagged registered=false. Read-only.",
      inputSchema: {},
    },
    () =>
      guard("list_services", async () => {
        const services = await Promise.all(
          catalog.map(async (svc) => {
            const hash = toBytes32Id(svc.id);
            const onchain = await rail.getService(hash);
            if (onchain.provider === zeroAddress) {
              return { ...catalogMeta(svc), registered: false, serviceIdHash: hash, onchain: null };
            }
            const { decimals, symbol } = await rail.getTokenInfo(onchain.token);
            return { ...catalogMeta(svc), registered: true, onchain: { ...onchainView(hash, onchain, decimals), tokenSymbol: symbol } };
          }),
        );
        return { services };
      }),
  );

  server.registerTool(
    "get_service",
    {
      title: "Get service",
      description: "One service: catalog metadata (if in the catalog) plus its on-chain record. Errors if the id is not registered on-chain. Read-only.",
      inputSchema: { service_id: serviceId },
    },
    ({ service_id }) =>
      guard("get_service", async () => {
        const { hash, svc } = await registeredService(service_id);
        const { decimals, symbol } = await rail.getTokenInfo(svc.token);
        const meta = catalog.find((s) => s.id === service_id);
        return {
          ...(meta ? catalogMeta(meta) : { id: service_id }),
          registered: true,
          onchain: { ...onchainView(hash, svc, decimals), tokenSymbol: symbol },
        };
      }),
  );

  server.registerTool(
    "build_authorization",
    {
      title: "Build authorization",
      description:
        "Build the EIP-3009 ReceiveWithAuthorization typed data the PAYER must sign for a service (exact on-chain price, nonce bound to request+service, token domain and validity window read from chain). Never signs — sign `typedData` with the payer wallet (eth_signTypedData_v4) and pass the signature to relay_settlement. Read-only.",
      inputSchema: {
        service_id: serviceId,
        request_id: requestId,
        payer: address.describe("Payer wallet address that will sign"),
        valid_for_seconds: z.number().int().positive().max(86_400).optional().describe("Validity window from chain time (default 600)"),
      },
    },
    ({ service_id, request_id, payer, valid_for_seconds }) =>
      guard("build_authorization", async () => {
        const { hash: serviceIdHash, svc } = await registeredService(service_id);
        if (!svc.active) throw new Error(`service "${service_id}" is inactive on-chain`);
        const requestIdHash = toBytes32Id(request_id);
        const [{ typedData, validAfter, validBefore }, { decimals, symbol }, balance] = await Promise.all([
          rail.buildAuthorization({
            payer,
            requestId: requestIdHash,
            serviceId: serviceIdHash,
            token: svc.token,
            value: svc.price,
            ...(valid_for_seconds ? { validForSeconds: valid_for_seconds } : {}),
          }),
          rail.getTokenInfo(svc.token),
          rail.tokenBalance(svc.token, payer),
        ]);
        return {
          service_id,
          request_id,
          serviceIdHash,
          requestIdHash,
          payer,
          token: svc.token,
          tokenSymbol: symbol,
          token_total_raw: svc.price,
          amount: formatUnits(svc.price, decimals),
          payerBalanceRaw: balance,
          payerFunded: balance >= svc.price,
          validAfter,
          validBefore,
          typedData,
          next: "Sign typedData with the payer wallet, then call relay_settlement with the same service_id, request_id, payer, validAfter, validBefore and the signature.",
        };
      }),
  );

  server.registerTool(
    "relay_settlement",
    {
      title: "Relay settlement",
      description:
        "ON-CHAIN TX (relayer pays gas): submit the payer's signed authorization to A2ASettlement.settleWithAuthorization. Pulls the exact price from the payer into escrow. Returns the tx hash, explorer url and the escrow record.",
      inputSchema: {
        service_id: serviceId,
        request_id: requestId,
        payer: address,
        valid_after: uint.describe("validAfter from build_authorization"),
        valid_before: uint.describe("validBefore from build_authorization"),
        signature: signature.describe("Payer's EIP-712 signature over typedData"),
      },
    },
    ({ service_id, request_id, payer, valid_after, valid_before, signature }) =>
      guard("relay_settlement", async () => {
        const requestIdHash = toBytes32Id(request_id);
        const tx = await rail.relaySettlement({
          payer,
          requestId: requestIdHash,
          serviceId: toBytes32Id(service_id),
          validAfter: valid_after,
          validBefore: valid_before,
          signature: signature as Hex,
        });
        const serviceIdHash = toBytes32Id(service_id);
        return { ...txView(tx), requestIdHash, serviceIdHash, payment: await paymentWithDecimals(payer, requestIdHash, serviceIdHash) };
      }),
  );

  server.registerTool(
    "get_payment",
    {
      title: "Get payment",
      description: "Escrow record for (payer, request_id, service_id): status none|escrowed|released|refunded, amount, deadline, deliveryHash. Read-only.",
      inputSchema: { request_id: requestId, service_id: serviceId, payer: address },
    },
    ({ request_id, service_id, payer }) =>
      guard("get_payment", async () => {
        const requestIdHash = toBytes32Id(request_id);
        const serviceIdHash = toBytes32Id(service_id);
        return { requestIdHash, serviceIdHash, payment: await paymentWithDecimals(payer, requestIdHash, serviceIdHash) };
      }),
  );

  server.registerTool(
    "confirm_delivery",
    {
      title: "Confirm delivery",
      description:
        "ON-CHAIN TX, provider-only (this server's relayer must be the service provider): anchor the delivered resource's hash and release escrow to payTo. Reverts with PaymentNotEscrowed / DeliveryWindowClosed / NotProvider when not allowed.",
      inputSchema: {
        request_id: requestId,
        service_id: serviceId,
        payer: address,
        delivery_hash: bytes32.describe("keccak256 of the delivered resource; must be non-zero"),
      },
    },
    ({ request_id, service_id, payer, delivery_hash }) =>
      guard("confirm_delivery", async () => {
        const requestIdHash = toBytes32Id(request_id);
        const serviceIdHash = toBytes32Id(service_id);
        const tx = await rail.confirmDelivery(payer, requestIdHash, serviceIdHash, delivery_hash as Hex);
        return { ...txView(tx), requestIdHash, serviceIdHash, payment: await paymentWithDecimals(payer, requestIdHash, serviceIdHash) };
      }),
  );

  server.registerTool(
    "refund",
    {
      title: "Refund",
      description:
        "ON-CHAIN TX (anyone may call): return an escrowed, undelivered payment to the payer once its delivery deadline has passed. Reverts with DeliveryWindowOpen before the deadline.",
      inputSchema: { request_id: requestId, service_id: serviceId, payer: address },
    },
    ({ request_id, service_id, payer }) =>
      guard("refund", async () => {
        const requestIdHash = toBytes32Id(request_id);
        const serviceIdHash = toBytes32Id(service_id);
        const tx = await rail.refund(payer, requestIdHash, serviceIdHash);
        return { ...txView(tx), requestIdHash, serviceIdHash, payment: await paymentWithDecimals(payer, requestIdHash, serviceIdHash) };
      }),
  );

  server.registerTool(
    "anchor_external_settlement",
    {
      title: "Anchor external settlement",
      description:
        "ON-CHAIN TX, provider-only: record a payment that settled on another rail (e.g. the HSP Gateway) as an on-chain receipt. Moves no funds. Reverts with AlreadyAnchored on a repeat.",
      inputSchema: {
        request_id: requestId,
        service_id: serviceId,
        payer: address,
        amount_raw: uint.describe("Amount settled, in raw token units"),
        rail: z.string().min(1).describe("Rail label, e.g. hsp"),
        external_ref: z.string().min(1).describe("Reference on the external rail (flow id, payment request id, tx)"),
        delivery_hash: bytes32,
      },
    },
    ({ request_id, service_id, payer, amount_raw, rail: railName, external_ref, delivery_hash }) =>
      guard("anchor_external_settlement", async () => {
        const tx = await rail.anchorExternalSettlement({
          requestId: toBytes32Id(request_id),
          serviceId: toBytes32Id(service_id),
          payer,
          amount: amount_raw,
          rail: railName,
          externalRef: external_ref,
          deliveryHash: delivery_hash as Hex,
        });
        return { ...txView(tx), requestIdHash: toBytes32Id(request_id), serviceIdHash: toBytes32Id(service_id) };
      }),
  );

  return server;
}

/** Express app: POST/GET/DELETE /mcp (stateless Streamable HTTP) and GET /health. */
export function createMcpApp(deps: McpServerDeps): Express {
  const rail = new HskEscrowRail(deps.network, deps.settlement, deps.relayer);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    // Stateless: one short-lived server + transport per request, sharing the rail.
    const server = createMcpServer(deps, rail);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `internal error: ${describeError(e)}` },
          id: null,
        });
      }
    }
  });

  return app;
}

export interface StartedMcpServer {
  server: HttpServer;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Start the HTTP server; `port: 0` picks a free port (tests). */
export function startMcpServer(deps: McpServerDeps, opts: { port?: number; host?: string } = {}): Promise<StartedMcpServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(createMcpApp(deps));
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4200, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : Number(opts.port);
      resolvePromise({
        server,
        port,
        url: `http://${host}:${port}`,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

// ─────────────────────────── CLI entrypoint ───────────────────────────

/** Same resolution as server.ts: ONCHAIN_NETWORK forces, else first deployed of hsk-testnet, local. */
export function resolveDepsFromEnv(): McpServerDeps {
  const explicit = process.env.ONCHAIN_NETWORK?.trim();
  const candidates: NetworkName[] = explicit ? [parseNetworkName(explicit)] : ["hsk-testnet", "local"];
  for (const name of candidates) {
    const network = getNetwork(name);
    const deployment = loadDeployment(network.chain.id);
    if (!deployment) continue;
    const providerKey =
      name === "local"
        ? process.env.LOCAL_DEPLOYER_PRIVATE_KEY?.trim() || DEMO_KEY
        : process.env.DEPLOYER_PRIVATE_KEY?.trim();
    if (!providerKey) throw new Error("DEPLOYER_PRIVATE_KEY (the receiving agent / relayer) is not set");
    return {
      network,
      settlement: deployment.settlement,
      token: deployment.token,
      relayer: privateKeyToAccount(providerKey as Hex),
    };
  }
  throw new Error(`no escrow deployment found for ${candidates.join(" or ")} — run pnpm deploy:local or pnpm deploy:testnet`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const deps = resolveDepsFromEnv();
  const port = Number(process.env.PORT_MCP ?? 4200);
  const host = process.env.MCP_HOST?.trim() || "127.0.0.1";
  startMcpServer(deps, { port, host })
    .then(({ url }) => {
      console.log(`\n  A2A escrow MCP server`);
      console.log(`  network:    ${deps.network.label} (chainId ${deps.network.chain.id})`);
      console.log(`  settlement: ${deps.settlement}`);
      console.log(`  relayer:    ${deps.relayer.address}`);
      console.log(`  endpoint:   ${url}/mcp`);
      console.log(`  add:        claude mcp add --transport http a2a-escrow ${url}/mcp\n`);
    })
    .catch((e) => {
      console.error(`failed to start: ${describeError(e)}`);
      process.exit(1);
    });
}
