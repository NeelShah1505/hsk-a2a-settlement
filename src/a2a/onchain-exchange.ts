import { formatUnits, getAddress, keccak256, parseUnits, toBytes, type Address, type Hex } from "viem";
import type { PaymentSigner } from "../signer/signer.js";
import type { ApprovalGate } from "../agent/approvals.js";
import { now, type FlowEvent, type FlowListener } from "../agent/events.js";
import { HskEscrowRail, toBytes32Id } from "../onchain/escrow-rail.js";
import { addressUrl, txUrl } from "../onchain/networks.js";
import type { ReceivingAgent, ResourcePayload } from "./receiving-agent.js";

export interface OnchainExchangeOptions {
  /** Team reporting name, shown on the receipt. */
  merchantName: string;
  /** Spend cap as a human token amount; the payer refuses to sign above it. */
  maxTokenAmount?: string;
  /** How long the payer's authorization stays valid, in seconds (default 600). */
  authorizationValiditySeconds?: number;
}

export interface OnchainPurchaseResult {
  status: "payment-released";
  requestId: Hex;
  payer: Address;
  payTo: Address;
  amount: bigint;
  tokenSymbol: string;
  decimals: number;
  escrowTx: Hex;
  releaseTx: Hex;
  deliveryHash: Hex;
  resource: ResourcePayload;
  /** Human-readable "key: value" receipt, rendered by the UI. */
  receipt: string;
}

export class OnchainExchangeError extends Error {}

/**
 * Trust-minimized A2A purchase on HSK Chain:
 *
 *   Payment Agent   requests a service; the Receiving Agent quotes it (the A2A "402").
 *   Payment Agent   cross-checks the quote against the on-chain price, then (after human
 *                   approval) signs a gasless EIP-3009 authorization bound to this request.
 *   Receiving Agent relays the authorization (it pays gas); the price locks in escrow.
 *   Receiving Agent verifies the escrow ON-CHAIN, delivers the resource, and confirms
 *                   delivery with the resource hash, which releases the funds.
 *
 * If the Receiving Agent never delivers, the escrow refunds the payer after the deadline.
 */
export class OnchainA2AExchange {
  constructor(
    private readonly receiving: ReceivingAgent,
    private readonly rail: HskEscrowRail,
    private readonly payer: PaymentSigner,
    private readonly approvals: ApprovalGate,
    private readonly opts: OnchainExchangeOptions,
    private readonly listener: FlowListener = () => {},
  ) {}

  private emit(e: FlowEvent): void {
    this.listener(e);
  }

  private log(message: string): void {
    this.emit({ type: "log", at: now(), message });
  }

  private tx(label: string, hash: Hex): void {
    this.emit({
      type: "onchain_tx",
      at: now(),
      label,
      hash,
      network: this.rail.network.label,
      explorerUrl: txUrl(this.rail.network, hash),
    });
  }

  async purchase(serviceId: string): Promise<OnchainPurchaseResult> {
    const svcMeta = this.receiving.getService(serviceId);
    this.emit({
      type: "service_requested",
      at: now(),
      serviceId,
      name: svcMeta.name,
      priceUsd: svcMeta.priceUsd,
      description: svcMeta.description,
    });

    // 1. The Receiving Agent transmits the payment conditions (A2A "402").
    const request = this.receiving.quoteService(serviceId);
    this.emit({
      type: "a2a_request_received",
      at: now(),
      requestId: request.id,
      merchantName: request.merchantName,
      payTo: request.payTo,
      amountUsd: request.amount.value,
      description: request.description,
    });
    if (Date.parse(request.expiry) <= Date.now()) {
      throw new OnchainExchangeError(`A2A payment request ${request.id} has already expired`);
    }

    // 2. Read the service from chain — the authoritative price, token and payout.
    const serviceHash = toBytes32Id(serviceId);
    const svc = await this.rail.getService(serviceHash);
    if (svc.provider === "0x0000000000000000000000000000000000000000") {
      throw new OnchainExchangeError(`service "${serviceId}" is not registered on ${this.rail.network.label}`);
    }
    if (!svc.active) throw new OnchainExchangeError(`service "${serviceId}" is inactive on-chain`);
    const token = await this.rail.getTokenInfo(svc.token);
    const human = formatUnits(svc.price, token.decimals);

    // The off-chain quote must match the on-chain price: protects the payer from a
    // receiving agent that quotes one price and charges another.
    if (parseUnits(request.amount.value, token.decimals) !== svc.price) {
      throw new OnchainExchangeError(
        `quote mismatch: receiving agent asked ${request.amount.value} USD but the on-chain price is ${human} ${token.symbol}`,
      );
    }
    this.emit({
      type: "chain_config",
      at: now(),
      network: this.rail.network.label,
      chainId: this.rail.network.chain.id,
      tokenSymbol: token.symbol,
      tokenAddress: svc.token,
      decimals: token.decimals,
      protocol: "eip3009",
      ambiguous: false,
    });

    // 3. Bind this purchase to an on-chain request id.
    const requestId = toBytes32Id(request.id);
    this.emit({
      type: "order_created",
      at: now(),
      flowId: requestId,
      paymentRequestId: this.rail.settlement,
      paymentUrl: addressUrl(this.rail.network, this.rail.settlement),
    });

    const payer = getAddress(await this.payer.getAddress());

    // Spend cap (human amount -> raw units with the live decimals).
    if (this.opts.maxTokenAmount && this.opts.maxTokenAmount.trim() !== "") {
      const cap = parseUnits(this.opts.maxTokenAmount, token.decimals);
      if (svc.price > cap) {
        throw new OnchainExchangeError(
          `price ${human} ${token.symbol} exceeds the spend cap of ${this.opts.maxTokenAmount} ${token.symbol}; refusing to sign`,
        );
      }
    }
    const balance = await this.rail.tokenBalance(svc.token, payer);
    if (balance < svc.price) {
      throw new OnchainExchangeError(
        `payer ${payer} holds ${formatUnits(balance, token.decimals)} ${token.symbol}, below the ${human} ${token.symbol} price; fund the payer first`,
      );
    }

    // 4. Quote: the exact EIP-3009 authorization the payer will sign.
    const { typedData, validAfter, validBefore } = await this.rail.buildAuthorization({
      payer,
      requestId,
      serviceId: serviceHash,
      token: svc.token,
      value: svc.price,
      validForSeconds: this.opts.authorizationValiditySeconds,
    });
    const humanAmount = `${human} ${token.symbol}`;
    this.emit({
      type: "quote_prepared",
      at: now(),
      payer,
      payTo: svc.payTo,
      tokenTotalRaw: svc.price.toString(),
      tokenTotalHuman: humanAmount,
      quoteExpiresAt: new Date(Number(validBefore) * 1000).toISOString(),
      protocol: "eip3009",
      primaryType: typedData.primaryType,
    });

    // 5. Human key #1 — authorize the signature.
    await this.requireApproval("sign", payer, svc.payTo, svc.price, humanAmount);
    const signature = await this.payer.signEip712(typedData);
    this.emit({ type: "signed", at: now(), signaturePreview: `${signature.slice(0, 10)}…${signature.slice(-6)}` });
    this.emit({ type: "finalized", at: now() });
    this.log("Signed EIP-3009 authorization handed to the receiving agent over A2A; the payer needs no gas.");

    // 6. Human key #2 — authorize the on-chain relay into escrow.
    await this.requireApproval("submit", payer, svc.payTo, svc.price, humanAmount);
    const escrow = await this.rail.relaySettlement({
      payer,
      requestId,
      serviceId: serviceHash,
      validAfter,
      validBefore,
      signature,
    });
    this.tx("escrow", escrow.hash);
    this.emit({ type: "submitted", at: now(), status: "escrow-submitted" });

    // 7. The Receiving Agent verifies the escrow on-chain instead of trusting the payer.
    const payment = await this.rail.getPayment(payer, requestId, serviceHash);
    const verified =
      payment.status === "escrowed" &&
      payment.amount === svc.price &&
      payment.serviceId === serviceHash &&
      getAddress(payment.payer) === payer;
    this.emit({
      type: "status_poll",
      at: now(),
      status: verified ? "payment-escrowed" : `escrow-${payment.status}`,
      attributionVerified: verified,
      txSignature: escrow.hash,
    });
    if (!verified) {
      throw new OnchainExchangeError(
        `on-chain escrow verification failed (status=${payment.status}, amount=${payment.amount})`,
      );
    }
    this.log(
      `Receiving agent verified on-chain: ${humanAmount} escrowed, deliver by ${new Date(payment.deadline * 1000).toISOString()}.`,
    );
    this.emit({
      type: "terminal",
      at: now(),
      status: "payment-escrowed",
      message: "Funds locked in escrow on HSK Chain and verified on-chain by the receiving agent.",
    });

    // 8. Deliver, then release escrow with a hash of exactly what was delivered.
    const resource = this.receiving.deliver(serviceId);
    const deliveryHash = keccak256(toBytes(JSON.stringify(resource)));
    const release = await this.rail.confirmDelivery(payer, requestId, serviceHash, deliveryHash);
    this.tx("release", release.hash);
    this.emit({
      type: "resource_delivered",
      at: now(),
      serviceId,
      title: resource.title,
      contentType: resource.contentType,
      body: resource.body,
    });

    const receipt = formatOnchainReceipt({
      merchantName: this.opts.merchantName,
      networkLabel: `${this.rail.network.label} (${this.rail.network.chain.id})`,
      amountRaw: svc.price,
      humanAmount,
      payTo: svc.payTo,
      payer,
      escrowTx: escrow.hash,
      releaseTx: release.hash,
      deliveryHash,
      settlement: this.rail.settlement,
      escrowUrl: txUrl(this.rail.network, escrow.hash),
      releaseUrl: txUrl(this.rail.network, release.hash),
    });

    return {
      status: "payment-released",
      requestId,
      payer,
      payTo: svc.payTo,
      amount: svc.price,
      tokenSymbol: token.symbol,
      decimals: token.decimals,
      escrowTx: escrow.hash,
      releaseTx: release.hash,
      deliveryHash,
      resource,
      receipt,
    };
  }

  private async requireApproval(
    stage: "sign" | "submit",
    payer: Address,
    payTo: Address,
    amount: bigint,
    humanAmount: string,
  ): Promise<void> {
    const req = { stage, payer, payTo, tokenTotalRaw: amount.toString(), tokenTotalHuman: humanAmount };
    this.emit({ type: "approval_requested", at: now(), ...req });
    const approved = await this.approvals.requestApproval(req);
    this.emit({ type: "approval_resolved", at: now(), stage, approved });
    if (!approved) {
      throw new OnchainExchangeError(stage === "sign" ? "User rejected signing" : "User rejected submission");
    }
  }
}

export function formatOnchainReceipt(r: {
  merchantName: string;
  networkLabel: string;
  amountRaw: bigint;
  humanAmount: string;
  payTo: Address;
  payer: Address;
  escrowTx: Hex;
  releaseTx: Hex;
  deliveryHash: Hex;
  settlement: Address;
  escrowUrl?: string;
  releaseUrl?: string;
}): string {
  const lines = [
    "HSK Chain A2A Escrow — Settlement Receipt",
    "Payment status: payment-released",
    `Hackathon team: ${r.merchantName}`,
    "Escrow verified on-chain: true",
    `Network: ${r.networkLabel}`,
    `Raw amount (raw units): ${r.amountRaw}`,
    `Human-readable amount: ${r.humanAmount}`,
    `Recipient address: ${r.payTo}`,
    `Payer address: ${r.payer}`,
    `Escrow transaction: ${r.escrowTx}`,
    `Release transaction: ${r.releaseTx}`,
    `Delivery hash: ${r.deliveryHash}`,
    `Escrow contract: ${r.settlement}`,
  ];
  if (r.escrowUrl) lines.push(`Escrow tx explorer: ${r.escrowUrl}`);
  if (r.releaseUrl) lines.push(`Release tx explorer: ${r.releaseUrl}`);
  return lines.join("\n");
}
