import type { Eip712Payload } from "../types.js";

/**
 * Pluggable payment signer.
 *
 * The HSP flow signs an off-chain EIP-712 authorization (the `eip712` object
 * returned by prepare_payment) — NOT a self-broadcast transaction. The signer:
 *   1. reports the payer EVM address it controls, and
 *   2. signs EXACTLY the returned eip712 (preserving domain/types/primaryType/message),
 *      returning a 65-byte signature beginning with 0x.
 *
 * Implementations: BurnerSigner (local private key via viem) and OkxWalletSigner
 * (delegates to the OKX Agentic Wallet skill).
 */
export interface PaymentSigner {
  /** The EVM address that will be the `payer`. Confirm it with the user before use. */
  getAddress(): Promise<string>;

  /** Sign the eip712 object returned by prepare_payment, unchanged. */
  signEip712(payload: Eip712Payload): Promise<`0x${string}`>;
}
