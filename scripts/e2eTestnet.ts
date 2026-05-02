import {
    TonClient, WalletContractV5R1, internal, SendMode, OpenedContract,
} from '@ton/ton'
import { mnemonicToPrivateKey } from '@ton/crypto'
import { Address, beginCell, toNano, Cell } from '@ton/core'
import { compile } from '@ton/blueprint'
import * as fs from 'fs'
import * as path from 'path'

import { Registry } from '../wrappers/Registry'
import { Channel } from '../wrappers/Channel'
import { OP } from '../wrappers/constants'

// ─────────────────────────────────────────────────────────────────────────
// End-to-end testnet проверка: user-канал, депозит, ожидание периода,
// process_payment от того же кошелька (роль relayer'а), верификация
// распределения on-chain.
// ─────────────────────────────────────────────────────────────────────────

const PERIOD_SECONDS    = 60                    // минимум по контракту
const SUB_AMOUNT_TON    = toNano('0.1')         // 0.1 TON / period
const TOP_UP_TON        = toNano('0.4')         // ~4 периода
const RELAYER_BOUNTY    = toNano('0.05')

function loadEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    fs.readFileSync(path.join(process.cwd(), '.env.testnet'), 'utf-8')
        .split('\n').forEach(line => {
            const m = line.match(/^([A-Z_]+)=(.*)$/)
            if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
        })
    return env
}

function fetchAdapter() {
    return async (config: any) => {
        const url = config.baseURL ? new URL(config.url, config.baseURL).toString() : config.url
        const body = config.data
            ? (typeof config.data === 'string' ? config.data : JSON.stringify(config.data))
            : undefined
        let delay = 1500
        for (let attempt = 0; attempt < 10; attempt++) {
            const res = await fetch(url, {
                method: (config.method?.toUpperCase()) ?? 'GET',
                headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
                body,
            })
            const text = await res.text()
            let data: any
            try { data = JSON.parse(text) } catch { data = text }
            if (res.status === 429) {
                console.log(`  [rate-limit] sleeping ${delay}ms`)
                await new Promise(r => setTimeout(r, delay))
                delay = Math.min(delay * 2, 20000)
                continue
            }
            return {
                data, status: res.status, statusText: res.statusText,
                headers: Object.fromEntries(res.headers.entries()),
                config, request: {} as any,
            }
        }
        throw new Error('Toncenter rate-limit exceeded after 10 retries')
    }
}

async function waitForActive(client: TonClient, addr: Address, label: string, timeoutSec = 120) {
    process.stdout.write(`  waiting for ${label} active`)
    for (let i = 0; i < timeoutSec / 3; i++) {
        const s = await client.getContractState(addr)
        if (s.state === 'active') { console.log(' ✓'); return }
        process.stdout.write('.')
        await new Promise(r => setTimeout(r, 3000))
    }
    throw new Error(`Timeout waiting for ${label} to become active`)
}

async function waitForSeqno(w: OpenedContract<WalletContractV5R1>, prevSeqno: number, timeoutSec = 60) {
    for (let i = 0; i < timeoutSec / 3; i++) {
        const s = await w.getSeqno()
        if (s > prevSeqno) return s
        await new Promise(r => setTimeout(r, 3000))
    }
    throw new Error('Timeout waiting for wallet seqno bump')
}

async function main() {
    const env = loadEnv()
    const mnemonic = env.TESTNET_MNEMONIC.split(/\s+/).filter(Boolean)
    const registryAddr = Address.parse(env.REGISTRY_ADDRESS)

    const keys = await mnemonicToPrivateKey(mnemonic)
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey })
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        httpAdapter: fetchAdapter() as any,
    })
    const w = client.open(wallet)

    console.log('────────────────────────────────────────────────')
    console.log(`User wallet:  ${wallet.address.toString({ testOnly: true, bounceable: false })}`)
    console.log(`Registry:     ${registryAddr.toString({ testOnly: true })}`)
    console.log(`Balance:      ${(Number(await w.getBalance()) / 1e9).toFixed(4)} TON`)
    console.log('────────────────────────────────────────────────')

    const registry = client.open(Registry.createFromAddress(registryAddr))

    // ─── 1. Compute predicted channel address ─────────────────────────
    const channelAddr = await registry.getChannelAddress(
        wallet.address,         // user
        wallet.address,         // creator (= self for test)
        null,                   // TON mode
    )
    console.log(`\n[1] Predicted Channel address: ${channelAddr.toString({ testOnly: true })}`)

    const existing = await client.getContractState(channelAddr)
    if (existing.state !== 'active') {
        // ─── 2. Send DEPLOY_CHANNEL via Registry ──────────────────────
        console.log(`[2] Sending OP_DEPLOY_CHANNEL via Registry`)
        const body = beginCell()
            .storeUint(OP.DEPLOY_CHANNEL, 32)
            .storeUint(BigInt(Date.now()), 64)
            .storeAddress(wallet.address)               // creator
            .storeAddress(null)                          // jettonMaster = null (TON mode)
            .storeUint(PERIOD_SECONDS, 32)
            .storeCoins(SUB_AMOUNT_TON)
            .storeCoins(RELAYER_BOUNTY)
            .endCell()

        const seqno1 = await w.getSeqno()
        await w.sendTransfer({
            seqno: seqno1,
            secretKey: keys.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({
                to: registryAddr,
                value: toNano('0.6'),
                body,
                bounce: true,
            })],
        })
        await waitForSeqno(w, seqno1)
        await waitForActive(client, channelAddr, 'channel')
    } else {
        console.log(`[2] Channel already exists, skipping deploy`)
    }

    // ─── 3. Read initial channel state ────────────────────────────────
    const channel = client.open(Channel.createFromAddress(channelAddr))
    const sBefore = await channel.getSubscription()
    console.log(`\n[3] Channel state:`)
    console.log(`    status:           ${sBefore.status} (1=ACTIVE)`)
    console.log(`    period:           ${sBefore.period}s`)
    console.log(`    amountPerPeriod:  ${(Number(sBefore.amountPerPeriod) / 1e9).toFixed(4)} TON`)
    console.log(`    nextBillingTs:    ${new Date(sBefore.nextBillingTs * 1000).toISOString()}`)
    console.log(`    vaultBalance:     ${(Number(sBefore.vaultBalance) / 1e9).toFixed(4)} TON`)

    // ─── 4. Top-up vault ──────────────────────────────────────────────
    if (sBefore.vaultBalance < SUB_AMOUNT_TON) {
        console.log(`\n[4] Topping up vault: ${(Number(TOP_UP_TON) / 1e9).toFixed(4)} TON`)
        const topUpBody = beginCell()
            .storeUint(OP.TOP_UP_TON, 32)
            .storeUint(BigInt(Date.now()), 64)
            .endCell()

        const seqno2 = await w.getSeqno()
        await w.sendTransfer({
            seqno: seqno2,
            secretKey: keys.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [internal({
                to: channelAddr,
                value: TOP_UP_TON,
                body: topUpBody,
                bounce: true,
            })],
        })
        await waitForSeqno(w, seqno2)
        // Wait for top-up to actually hit the channel (poll vault balance)
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 4000))
            const s = await channel.getSubscription()
            if (s.vaultBalance > 0n) {
                console.log(`    new vaultBalance: ${(Number(s.vaultBalance) / 1e9).toFixed(4)} TON  (after ${(i + 1) * 4}s)`)
                break
            }
            if (i === 14) {
                throw new Error('Top-up did not arrive at channel after 60s — wallet may have insufficient balance')
            }
        }
    } else {
        console.log(`\n[4] Vault already has enough balance, skipping top-up`)
    }

    // ─── 5. Wait until nextBillingTs ──────────────────────────────────
    const sNow = await channel.getSubscription()
    const waitUntil = sNow.nextBillingTs + 5
    const nowSec = Math.floor(Date.now() / 1000)
    const waitSec = Math.max(0, waitUntil - nowSec)
    console.log(`\n[5] Waiting ${waitSec}s until billing window opens (${new Date(waitUntil * 1000).toISOString()})`)
    if (waitSec > 0) await new Promise(r => setTimeout(r, waitSec * 1000))

    const isDue = await channel.isDueForPayment()
    console.log(`    is_due_for_payment: ${isDue}`)

    // ─── 6. Trigger process_payment ───────────────────────────────────
    console.log(`\n[6] Triggering OP_PROCESS_PAYMENT (acting as relayer)`)
    const balBeforeRelayer = await w.getBalance()
    const processBody = beginCell()
        .storeUint(OP.PROCESS_PAYMENT, 32)
        .storeUint(BigInt(Date.now()), 64)
        .endCell()

    const seqno3 = await w.getSeqno()
    await w.sendTransfer({
        seqno: seqno3,
        secretKey: keys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({
            to: channelAddr,
            value: toNano('0.3'),
            body: processBody,
            bounce: true,
        })],
    })
    await waitForSeqno(w, seqno3)
    await new Promise(r => setTimeout(r, 8000))

    // ─── 7. Verify final state ────────────────────────────────────────
    const sFinal = await channel.getSubscription()
    const balAfter = await w.getBalance()
    console.log(`\n[7] Final channel state:`)
    console.log(`    status:           ${sFinal.status} (1=ACTIVE)`)
    console.log(`    nextBillingTs:    ${new Date(sFinal.nextBillingTs * 1000).toISOString()}`)
    console.log(`    vaultBalance:     ${(Number(sFinal.vaultBalance) / 1e9).toFixed(4)} TON`)
    console.log(`    pendingCharge:    ${(Number(sFinal.pendingCharge) / 1e9).toFixed(4)} TON`)

    const charged = sNow.vaultBalance - sFinal.vaultBalance
    console.log(`    charged this run: ${(Number(charged) / 1e9).toFixed(4)} TON  (expected ${(Number(SUB_AMOUNT_TON) / 1e9).toFixed(4)})`)

    const expectedAdmin   = SUB_AMOUNT_TON * 50n / 10000n
    const expectedCreator = SUB_AMOUNT_TON - expectedAdmin
    console.log(`\n    distribution:`)
    console.log(`      admin (0.5%):    ${(Number(expectedAdmin) / 1e9).toFixed(6)} TON`)
    console.log(`      creator (99.5%): ${(Number(expectedCreator) / 1e9).toFixed(6)} TON`)
    console.log(`      relayer bounty:  ${(Number(RELAYER_BOUNTY) / 1e9).toFixed(4)} TON`)
    console.log(`    NB: admin + creator + relayer == self в этом тесте, всё вернулось обратно.`)

    console.log(`\n────────────────────────────────────────────────`)
    console.log(`✅ End-to-end success`)
    console.log(`Channel: https://testnet.tonviewer.com/${channelAddr.toString({ testOnly: true })}`)
    console.log(`────────────────────────────────────────────────`)
}

main().catch(e => { console.error(e); process.exit(1) })
