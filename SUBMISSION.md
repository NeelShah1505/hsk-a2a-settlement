# HSP A2A Settlement Terminal — Hackathon Submission

**Event:** HSK Chain Horizon Hackathon · India
**Track:** Agent Payments & A2A Settlement (HSP)
**One line:** Trust-minimized agent-to-agent commerce on HSK Chain. A Payment Agent buys a
service from a Receiving Agent with a gasless EIP-3009 authorization; the funds sit in an
on-chain escrow until the Receiving Agent delivers and anchors proof of delivery. The same
purchase can also settle through the HSP Gateway.

---

## The problem

Agents paying agents need more than a transfer. With x402-style "pay, then deliver":

- the **paying agent** has no guarantee it will receive what it paid for, and
- the **receiving agent** has to trust a payment claim it cannot check itself.

Giving an autonomous agent an open wallet is not an answer either.

## What we built

1. **`A2ASettlement` escrow on HSK Chain.** Receiving agents register services (price, token,
   payout, delivery window). A payer's signed EIP-3009 authorization moves the exact price into
   escrow. The receiving agent confirms delivery with a hash of the delivered resource, which
   releases the funds. If it misses the deadline, anyone can refund the payer. The nonce is
   bound to the contract, chain, request and service, so a signature cannot be replayed or
   reused at a different price. HSP-rail payments can be anchored in the same contract as
   on-chain receipts.
2. **An A2A exchange in two rails.** The Receiving Agent quotes a service (the A2A "402"). The
   Payment Agent cross-checks the quote against the on-chain price, signs after human approval,
   and hands the authorization over A2A. The Receiving Agent relays it (paying gas, so the payer
   never needs any), **verifies the escrow on-chain**, delivers, and releases. The HSP rail runs
   the documented Agentic Payment flow across all eight MCP tools.
3. **HSP settles *into* the escrow (deposit vaults).** HSP's gateway builds the EIP-3009 message
   itself and its relayer pays into the order's `pay_to`. So the receiving agent gives HSP a
   **deterministic deposit address that commits to the exact terms**; HSP's relayer pays into it;
   `claimDeposit` pulls it into escrow. Proven on a fork of HSK mainnet with the **real USDC.e
   contract** and an HSP-style relayer `transferWithAuthorization` (see [docs/PROOF.md](docs/PROOF.md)).
4. **A 9-tool MCP server** so a judge can `claude mcp add` and drive the whole purchase from any
   MCP client, plus **the Settlement Terminal web UI**: two agents across an A2A wire, a nine-stage
   pipeline, two human-authorization gates that show exactly what is being signed, real
   transactions linked to the explorer, and a receipt with the escrow tx, release tx and delivery
   hash. A 20-second demo video is in [docs/demo/](docs/demo/).

## Why it is trustworthy

- **Human in the loop at the two moments that matter:** before signing and before relay/submit.
- **Payer protection:** exact-amount signatures, a quote-vs-chain price check, a spend cap applied
  with live token decimals, a balance check, and an automatic refund path.
- **Receiver protection:** delivery happens only after the escrow is verified on-chain.
- **HSP faithfulness:** chain data comes only from `get_chain_config`; only the returned EIP-712 is
  signed; `payment-safe` is never reported as final; nothing is fabricated.
- **Honest:** every claim is tagged in [docs/CLAIMS.md](docs/CLAIMS.md). We do **not** claim a
  live HSP-server payment (needs HashKey allowlist/credentials) or a mainnet deployment yet
  (needs ~3 HSK for gas); both are one command away.
- **Reviewed:** the deposit-vault design passed three independent security reviews before it was
  written; every consensus issue was fixed.
- **Tested:** 43 Foundry tests (incl. fuzzing fund conservation) and 28 TypeScript tests, plus 2
  mainnet-fork tests against the real USDC.e contract.

## Deployments

| Network | Escrow | Token |
|---|---|---|
| Local (anvil) | deployed by `pnpm deploy:local` | TestUSDC (EIP-3009) |
| HSK Chain testnet (133) | `pnpm deploy:testnet` → `deployments/133.json` | TestUSDC (EIP-3009) |
| HSK Chain mainnet (177) | `pnpm deploy:mainnet` → `deployments/177.json` | real USDC.e `0x054ed458…` |

See [docs/JUDGES.md](docs/JUDGES.md), [docs/PROOF.md](docs/PROOF.md), [docs/CLAIMS.md](docs/CLAIMS.md).

## Demo

```bash
pnpm install
pnpm chain:local && pnpm deploy:local   # or pnpm deploy:testnet with a funded deployer
pnpm dev                                # http://localhost:4100 → HSK Chain escrow → Initiate
```

Or drive it from any MCP client: `pnpm mcp` then
`claude mcp add --transport http a2a-escrow http://localhost:4200/mcp`.

Add `?autoplay=1` for a hands-free loop. The HSP rail runs against a faithful mock by default
(the QA endpoint needs an allowlisted IP) and switches to the live server with `HSP_MODE=live`.

## Tech

Solidity 0.8.24 + Foundry + OpenZeppelin · TypeScript (Node 20+) · viem · `@modelcontextprotocol/sdk`
(HSP MCP client) · zod · Express + SSE · Vitest · zero-build web UI.

Architecture adapted from [`hrishabhayush/wraps`](https://github.com/hrishabhayush/wraps).
