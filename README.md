# TON Subscriptions Protocol

Recurring-payment smart contracts for TON and Jetton assets. A contract-engineering case study in explicit state transitions, asynchronous transfers, and reproducible integration tests.

[![CI](https://github.com/arar228/ton-subscriptions-protocol/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/arar228/ton-subscriptions-protocol/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Tolk 1.3](https://img.shields.io/badge/Tolk-1.3-green.svg)](https://github.com/ton-blockchain/tolk-js)

This public repository contains the **contract layer**: Tolk contracts, TypeScript wrappers, deployment scripts, and 36 sandbox tests. Relayer, indexer, and Telegram Mini App implementations are maintained separately and are outside this repository's review scope.

**Start here:** [Architecture](#architecture) · [Run locally](#quick-start) · [Tests](#test-coverage-36-tests) · [Security](#security)

## Engineering review guide

Subscribers pre-fund a channel; an external caller triggers each due payment. The engineering challenge is preserving billing and balance state across delayed messages, user actions, and failed transfers.

| Decision | Implementation and evidence |
|---|---|
| Separate shared configuration from per-subscription state | [Registry contract](contracts/registry.tolk), [channel contract](contracts/channel.tolk), and [registry tests](tests/Registry.spec.ts) |
| Validate billing time and reject repeated processing | [Channel tests](tests/Channel.spec.ts) cover early and duplicate calls, pause/resume, cancellation, and getters |
| Restore accounting state when a Jetton transfer bounces | [Bounce tests](tests/ChannelJettonBounce.spec.ts) use a controllable wallet to exercise rollback and recovery |
| Exercise integration against a concrete token implementation | [Tether integration tests](tests/ChannelRealUSDT.spec.ts) compile vendored contracts and run mint, transfer, charge distribution, and refund flows in TON Sandbox |
| Keep verification reproducible | [CI workflow](.github/workflows/ci.yml) installs the lockfile, compiles contracts, runs Jest, and uploads compiled artifacts |

**Status:** the public code supports local compilation and sandbox evaluation. A formal security audit is required before mainnet deployment with real user funds; see [Security](#security).

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

The [CI environment](.github/workflows/ci.yml) currently uses Node.js 20. Local compilation and all 36 sandbox tests were also verified with Node.js 22.17.0 on 2026-09-06.

```bash
git clone https://github.com/arar228/ton-subscriptions-protocol.git
cd ton-subscriptions-protocol
npm ci
npm run build
npm test -- --runInBand
```

The test suite creates an in-memory blockchain with `@ton/sandbox`. Wallet credentials, RPC access, and real funds are not required. The deployment scripts below are a separate, explicit workflow.

## Test coverage (36 tests)

| Suite | Count | What it verifies |
|---|---|---|
| [Registry.spec.ts](tests/Registry.spec.ts) | 9 | Config update, deterministic channel address, deploy validation (period/amount/bounty bounds) |
| [Channel.spec.ts](tests/Channel.spec.ts) | 16 | TON-mode happy path, double-process rejection, pause/resume remainder, cancel refund, getter consistency |
| [ChannelJettonBounce.spec.ts](tests/ChannelJettonBounce.spec.ts) | 7 | TOFU JW-bind, spoofed-notify rejection, state rollback on Jetton bounce |
| [ChannelRealUSDT.spec.ts](tests/ChannelRealUSDT.spec.ts) | 4 | Vendored Tether `stablecoin-contract` integration: sandbox mint, transfer, charge distribution, and refund |

The Tether code under [`contracts/jetton-tether/`](contracts/jetton-tether/) is vendored from [ton-blockchain/stablecoin-contract](https://github.com/ton-blockchain/stablecoin-contract). These tests use that implementation inside the sandbox; they do not execute mainnet payments or establish production security. Its upstream audit concerns the vendored token implementation, not this subscription protocol.

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
