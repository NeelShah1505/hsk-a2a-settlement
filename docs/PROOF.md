# Proof

Every claim here is reproducible from this repo. Tags are defined in [CLAIMS.md](CLAIMS.md).

## 1. HSP settles into our escrow — proven against real USDC.e (REPRODUCIBLE)

HSP's Agentic Payment gateway builds an EIP-3009 authorization (it picks the nonce) and its
own relayer broadcasts `token.transferWithAuthorization(payer, pay_to, value, …)` into the
order's `pay_to`. Our receiving agent sets `pay_to` to a **deterministic deposit address**
that commits to the exact deal terms, so HSP's relayer pays into it and `claimDeposit` pulls
it into escrow.

[`tests/fork.test.ts`](../tests/fork.test.ts) → *"absorbs an HSP-style relayer
transferWithAuthorization into the deposit vault, then claims it"* does exactly this on a
**fork of HSK Chain mainnet (chain 177) using the real USDC.e contract**
`0x054ed45810DbBAb8B27668922D110669c9D88D0a` (Circle FiatToken v2):

1. the receiving agent derives `pay_to = depositAddress(terms)` (a counterfactual address
   with no code yet);
2. the payer signs a `TransferWithAuthorization` to that address;
3. a **separate relayer account** broadcasts `transferWithAuthorization` on real USDC.e — the
   same call shape HSP's relayer uses — and the funds land in the vault;
4. `claimDeposit(terms)` deploys the vault clone, pulls exactly the price into escrow;
5. `confirmDelivery` releases to the provider.

```bash
pnpm test:fork    # 2 passing tests; needs the public HSK mainnet RPC
```

This is the production flow (real token, real `transferWithAuthorization`, third-party
relayer, counterfactual `pay_to`) settling into our escrow. The only piece not exercised is
HSP's *server* (see CLAIMS.md → PENDING).

## 2. We really do reach HSP's production API (VERIFIED-LIVE)

HSP's production chain-config is public and we read it live:

```bash
curl -s https://hsp.hashkey.com/api/v1/payment/chain-config
# → {"code":0,"msg":"success", … }
```

It returns, for HSK Chain mainnet (177):

| token | address | protocol | relayer (permit2_spender) |
|---|---|---|---|
| USDC.e | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | eip3009 | `0x1aaA5E4371aAdf96bEfb5bd2Af4d896FD16915Ea` |
| USDT | `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` | permit2 | `0x1aaA5E4371aAdf96bEfb5bd2Af4d896FD16915Ea` |

Our escrow uses the same USDC.e address and settles the eip3009 protocol HSP specifies.

## 3. The full on-chain purchase (REPRODUCIBLE)

```bash
pnpm chain:local && pnpm deploy:local && pnpm dev   # http://localhost:4100
```

Nine stages, two human-authorization gates, and a receipt carrying the escrow tx, release tx
and delivery hash. Stills in [`docs/demo/`](demo/) (`demo-complete.png`) and a 20 s video
(`demo.mp4`). The `onchain_tx` tape lines link to the block explorer on a live network.

## 4. Tests (VERIFIED-LIVE — run them)

| Suite | Count | Command |
|---|---|---|
| Foundry (unit + fuzz) | 43 | `pnpm contracts:test` |
| TypeScript (rail, agent, exchange, MCP, integration) | 28 | `pnpm test` |
| Mainnet-fork, real USDC.e | 2 | `pnpm test:fork` |

The integration tests spin a throwaway anvil chain, deploy the real contracts, and run the
whole purchase (build authorization → sign → relay → verify on-chain → deliver → release),
asserting fund conservation and that the payer never holds native gas.

## 5. Security review (REPRODUCIBLE process)

Before the deposit-vault code was written, three independent reviewers (accounting/reentrancy,
adversarial game-theory, EVM mechanics) audited the design. Every consensus issue was fixed:
terms-bound deposit salt, service-independent refunds, claim/refund anti-griefing gates, a
`claimBy` window, `DepositVault.settlement = msg.sender`, deploy-clone-only-on-funded-path,
and activity counters documented as non-reputation. See the commit history.

## Addresses

- Deployer / relayer / provider (fund this to deploy to mainnet): `0xBaA9364c59041392b503d4a1A4be6126557FC919`
- HSK mainnet USDC.e: `0x054ed45810DbBAb8B27668922D110669c9D88D0a`
- HSK mainnet explorer: https://hsk.blockscout.com
- Mainnet / testnet escrow addresses: written to `deployments/177.json` / `deployments/133.json` on deploy.
