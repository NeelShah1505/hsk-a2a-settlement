/** Runtime configuration, read from environment (.env). */

export interface AppConfig {
  hspMcpUrl: string;
  merchantName: string;
  payTo: string;
  signer: "okx" | "burner";
  burnerPrivateKey: string;
  /** Human token amount cap (converted to raw units with live decimals at sign time). */
  maxTokenAmount: string;
  amountUsd: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

export function loadConfig(): AppConfig {
  const signer = (process.env.SIGNER ?? "burner").trim();
  if (signer !== "okx" && signer !== "burner") {
    throw new Error(`SIGNER must be "okx" or "burner", got: ${signer}`);
  }
  return {
    hspMcpUrl: process.env.HSP_MCP_URL?.trim() || "https://mcp-qa.hashkeymerchant.com/",
    merchantName: req("MERCHANT_NAME"),
    payTo: req("PAY_TO"),
    signer,
    burnerPrivateKey: process.env.BURNER_PRIVATE_KEY?.trim() ?? "",
    maxTokenAmount: process.env.MAX_TOKEN_AMOUNT?.trim() || "5",
    amountUsd: process.env.AMOUNT_USD?.trim() || "1",
  };
}
