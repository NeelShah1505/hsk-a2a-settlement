import { randomUUID } from "node:crypto";
import type { ChainConfig, ChainNetworkConfig, ChainTokenConfig, PaymentProtocol } from "../types.js";
import type { PaymentRequest } from "../a2a/schema.js";

/**
 * Builds the HSP create_order `cart_mandate` from an A2A PaymentRequest plus the
 * live chain configuration.
 *
 * Per the HSP guide, the cart mandate must include at least:
 *   - contents.id
 *   - contents.cart_expiry (RFC3339)
 *   - contents.payment_request.method_data[]  (one per payment method)
 *   - contents.payment_request.details
 * and amount.currency must be USD. We MUST NOT provide merchant_authorization.
 * Network/token values come from get_chain_config, never from memory. The server
 * overrides each item's data.pay_to with the separately-supplied pay_to.
 *
 * The exact nested shape is governed by the live create_order input schema —
 * confirm field names/types against it before sending.
 */

export interface PaymentOption {
  network: string;
  chainId: number | string;
  tokenAddress: string;
  decimals: number;
  protocol: PaymentProtocol;
  symbol: string;
}

/** Flatten get_chain_config into selectable network/token options. */
export function listPaymentOptions(config: ChainConfig): PaymentOption[] {
  const networks: ChainNetworkConfig[] = Array.isArray(config.networks)
    ? config.networks
    : [];
  const options: PaymentOption[] = [];
  for (const net of networks) {
    for (const t of net.tokens ?? []) {
      options.push({
        network: net.network,
        chainId: net.chain_id,
        tokenAddress: t.address,
        decimals: t.decimals,
        protocol: t.payment_protocol,
        symbol: (t as ChainTokenConfig).symbol ?? "",
      });
    }
  }
  return options;
}

/**
 * Pick a payment option, honouring any constraints from the receiving agent.
 * If more than one option matches and no constraint disambiguates, the caller
 * should ask which to use rather than guessing.
 */
export function selectPaymentOption(
  config: ChainConfig,
  constraints?: PaymentRequest["constraints"],
): { option: PaymentOption; ambiguous: boolean } {
  const all = listPaymentOptions(config);
  if (all.length === 0) {
    throw new Error("get_chain_config returned no selectable network/token options");
  }
  let filtered = all;
  if (constraints?.network) {
    filtered = filtered.filter((o) => o.network === constraints.network);
  }
  if (constraints?.tokenSymbol) {
    filtered = filtered.filter(
      (o) => o.symbol.toLowerCase() === constraints.tokenSymbol!.toLowerCase(),
    );
  }
  if (filtered.length === 0) {
    throw new Error(
      `No network/token option matches constraints ${JSON.stringify(constraints)}`,
    );
  }
  return { option: filtered[0]!, ambiguous: filtered.length > 1 };
}

export interface CartMandate {
  contents: {
    id: string;
    cart_expiry: string; // RFC3339
    payment_request: {
      method_data: Array<{
        supported_methods: string[];
        data: Record<string, unknown>;
      }>;
      details: Record<string, unknown>;
    };
  };
  // Note: amount.currency must be USD; no merchant_authorization.
  amount: { value: string; currency: "USD" };
}

export function buildCartMandate(
  request: PaymentRequest,
  option: PaymentOption,
): CartMandate {
  return {
    contents: {
      id: randomUUID(),
      cart_expiry: request.expiry,
      payment_request: {
        method_data: [
          {
            supported_methods: ["https://www.x402.org/"],
            data: {
              x402Version: 2,
              network: option.network,
              chainId: option.chainId,
              asset: option.tokenAddress,
              // The server overrides data.pay_to with the supplied pay_to; we set
              // it for completeness/traceability.
              pay_to: request.payTo,
            },
          },
        ],
        details: {
          id: request.id,
          description: request.description ?? "A2A payment",
          total: { amount: request.amount, label: request.merchantName },
        },
      },
    },
    amount: { value: request.amount.value, currency: "USD" },
  };
}
