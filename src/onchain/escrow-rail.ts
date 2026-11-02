import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseSignature,
  toBytes,
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

export interface TxResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

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

  async getPayment(payer: Address, requestId: Hex): Promise<OnchainPayment> {
    const p = await this.publicClient.readContract({
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "getPayment",
      args: [payer, requestId],
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
    const [domainTuple, nonce, block] = await Promise.all([
      this.publicClient.readContract({ address: params.token, abi: testUsdcAbi, functionName: "eip712Domain" }),
      this.publicClient.readContract({
        address: this.settlement,
        abi: a2aSettlementAbi,
        functionName: "authorizationNonce",
        args: [params.requestId, params.serviceId],
      }),
      this.publicClient.getBlock(),
    ]);
    const [, name, version, chainId, verifyingContract] = domainTuple;
    const validAfter = 0n;
    const validBefore = block.timestamp + BigInt(params.validForSeconds ?? 600);

    return {
      validAfter,
      validBefore,
      typedData: {
        domain: { name, version, chainId: Number(chainId), verifyingContract },
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
  async confirmDelivery(payer: Address, requestId: Hex, deliveryHash: Hex): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "confirmDelivery",
      args: [payer, requestId, deliveryHash],
    });
    return this.send(await this.wallet.writeContract(request));
  }

  /** Refund an expired, undelivered escrow back to the payer (callable by anyone). */
  async refund(payer: Address, requestId: Hex): Promise<TxResult> {
    const { request } = await this.publicClient.simulateContract({
      account: this.relayer,
      address: this.settlement,
      abi: a2aSettlementAbi,
      functionName: "refund",
      args: [payer, requestId],
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
