import { describe, it, expect } from "vitest";
import {
  buildCartMandate,
  listPaymentOptions,
  selectPaymentOption,
} from "../src/mandate/cart-mandate.js";
import type { ChainConfig } from "../src/types.js";
import type { PaymentRequest } from "../src/a2a/schema.js";

const config: ChainConfig = {
  networks: [
    {
      network: "hashkey-testnet",
      chain_id: 133,
      tokens: [
        { address: "0x" + "1".repeat(40), decimals: 6, symbol: "USDC", payment_protocol: "eip3009" },
        { address: "0x" + "9".repeat(40), decimals: 6, symbol: "USDT", payment_protocol: "permit2" },
      ],
    },
  ],
};

const request: PaymentRequest = {
  id: "req-1",
  merchantName: "demo-team",
  payTo: "0x" + "2".repeat(40),
  amount: { value: "1", currency: "USD" },
  expiry: new Date(Date.now() + 300_000).toISOString(),
  description: "data feed",
};

describe("payment option selection", () => {
  it("flattens networks/tokens into options", () => {
    const options = listPaymentOptions(config);
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ network: "hashkey-testnet", symbol: "USDC", protocol: "eip3009" });
  });

  it("flags ambiguity when multiple options match and none disambiguates", () => {
    const { ambiguous } = selectPaymentOption(config);
    expect(ambiguous).toBe(true);
  });

  it("disambiguates by token symbol", () => {
    const { option, ambiguous } = selectPaymentOption(config, { tokenSymbol: "USDT" });
    expect(ambiguous).toBe(false);
    expect(option.symbol).toBe("USDT");
    expect(option.protocol).toBe("permit2");
  });

  it("throws when no option matches constraints", () => {
    expect(() => selectPaymentOption(config, { tokenSymbol: "DAI" })).toThrow();
  });

  it("throws when chain config has no options", () => {
    expect(() => selectPaymentOption({ networks: [] })).toThrow();
  });
});

describe("cart mandate", () => {
  it("builds an x402 cart mandate from an A2A request", () => {
    const { option } = selectPaymentOption(config, { tokenSymbol: "USDC" });
    const mandate = buildCartMandate(request, option);

    expect(mandate.amount).toEqual({ value: "1", currency: "USD" });
    const method = mandate.contents.payment_request.method_data[0]!;
    expect(method.supported_methods).toEqual(["https://www.x402.org/"]);
    expect(method.data.x402Version).toBe(2);
    expect(method.data.network).toBe("hashkey-testnet");
    expect(method.data.asset).toBe("0x" + "1".repeat(40));
    expect(method.data.pay_to).toBe(request.payTo);
    expect(mandate.contents.cart_expiry).toBe(request.expiry);
    expect(mandate.contents.id).toBeTruthy();
    // Never include merchant_authorization.
    expect(JSON.stringify(mandate)).not.toContain("merchant_authorization");
  });
});
