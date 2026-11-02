import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { a2aSettlementAbi, a2aSettlementBytecode, testUsdcAbi, testUsdcBytecode } from "../src/onchain/abi.js";
import { HskEscrowRail, toBytes32Id } from "../src/onchain/escrow-rail.js";
import type { Network } from "../src/onchain/networks.js";
import { OnchainA2AExchange } from "../src/a2a/onchain-exchange.js";
import { ReceivingAgent } from "../src/a2a/receiving-agent.js";
import { AutoApprove, type ApprovalGate } from "../src/agent/approvals.js";
import { BurnerSigner } from "../src/signer/burner.js";
import type { FlowEvent } from "../src/agent/events.js";

const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

// Anvil's well-known dev account #0 (provider / relayer). Local chain only.
const PROVIDER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;

describe.skipIf(!hasAnvil)("on-chain A2A escrow (local anvil)", () => {
  let anvil: ChildProcess;
  let settlement: Address;
  let token: Address;
  const provider = privateKeyToAccount(PROVIDER_PK);
  const network: Network = { name: "local", label: "Local (anvil)", chain: foundry, rpcUrl: RPC };
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: provider });

  async function deploy(abi: readonly unknown[], bytecode: Hex): Promise<Address> {
    const hash = await wallet.deployContract({ abi, bytecode, args: [] } as Parameters<typeof wallet.deployContract>[0]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
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

  function exchange(payer: BurnerSigner, approvals: ApprovalGate = new AutoApprove(), events: FlowEvent[] = []) {
    const rail = new HskEscrowRail(network, settlement, provider);
    // The receiving agent's off-chain identity pays out to the on-chain provider.
    const receiving = new ReceivingAgent("demo-team", provider.address);
    return new OnchainA2AExchange(receiving, rail, payer, approvals, { merchantName: "demo-team", maxTokenAmount: "5" }, (e) =>
      events.push(e),
    );
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
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("escrows a gasless payment, verifies it on-chain, delivers and releases", async () => {
    const payer = newPayer();
    await write(token, testUsdcAbi, "mint", [payer.address, 10_000_000n]);
    const providerBefore = await balance(provider.address);

    const events: FlowEvent[] = [];
    const result = await exchange(payer.signer, new AutoApprove(), events).purchase("hsk-market-snapshot");

    expect(result.status).toBe("payment-released");
    expect(await balance(payer.address)).toBe(9_000_000n);
    expect(await balance(provider.address)).toBe(providerBefore + 1_000_000n);
    expect(await balance(settlement)).toBe(0n);

    // The payer never held native gas.
    expect(await publicClient.getBalance({ address: payer.address })).toBe(0n);

    const onchain = await publicClient.readContract({
      address: settlement,
      abi: a2aSettlementAbi,
      functionName: "getPayment",
      args: [payer.address, result.requestId, toBytes32Id("hsk-market-snapshot")],
    });
    expect(onchain.status).toBe(2); // Released
    expect(onchain.deliveryHash).toBe(result.deliveryHash);

    const txLabels = events.filter((e) => e.type === "onchain_tx").map((e) => (e as { label: string }).label);
    expect(txLabels).toEqual(["escrow", "release"]);
    expect(events.map((e) => e.type)).toContain("resource_delivered");
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(2);
    expect(result.receipt).toContain("Escrow verified on-chain: true");
  });

  it("refuses to sign when the payer is unfunded", async () => {
    const payer = newPayer();
    await expect(exchange(payer.signer).purchase("hsk-market-snapshot")).rejects.toThrow(/fund the payer/);
  });

  it("does not escrow anything when the user rejects signing", async () => {
    const payer = newPayer();
    await write(token, testUsdcAbi, "mint", [payer.address, 5_000_000n]);
    const reject: ApprovalGate = { async requestApproval() { return false; } };
    await expect(exchange(payer.signer, reject).purchase("hsk-market-snapshot")).rejects.toThrow(/rejected signing/);
    expect(await balance(payer.address)).toBe(5_000_000n);
  });

  it("rejects a quote that does not match the on-chain price", async () => {
    const payer = newPayer();
    await write(token, testUsdcAbi, "mint", [payer.address, 5_000_000n]);
    // settlement-receipt-api is quoted at 2 USD off-chain but registered at 3 on-chain.
    await write(settlement, a2aSettlementAbi, "registerService", [
      keccak256(toBytes("settlement-receipt-api")),
      provider.address,
      token,
      3_000_000n,
      3600n,
    ]);
    await expect(exchange(payer.signer).purchase("settlement-receipt-api")).rejects.toThrow(/quote mismatch/);
    expect(await balance(payer.address)).toBe(5_000_000n);
  });

  it("rejects a service that is not registered on-chain", async () => {
    const payer = newPayer();
    const ex = new OnchainA2AExchange(
      new ReceivingAgent("demo-team", provider.address, [
        {
          id: "unregistered",
          name: "Unregistered",
          description: "not on chain",
          priceUsd: "1",
          deliver: () => ({ contentType: "text/plain", title: "x", body: "x" }),
        },
      ]),
      new HskEscrowRail(network, settlement, provider),
      payer.signer,
      new AutoApprove(),
      { merchantName: "demo-team" },
    );
    await expect(ex.purchase("unregistered")).rejects.toThrow(/not registered/);
  });
});
