import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Human-in-the-loop approval gate.
 *
 * The HSP guide requires explicit user approval TWICE: once before signing, once
 * before submission. Each must show pay_to, payer, and token_total_raw. The gate
 * is an interface so the orchestrator is agnostic to how approval is collected
 * (CLI prompt, web UI, auto-approve for tests).
 */
export interface ApprovalRequest {
  stage: "sign" | "submit";
  payer: string;
  payTo: string;
  tokenTotalRaw: string;
  tokenTotalHuman: string;
}

export interface ApprovalGate {
  requestApproval(req: ApprovalRequest): Promise<boolean>;
}

/** Auto-approve — for tests and the offline mock demo only. */
export class AutoApprove implements ApprovalGate {
  async requestApproval(): Promise<boolean> {
    return true;
  }
}

/** Interactive CLI approval. */
export class CliApprove implements ApprovalGate {
  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const verb = req.stage === "sign" ? "SIGN" : "SUBMIT";
      stdout.write(
        `\n────────────────────────────────────────\n` +
          `  Approve to ${verb} payment?\n` +
          `  recipient (pay_to): ${req.payTo}\n` +
          `  payer:              ${req.payer}\n` +
          `  token_total_raw:    ${req.tokenTotalRaw} (raw units)\n` +
          `  ≈ human amount:     ${req.tokenTotalHuman}\n` +
          `────────────────────────────────────────\n`,
      );
      const answer = (await rl.question(`Type "yes" to approve ${verb}: `)).trim().toLowerCase();
      return answer === "yes" || answer === "y";
    } finally {
      rl.close();
    }
  }
}

/**
 * Deferred/remote approval gate — the web UI resolves it. The orchestrator awaits
 * a promise that the server completes when the user clicks approve/reject.
 */
export class DeferredApprovalGate implements ApprovalGate {
  private pending = new Map<string, (approved: boolean) => void>();
  private onRequest?: (req: ApprovalRequest, key: string) => void;

  setOnRequest(cb: (req: ApprovalRequest, key: string) => void): void {
    this.onRequest = cb;
  }

  resolve(key: string, approved: boolean): boolean {
    const resolver = this.pending.get(key);
    if (!resolver) return false;
    this.pending.delete(key);
    resolver(approved);
    return true;
  }

  requestApproval(req: ApprovalRequest): Promise<boolean> {
    const key = req.stage;
    return new Promise<boolean>((resolve) => {
      this.pending.set(key, resolve);
      this.onRequest?.(req, key);
    });
  }
}
