/**
 * Offline end-to-end demo against the MockHspClient. Proves the full A2A purchase
 * loop — request a service, settle it through HSP, receive the resource — without
 * the live endpoint. Run: `pnpm demo`.
 *
 * This is a MOCK — never treat its output as a real on-chain payment.
 */
import { ReceivingAgent } from "./a2a/receiving-agent.js";
import { A2AExchange } from "./a2a/exchange.js";
import { MockHspClient } from "./hsp/mock-client.js";
import { AutoApprove } from "./agent/approvals.js";
import { BurnerSigner } from "./signer/burner.js";
import { formatQaResult } from "./agent/report.js";
import type { FlowEvent } from "./agent/events.js";

// A throwaway, well-known test key (Hardhat account #0). Testnet/mock only.
const DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function printEvent(e: FlowEvent): void {
  const tag = e.type.toUpperCase().padEnd(20);
  switch (e.type) {
    case "service_requested":
      console.log(`${tag} ${e.name} — ${e.priceUsd} USD`);
      break;
    case "a2a_request_received":
      console.log(`${tag} ${e.merchantName} wants ${e.amountUsd} USD → ${e.payTo}`);
      break;
    case "chain_config":
      console.log(`${tag} ${e.network} (${e.chainId}) ${e.tokenSymbol} ${e.protocol}`);
      break;
    case "order_created":
      console.log(`${tag} flow_id=${e.flowId}`);
      break;
    case "quote_prepared":
      console.log(`${tag} ${e.tokenTotalHuman} (raw ${e.tokenTotalRaw}) ${e.primaryType}`);
      break;
    case "approval_requested":
      console.log(`${tag} stage=${e.stage} ${e.tokenTotalHuman}`);
      break;
    case "signed":
      console.log(`${tag} ${e.signaturePreview}`);
      break;
    case "status_poll":
      console.log(`${tag} ${e.status} attribution=${e.attributionVerified}`);
      break;
    case "terminal":
      console.log(`${tag} ${e.status} — ${e.message}`);
      break;
    case "resource_delivered":
      console.log(`${tag} ${e.title}`);
      break;
    case "resource_denied":
      console.log(`${tag} ${e.reason}`);
      break;
    default:
      console.log(`${tag} ${"message" in e ? e.message : ""}`);
  }
}

async function main(): Promise<void> {
  const receiving = new ReceivingAgent("demo-team", "0x" + "2".repeat(40));
  const hsp = new MockHspClient({ pollsBeforeTerminal: 3, terminal: "payment-finalized" });
  const signer = new BurnerSigner(DEMO_KEY);

  const exchange = new A2AExchange(
    receiving,
    hsp,
    signer,
    new AutoApprove(),
    { merchantName: "demo-team", pollIntervalMs: 200, maxTokenTotalRaw: 2_000_000n },
    printEvent,
  );

  const { qa, fulfill } = await exchange.purchase("hsk-market-snapshot");

  console.log("\n" + formatQaResult(qa));
  if (fulfill.delivered && fulfill.resource) {
    console.log(`\nResource delivered: ${fulfill.resource.title}`);
    console.log(JSON.stringify(fulfill.resource.body, null, 2));
  } else {
    console.log(`\nResource withheld: ${fulfill.reason}`);
  }
  await hsp.close?.();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
