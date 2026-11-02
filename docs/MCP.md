# A2A escrow as an MCP server

`src/mcp/server.ts` exposes the on-chain A2A escrow (`A2ASettlement` on HSK Chain) as nine MCP
tools over Streamable HTTP, so a purchase can be driven from Claude Code, Cursor, the MCP
Inspector, or any other MCP client.

The server plays the **receiving agent / relayer**: it holds the provider key, pays gas, and
confirms delivery. It never holds or signs for the **payer**. `build_authorization` hands back
EIP-712 typed data; the client signs it with the payer wallet and passes the signature to
`relay_settlement`. The payer needs tokens, never native gas.

## Run

```bash
pnpm install

# Fully local (no faucet): anvil + deploy, then the MCP server
pnpm chain:local            # terminal 1: anvil on :8545
pnpm deploy:local           # terminal 2: deploys TestUSDC + A2ASettlement → deployments/31337.json
pnpm mcp                    # terminal 3: http://localhost:4200/mcp

# HSK testnet: needs DEPLOYER_PRIVATE_KEY in .env and deployments/133.json (pnpm deploy:testnet)
pnpm mcp
```

Network resolution is the same as the web server: `deployments/<chainId>.json` for
`hsk-testnet` is preferred, then `local`; `ONCHAIN_NETWORK=local|hsk-testnet|hsk-mainnet`
forces one. The relayer key is `DEPLOYER_PRIVATE_KEY`, or for `local`
`LOCAL_DEPLOYER_PRIVATE_KEY` falling back to anvil account #0.

| Env | Default | Meaning |
|---|---|---|
| `PORT_MCP` | `4200` | HTTP port |
| `MCP_HOST` | `127.0.0.1` | Bind address |
| `ONCHAIN_NETWORK` | auto | Force a network |
| `DEPLOYER_PRIVATE_KEY` | — | Relayer / provider key (testnet, mainnet) |
| `LOCAL_DEPLOYER_PRIVATE_KEY` | anvil #0 | Relayer / provider key (local) |

Endpoints: `POST /mcp` (Streamable HTTP, stateless, JSON responses) and `GET /health` →
`{"status":"ok"}`.

## Connect a client

**Claude Code**

```bash
claude mcp add --transport http a2a-escrow http://localhost:4200/mcp
```

or in `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "a2a-escrow": { "type": "http", "url": "http://localhost:4200/mcp" }
  }
}
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "a2a-escrow": { "url": "http://localhost:4200/mcp" }
  }
}
```

**MCP Inspector**

```bash
npx @modelcontextprotocol/inspector --transport http --server-url http://localhost:4200/mcp
```

## Tools

Ids (`service_id`, `request_id`) are plain strings; the server hashes them with `keccak256`
to the `bytes32` the contract uses and returns both forms. Raw token amounts are decimal
strings. Every result is JSON in a text block and, for clients that read it, in
`structuredContent`. Contract reverts come back as MCP tool errors
(`isError: true`) carrying the custom error name, e.g. `PaymentNotEscrowed`.

| Tool | Chain | What it does |
|---|---|---|
| `get_chain_config` | read | Network (name, label, chainId, rpcUrl, explorer), settlement address, token address/symbol/decimals, relayer address |
| `list_services` | read | Catalog (id, name, description, priceUsd) merged with each on-chain record; unregistered services flagged `registered: false` |
| `get_service(service_id)` | read | One service, catalog + on-chain |
| `build_authorization(service_id, request_id, payer, valid_for_seconds?)` | read | EIP-3009 `ReceiveWithAuthorization` typed data for the payer to sign, plus `requestIdHash`, `serviceIdHash`, `validAfter`, `validBefore`, `token_total_raw`, `amount`, `payerFunded`. Never signs |
| `relay_settlement(service_id, request_id, payer, valid_after, valid_before, signature)` | **tx** | Relayer submits the signed authorization; the exact price moves into escrow. Returns tx hash, explorer url, payment |
| `get_payment(request_id, payer)` | read | Escrow record: status `none/escrowed/released/refunded`, amount, deadline, deliveryHash |
| `confirm_delivery(request_id, payer, delivery_hash)` | **tx**, provider-only | Anchors the delivered resource's hash and releases escrow to `payTo` |
| `refund(request_id, payer)` | **tx** | Returns an undelivered escrow to the payer after its deadline (anyone may call) |
| `anchor_external_settlement(request_id, service_id, payer, amount_raw, rail, external_ref, delivery_hash)` | **tx**, provider-only | Records a payment settled elsewhere (e.g. the HSP Gateway) as an on-chain receipt; moves no funds |

Address inputs are checksummed on the way in; `delivery_hash` is a 32-byte hex;
`signature` is the 65-byte (or 64-byte compact) ECDSA signature from the payer wallet.

## Example transcript

Local anvil, the default catalog, payer `0xPAYER` funded with TestUSDC. Values are abridged.

**1. Discover the chain**

```
> get_chain_config
{
  "network": { "name": "local", "label": "Local (anvil)", "chainId": 31337, "rpcUrl": "http://127.0.0.1:8545", "explorer": null },
  "settlement": { "address": "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1", "url": null },
  "token": { "address": "0x9A676e781A523b5d0C0e43731313A708CB607508", "symbol": "tUSDC", "decimals": 6, "url": null },
  "relayer": { "address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "url": null }
}
```

**2. Pick a service**

```
> list_services
{ "services": [
  { "id": "hsk-market-snapshot", "name": "HashKey Swap market snapshot", "priceUsd": "1", "registered": true,
    "onchain": { "serviceIdHash": "0x7c6f…", "provider": "0xf39F…", "payTo": "0xf39F…", "token": "0x9A67…",
                 "priceRaw": "1000000", "price": "1", "tokenSymbol": "tUSDC", "deliveryWindowSeconds": 3600, "active": true } },
  { "id": "settlement-receipt-api", "name": "Premium settlement attestation", "priceUsd": "2", "registered": true, "onchain": { … } }
] }
```

**3. Build what the payer signs** (nothing on-chain changes)

```
> build_authorization { service_id: "hsk-market-snapshot", request_id: "req-2026-11-02-001", payer: "0xPAYER" }
{
  "requestIdHash": "0x3a9e…", "serviceIdHash": "0x7c6f…",
  "token_total_raw": "1000000", "amount": "1", "tokenSymbol": "tUSDC", "payerFunded": true,
  "validAfter": "0", "validBefore": "1762076543",
  "typedData": {
    "domain": { "name": "Test USD Coin", "version": "1", "chainId": 31337, "verifyingContract": "0x9A67…" },
    "primaryType": "ReceiveWithAuthorization",
    "types": { "ReceiveWithAuthorization": [ { "name": "from", "type": "address" }, { "name": "to", "type": "address" },
               { "name": "value", "type": "uint256" }, { "name": "validAfter", "type": "uint256" },
               { "name": "validBefore", "type": "uint256" }, { "name": "nonce", "type": "bytes32" } ] },
    "message": { "from": "0xPAYER", "to": "0x9599…", "value": "1000000", "validAfter": "0", "validBefore": "1762076543", "nonce": "0xd1c0…" }
  },
  "next": "Sign typedData with the payer wallet, then call relay_settlement …"
}
```

The client signs `typedData` with the payer wallet (`eth_signTypedData_v4`, or
`BurnerSigner.signEip712` in this repo) → `0xSIG`.

**4. Relay into escrow** (on-chain tx, relayer pays gas)

```
> relay_settlement { service_id: "hsk-market-snapshot", request_id: "req-2026-11-02-001", payer: "0xPAYER",
                     valid_after: "0", valid_before: "1762076543", signature: "0xSIG" }
{
  "txHash": "0x5e21…", "explorerUrl": null, "blockNumber": "14", "gasUsed": "121884",
  "payment": { "status": "escrowed", "amountRaw": "1000000", "amount": "1", "payer": "0xPAYER",
               "payTo": "0xf39F…", "escrowedAt": 1762075943, "deadline": 1762079543, "deliveryHash": "0x00…00" }
}
```

**5. Deliver, then confirm** (on-chain tx, provider-only)

The receiving agent checks `get_payment` → `escrowed`, hands the resource to the payer, and
anchors its hash:

```
> confirm_delivery { request_id: "req-2026-11-02-001", payer: "0xPAYER", delivery_hash: "0x9b1f…" }
{
  "txHash": "0xa804…", "blockNumber": "15",
  "payment": { "status": "released", "amountRaw": "1000000", "deliveryHash": "0x9b1f…", … }
}
```

**6. Verify**

```
> get_payment { request_id: "req-2026-11-02-001", payer: "0xPAYER" }
{ "payment": { "status": "released", "amount": "1", "payTo": "0xf39F…", "deliveryHash": "0x9b1f…", … } }
```

Had the provider never delivered, anyone could call `refund` after `deadline` and the
status would read `refunded`. A wrong signature, a repeat request id, or confirming an
unknown payment returns a tool error such as
`relay_settlement failed: contract reverted: InvalidSignature` instead of a transport failure.

## Tests

`tests/mcp.test.ts` starts the server in-process on a random port against a throwaway anvil
chain (skipped when `anvil` is not installed), connects with the SDK `Client` +
`StreamableHTTPClientTransport`, checks the nine tool names, and runs the full
build → sign → relay → confirm path plus the error cases above.

```bash
pnpm test
```
