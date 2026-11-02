# Judges — a 5-minute path

**What this is.** Trust-minimized agent-to-agent commerce on HSK Chain. A paying agent buys
a service from a receiving agent; funds sit in an on-chain escrow until the receiving agent
delivers and anchors proof of delivery. It settles over **two rails** — the **HSP Agentic
Payment gateway** and a **native HSK Chain escrow** — and is built so HSP's own gateway can
settle *into* the escrow.

**The one idea that matters.** x402 "pay then deliver" gives the payer no delivery guarantee
and makes the receiver trust a payment claim. Our `A2ASettlement` escrow fixes both, and its
**deposit-vault** address is a *commitment to the exact deal terms*, so HSP's relayer can pay
into it and our contract takes over — delivery-gated release, timeout refund, on-chain proof.

## Run it (pick one)

1. **Fastest — the real on-chain purchase, fully local (~2 min, no wallet, no faucet):**
   ```bash
   pnpm install
   pnpm chain:local      # terminal 1: anvil
   pnpm deploy:local     # terminal 2: deploy escrow + TestUSDC, fund the payer
   pnpm dev              # http://localhost:4100 → "HSK Chain escrow" → Initiate payment
   ```
   Watch the nine-stage pipeline, two human-authorization gates, and a receipt with the
   escrow tx, release tx and delivery hash. Add `?autoplay=1` for a hands-free run.

2. **The tests (proves it against the REAL USDC.e on a fork of HSK mainnet):**
   ```bash
   pnpm contracts:test   # 43 Foundry tests (incl. fuzz)
   pnpm test             # 28 TypeScript tests
   pnpm test:fork        # 2 tests on a fork of HSK mainnet with the real USDC.e contract
   ```
   The second fork test reproduces **HSP's exact settlement call** — a relayer broadcasting
   `transferWithAuthorization(payer, depositAddress, …)` on real USDC.e — and claims it into
   escrow. See [PROOF.md](PROOF.md).

3. **Drive it from your own agent (MCP):**
   ```bash
   pnpm mcp              # Streamable HTTP MCP server on :4200
   claude mcp add --transport http a2a-escrow http://localhost:4200/mcp
   ```
   Nine tools: `get_chain_config, list_services, get_service, build_authorization,
   relay_settlement, get_payment, confirm_delivery, refund, anchor_external_settlement`.
   See [MCP.md](MCP.md).

## What is real vs. pending

See [CLAIMS.md](CLAIMS.md) for the line-by-line tags. In short: the escrow, the three
settlement rails, the delivery/refund logic, the MCP server and the web UI are **built and
tested** (including against real USDC.e on a mainnet fork). The two things gated on external
grants are **mainnet deployment** (needs HSK for gas) and a **live HSP-server settlement**
(needs HashKey to allowlist us / issue merchant credentials). We do **not** claim either as
done, and the code never fabricates a payment, signature, tx hash or status.

## Where to look

- Contracts: [`contracts/src/A2ASettlement.sol`](../contracts/src/A2ASettlement.sol),
  [`contracts/src/DepositVault.sol`](../contracts/src/DepositVault.sol)
- The HSP-into-escrow proof: [`tests/fork.test.ts`](../tests/fork.test.ts)
- The two-rail agent: [`src/a2a/onchain-exchange.ts`](../src/a2a/onchain-exchange.ts),
  [`src/onchain/escrow-rail.ts`](../src/onchain/escrow-rail.ts)
- Demo video: [`docs/demo/demo.mp4`](demo/demo.mp4)
