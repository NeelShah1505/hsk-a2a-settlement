import { formatUnits, parseUnits } from "viem";
import type { HspClient } from "../hsp/client.js";
import type { PaymentSigner } from "../signer/signer.js";
import type { PaymentRequest } from "../a2a/schema.js";
import type {
  CreateOrderResult,
  FinalizePaymentResult,
  PreparePaymentResult,
  QueryPaymentResult,
} from "../types.js";
import {
  buildCartMandate,
  selectPaymentOption,
  type PaymentOption,
} from "../mandate/cart-mandate.js";
import type { ApprovalGate } from "./approvals.js";
import { buildQaResult, type QaResult } from "./report.js";
import { now, type FlowEvent, type FlowListener } from "./events.js";

export interface PaymentAgentOptions {
  /** Team reporting name — identical in create_order and query_payment. */
  merchantName: string;
  /**
   * Code-enforced spend cap as a HUMAN token amount (e.g. "5" = 5 tokens). Converted
   * to raw units with the live token decimals at sign time, so it is decimals-correct
   * for any token. Preferred over maxTokenTotalRaw.
   */
  maxTokenAmount?: string;
  /** Raw-units spend cap (0 disables). Use only when you mean exact raw units. */
  maxTokenTotalRaw?: bigint;
  /** Poll interval for query_payment (ms). Guide uses 15s; smaller for demo/tests. */
  pollIntervalMs?: number;
  /** Max total polling time before reporting "Pending confirmation" (ms). */
  maxPollMs?: number;
  /** Max consecutive query_payment errors before giving up polling (default 20). */
  maxConsecutiveQueryErrors?: number;
  /** Proceed when multiple network/token options match and none was disambiguated. */
  allowAmbiguousOption?: boolean;
  /** Max re-prepare attempts on quote expiry / Gateway 30043. */
  maxReprepares?: number;
  /** Optional on-chain balance check; return the payer's raw token balance. */
  balanceChecker?: (tokenAddress: string, payer: string) => Promise<bigint>;
}

export class PaymentAgentError extends Error {}

/**
 * The Payment Agent. Consumes an A2A PaymentRequest and drives the documented HSP
 * flow: get_chain_config -> create_order -> prepare_payment -> (approval) -> sign
 * -> finalize_payment -> (approval) -> submit_payment -> query_payment.
 */
export class PaymentAgent {
  constructor(
    private readonly hsp: HspClient,
    private readonly signer: PaymentSigner,
    private readonly approvals: ApprovalGate,
    private readonly opts: PaymentAgentOptions,
    private readonly listener: FlowListener = () => {},
  ) {}

  private emit(event: FlowEvent): void {
    this.listener(event);
  }

  private log(message: string): void {
    this.emit({ type: "log", at: now(), message });
  }

  async run(request: PaymentRequest): Promise<QaResult> {
    this.emit({
      type: "a2a_request_received",
      at: now(),
      requestId: request.id,
      merchantName: request.merchantName,
      payTo: request.payTo,
      amountUsd: request.amount.value,
      description: request.description,
    });

    // Reject expired A2A requests up front.
    if (Date.parse(request.expiry) <= Date.now()) {
      throw new PaymentAgentError(`A2A payment request ${request.id} has already expired`);
    }

    // 1. Chain config — authoritative source for network/token/protocol.
    const chainConfig = await this.hsp.getChainConfig();
    const { option, ambiguous } = selectPaymentOption(chainConfig, request.constraints);
    if (ambiguous && !this.opts.allowAmbiguousOption) {
      throw new PaymentAgentError(
        "Multiple network/token options match and none was disambiguated. " +
          `Pin one via constraints (network/tokenSymbol), e.g. network="${option.network}" ` +
          `tokenSymbol="${option.symbol}", or enable allowAmbiguousOption.`,
      );
    }
    if (ambiguous) {
      this.log(
        `Multiple network/token options matched; proceeding with ${option.network} · ` +
          `${option.symbol} · ${option.protocol}. Pin one via constraints to be explicit.`,
      );
    }
    this.emit({
      type: "chain_config",
      at: now(),
      network: option.network,
      chainId: option.chainId,
      tokenSymbol: option.symbol,
      tokenAddress: option.tokenAddress,
      decimals: option.decimals,
      protocol: option.protocol,
      ambiguous,
    });

    // 2. Create order from the A2A conditions.
    const cartMandate = buildCartMandate(request, option);
    const order = await this.hsp.createOrder({
      merchant_name: this.opts.merchantName,
      pay_to: request.payTo,
      cart_mandate: cartMandate,
    });
    if (!order.flow_id || !order.payment_request_id) {
      throw new PaymentAgentError("create_order did not return flow_id / payment_request_id");
    }
    this.emit({
      type: "order_created",
      at: now(),
      flowId: order.flow_id,
      paymentRequestId: order.payment_request_id,
      paymentUrl: order.payment_url,
    });

    // Best-effort: read order detail (gas treatment) and a fee estimate. These are
    // informational and never gate the flow — the authoritative amount is the
    // token_total_raw returned by prepare_payment. Guarded so a live-schema mismatch
    // or an unsupported tool cannot break settlement.
    let gasFeeAdvanced: boolean | undefined;
    try {
      const detail = (await this.hsp.getOrder({ flow_id: order.flow_id })) as {
        gas_fee_advanced?: boolean;
      };
      gasFeeAdvanced = detail?.gas_fee_advanced;
      this.log(
        `order gas treatment: gas_fee_advanced=${gasFeeAdvanced === undefined ? "n/a" : gasFeeAdvanced}` +
          (gasFeeAdvanced === false ? " (payer bears network fee, included in authorization)" : ""),
      );
    } catch (e) {
      this.log(`get_order skipped: ${String((e as Error)?.message ?? e)}`);
    }
    try {
      const fee = (await this.hsp.estimateFee({ flow_id: order.flow_id })) as {
        gas_fee?: string | number;
      };
      const g = fee?.gas_fee;
      this.log(`estimate_fee: gas_fee=${g === undefined ? "n/a" : g}`);
    } catch (e) {
      this.log(`estimate_fee skipped: ${String((e as Error)?.message ?? e)}`);
    }

    const payer = await this.signer.getAddress();

    // 3-6. prepare -> approve -> sign -> finalize, re-preparing on expiry/30043,
    // then submit.
    const { final } = await this.submitWithRetry(order, payer, option);

    const tokenTotalHuman = (raw: string): string =>
      `${formatUnits(BigInt(raw), option.decimals)} ${option.symbol}`.trim();

    const qa = buildQaResult({
      merchantName: this.opts.merchantName,
      tokenTotalRaw: final.tokenTotalRaw,
      tokenTotalHuman: tokenTotalHuman(final.tokenTotalRaw),
      final: final.query,
    });

    this.emit({
      type: "terminal",
      at: now(),
      status: final.query.status,
      message: final.message,
    });
    return qa;
  }

  /** Prepare a quote, get sign-approval, sign the returned eip712, and finalize. */
  private async prepareSignFinalize(
    flowId: string,
    payer: string,
    option: PaymentOption,
  ): Promise<{ prepared: PreparePaymentResult; finalized: FinalizePaymentResult }> {
    const prepared = await this.hsp.prepare_payment({
      flow_id: flowId,
      payer,
      protocol: option.protocol,
    });

    const human = `${formatUnits(BigInt(prepared.token_total_raw), option.decimals)} ${option.symbol}`.trim();
    this.emit({
      type: "quote_prepared",
      at: now(),
      payer: prepared.payer,
      payTo: prepared.pay_to,
      tokenTotalRaw: prepared.token_total_raw,
      tokenTotalHuman: human,
      quoteExpiresAt: prepared.quote_expires_at,
      protocol: option.protocol,
      primaryType: prepared.eip712.primaryType,
    });

    // Safety cap — refuse to sign above the configured maximum. The cap is computed
    // in raw units using the live token decimals so it is correct for any token.
    const cap = this.capRaw(option);
    if (cap > 0n && BigInt(prepared.token_total_raw) > cap) {
      throw new PaymentAgentError(
        `token_total_raw ${prepared.token_total_raw} exceeds the spend cap of ${cap} raw units ` +
          `(${formatUnits(cap, option.decimals)} ${option.symbol}); refusing to sign`,
      );
    }

    // Optional balance check — never sign for more than the payer holds.
    if (this.opts.balanceChecker) {
      const balance = await this.opts.balanceChecker(option.tokenAddress, payer);
      if (balance < BigInt(prepared.token_total_raw)) {
        throw new PaymentAgentError(
          `payer balance ${balance} is below token_total_raw ${prepared.token_total_raw}; ` +
            `fund the wallet manually before signing`,
        );
      }
    }

    // Approval #1 — before signing.
    this.emit({
      type: "approval_requested",
      at: now(),
      stage: "sign",
      payer: prepared.payer,
      payTo: prepared.pay_to,
      tokenTotalRaw: prepared.token_total_raw,
      tokenTotalHuman: human,
    });
    const okToSign = await this.approvals.requestApproval({
      stage: "sign",
      payer: prepared.payer,
      payTo: prepared.pay_to,
      tokenTotalRaw: prepared.token_total_raw,
      tokenTotalHuman: human,
    });
    this.emit({ type: "approval_resolved", at: now(), stage: "sign", approved: okToSign });
    if (!okToSign) throw new PaymentAgentError("User rejected signing");

    if (this.isExpired(prepared.quote_expires_at)) {
      throw new QuoteExpiredError();
    }

    // Sign EXACTLY the returned eip712.
    const signature = await this.signer.signEip712(prepared.eip712);
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new PaymentAgentError("signer returned an invalid signature");
    }
    this.emit({
      type: "signed",
      at: now(),
      signaturePreview: `${signature.slice(0, 10)}…${signature.slice(-6)}`,
    });

    // Finalize — pass the server objects through UNCHANGED.
    const finalized = await this.hsp.finalize_payment({
      signature,
      payment_payload: prepared.payment_payload,
      payment_mandate_contents: prepared.payment_mandate_contents,
      cart_hash: prepared.cart_hash,
    });
    if (finalized.payment_mandate_json === undefined) {
      throw new PaymentAgentError("finalize_payment did not return payment_mandate_json");
    }
    this.emit({ type: "finalized", at: now() });
    return { prepared, finalized };
  }

  /** Submit, re-preparing + re-signing on quote expiry or Gateway 30043. */
  private async submitWithRetry(
    order: CreateOrderResult,
    payer: string,
    option: PaymentOption,
  ): Promise<{ final: FinalState }> {
    const maxReprepares = this.opts.maxReprepares ?? 2;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxReprepares; attempt++) {
      let prepared: PreparePaymentResult;
      let finalized: FinalizePaymentResult;
      try {
        const r = await this.prepareSignFinalize(order.flow_id, payer, option);
        prepared = r.prepared;
        finalized = r.finalized;
      } catch (e) {
        if (e instanceof QuoteExpiredError && attempt < maxReprepares) {
          this.emit({ type: "quote_reprepared", at: now(), reason: "quote expired before signing" });
          continue;
        }
        throw e;
      }

      // Approval #2 — before submission.
      const human = `${formatUnits(BigInt(prepared.token_total_raw), option.decimals)} ${option.symbol}`.trim();
      this.emit({
        type: "approval_requested",
        at: now(),
        stage: "submit",
        payer: prepared.payer,
        payTo: prepared.pay_to,
        tokenTotalRaw: prepared.token_total_raw,
        tokenTotalHuman: human,
      });
      const okToSubmit = await this.approvals.requestApproval({
        stage: "submit",
        payer: prepared.payer,
        payTo: prepared.pay_to,
        tokenTotalRaw: prepared.token_total_raw,
        tokenTotalHuman: human,
      });
      this.emit({ type: "approval_resolved", at: now(), stage: "submit", approved: okToSubmit });
      if (!okToSubmit) throw new PaymentAgentError("User rejected submission");

      try {
        const submit = await this.hsp.submit_payment({
          payment_mandate_json: finalized.payment_mandate_json,
        });
        this.emit({ type: "submitted", at: now(), status: submit.status });

        const query = await this.pollUntilTerminal(order);
        return {
          final: {
            tokenTotalRaw: prepared.token_total_raw,
            query: query.result,
            message: query.message,
          },
        };
      } catch (e) {
        lastErr = e;
        if (is30043(e) && attempt < maxReprepares) {
          this.emit({ type: "quote_reprepared", at: now(), reason: "Gateway returned 30043" });
          continue;
        }
        throw e;
      }
    }
    // Unreachable in practice (the loop returns or throws), but keeps the contract total.
    throw new PaymentAgentError(
      `submit failed after ${maxReprepares} re-prepares: ${String(lastErr)}`,
    );
  }

  /** Poll query_payment until a terminal status, honouring each documented status. */
  private async pollUntilTerminal(
    order: CreateOrderResult,
  ): Promise<{ result: QueryPaymentResult; message: string }> {
    const interval = this.opts.pollIntervalMs ?? 15_000;
    const maxMs = this.opts.maxPollMs ?? 600_000;
    const maxConsecutiveErrors = this.opts.maxConsecutiveQueryErrors ?? 20;
    const start = Date.now();
    let lastResult: QueryPaymentResult | undefined;
    let consecutiveErrors = 0;

    const pendingMessage = () =>
      `Pending confirmation. flow_id=${order.flow_id} payment_request_id=${order.payment_request_id}. ` +
      `Did not reach payment-safe/finalized/failed; resume querying with these identifiers.`;
    const pendingResult = (): QueryPaymentResult =>
      lastResult ?? { status: "payment-timeout", payment: {} };

    for (;;) {
      // Enforce the overall budget regardless of whether queries succeed or error.
      if (Date.now() - start >= maxMs) {
        return { result: pendingResult(), message: pendingMessage() };
      }

      let result: QueryPaymentResult;
      try {
        result = await this.hsp.queryPayment({
          flow_id: order.flow_id,
          payment_request_id: order.payment_request_id,
          expected_merchant_name: this.opts.merchantName,
        });
        consecutiveErrors = 0;
        lastResult = result;
      } catch (e) {
        // Do not infer success or failure — show the error and keep the identifiers.
        consecutiveErrors += 1;
        this.log(
          `query_payment error ${consecutiveErrors}/${maxConsecutiveErrors} ` +
            `(retaining flow_id=${order.flow_id} payment_request_id=${order.payment_request_id}): ${String(e)}`,
        );
        if (consecutiveErrors >= maxConsecutiveErrors) {
          return { result: pendingResult(), message: pendingMessage() };
        }
        await sleep(interval);
        continue;
      }

      this.emit({
        type: "status_poll",
        at: now(),
        status: result.status,
        attributionVerified: result.attribution_verified,
        txSignature: result.payment?.tx_signature,
      });

      switch (result.status) {
        case "payment-safe":
          return {
            result,
            message:
              "The transaction is on-chain and has received half of the required block confirmations. It is not yet finalized.",
          };
        case "payment-finalized":
          return { result, message: "The payment has reached final confirmation." };
        case "payment-failed":
          return {
            result,
            message: `Payment failed: ${result.payment?.status_reason ?? "no reason provided"}`,
          };
        case "payment-submitted":
        case "payment-verified":
        case "payment-processing":
        case "payment-included":
        case "payment-timeout":
          // Keep polling the same payment (timeout is recoverable).
          break;
        default:
          // Unrecognised status — report it, do not infer; keep polling.
          this.log(`Unrecognised status "${result.status}"; retaining identifiers and continuing.`);
          break;
      }

      if (Date.now() - start >= maxMs) {
        return {
          result,
          message:
            `Pending confirmation. flow_id=${order.flow_id} payment_request_id=${order.payment_request_id}. ` +
            `Did not reach payment-safe/finalized/failed within the polling window; resume querying with these identifiers.`,
        };
      }
      await sleep(interval);
    }
  }

  private isExpired(rfc3339: string): boolean {
    const t = Date.parse(rfc3339);
    // Fail closed: if we can't parse the expiry, treat the quote as expired rather
    // than sign against a deadline we don't understand.
    if (Number.isNaN(t)) return true;
    // 3s safety margin so we never sign a quote about to lapse.
    return Date.now() >= t - 3_000;
  }

  /** Resolve the spend cap to raw units using the live token decimals. */
  private capRaw(option: PaymentOption): bigint {
    if (this.opts.maxTokenAmount && this.opts.maxTokenAmount.trim() !== "") {
      return parseUnits(this.opts.maxTokenAmount, option.decimals);
    }
    return this.opts.maxTokenTotalRaw ?? 0n;
  }
}

interface FinalState {
  tokenTotalRaw: string;
  query: QueryPaymentResult;
  message: string;
}

class QuoteExpiredError extends Error {
  constructor() {
    super("quote expired before signing");
    this.name = "QuoteExpiredError";
  }
}

function is30043(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes("30043");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
