# Claims ledger

Honesty is a feature. Each claim below carries a tag; nothing is overstated, and the code
never fabricates a payment, signature, tx hash, attribution or status.

- **VERIFIED-LIVE** — observed working against a live network or real contract in this repo.
- **REPRODUCIBLE** — runs deterministically from a clean checkout with the given command.
- **MODELED** — exercises the real components and call shapes, but stands in for a party we
  cannot yet access (HSP's server).
- **PENDING** — built and ready, gated only on an external grant (gas, allowlist).
- **NOT-CLAIMED** — explicitly not done; we do not assert it.

## On-chain escrow

| Claim | Tag |
|---|---|
| `A2ASettlement` escrows via EIP-3009 (gasless), ERC-20 approval, and terms-committed deposit vaults | REPRODUCIBLE (43 Foundry tests) |
| Delivery-gated release + timeout refund + delivery-hash anchoring | REPRODUCIBLE |
| Deposit address commits to exact terms (payer, request, service, token, price, window, claimBy) | REPRODUCIBLE (`test_RevertWhen_ClaimDepositTermsMismatch`) |
| Payments keyed by (payer, requestId, serviceId); no cross-deal squatting | REPRODUCIBLE |
| Works against the real USDC.e (FiatToken v2) contract on a fork of HSK mainnet | VERIFIED-LIVE (`pnpm test:fork`) |
| Fund conservation under fuzzing | REPRODUCIBLE (`testFuzz_*`) |

## HSP integration

| Claim | Tag |
|---|---|
| We read HSP's **production** chain-config over the network | VERIFIED-LIVE (`curl https://hsp.hashkey.com/api/v1/payment/chain-config` → `code:0`) |
| Our escrow uses the same HSK-mainnet USDC.e address and eip3009 protocol HSP specifies | VERIFIED-LIVE |
| HSP's gateway can settle **into** our escrow: a relayer's `transferWithAuthorization` into our deposit address, claimed into escrow | MODELED (real USDC.e + real call shape + third-party relayer on a mainnet fork; HSP's own server not in the loop) |
| HSP Gateway rail (MCP: create_order → prepare → sign → finalize → submit → query) | REPRODUCIBLE against a faithful mock; **PENDING** against the live QA endpoint |
| A payment settled by HSP's own relayer on a live network | NOT-CLAIMED — needs HashKey to allowlist our IP / issue merchant credentials |

## Deployment

| Claim | Tag |
|---|---|
| Deploys to a local chain and to HSK testnet/mainnet via one script | REPRODUCIBLE (`pnpm deploy:local`; dry-run verified against mainnet RPC) |
| Live deployment on HSK Chain **mainnet (177)** | PENDING — needs native HSK for gas at `0xBaA9364c59041392b503d4a1A4be6126557FC919` (deploy is a single `pnpm deploy:mainnet`) |

## Tooling & UX

| Claim | Tag |
|---|---|
| 10-tool MCP server a judge can `claude mcp add` and drive end to end | REPRODUCIBLE (`pnpm mcp`; `tests/mcp.test.ts`) |
| Settlement-backed reputation (ERC-8004-style): only the escrow writes it; readable + MCP `get_reputation` | REPRODUCIBLE (`test_Reputation_*`) |
| Web UI showing both rails, live stages, two approval gates, a receipt with tx hashes | REPRODUCIBLE (`pnpm dev`) |
| Demo video of a real on-chain purchase | VERIFIED-LIVE (`docs/demo/demo.mp4`, recorded from the running app) |

## Not claimed

- No live payment through HSP's server. No mainnet transactions yet. No profitability or
  trading claims. Reputation reflects only settled on-chain deals (self-dealing excluded); it is
  not a predictive credit score and a provider can still choose which deals to take.
