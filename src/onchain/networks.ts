import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { foundry, hashkey, hashkeyTestnet } from "viem/chains";
import type { Address, Chain, Hash } from "viem";

/** Networks the on-chain escrow rail can target. */
export type NetworkName = "local" | "hsk-testnet" | "hsk-mainnet";

export interface Network {
  name: NetworkName;
  label: string;
  chain: Chain;
  rpcUrl: string;
  explorer?: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function getNetwork(name: NetworkName): Network {
  switch (name) {
    case "local":
      return {
        name,
        label: "Local (anvil)",
        chain: foundry,
        rpcUrl: process.env.LOCAL_RPC?.trim() || "http://127.0.0.1:8545",
      };
    case "hsk-testnet":
      return {
        name,
        label: "HSK Chain Testnet",
        chain: hashkeyTestnet,
        rpcUrl: process.env.HSK_TESTNET_RPC?.trim() || "https://testnet.hsk.xyz",
        explorer: "https://testnet-explorer.hsk.xyz",
      };
    case "hsk-mainnet":
      return {
        name,
        label: "HSK Chain Mainnet",
        chain: hashkey,
        rpcUrl: process.env.HSK_MAINNET_RPC?.trim() || "https://mainnet.hsk.xyz",
        explorer: "https://hashkey.blockscout.com",
      };
  }
}

export function parseNetworkName(value: string | undefined): NetworkName {
  const v = (value ?? "").trim();
  if (v === "local" || v === "hsk-testnet" || v === "hsk-mainnet") return v;
  throw new Error(`Unknown network "${value}" (expected local | hsk-testnet | hsk-mainnet)`);
}

export function txUrl(network: Network, hash: Hash): string | undefined {
  return network.explorer ? `${network.explorer}/tx/${hash}` : undefined;
}

export function addressUrl(network: Network, address: Address): string | undefined {
  return network.explorer ? `${network.explorer}/address/${address}` : undefined;
}

/** Shape written by contracts/script/Deploy.s.sol. */
export interface Deployment {
  chainId: number;
  settlement: Address;
  token: Address;
  provider: Address;
  payTo: Address;
  testToken: boolean;
  deliveryWindow: number;
}

export function deploymentPath(chainId: number): string {
  return join(ROOT, "deployments", `${chainId}.json`);
}

/** Load the deployment for a chain, or undefined if nothing has been deployed there yet. */
export function loadDeployment(chainId: number): Deployment | undefined {
  const path = deploymentPath(chainId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}
