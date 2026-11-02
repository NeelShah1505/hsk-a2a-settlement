import {
  createPublicClient,
  createWalletClient,
  domainSeparator,
  http,
  keccak256,
  parseAbi,
  parseSignature,
  toBytes,
  type TypedDataDomain,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { a2aSettlementAbi, testUsdcAbi } from "./abi.js";
import type { Network } from "./networks.js";
import type { Eip712Payload } from "../types.js";

/** On-chain escrow status, mirroring A2ASettlement.Status. */
export const EscrowStatus = ["none", "escrowed", "released", "refunded"] as const;
export type EscrowStatusName = (typeof EscrowStatus)[number];

export interface OnchainService {
  provider: Address;
  payTo: Address;
  token: Address;
  price: bigint;
  deliveryWindow: number;
  active: boolean;
}

export interface OnchainPayment {
  serviceId: Hex;
  payer: Address;
  payTo: Address;
  token: Address;
  amount: bigint;
  escrowedAt: number;
  deadline: number;
  status: EscrowStatusName;
  deliveryHash: Hex;
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface SignedAuthorization {
  payer: Address;
  requestId: Hex;
  serviceId: Hex;
  validAfter: bigint;
  validBefore: bigint;
  signature: Hex;
}

/** Deal terms a deposit address commits to (mirrors A2ASettlement.DepositTerms). */
export interface DepositTerms {
  payer: Address;
  requestId: Hex;
  serviceId: Hex;
  token: Address;
  price: bigint;
  deliveryWindow: number;
  claimBy: bigint;
}

/** Shape DepositTerms for the contract call (uint64 fields as bigint). */
function toContractTerms(t: DepositTerms) {
  return {
    payer: t.payer,
    requestId: t.requestId,
    serviceId: t.serviceId,
    token: t.token,
    price: t.price,
    deliveryWindow: BigInt(t.deliveryWindow),
    claimBy: t.claimBy,
  } as const;
}

export interface TxResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

/** Fragments for tokens that predate EIP-5267 (e.g. Circle FiatToken v2 / USDC.e). */
const legacyDomainAbi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

/** Hash an off-chain identifier (service id, A2A request id) to the bytes32 the contract uses. */
export function toBytes32Id(id: string): Hex {
  return keccak256(toBytes(id));
}

/**
 * Typed access to the A2ASettlement escrow on HSK Chain. The `relayer` account pays gas
 * for relays and acts as the service provider (receiving agent); payers never need gas.
 */
export class HskEscrowRail {
  readonly publicClient: PublicClient;
  private readonly wallet: WalletClient;

  constructor(
    readonly network: Network,
    readonly settlement: Address,
    private readonly relayer: Account,
  ) {
    const transport = http(network.rpcUrl);
    this.publicClient = createPublicClient({ chain: network.chain, transport });
    this.wallet = createWalletClient({ chain: network.chain, transport, account: relayer });
  }

  get relayerAddress(): Address {
    return this.relayer.address;
  }

  async getService(serviceId: Hex): Promise<OnchainService> {
    const [provider, payTo, token, price, deliveryWindow, active] = await this.publicClient.readContract({
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "services",
      args: [serviceId],
    });
    return { provider, payTo, token, price, deliveryWindow: Number(deliveryWindow), active };
  }

  async getTokenInfo(token: Address): Promise<TokenInfo> {
    const [symbol, decimals] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: testUsdcAbi, functionName: "symbol" }),
      this.publicClient.readContract({ address: token, abi: testUsdcAbi, functionName: "decimals" }),
    ]);
    return { symbol, decimals: Number(decimals) };
  }

  async tokenBalance(token: Address, owner: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: testUsdcAbi,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  async getPayment(payer: Address, requestId: Hex, serviceId: Hex): Promise<OnchainPayment> {
    const p = await this.publicClient.readContract({
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "getPayment",
      args: [payer, requestId, serviceId],
    });
    return {
      serviceId: p.serviceId,
      payer: p.payer,
      payTo: p.payTo,
      token: p.token,
      amount: p.amount,
      escrowedAt: Number(p.escrowedAt),
      deadline: Number(p.deadline),
      status: EscrowStatus[p.status] ?? "none",
      deliveryHash: p.deliveryHash,
    };
  }

  /**
   * Build the EIP-3009 ReceiveWithAuthorization the payer must sign. The domain is read
   * from the token itself (EIP-5267) and the validity window is anchored to chain time,
   * so neither depends on hard-coded values or the local clock.
   */
  async buildAuthorization(params: {
    payer: Address;
    requestId: Hex;
    serviceId: Hex;
    token: Address;
    value: bigint;
    validForSeconds?: number;
  }): Promise<{ typedData: Eip712Payload; validAfter: bigint; validBefore: bigint }> {
    const [domain, nonce, block] = await Promise.all([
      this.readTokenDomain(params.token),
      this.publicClient.readContract({
        address: this.settlement,
        abi: a2aSettlementAbi,
        functionName: "authorizationNonce",
        args: [params.requestId, params.serviceId],
      }),
      this.publicClient.getBlock(),
    ]);
    const validAfter = 0n;
    const validBefore = block.timestamp + BigInt(params.validForSeconds ?? 600);

    return {
      validAfter,
      validBefore,
      typedData: {
        domain: domain as Record<string, unknown>,
        types: {
          ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "ReceiveWithAuthorization",
        message: {
          from: params.payer,
          to: this.settlement,
          value: params.value,
          validAfter,
          validBefore,
          nonce,
        },
      },
    };
  }

  /**
   * The token's EIP-712 domain. Prefers EIP-5267 `eip712Domain()`; for tokens without it
   * (Circle FiatToken v2 such as USDC.e on HSK mainnet) it rebuilds the domain from
   * name()/version() and refuses to continue unless it matches the token's own
   * DOMAIN_SEPARATOR(), so the payer never signs against a wrong domain.
   */
  async readTokenDomain(token: Address): Promise<TypedDataDomain> {
    try {
      const [, name, version, chainId, verifyingContract] = await this.publicClient.readContract({
        address: token,
        abi: testUsdcAbi,
        functionName: "eip712Domain",
      });
      return { name, version, chainId: Number(chainId), verifyingContract };
    } catch {
      const [name, version, onchainSeparator] = await Promise.all([
        this.publicClient.readContract({ address: token, abi: legacyDomainAbi, functionName: "name" }),
        this.publicClient
          .readContract({ address: token, abi: legacyDomainAbi, functionName: "version" })
          .catch(() => "1"),
        this.publicClient.readContract({ address: token, abi: legacyDomainAbi, functionName: "DOMAIN_SEPARATOR" }),
      ]);
      const domain: TypedDataDomain = {
        name,
        version,
        chainId: this.network.chain.id,
        verifyingContract: token,
      };
      if (domainSeparator({ domain }) !== onchainSeparator) {
        throw new Error(`could not reconstruct the EIP-712 domain of token ${token}; refusing to sign`);
      }
      return domain;
    }
  }

  /** Relay the payer's signed authorization; the exact price moves into escrow. */
  async relaySettlement(auth: SignedAuthorization): Promise<TxResult> {
    const { r, s, v, yParity } = parseSignature(auth.signature);
    const vNum = v !== undefined ? Number(v) : yParity + 27;
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "settleWithAuthorization",
      args: [auth.requestId, auth.serviceId, auth.payer, auth.validAfter, auth.validBefore, vNum, r, s],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  /** Provider confirms delivery with a hash of the delivered resource; releases escrow. */
  async confirmDelivery(payer: Address, requestId: Hex, serviceId: Hex, deliveryHash: Hex): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "confirmDelivery",
      args: [payer, requestId, serviceId, deliveryHash],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  /** Refund an expired, undelivered escrow back to the payer (callable by anyone). */
  async refund(payer: Address, requestId: Hex, serviceId: Hex): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "refund",
      args: [payer, requestId, serviceId],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  // ─────────────────────────── deposit-vault rail ───────────────────────────

  /** The deterministic deposit address for a set of terms — use as the HSP order pay_to. */
  async depositAddress(terms: DepositTerms): Promise<Address> {
    return this.publicClient.readContract({
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "depositAddress",
      args: [toContractTerms(terms)],
    });
  }

  /** Vault, balance, whether the clone is deployed, whether a claim would succeed, status. */
  async depositStatus(terms: DepositTerms): Promise<{
    vault: Address;
    balance: bigint;
    deployed: boolean;
    claimable: boolean;
    status: EscrowStatusName;
  }> {
    const [vault, balance, deployed, claimable, status] = await this.publicClient.readContract({
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "depositStatus",
      args: [toContractTerms(terms)],
    });
    return { vault, balance, deployed, claimable, status: EscrowStatus[status] ?? "none" };
  }

  /** Claim a terms-committed deposit into escrow (provider or payer). */
  async claimDeposit(terms: DepositTerms): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "claimDeposit",
      args: [toContractTerms(terms)],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  /** Return tokens sitting in a deposit vault to the terms-bound payer. */
  async refundExcessDeposit(terms: DepositTerms, recoverToken?: Address): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "refundExcessDeposit",
      args: [toContractTerms(terms), recoverToken ?? terms.token],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  /** Anchor a payment settled on another rail (e.g. HSP) as an on-chain receipt. */
  async anchorExternalSettlement(params: {
    requestId: Hex;
    serviceId: Hex;
    payer: Address;
    amount: bigint;
    rail: string;
    externalRef: string;
    deliveryHash: Hex;
  }): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "anchorExternalSettlement",
      args: [
        params.requestId,
        params.serviceId,
        params.payer,
        params.amount,
        params.rail,
        params.externalRef,
        params.deliveryHash,
      ],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  private async send(hash: Hash): Promise<TxResult> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`transaction ${hash} reverted`);
    }
    return { hash, receipt };
  }
}
