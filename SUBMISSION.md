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
3. **The Settlement Terminal UI.** The purchase plays out live: two agents across an A2A wire, a
   nine-stage pipeline, two human-authorization gates that show exactly what is being signed,
   real transactions linked to the explorer, and a receipt with the escrow tx, release tx and
   delivery hash.

## Why it is trustworthy

- **Human in the loop at the two moments that matter:** before signing and before relay/submit.
- **Payer protection:** exact-amount signatures, a quote-vs-chain price check, a spend cap applied
  with live token decimals, a balance check, and an automatic refund path.
- **Receiver protection:** delivery happens only after the escrow is verified on-chain.
- **HSP faithfulness:** chain data comes only from `get_chain_config`; only the returned EIP-712 is
  signed; `payment-safe` is never reported as final; nothing is fabricated.
- **Tested:** 30 Foundry tests (including fuzzing fund conservation) and 22 TypeScript tests,
  including integration tests that run the full on-chain purchase on a fresh chain.

## Deployments

| Network | Escrow | Token |
|---|---|---|
| HSK Chain testnet (133) | see `deployments/133.json` | TestUSDC (EIP-3009) |
| HSK Chain mainnet (177) | see `deployments/177.json` | — |

## Demo

```bash
pnpm install
pnpm chain:local && pnpm deploy:local   # or pnpm deploy:testnet with a funded deployer
pnpm dev                                # http://localhost:4100 → HSK Chain escrow → Initiate
```

Add `?autoplay=1` for a hands-free loop. The HSP rail runs against a faithful mock by default
(the QA endpoint needs an allowlisted IP) and switches to the live server with `HSP_MODE=live`.

## Tech

Solidity 0.8.24 + Foundry + OpenZeppelin · TypeScript (Node 20+) · viem · `@modelcontextprotocol/sdk`
(HSP MCP client) · zod · Express + SSE · Vitest · zero-build web UI.

Architecture adapted from [`hrishabhayush/wraps`](https://github.com/hrishabhayush/wraps).
