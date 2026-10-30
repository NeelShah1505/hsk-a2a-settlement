# HSP A2A Settlement Terminal — Hackathon Submission

**Track:** Agent Payments & A2A Settlement (HSP)
**One line:** An autonomous Payment Agent that settles an agent-to-agent payment on HashKey through HSP Agentic Payment — building the x402 mandate, signing the EIP-712 authorization, and executing on-chain via the HSP Gateway, with a human holding the two authorization keys.

---

## The problem

Agent-to-agent commerce needs a payment leg: when one agent owes another, something has to turn *"you owe me 1 USD"* into a real, attributable, on-chain settlement — safely, without handing an autonomous agent an open wallet. HSP Agentic Payment provides the rails (x402 mandate → EIP-712 authorization → Gateway settlement). This project is the **agent that drives those rails end to end**, and the **control surface** that keeps a human in the loop at exactly the two moments that matter.

## What we built

A complete, runnable system in three parts:

1. **A2A layer** — a Receiving Agent emits payment *conditions*; the Payment Agent consumes them. The HSP order is **derived from the counterparty's conditions**, not hand-entered. This is the "A2A" the track asks for.
2. **Payment Agent (orchestrator)** — a state machine that runs the documented HSP flow faithfully: `get_chain_config → create_order → prepare_payment → sign → finalize_payment → submit_payment → query_payment`, with quote-expiry / Gateway-`30043` re-prepare, spend caps, and precise status handling.
3. **Settlement Terminal (web UI)** — the whole flow animates live: two agents across an A2A wire, an eight-stage pipeline that lights up, the **two human-authorization gates** showing exactly what is being signed (`token_total_raw` in raw units, payer, recipient), and a printed settlement receipt.

## Why it's faithful to HSP (and trustworthy)

- **Never invents chain data** — network/token/protocol come from `get_chain_config` at runtime.
- **Two explicit human authorizations** — before signing and before submission, each showing `pay_to` / `payer` / `token_total_raw`.
- **Signs only the returned EIP-712** — never constructs x402 JSON, the JWT, or a transaction; passes server objects through unchanged.
- **Status honesty** — `payment-safe` (half-confirmed) is never reported as `payment-finalized`; unknown statuses are surfaced, not inferred; identifiers are retained for recovery instead of creating duplicate orders.
- **Attribution** — `merchant_name` is identical across `create_order` and `query_payment`; `attribution_verified` reported as returned.
- **Safety caps** — refuses to sign above a configured `token_total_raw`.

## Lineage

Architecture adapted from [`hrishabhayush/wraps`](https://github.com/hrishabhayush/wraps) (x402 agent payments + settlement), with its home-grown issuer/settlement replaced by the **HSP MCP** tools on HashKey.

## Demo

```bash
pnpm install
pnpm dev            # http://localhost:4100  — click "Initiate payment", authorize twice
                    # add ?autoplay=1 for a hands-free loop on a projector
pnpm demo           # same flow in the terminal
pnpm test           # 17 tests, all green
```

Mock mode is an offline simulation (clearly labeled, never presented as a real payment). Live settlement switches on with `HSP_MODE=live` once the egress IP is allowlisted and the wallet is funded + approved — see [README.md](README.md).

## Status

Built, typed, tested (17/17), independently reviewed (all findings fixed), and verified end-to-end against a faithful mock — CLI, HTTP+SSE, and the UI flow. Live settlement is gated only on the external prerequisites (IP allowlisting, funded/approved wallet), not on the code.

## Tech

TypeScript (Node 20+, ESM) · `@modelcontextprotocol/sdk` (HSP MCP client) · `viem` (EIP-712 signing) · `zod` · Express + SSE · Vitest · zero-build vanilla web UI.
