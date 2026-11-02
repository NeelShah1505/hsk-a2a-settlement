/**
 * Deploy the A2A escrow to a network and record it in deployments/<chainId>.json.
 *
 *   pnpm deploy:local     # anvil at http://127.0.0.1:8545 (start it with `pnpm chain:local`)
 *   pnpm deploy:testnet   # HSK Chain testnet (133) — deploys TestUSDC + escrow, funds the payer
 *   pnpm deploy:mainnet   # HSK Chain mainnet (177) — escrow only; set SETTLEMENT_TOKEN to register services
 *
 * Uses DEPLOYER_PRIVATE_KEY (needs native HSK for gas). On `local` it falls back to
 * anvil's dev account so no funding is needed.
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addressUrl, getNetwork, loadDeployment, parseNetworkName } from "../onchain/networks.js";

const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts");

async function main(): Promise<void> {
  const network = getNetwork(parseNetworkName(process.argv[2]));
  const isLocal = network.name === "local";
  const isMainnet = network.name === "hsk-mainnet";

  const deployerKey = (isLocal
    ? process.env.LOCAL_DEPLOYER_PRIVATE_KEY?.trim() || ANVIL_DEV_KEY
    : process.env.DEPLOYER_PRIVATE_KEY?.trim()) as Hex | undefined;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is not set in .env");
  const deployer = privateKeyToAccount(deployerKey);

  const client = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== network.chain.id) {
    throw new Error(`RPC ${network.rpcUrl} reports chain ${chainId}, expected ${network.chain.id}`);
  }
  const gas = await client.getBalance({ address: deployer.address });
  console.log(`Network:  ${network.label} (${chainId}) via ${network.rpcUrl}`);
  console.log(`Deployer: ${deployer.address}  balance ${formatEther(gas)} ${network.chain.nativeCurrency.symbol}`);
  if (gas === 0n) {
    console.error(
      `\nThe deployer has no ${isLocal ? "ETH" : "HSK"} for gas.` +
        (isLocal
          ? " Is anvil running? Start it with `pnpm chain:local`."
          : ` Fund ${deployer.address} with ${isMainnet ? "a small amount of HSK" : "testnet HSK from the HashKey faucet"}, then retry.`),
    );
    process.exit(1);
  }

  const payerKey = process.env.BURNER_PRIVATE_KEY?.trim();
  const payer = payerKey && /^0x[0-9a-fA-F]{64}$/.test(payerKey) ? privateKeyToAccount(payerKey as Hex).address : "";

  // On mainnet, default to the real HSK-mainnet USDC.e (the token HSP settles in eip3009),
  // so `pnpm deploy:mainnet` registers the demo services ready for an HSP-into-escrow flow.
  const HSK_MAINNET_USDCE = "0x054ed45810DbBAb8B27668922D110669c9D88D0a";
  const settlementToken = process.env.SETTLEMENT_TOKEN ?? (isMainnet ? HSK_MAINNET_USDCE : undefined);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEPLOYER_PRIVATE_KEY: deployerKey,
    DEPLOY_TEST_TOKEN: isMainnet ? (process.env.DEPLOY_TEST_TOKEN ?? "false") : "true",
    PAYER_ADDRESS: payer,
    ...(settlementToken ? { SETTLEMENT_TOKEN: settlementToken } : {}),
  };
  if (isMainnet) {
    console.log(`Settlement token: ${settlementToken} (services registered against it)`);
  }

  const args = ["script", "script/Deploy.s.sol", "--rpc-url", network.rpcUrl, "--broadcast"];
  if (!isLocal) args.push("--slow");
  const run = spawnSync("forge", args, { cwd: contractsDir, env, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);

  const dep = loadDeployment(chainId);
  if (!dep) throw new Error(`deployment file for chain ${chainId} was not written`);
  console.log("\nDeployed:");
  console.log(`  A2ASettlement  ${dep.settlement}  ${addressUrl(network, dep.settlement) ?? ""}`);
  console.log(`  Token          ${dep.token}${dep.testToken ? " (TestUSDC)" : ""}  ${addressUrl(network, dep.token) ?? ""}`);
  if (payer && dep.testToken) console.log(`  Payer funded   ${payer} (1,000 tUSDC, gasless)`);
}

main().catch((err) => {
  console.error("\nDeploy failed:", err?.message ?? err);
  process.exit(1);
});
