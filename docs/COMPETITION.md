# Competitive analysis — HSP A2A Settlement track (brutal, internal)

24 payments-track projects read via GitHub; every on-chain claim re-checked against
`https://mainnet.hsk.xyz` (177) / `https://testnet.hsk.xyz` (133). This is internal and raw.

## The two gates that decide eligibility

- **Mainnet deploy (hard rule).** Verified live on chain 177: **Proviso, RiskLayer, Lamplight,
  Credence-Pay, devx-agenttab, tessera** — at least **6 competitors are already on mainnet.**
  **We are not.** This is the single biggest gap; it is an eligibility rule, not a nicety.
- **Public repo + submission.** Every competitor has a public GitHub repo. **We do not yet**
  (blocked by the safety classifier). No repo link = no DoraHacks submission.

## Where the field actually is

- **Live HSP settlement (a payment settled by HSP's own relayer): nobody confirmed.** The
  closest: **tessera** obtained *real HSP credentials* and hits the production Coordinator
  (`hsp-hackathon.hashkeymerchant.com`); **Credence-Pay** connects to the live HSP QA MCP and
  verifies all 8 tools against live schemas. So a few teams cleared the allowlist we couldn't —
  it is achievable, and it is a gap for us.
- **Escrow is common, not our moat:** Nundina, Sealed, devx-agenttab, slaa, Proviso, Lamplight.
- **ERC-8004 on-chain reputation is everywhere:** Nundina, Kohaku, Spawn, tessera, slaa, Proviso,
  Avow. Judges are seeing it repeatedly. **We don't have it.**
- **Real LLM agents are common:** Nundina (Claude), Sealed (Gemini), Kohaku (Claude), SafeFlow
  (OpenAI/Anthropic), skymiss (Qwen), Credence (Groq). **Our "agent" is deterministic
  orchestration** — thin for a track literally called *Agent* Payments.

## Top threats

| Project | Threat | On mainnet? | Why it's dangerous |
|---|---|---|---|
| **Nundina** | 5 | no (testnet full) | Complete deployed product (web+API+Telegram bot+MiniApp), ERC-8004 reputation, RevenueRouter multi-hop A2A, 114 tests, demo video. Broadest + most polished. |
| **tessera** | 4 | **yes** | Real HSP credentials vs the production Coordinator; reputation + under-collateralized lending; Gemini reasoning receipts. |
| **Credence-Pay** | 4 | **yes** | On mainnet, connects to live HSP MCP (8 tools, live schemas); reusable trust/credit-terms primitive. |
| **devx-agenttab** | 4 | **yes** | On mainnet, public repo, dead-simple legible micropayment "tab" narrative. |
| **Kohaku** | 4 | no | Clearing-house netting (70 IOUs→7 transfers), ERC-8004 + staked-validator disputes, live 14-agent fleet. |
| **Sealed** | 4 | no | ZK budget privacy (Poseidon/Groth16) — genuinely novel; pay-on-delivery vouchers + refund. |
| **Proviso** | 4 | **yes** | Counterfactual `pay_to`=escrow over CREATE2 terms (our mechanism), ERC-8004, LLM validator court, 3 real mainnet deals. |

## Our honest standing

**Engineering quality: top-tier (maybe top 3).** Terms-committed deposit vaults with the salt
cryptographically binding payer/request/service/token/price/window/claimBy; a 3-lens security
review before writing; a mainnet-fork proof settling the **real USDC.e** via an HSP-style
`transferWithAuthorization` into the deposit address; two human approval gates; honesty-tagged
evidence pack. Few match this rigor.

**Winning-surface: mid-pack.** We are not on mainnet, have no public repo, no live HSP, no
on-chain reputation, and no real LLM agent. Our deposit-vault idea is strong but **not unique**
(Proviso ships it, Nundina models it) — our edge there is rigor and the real-USDC.e proof, which
we must make obvious.

**Verdict:** correct and credible, but currently losing on the axes that decide this hackathon.
We close most of the gap with actions below; the top two need the operator.

## Ranked actions

Operator-gated (do these or we can't place):
1. **Publish the repo** (classifier-blocked for the agent). No repo = no submission.
2. **Fund the deployer `0xBaA9364c59041392b503d4a1A4be6126557FC919` with ~4 HSK** → `pnpm deploy:mainnet`. Clears the eligibility gate 6 teams already cleared.
3. **Get HSP allowlist / credentials** (tessera + Credence did). Unlocks a live HSP settlement.

Non-blocked (agent builds these):
4. **ERC-8004 identity + reputation**, written from settled escrows — the most common thing we lack.
5. **A real LLM payment agent** (NL intent → policy → escrow flow), pluggable behind an API key.
6. **Expose the deposit/HSP-into-escrow rail in the MCP server and UI** so the differentiator is drivable, not just a test.
7. **Deepen tests** toward the top of the field; keep the honesty discipline (it is itself a differentiator).
