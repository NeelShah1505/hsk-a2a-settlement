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
  onchain/        Typed ABIs, HSK Chain networks, HskEscrowRail (viem)
  a2a/            A2A schema, Receiving Agent + catalog, HSP exchange, on-chain exchange
  onchain/        Typed ABIs, HSK networks, HskEscrowRail (viem) + ERC-8004 Identity/Reputation reads
  hsp/            The 8 HSP tools: typed interface, MCP client, offline mock
  agent/          HSP payment-agent state machine, approvals, receipts, flow events
  signer/         Pluggable signer: burner (viem) + OKX wallet-skill adapter
  server/         Express + SSE server, both rails, deferred human approvals
  scripts/        deploy, connect, pay, sync-abi
public/           Settlement Terminal web UI (no build step)
tests/            Vitest: mandate, HSP agent, HSP exchange, on-chain integration
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
