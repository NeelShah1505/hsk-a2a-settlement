import type { PaymentSigner } from "./signer.js";
import type { Eip712Payload } from "../types.js";

/**
 * OKX Agentic Wallet signer (boundary adapter).
 *
 * The OKX Agentic Wallet signs via the Onchain OS "wallet skill", which runs
 * inside the MCP-capable agent (e.g. Claude Code), not inside this process. This
 * adapter is the integration seam: wire these two callbacks to the wallet-skill
 * tool calls your agent exposes.
 *
 *   addressProvider: returns the logged-in wallet's EVM address.
 *   signProvider:    hands the eip712 to the wallet skill and returns its signature.
 *
 * Keeping this behind the PaymentSigner interface means the orchestrator does not
 * care whether signing happens via a local burner key or the OKX wallet skill.
 */
export class OkxWalletSigner implements PaymentSigner {
  constructor(
    private readonly addressProvider: () => Promise<string>,
    private readonly signProvider: (payload: Eip712Payload) => Promise<`0x${string}`>,
  ) {}

  getAddress(): Promise<string> {
    return this.addressProvider();
  }

  signEip712(payload: Eip712Payload): Promise<`0x${string}`> {
    return this.signProvider(payload);
  }
}
