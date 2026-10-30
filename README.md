# HSP A2A Settlement Terminal

An autonomous **Payment Agent** that settles an **agent-to-agent (A2A)** payment on
**HashKey** through **HSP Agentic Payment** — building an x402 payment mandate from a
receiving agent's conditions, signing the returned EIP-712 authorization, and executing
on-chain via the HSP Gateway, with a human holding the two authorization keys.

> **Hackathon track:** *Agent Payments & A2A Settlement (HSP).*
> Architecture adapted from the agent-payment design of
> [`hrishabhayush/wraps`](https://github.com/hrishabhayush/wraps) (x402 agent payments +
> settlement), retargeted from its own issuer to the **HSP MCP** tools on HashKey.

---

## What it does

The full **agent-to-agent purchase loop** — one agent autonomously buys something from
another, with a human holding the two keys:

0. The **Payment Agent** requests a **service** from the **Receiving Agent**, which
   returns x402-style payment *conditions* (the "402").
1. reads `get_chain_config` (network/token/protocol are never hard-coded),
2. turns the A2A conditions into an HSP order (`create_order` with an **x402 cart mandate**);
   also reads `get_order` + `estimate_fee` for gas treatment,
3. locks a quote (`prepare_payment` → EIP-712 + `token_total_raw`),
4. **asks you to authorize**, signs *exactly* the returned EIP-712,
5. assembles the mandate (`finalize_payment` → JWT),
6. **asks you to authorize again**, submits (`submit_payment`),
7. polls `query_payment` and reports the true status — `payment-safe` vs `payment-finalized`
   are never conflated, and nothing is fabricated,
8. hands the Receiving Agent a **settlement proof**; on `payment-finalized` with verified
   attribution, the Receiving Agent **delivers the resource** — otherwise it is withheld.

All eight HSP tools are exercised: `get_chain_config, create_order, get_order,
prepare_payment, estimate_fee, finalize_payment, submit_payment, query_payment`.

```
 Receiving agent ──(A2A: amount, pay_to, expiry)──▶ Payment agent
                                                        │  get_chain_config
                                                        ▼
       create_order (x402 cart mandate) ──▶ flow_id / payment_request_id
                                                        │  prepare_payment
                                                        ▼
               EIP-712 + token_total_raw ──▶ [ AUTHORIZE #1 ] ──▶ sign (eip3009 | permit2)
                                                        │  finalize_payment
                                                        ▼
                     payment_mandate_json ──▶ [ AUTHORIZE #2 ] ──▶ submit_payment
                                                        │  query_payment (15s)
                                                        ▼
                         payment-safe → payment-finalized  +  QA result
```

---

## Project layout

```
src/
  a2a/            A2A schema, Receiving Agent + service catalog, and the exchange
                  (request → 402 → pay → deliver) coordinator
  hsp/            The 8 HSP tools: typed client interface, MCP impl, offline mock
  mandate/        x402 cart-mandate builder + chain-config option selection
  signer/         Pluggable signer: burner (viem) + OKX wallet-skill adapter
  agent/          Payment-agent orchestrator (state machine), approvals, QA report, events
  server/         Express + SSE server backing the web UI, with deferred approvals
  scripts/        connect (verify live tools + schemas), pay (live CLI)
  demo.ts         End-to-end purchase loop against the mock
public/           The web UI (settlement terminal): index.html, styles.css, app.js
tests/            Vitest (17): mandate builder, orchestrator (happy/safe/fail/caps/reject),
                  and the A2A exchange (deliver/withhold/denied)
```

---

## Quickstart (offline, no prerequisites)

```bash
pnpm install
pnpm demo          # full flow against the mock, in the terminal
pnpm test          # 12 tests
pnpm typecheck
pnpm dev           # web UI at http://localhost:4100  (mock mode)
```

The web UI runs the whole flow with the two authorization gates. Add `?autoplay=1` for a
hands-free demo loop (useful on a projector).

> **Mock mode is an offline simulation** of the HSP flow for development and demos. It is
> **not** a real on-chain payment and is labeled as such everywhere.

---

## Going live on HSP

Live settlement needs four prerequisites that are **the team's manual responsibility**
(the agent must not do them):

1. **IP allowlisting.** Give HSP your actual public **egress** IP(s) and wait for
   confirmation. A Cloudflare block / non-`{"status":"ok"}` health response means the IP in
   use is not allowlisted. Mobile/residential IPs rotate — prefer a box with a static IP.
2. **Wallet.** Create the payer wallet (OKX Agentic Wallet, or a burner key for the CLI).
3. **Approvals.** Complete any Permit2/token approval the selected protocol needs.
4. **Funding.** Hold the **exact** test USDC contract returned by `get_chain_config`
   (another token with the same symbol does not substitute).

Then:

```bash
cp .env.example .env     # set MERCHANT_NAME, PAY_TO, SIGNER, BURNER_PRIVATE_KEY, caps
pnpm connect             # connect HSP MCP, verify all 8 tools, print live schemas + chain config
pnpm pay                 # live CLI payment with interactive approvals (SIGNER=burner)
HSP_MODE=live pnpm dev   # live web UI (set BURNER_PRIVATE_KEY, or wire the OKX signer)
```

`pnpm connect` prints each tool's **live input schema** — confirm argument names/types
against it. The code follows the documented shapes but the live schema is authoritative;
adapt `src/hsp/client.ts` / `src/mandate/cart-mandate.ts` if HSP's schema differs.

---

## Signer (pluggable)

- **Burner** (`SIGNER=burner`): a local testnet/QA key; signs the returned EIP-712 with viem.
  Never use a key holding real funds.
- **OKX Agentic Wallet** (`SIGNER=okx`): signing runs through the Onchain OS wallet skill in
  your MCP agent. `src/signer/okx.ts` is the seam — wire its `addressProvider` /
  `signProvider` to the wallet-skill tool calls your agent exposes.

Either way the orchestrator only ever asks the signer to **sign the exact `eip712` HSP
returned** — it never builds x402 JSON, the JWT, or a transaction.

---

## Guardrails (built in)

- **Two human authorizations** — before signing and before submission — each showing
  `pay_to`, `payer`, and `token_total_raw` (raw units).
- **Spend cap** (`MAX_TOKEN_AMOUNT`, a human token amount): converted to raw units with the
  live token decimals at sign time, so it is correct for any token. Optional balance-check hook.
- **Resource withheld unless settled**: the service is released only on `payment-finalized`
  with verified attribution; `payment-safe` or a failure withholds it.
- **Quote lifecycle**: re-prepares + re-signs on quote expiry or Gateway `30043`; never
  resubmits a stale signature.
- **Status honesty**: `payment-safe` is reported as half-confirmed, *not* finalized; only
  `payment-finalized` is final; unknown statuses are surfaced, never inferred; identifiers are
  retained for recovery instead of creating duplicate orders.
- **Attribution**: `merchant_name` is identical in `create_order` and `query_payment`;
  `attribution_verified` is reported as returned.

---

## Status

- ✅ Full purchase loop, A2A layer + service catalog, mandate builder, pluggable signer,
  web UI — built, typed, tested (17/17), and verified end-to-end against the mock
  (CLI, HTTP+SSE, and the UI flow). Passed an independent correctness review; all findings fixed.
- ⏳ Live settlement is gated on the four prerequisites above. The MCP client + `connect`/`pay`
  paths are implemented against the documented HSP schemas and switch on with `HSP_MODE=live`.
