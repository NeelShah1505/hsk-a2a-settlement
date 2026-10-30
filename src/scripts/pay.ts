/**
 * Live CLI payment against the HSP MCP server, with interactive approvals.
 * Run: `pnpm pay`. Requires: egress IP allowlisted, wallet funded + approvals done,
 * and (for SIGNER=burner) BURNER_PRIVATE_KEY set.
 *
 * SIGNER=okx is not drivable from this standalone CLI — OKX wallet signing runs
 * through the MCP agent's wallet skill. Use the host agent for that path.
 */
import { loadConfig } from "../config.js";
import { McpHspClient } from "../hsp/mcp-client.js";
import { ReceivingAgent } from "../a2a/receiving-agent.js";
import { PaymentAgent } from "../agent/payment-agent.js";
import { CliApprove } from "../agent/approvals.js";
import { createSigner } from "../signer/factory.js";
import { formatQaResult } from "../agent/report.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.signer === "okx") {
    throw new Error(
      "SIGNER=okx is not supported by the standalone CLI. Use SIGNER=burner here, " +
        "or drive the OKX wallet path through your MCP agent.",
    );
  }

  const client = new McpHspClient(config.hspMcpUrl);
  await client.verifyTools();

  const signer = createSigner(config);
  const receiving = new ReceivingAgent(config.merchantName, config.payTo);
  const request = receiving.requestPayment({
    amountUsd: config.amountUsd,
    description: "A2A live payment",
  });

  const agent = new PaymentAgent(
    client,
    signer,
    new CliApprove(),
    {
      merchantName: config.merchantName,
      maxTokenAmount: config.maxTokenAmount,
      pollIntervalMs: 15_000,
      allowAmbiguousOption: false,
    },
    (e) => console.log(`[${e.type}]`, "message" in e ? e.message : ""),
  );

  const qa = await agent.run(request);
  console.log("\n" + formatQaResult(qa));
  await client.close();
}

main().catch((err) => {
  console.error("\nPayment failed:", err?.message ?? err);
  process.exit(1);
});
