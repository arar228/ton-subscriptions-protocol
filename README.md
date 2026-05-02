# TON Subscriptions Protocol

> Recurring payments on TON — "Stripe for Web3". Self-custodial subscription channels for native TON and Jetton (USDT) auto-debits.

[![CI](https://github.com/USER/REPO/actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Tolk 1.3](https://img.shields.io/badge/Tolk-1.3-green.svg)](https://github.com/ton-blockchain/tolk-js)

This repository contains the **smart contracts** of the protocol. The relayer / indexer / Telegram Mini App are operated separately as a hosted SaaS — but you're free to run your own thanks to the open contract layer.

## Architecture

```
SubscriptionRegistry (one master contract, holds protocol config)
        │ deploys
        ▼
SubscriptionChannel (per user↔creator↔asset, deterministic address)
   ├── pre-funded vault
   ├── next_billing_timestamp
   ├── status: active / paused-by-user / paused-insufficient / cancelled
   └── inbox: top_up · process_payment · pause · resume · cancel
```

**Crank pattern.** TON has no native cron, so any external relayer can poke `process_payment` once `now() >= next_billing_timestamp`. The contract validates the time, debits the vault by `amount_per_period`, sends 99.5 % to creator, 0.5 % to protocol admin, and pays the caller a small bounty in TON. Idempotent: only the first relayer per period wins.

**Bounce-safe Jetton transfers.** When a Jetton transfer fails (creator has no JW, minter froze the wallet, etc.), the channel's `onBouncedMessage` rolls vault + nextBillingTs back to pre-charge state and moves to `paused_insufficient`. Top-up auto-resumes.

**Pause/Resume preserves remainder.** Time left until next charge is frozen on pause and restored on resume — so a user pausing a day before charge cannot exploit a long pause to skip a month of fee.

## Quick start

```bash
git clone https://github.com/USER/REPO.git
cd REPO
npm install
npx blueprint build --all
npx jest                    # 36/36 should pass
```

## Test coverage (36 tests)

| Suite | Count | What it verifies |
|---|---|---|
| `Registry.spec.ts` | 9 | Config update, deterministic channel address, deploy validation (period/amount/bounty bounds) |
| `Channel.spec.ts` | 16 | TON-mode happy path, double-process rejection, pause/resume remainder, cancel refund, getter consistency |
| `ChannelJettonBounce.spec.ts` | 7 | TOFU JW-bind, spoofed-notify rejection, **state rollback on Jetton bounce** (the critical one) |
| `ChannelRealUSDT.spec.ts` | 4 | Integration vs **real Tether `stablecoin-contract`** — real mint, real transfer, real charge distribution |

The Tether code under `contracts/jetton-tether/` is a vendored shallow-clone of [ton-blockchain/stablecoin-contract](https://github.com/ton-blockchain/stablecoin-contract); compiled hash matches the production USDT minter on TON mainnet.

## Deploy

### Testnet

```bash
# 1. Deploy Registry (sender becomes admin by default)
npx blueprint run deployRegistry --testnet --mnemonic

# 2. Deploy a sample channel (sender becomes user/subscriber)
REGISTRY=EQ_registry_address \
CREATOR=EQ_creator_address \
AMOUNT=10 PERIOD_DAYS=30 \
JETTON_MASTER=kQB...        # optional, omit for TON channel
  npx blueprint run deployChannel --testnet --mnemonic

# 3. Smoke check
REGISTRY=EQ_registry_address npx blueprint run readRegistry --testnet
```

### Mainnet

Use **TON Connect** instead of seed phrase — `--tonconnect` instead of `--mnemonic`. Verify the contract on Tonviewer/Tonscan via [verifier.ton.org](https://verifier.ton.org) by uploading the source from this repo at the deployed commit.

## Economics

- **Protocol fee:** 0.5 % of every successful debit (configurable up to 10 % via `update_config`)
- **Relayer bounty floor:** 0.03 TON (TON channels), 0.10 TON (Jetton channels) — calibrated to cover real TEP-74 internal-transfer gas
- **Vault model:** pre-funded — user deposits N periods upfront, can cancel anytime to refund the remainder

## Contract storage layout

| Field | Location | Why |
|---|---|---|
| `status, nextBillingTs, vaultBalance, pendingCharge, jettonMaster, jettonWallet, pausedRemainder` | root | hot path access for `process_payment` |
| `identity (registry, user, creator)` | ref-cell | immutable after init, verified on each handler |
| `config (admin, fee, period, amount, bounty)` | ref-cell | immutable after init, loaded on charge |

Layout split is **enforced by the Tolk 1.3 compiler** to fit the 1023-bit cell limit without runtime overflow risk.

## Security

- Bounce handler rolls back state on failed Jetton transfers — verified by `ChannelJettonBounce.spec.ts` with controllable mock JW
- TOFU jetton-wallet binding with permanent sender lock — prevents notification spoofing
- `pendingCharge` flag prevents double-charge during in-flight Jetton transfers
- Pause-by-user vs pause-by-insufficient are separate states — top-up does **not** auto-resume manual pauses

A formal audit (Trail of Bits / SlowMist / Trust) is **required before mainnet deployment with real user funds**. Bug bounty program will be opened on Immunefi after audit.

## License

[Apache 2.0](LICENSE) — protocol code is freely forkable and modifiable.

The names "TON Subscriptions Protocol" and any associated logos remain trademarks of the project authors. Forks must be renamed and rebranded; see the trademark notice in [LICENSE](LICENSE).
