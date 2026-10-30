import type { PaymentSigner } from "./signer.js";
import { BurnerSigner } from "./burner.js";
import { OkxWalletSigner } from "./okx.js";
import type { AppConfig } from "../config.js";
import type { Eip712Payload } from "../types.js";

export interface OkxProviders {
  addressProvider: () => Promise<string>;
  signProvider: (payload: Eip712Payload) => Promise<`0x${string}`>;
}

/**
 * Build the configured signer. "burner" uses a local key; "okx" needs the OKX
 * wallet-skill providers wired in by the host agent (see src/signer/okx.ts).
 */
export function createSigner(config: AppConfig, okx?: OkxProviders): PaymentSigner {
  if (config.signer === "burner") {
    if (!config.burnerPrivateKey) {
      throw new Error('SIGNER=burner but BURNER_PRIVATE_KEY is not set');
    }
    return new BurnerSigner(config.burnerPrivateKey);
  }
  if (!okx) {
    throw new Error(
      'SIGNER=okx requires OKX wallet-skill providers (addressProvider/signProvider). ' +
        'Wire them to the OKX Agentic Wallet skill exposed by your MCP agent.',
    );
  }
  return new OkxWalletSigner(okx.addressProvider, okx.signProvider);
}
