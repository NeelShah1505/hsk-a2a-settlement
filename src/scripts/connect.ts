/**
 * Connect to the live HSP MCP server, verify all eight tools are present, and
 * print each tool's real input schema plus get_chain_config. Run: `pnpm connect`.
 *
 * Prerequisite: your public egress IP must be allowlisted by HSP, or this is
 * blocked at the edge. Do not repeatedly retry a blocked endpoint.
 */
import "../env.js"; // load .env before anything reads process.env
import { loadConfig } from "../config.js";
import { McpHspClient } from "../hsp/mcp-client.js";
import { listPaymentOptions } from "../mandate/cart-mandate.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Connecting to HSP MCP: ${config.hspMcpUrl}`);
  const client = new McpHspClient(config.hspMcpUrl);

  const tools = await client.verifyTools();
  console.log(`\n✓ All 8 required HSP tools present. Live input schemas:`);
  for (const t of tools) {
    console.log(`\n── ${t.name} ──`);
    console.log(JSON.stringify(t.inputSchema, null, 2));
  }

  console.log(`\n── get_chain_config ──`);
  const chainConfig = await client.getChainConfig();
  console.log(JSON.stringify(chainConfig, null, 2));

  console.log(`\nSelectable payment options:`);
  for (const o of listPaymentOptions(chainConfig)) {
    console.log(`  • ${o.network} (${o.chainId}) ${o.symbol} ${o.protocol} @ ${o.tokenAddress} [${o.decimals}d]`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("\nConnect failed:", err?.message ?? err);
  console.error(
    "\nIf this is a network/allowlist block: confirm your egress IP is on the HSP QA allowlist, " +
      "then retry. Do not hammer a blocked endpoint.",
  );
  process.exit(1);
});
