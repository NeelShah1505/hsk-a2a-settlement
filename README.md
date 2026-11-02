# HSP A2A Settlement Terminal

Agent-to-agent commerce on **HSK Chain**: a **Payment Agent** buys a service from a
**Receiving Agent**, and a human holds the two authorization keys. It ships two settlement
rails:

- **HSK Chain escrow (on-chain).** Trust-minimized: the payer signs a gasless EIP-3009
  authorization, funds lock in the `A2ASettlement` escrow contract, the receiving agent checks
  the escrow **on-chain**, delivers, and anchors a hash of the delivered resource to release
  payment. If it never delivers, the payer is refunded after the deadline.
- **HSP Gateway.** The documented HSP Agentic Payment flow over MCP (all eight tools), with
  the x402 mandate, EIP-712 signing, and spec-faithful status handling.

And it is built so **HSP can settle *into* the escrow**: the receiving agent gives HSP a
deterministic **deposit address** as the order's `pay_to`; HSP's relayer pays into it with
`transferWithAuthorization`; `claimDeposit` pulls it into escrow. Proven against the real
USDC.e contract on a fork of HSK mainnet — see [docs/PROOF.md](docs/PROOF.md).

> **Hackathon track:** *Agent Payments & A2A Settlement (HSP)* — HSK Chain Horizon Hackathon ·
> India. Architecture adapted from [`hrishabhayush/wraps`](https://github.com/hrishabhayush/wraps)
> (x402 agent payments), retargeted to HSK Chain and HSP.
>
> **Judges:** start at [docs/JUDGES.md](docs/JUDGES.md) (5-minute path) ·
> [docs/PROOF.md](docs/PROOF.md) · [docs/CLAIMS.md](docs/CLAIMS.md) · [docs/MCP.md](docs/MCP.md)

## Status

**Done & tested (45 Foundry + 28 TS + 2 mainnet-fork, all green):** the escrow with three
funding rails (EIP-3009 gasless, approval, terms-committed deposit vaults); HSP-into-escrow
proven on a fork of HSK mainnet with the **real USDC.e**; settlement-backed ERC-8004-style
reputation + identity; a 10-tool MCP server; the two-rail web UI; a demo video; and the judge
evidence pack. Every claim is tagged in [docs/CLAIMS.md](docs/CLAIMS.md).

**Pending external grants (one command / one request each):**
- **Mainnet deploy (177)** — fund `0xBaA9364c59041392b503d4a1A4be6126557FC919` with ~4 HSK, then `pnpm deploy:mainnet`.
- **Live HSP-server settlement** — needs HashKey to allowlist our IP / issue merchant credentials.

See [docs/COMPETITION.md](docs/COMPETITION.md) for where this stands against the field.

---

## Why escrow

x402-style "pay, then deliver" gives the paying agent no guarantee that it will ever get what
it paid for, and the receiving agent has to trust a payment claim. `A2ASettlement` closes both
gaps:

| Risk | How the escrow handles it |
|---|---|
| Receiving agent takes payment and never delivers | Funds sit in escrow; `refund` returns them after the delivery deadline |
| Receiving agent overcharges | The payer signs an exact amount; changing the price invalidates the signature |
| Signature replayed for another purchase | The EIP-3009 nonce is bound to `(contract, chain, requestId, serviceId)` |
| Someone squats a payer's deal slot | Payments are keyed by `(payer, requestId, serviceId)` |
| HSP settles via its own relayer (it picks the nonce) | The deposit address commits to the terms, so HSP's `transferWithAuthorization` into `pay_to` lands in a vault only `claimDeposit` can move into escrow |
| Receiving agent trusts a forged "I paid" claim | It reads the escrow state from HSK Chain before delivering |
| Payer agent has no gas | The receiving agent relays the signed authorization and pays gas |
| Dispute over what was delivered | `confirmDelivery` anchors a hash of the delivered resource on-chain |
| "Can I trust this provider?" | Settlement-backed ERC-8004-style reputation: only the escrow writes it, one record per real release/refund |

Payments settled through the HSP Gateway can be anchored in the same contract
(`anchorExternalSettlement`), so both rails leave an on-chain receipt.

---

## The on-chain flow

```
Payment agent                     Receiving agent                    A2ASettlement (HSK Chain)
     │  request service ───────────────▶│
     │◀──────────── quote (A2A "402") ──│
     │  read service: price/token/payTo ─────────────────────────────▶│
     │  cross-check quote == on-chain price
     │  [ AUTHORIZE #1 ]  sign EIP-3009 (nonce bound to request+service)
     │  signed authorization ──────────▶│
     │  [ AUTHORIZE #2 ]                │  settleWithAuthorization ───▶│  price → escrow
     │                                  │  getPayment: verify escrow ─▶│
     │◀──────────────── resource ───────│  confirmDelivery(hash) ─────▶│  escrow → payTo
```

The UI shows each step live with links to the block explorer, and finishes with a receipt
carrying the escrow and release transaction hashes and the delivery hash.

## The HSP flow

`get_chain_config → create_order (x402 cart mandate) → get_order / estimate_fee →
prepare_payment → [AUTHORIZE #1] sign → finalize_payment → [AUTHORIZE #2] submit_payment →
query_payment → deliver on payment-finalized`. `payment-safe` is never reported as final, and
nothing is fabricated.

---

## Quickstart

```bash
pnpm install
pnpm test                 # 28 TypeScript tests (incl. on-chain + MCP integration on a throwaway anvil)
pnpm contracts:test       # 45 Foundry tests (incl. fuzz)
pnpm test:fork            # 2 tests against the REAL USDC.e on a fork of HSK mainnet
```

**Real on-chain demo, fully local (no wallet, no faucet):**

```bash
pnpm chain:local          # terminal 1: anvil on :8545
pnpm deploy:local         # terminal 2: deploy TestUSDC + A2ASettlement, fund the payer
pnpm dev                  # http://localhost:4100 → "HSK Chain escrow" → Initiate payment
```

**HSK Chain testnet (chain 133):** fund `DEPLOYER_PRIVATE_KEY`'s address with testnet HSK, then

```bash
pnpm deploy:testnet       # writes deployments/133.json; the server picks it up automatically
pnpm dev
```

**HSK Chain mainnet (chain 177):** fund the deployer `0xBaA9364c59041392b503d4a1A4be6126557FC919`
with ~3 HSK, then `pnpm deploy:mainnet` — it deploys the escrow and registers the demo
services against the real USDC.e (`0x054ed458…`), ready for an HSP-into-escrow flow.

Add `?autoplay=1` to the URL for a hands-free demo loop on a projector.

**Drive it from your own agent (MCP):**

```bash
pnpm mcp                  # Streamable HTTP MCP server on :4200
claude mcp add --transport http a2a-escrow http://localhost:4200/mcp
```

Ten tools (`get_chain_config, list_services, get_service, build_authorization, relay_settlement,
get_payment, confirm_delivery, refund, anchor_external_settlement, get_reputation`); see
[docs/MCP.md](docs/MCP.md).

---

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `BURNER_PRIVATE_KEY` | Payer agent key. Signs authorizations; never needs gas. |
| `DEPLOYER_PRIVATE_KEY` | Deployer, relayer and service provider. Needs native HSK. |
| `ONCHAIN_NETWORK` | Force `local`, `hsk-testnet` or `hsk-mainnet` (default: testnet if deployed, else local). |
| `MAX_TOKEN_AMOUNT` | Spend cap as a human token amount, applied with the live decimals. |
| `HSP_MODE` | `mock` (default) or `live` for the real HSP MCP server. |
| `MERCHANT_NAME`, `PAY_TO` | HSP rail: team reporting name and recipient. |

See [`.env.example`](.env.example). `.env` is gitignored.

---

## HSP Gateway, live

The QA MCP endpoint requires an allowlisted egress IP, a funded wallet holding the exact test
token from `get_chain_config`, and any Permit2 approval done manually. Then:

```bash
pnpm connect              # verify all 8 tools, print live schemas + chain config
pnpm pay                  # live CLI payment with interactive approvals
HSP_MODE=live pnpm dev
```

Mobile connections rotate IPs; [`deploy/`](deploy/README.md) has a one-command setup for a
static-IP box.

---

## Project layout

```
contracts/        Foundry: A2ASettlement, DepositVault, TestUSDC (EIP-3009), ReputationRegistry +
                  IdentityRegistry (ERC-8004-style), tests, deploy script
deployments/      Deployed addresses per chain (written by the deploy script)
src/
  onchain/        Typed ABIs + bytecode, HSK networks, HskEscrowRail (viem), ERC-8004 reads
  a2a/            A2A schema, Receiving Agent + service catalog, HSP exchange, on-chain exchange
  hsp/            The 8 HSP tools: typed interface, MCP client, offline mock
  agent/          HSP payment-agent state machine, approvals, receipts, flow events
  signer/         Pluggable signer: burner (viem) + OKX wallet-skill adapter
  server/         Express + SSE server, both rails, deferred human approvals
  mcp/            10-tool Streamable HTTP MCP server (server.ts)
  scripts/        deploy, connect, pay, sync-abi
public/           Settlement Terminal web UI (no build step)
tests/            Vitest: mandate, HSP agent, HSP exchange, on-chain + MCP integration, fork
docs/             JUDGES / PROOF / CLAIMS / COMPETITION / MCP, demo/ (video + stills)
```

---

## Guardrails

- **Two human authorizations** on both rails, each showing recipient, payer and the raw amount.
- **Spend cap** applied with the live token decimals; the payer refuses to sign above it.
- **Quote cross-check**: the receiving agent's off-chain quote must equal the on-chain price.
- **Balance check** before signing; the payer is told to fund rather than failing on-chain.
- **HSP status honesty**: `payment-safe` is half-confirmed, not final; unknown statuses are
  surfaced, never inferred; identifiers are retained instead of creating duplicate orders.
- **Fail closed**: unparseable quote expiry is treated as expired; polling is time-bounded.

---

## Handoff — continuing this project

This section is for the next developer. Everything below the two "pending" items is already
built and tested; the backlog is optional polish, ordered by competitive value.

### Set up a fresh clone

```bash
# prerequisites: Node 20+, pnpm, and Foundry (https://getfoundry.sh) for the contracts
pnpm install
pnpm contracts:build        # forge build (forge-std is vendored under contracts/lib)
pnpm contracts:test         # 45 Foundry tests
pnpm test                   # 28 TS tests (spins throwaway anvil chains itself)
pnpm test:fork              # 2 tests vs the real USDC.e on a fork of HSK mainnet (needs the public RPC)
pnpm typecheck
# run it: pnpm chain:local  (t1) · pnpm deploy:local (t2) · pnpm dev → http://localhost:4100
```

Copy `.env.example` → `.env` and fill it. `.env` is gitignored; the committed burner/deployer
keys are **not** in the repo, so generate your own (`cast wallet new`) and set
`DEPLOYER_PRIVATE_KEY` / `BURNER_PRIVATE_KEY`.

### What's DONE (don't redo)

- `A2ASettlement` escrow with 3 funding rails (EIP-3009 gasless, ERC-20 approval, terms-committed
  **deposit vaults**); delivery-hash release + timeout refund; payments keyed by `(payer,request,service)`.
- Deposit vaults let HSP settle into escrow — proven on a mainnet fork with real USDC.e
  (`tests/fork.test.ts`). Three-lens security review applied.
- ERC-8004-style `ReputationRegistry` (settlement-backed) + `IdentityRegistry`.
- `HskEscrowRail` (viem), `OnchainA2AExchange`, Express+SSE server, two-rail web UI, demo video.
- 10-tool MCP server (`src/mcp/server.ts`), evidence pack in `docs/`.

### What's LEFT

**Operator-gated (needed to place in the hackathon):**
1. **Deploy to HSK mainnet (177).** Fund `0xBaA9364c59041392b503d4a1A4be6126557FC919` with ~4 HSK,
   then `pnpm deploy:mainnet` (writes `deployments/177.json`, registers services vs real USDC.e).
   Then commit `deployments/177.json` and add the explorer links to `docs/PROOF.md`.
2. **Live HSP settlement.** Ask the organizers to allowlist the run host's egress IP / issue HSP
   merchant credentials, then `HSP_MODE=live pnpm dev` (or `pnpm connect` to verify the 8 tools).
   `deploy/README.md` has a one-command static-IP box setup if the dev machine's IP rotates.

**Non-blocked backlog (optional, ranked by value — see `docs/COMPETITION.md`):**
3. **A real LLM payment-agent brain.** Today the agent is deterministic orchestration. Add an
   LLM that turns natural language ("buy the market snapshot") into a service+policy decision,
   pluggable behind an API key, degrading to deterministic without one. Natural seam:
   `src/a2a/onchain-exchange.ts` (service selection) + a new `src/agent/llm.ts`.
4. **Expose the deposit rail in the MCP server and UI.** The rail already has
   `depositAddress / depositStatus / claimDeposit / refundExcessDeposit`
   (`src/onchain/escrow-rail.ts`); add matching MCP tools in `src/mcp/server.ts` and a
   "deposit" mode in the web UI so the HSP-into-escrow path is clickable, not just tested.
5. **Deepen tests** toward the top of the field (property/invariant tests on the escrow).

### Gotchas

- **Local anvil + EIP-3009 expiry:** anvil mines on demand, so if it sits idle >10 min the block
  timestamp goes stale and a signed authorization can read as expired. For long demos run
  `anvil --block-time 1` or `evm_mine` periodically (the demo recorder does this).
- **ABIs are generated:** after changing a contract, run `pnpm contracts:build && pnpm contracts:abi`
  to regenerate `src/onchain/abi.ts` (ABIs **and** bytecode the tests deploy with).
- **Don't commit `deployments/31337.json`** (local anvil, gitignored) — only real-network deployments.
- **HSP facts** (verified live): production chain-config is public at
  `https://hsp.hashkey.com/api/v1/payment/chain-config`; HSK-mainnet USDC.e is
  `0x054ed45810DbBAb8B27668922D110669c9D88D0a` (eip3009), relayer `0x1aaA5E4371aAdf96bEfb5bd2Af4d896FD16915Ea`.
