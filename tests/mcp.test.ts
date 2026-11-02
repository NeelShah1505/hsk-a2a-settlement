import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { a2aSettlementAbi, a2aSettlementBytecode, testUsdcAbi, testUsdcBytecode } from "../src/onchain/abi.js";
import type { Network } from "../src/onchain/networks.js";
import { MCP_TOOL_NAMES, startMcpServer, type StartedMcpServer } from "../src/mcp/server.js";
import { BurnerSigner } from "../src/signer/burner.js";
import type { Eip712Payload } from "../src/types.js";

const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

// Anvil's well-known dev account #0 (provider / relayer). Local chain only.
const PROVIDER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
// Distinct range from onchain.test.ts so both files can run in parallel.
const PORT = 8900 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

describe.skipIf(!hasAnvil)("MCP server over the on-chain A2A escrow (local anvil)", () => {
  let anvil: ChildProcess;
  let settlement: Address;
  let token: Address;
  let mcp: StartedMcpServer;
  let client: Client;
  const provider = privateKeyToAccount(PROVIDER_PK);
  const network: Network = { name: "local", label: "Local (anvil)", chain: foundry, rpcUrl: RPC };
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: provider });

  async function deploy(abi: readonly unknown[], bytecode: Hex): Promise<Address> {
    const hash = await wallet.deployContract({ abi, bytecode, args: [] } as Parameters<typeof wallet.deployContract>[0]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    // Checksummed, matching what the contract reads return.
    return getAddress(receipt.contractAddress!);
  }

  async function write(address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
    const hash = await wallet.writeContract({ address, abi, functionName, args } as Parameters<typeof wallet.writeContract>[0]);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function balance(owner: Address): Promise<bigint> {
    return publicClient.readContract({ address: token, abi: testUsdcAbi, functionName: "balanceOf", args: [owner] });
  }

  function newPayer(): { signer: BurnerSigner; address: Address } {
    const pk = generatePrivateKey();
    return { signer: new BurnerSigner(pk), address: privateKeyToAccount(pk).address };
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  /** Call a tool that must succeed and return its structured payload. */
  async function callOk<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await call(name, args);
    expect(res.isError, `${name}: ${res.content[0]?.text}`).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    // The text block must be the same JSON, for clients that ignore structuredContent.
    expect(JSON.parse(res.content[0]!.text!)).toEqual(res.structuredContent);
    return res.structuredContent as T;
  }

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    token = await deploy(testUsdcAbi, testUsdcBytecode);
    settlement = await deploy(a2aSettlementAbi, a2aSettlementBytecode);
    await write(settlement, a2aSettlementAbi, "registerService", [
      keccak256(toBytes("hsk-market-snapshot")),
      provider.address,
      token,
      1_000_000n,
      3600n,
    ]);

    // Token is deliberately omitted so the server derives it from the registered service.
    mcp = await startMcpServer({ network, settlement, relayer: provider }, { port: 0 });
    client = new Client({ name: "mcp-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp`)));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await mcp?.close();
    anvil?.kill();
  });

  it("answers /health", async () => {
    const res = await fetch(`${mcp.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("exposes exactly the nine escrow tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
  });

  it("reports the chain config from the injected deployment", async () => {
    const cfg = await callOk<{
      network: { name: string; chainId: number; rpcUrl: string };
      settlement: { address: string };
      token: { address: string; symbol: string; decimals: number };
      relayer: { address: string };
    }>("get_chain_config");
    expect(cfg.network).toMatchObject({ name: "local", chainId: 31337, rpcUrl: RPC });
    expect(cfg.settlement.address).toBe(settlement);
    expect(cfg.token).toMatchObject({ address: token, decimals: 6 });
    expect(cfg.token.symbol).toBeTruthy();
    expect(cfg.relayer.address).toBe(provider.address);
  });

  it("lists the catalog merged with on-chain records and flags unregistered services", async () => {
    const { services } = await callOk<{
      services: Array<{ id: string; priceUsd: string; registered: boolean; onchain: Record<string, unknown> | null }>;
    }>("list_services");
    const snapshot = services.find((s) => s.id === "hsk-market-snapshot")!;
    expect(snapshot.registered).toBe(true);
    expect(snapshot.priceUsd).toBe("1");
    expect(snapshot.onchain).toMatchObject({
      provider: provider.address,
      payTo: provider.address,
      token,
      priceRaw: "1000000",
      price: "1",
      deliveryWindowSeconds: 3600,
      active: true,
    });
    const receipt = services.find((s) => s.id === "settlement-receipt-api")!;
    expect(receipt.registered).toBe(false);
    expect(receipt.onchain).toBeNull();

    const single = await callOk<{ id: string; registered: boolean }>("get_service", { service_id: "hsk-market-snapshot" });
    expect(single).toMatchObject({ id: "hsk-market-snapshot", registered: true });
  });

  it("drives the full happy path: build → sign → relay → escrowed → confirm → released", async () => {
    const payer = newPayer();
    await write(token, testUsdcAbi, "mint", [payer.address, 10_000_000n]);
    const providerBefore = await balance(provider.address);
    const requestId = `req-${Date.now()}`;

    // 1. The server builds what the payer must sign; it never signs itself.
    const auth = await callOk<{
      typedData: Eip712Payload;
      validAfter: string;
      validBefore: string;
      token_total_raw: string;
      amount: string;
      payerFunded: boolean;
      requestIdHash: Hex;
    }>("build_authorization", { service_id: "hsk-market-snapshot", request_id: requestId, payer: payer.address });
    expect(auth.token_total_raw).toBe("1000000");
    expect(auth.amount).toBe("1");
    expect(auth.payerFunded).toBe(true);
    expect(auth.typedData.primaryType).toBe("ReceiveWithAuthorization");
    expect(auth.typedData.message).toMatchObject({ from: payer.address, to: settlement, value: "1000000" });

    // 2. Payer signs the typed data exactly as returned (strings for uint256 values).
    const signature = await payer.signer.signEip712(auth.typedData);

    // 3. Relayer submits it; funds move into escrow.
    const relayed = await callOk<{ txHash: Hex; payment: { status: string; amountRaw: string } }>("relay_settlement", {
      service_id: "hsk-market-snapshot",
      request_id: requestId,
      payer: payer.address,
      valid_after: auth.validAfter,
      valid_before: auth.validBefore,
      signature,
    });
    expect(relayed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(relayed.payment).toMatchObject({ status: "escrowed", amountRaw: "1000000", payer: payer.address });
    expect(await balance(payer.address)).toBe(9_000_000n);
    expect(await balance(settlement)).toBe(1_000_000n);

    // 4. Read it back.
    const escrowed = await callOk<{ payment: { status: string } }>("get_payment", { request_id: requestId, service_id: "hsk-market-snapshot", payer: payer.address });
    expect(escrowed.payment.status).toBe("escrowed");

    // 5. Provider confirms delivery with a hash of the resource; escrow releases.
    const deliveryHash = keccak256(toBytes(JSON.stringify({ pair: "HSK/USDT", synthetic: true })));
    const confirmed = await callOk<{ payment: { status: string; deliveryHash: Hex } }>("confirm_delivery", {
      request_id: requestId,
      service_id: "hsk-market-snapshot",
      payer: payer.address,
      delivery_hash: deliveryHash,
    });
    expect(confirmed.payment).toMatchObject({ status: "released", deliveryHash });

    // 6. Final state.
    const released = await callOk<{ payment: { status: string } }>("get_payment", { request_id: requestId, service_id: "hsk-market-snapshot", payer: payer.address });
    expect(released.payment.status).toBe("released");
    expect(await balance(provider.address)).toBe(providerBefore + 1_000_000n);
    expect(await balance(settlement)).toBe(0n);
    // The payer never held native gas.
    expect(await publicClient.getBalance({ address: payer.address })).toBe(0n);
  }, 30_000);

  it("returns contract reverts as MCP tool errors, not transport failures", async () => {
    const payer = newPayer();
    await write(token, testUsdcAbi, "mint", [payer.address, 5_000_000n]);
    const requestId = `bad-${Date.now()}`;
    const auth = await callOk<{ validAfter: string; validBefore: string }>("build_authorization", {
      service_id: "hsk-market-snapshot",
      request_id: requestId,
      payer: payer.address,
    });

    const bad = await call("relay_settlement", {
      service_id: "hsk-market-snapshot",
      request_id: requestId,
      payer: payer.address,
      valid_after: auth.validAfter,
      valid_before: auth.validBefore,
      signature: `0x${"11".repeat(64)}1b`,
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/relay_settlement failed: .*signature/i);
    expect(await balance(payer.address)).toBe(5_000_000n);

    // Nothing escrowed → confirm_delivery reverts with the contract's own error name.
    const notEscrowed = await call("confirm_delivery", {
      request_id: requestId,
      service_id: "hsk-market-snapshot",
      payer: payer.address,
      delivery_hash: keccak256(toBytes("x")),
    });
    expect(notEscrowed.isError).toBe(true);
    expect(notEscrowed.content[0]?.text).toContain("PaymentNotEscrowed");

    // Unknown service → tool error, and the transport stays usable afterwards.
    const unknown = await call("get_service", { service_id: "does-not-exist" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toMatch(/not registered on-chain/);
    expect((await client.listTools()).tools).toHaveLength(MCP_TOOL_NAMES.length);
  });
});
