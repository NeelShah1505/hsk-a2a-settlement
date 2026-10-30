import { privateKeyToAccount } from "viem/accounts";
import type { Account, TypedDataDomain } from "viem";
import type { PaymentSigner } from "./signer.js";
import type { Eip712Payload } from "../types.js";

/**
 * Burner-key signer. Signs the returned EIP-712 locally with viem.
 *
 * Use ONLY a testnet/QA key that holds no real funds. The payer wallet must hold
 * the exact test token from get_chain_config and have completed the required
 * approvals (e.g. Permit2) — those prerequisite transactions are the team's manual
 * responsibility and are NOT performed here.
 */
export class BurnerSigner implements PaymentSigner {
  private readonly account: Account;

  constructor(privateKey: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("BURNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
    }
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
  }

  async getAddress(): Promise<string> {
    return this.account.address;
  }

  async signEip712(payload: Eip712Payload): Promise<`0x${string}`> {
    if (!this.account.signTypedData) {
      throw new Error("account cannot signTypedData");
    }
    // Sign exactly what the server returned — do not add, reorder, or re-type fields.
    return this.account.signTypedData({
      domain: payload.domain as TypedDataDomain,
      types: payload.types as Record<string, { name: string; type: string }[]>,
      primaryType: payload.primaryType,
      message: payload.message as Record<string, unknown>,
    });
  }
}
