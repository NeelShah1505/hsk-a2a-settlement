/**
 * Mainnet-fork test: runs the full on-chain A2A purchase against the REAL USDC.e
 * (Circle FiatToken v2) contract on a local fork of HSK Chain mainnet. Nothing touches the
 * real chain — balances are moved by impersonating a holder on the fork only.
 *
 * Opt-in (needs network access to the mainnet RPC): `pnpm test:fork`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashkey } from "viem/chains";
import { a2aSettlementAbi, a2aSettlementBytecode, testUsdcAbi } from "../src/onchain/abi.js";
import { HskEscrowRail, type DepositTerms } from "../src/onchain/escrow-rail.js";
import type { Network } from "../src/onchain/networks.js";
import { OnchainA2AExchange } from "../src/a2a/onchain-exchange.js";
import { ReceivingAgent } from "../src/a2a/receiving-agent.js";
import { AutoApprove } from "../src/agent/approvals.js";
import { BurnerSigner } from "../src/signer/burner.js";

const enabled = process.env.FORK_TEST === "1" && spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;

const USDCE = "0x054ed45810DbBAb8B27668922D110669c9D88D0a" as const; // Bridged USDC (FiatToken v2) on HSK mainnet
const WHALE = "0x62cB71582F277ef581e5F282F78e482fa347Bde7" as const; // USDC.e holder, impersonated on the fork only
const PROVIDER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const PORT = 9100 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

describe.skipIf(!enabled)("on-chain escrow on a fork of HSK mainnet with real USDC.e", () => {
  let anvil: ChildProcess;
  let settlement: Address;
  const provider = privateKeyToAccount(PROVIDER_PK);
  const network: Network = { name: "hsk-mainnet", label: "HSK Chain Mainnet (fork)", chain: hashkey, rpcUrl: RPC };
  const publicClient = createPublicClient({ chain: hashkey, transport: http(RPC) });
  const wallet = createWalletClient({ chain: hashkey, transport: http(RPC), account: provider });
  const testClient = createTestClient({ chain: hashkey, transport: http(RPC), mode: "anvil" });

  const balance = (who: Address) => publicClient.readContract({ address: USDCE, abi: erc20, functionName: "balanceOf", args: [who] });

  beforeAll(async () => {
    anvil = spawn("anvil", ["--fork-url", process.env.HSK_MAINNET_RPC || "https://mainnet.hsk.xyz", "--port", String(PORT), "--silent"], {
      stdio: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try {
        if ((await publicClient.getChainId()) === 177) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const hash = await wallet.deployContract({ abi: a2aSettlementAbi, bytecode: a2aSettlementBytecode });
    settlement = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    const reg = await wallet.writeContract({
      address: settlement,
      abi: a2aSettlementAbi,
      functionName: "registerService",
      args: [keccak256(toBytes("hsk-market-snapshot")), provider.address, USDCE, 1_000_000n, 3600n],
    });
    await publicClient.waitForTransactionReceipt({ hash: reg });
  }, 60_000);

  afterAll(() => anvil?.kill());

  it("escrows real USDC.e gaslessly, verifies on-chain, delivers and releases", async () => {
    const payerPk = generatePrivateKey();
    const payer = privateKeyToAccount(payerPk).address;

    // Fund the payer with 2 USDC.e from a holder — on the fork only.
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whaleWallet = createWalletClient({ chain: hashkey, transport: http(RPC), account: WHALE });
    const t = await whaleWallet.writeContract({ address: USDCE, abi: erc20, functionName: "transfer", args: [payer, 2_000_000n] });
    await publicClient.waitForTransactionReceipt({ hash: t });
    await testClient.stopImpersonatingAccount({ address: WHALE });

    const providerBefore = await balance(provider.address);
    const result = await new OnchainA2AExchange(
      new ReceivingAgent("demo-team", provider.address),
      new HskEscrowRail(network, settlement, provider),
      new BurnerSigner(payerPk),
      new AutoApprove(),
      { merchantName: "demo-team", maxTokenAmount: "5" },
    ).purchase("hsk-market-snapshot");

    expect(result.status).toBe("payment-released");
    expect(result.tokenSymbol).toBe("USDC.e");
    expect(await balance(payer)).toBe(1_000_000n);
    expect(await balance(provider.address)).toBe(providerBefore + 1_000_000n);
    expect(await balance(settlement)).toBe(0n);
    expect(await publicClient.getBalance({ address: payer })).toBe(0n); // payer never had gas
  }, 60_000);

  // This is the HSP-settles-into-escrow path: HSP's gateway builds a TransferWithAuthorization
  // (it picks the nonce), its relayer broadcasts token.transferWithAuthorization(payer, pay_to, ...)
  // where pay_to is our deterministic deposit address, and claimDeposit then pulls it into escrow.
  // We reproduce exactly that call shape against the real USDC.e contract on the fork.
  it("absorbs an HSP-style relayer transferWithAuthorization into the deposit vault, then claims it", async () => {
    const rail = new HskEscrowRail(network, settlement, provider);
    const payerPk = generatePrivateKey();
    const payerAcct = privateKeyToAccount(payerPk);
    const payer = payerAcct.address;
    const relayerPk = generatePrivateKey();
    const relayer = privateKeyToAccount(relayerPk);

    // Fund the payer with 1 USDC.e and the relayer with gas (fork-only).
    await testClient.impersonateAccount({ address: WHALE });
    await testClient.setBalance({ address: WHALE, value: 10n ** 18n });
    const whaleWallet = createWalletClient({ chain: hashkey, transport: http(RPC), account: WHALE });
    await publicClient.waitForTransactionReceipt({
      hash: await whaleWallet.writeContract({ address: USDCE, abi: erc20, functionName: "transfer", args: [payer, 1_000_000n] }),
    });
    await testClient.stopImpersonatingAccount({ address: WHALE });
    await testClient.setBalance({ address: relayer.address, value: 10n ** 18n });

    // Terms the receiving agent would publish; pay_to = the deterministic deposit address.
    const block = await publicClient.getBlock();
    const terms: DepositTerms = {
      payer,
      requestId: keccak256(toBytes("hsp-order-1")),
      serviceId: keccak256(toBytes("hsk-market-snapshot")),
      token: USDCE,
      price: 1_000_000n,
      deliveryWindow: 3600,
      claimBy: block.timestamp + 3600n,
    };
    const payTo = await rail.depositAddress(terms);
    expect(await publicClient.getBytecode({ address: payTo })).toBeUndefined(); // counterfactual

    // The payer signs a TransferWithAuthorization to the deposit address (HSP picks the nonce).
    const domain = await rail.readTokenDomain(USDCE);
    const validAfter = 0n;
    const validBefore = block.timestamp + 600n;
    const nonce = keccak256(toBytes("hsp-nonce-1")) as Hex;
    const signature = await payerAcct.signTypedData({
      domain,
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: payer, to: payTo, value: 1_000_000n, validAfter, validBefore, nonce },
    });
    const sig = signature.slice(2);
    const r = `0x${sig.slice(0, 64)}` as Hex;
    const s = `0x${sig.slice(64, 128)}` as Hex;
    const v = parseInt(sig.slice(128, 130), 16);

    // HSP's relayer broadcasts it — a third party, not the payer. Funds land in the vault.
    const relayerWallet = createWalletClient({ chain: hashkey, transport: http(RPC), account: relayer });
    await publicClient.waitForTransactionReceipt({
      hash: await relayerWallet.writeContract({
        address: USDCE,
        abi: testUsdcAbi,
        functionName: "transferWithAuthorization",
        args: [payer, payTo, 1_000_000n, validAfter, validBefore, nonce, v, r, s],
      }),
    });
    expect(await balance(payTo)).toBe(1_000_000n);

    // Anyone (here the provider) claims the deposit into escrow, then delivers and releases.
    const status = await rail.depositStatus(terms);
    expect(status.claimable).toBe(true);
    await rail.claimDeposit(terms);
    expect((await rail.getPayment(payer, terms.requestId, terms.serviceId)).status).toBe("escrowed");
    expect(await balance(settlement)).toBe(1_000_000n);

    const providerBefore = await balance(provider.address);
    await rail.confirmDelivery(payer, terms.requestId, terms.serviceId, keccak256(toBytes("resource")));
    expect(await balance(provider.address)).toBe(providerBefore + 1_000_000n);
    expect(await balance(payer)).toBe(0n); // payer spent exactly the price, no gas
  }, 60_000);
});
