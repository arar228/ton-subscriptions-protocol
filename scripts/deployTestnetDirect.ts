import { TonClient, WalletContractV5R1, internal, SendMode } from '@ton/ton'
import { mnemonicToPrivateKey } from '@ton/crypto'
import { Address, beginCell, toNano } from '@ton/core'
import { compile } from '@ton/blueprint'
import * as fs from 'fs'
import * as path from 'path'

import { Registry } from '../wrappers/Registry'

// Stand-alone testnet deployer: использует mnemonic из .env.testnet,
// шлёт через toncenter v2 jsonRPC, не зависит от blueprint NetworkProvider.

const PROTOCOL_FEE_BPS = 50

async function main() {
    // 1. Load env
    const envPath = path.join(process.cwd(), '.env.testnet')
    const env: Record<string, string> = {}
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_]+)=(.*)$/)
        if (!m) return
        env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
    })

    const mnemonic = env.TESTNET_MNEMONIC.split(/\s+/).filter(Boolean)
    if (mnemonic.length !== 24) throw new Error(`Bad mnemonic length: ${mnemonic.length}`)

    // 2. Wallet
    const keys = await mnemonicToPrivateKey(mnemonic)
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey })

    // 3. Client — fetch-based HTTP adapter with retry on 429 (no API key)
    const fetchAdapter = async (config: any) => {
        const url = config.baseURL ? new URL(config.url, config.baseURL).toString() : config.url
        const body = config.data
            ? (typeof config.data === 'string' ? config.data : JSON.stringify(config.data))
            : undefined
        let delay = 1500
        for (let attempt = 0; attempt < 8; attempt++) {
            const res = await fetch(url, {
                method: (config.method?.toUpperCase()) ?? 'GET',
                headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
                body,
            })
            const text = await res.text()
            let data: any
            try { data = JSON.parse(text) } catch { data = text }
            if (res.status === 429) {
                console.log(`[rate-limit] sleeping ${delay}ms (attempt ${attempt + 1}/8)`)
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
        throw new Error('Toncenter rate-limit exceeded after 8 retries')
    }
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        httpAdapter: fetchAdapter as any,
    })
    const w = client.open(wallet)

    const balance = await w.getBalance()
    console.log(`[wallet] ${wallet.address.toString({ testOnly: true, bounceable: false })}`)
    console.log(`[wallet] balance: ${(Number(balance) / 1e9).toFixed(4)} TON`)
    if (balance < toNano('0.5')) throw new Error('Insufficient balance for deploy (need ≥ 0.5 TON)')

    // 4. Compile + create Registry
    console.log('[compile] Channel + Registry')
    const channelCode = await compile('Channel')
    const registryCode = await compile('Registry')

    const registry = Registry.createFromConfig(
        {
            admin: wallet.address,
            protocolFeeBps: PROTOCOL_FEE_BPS,
            channelCode,
        },
        registryCode,
    )

    const registryAddr = registry.address
    console.log(`[registry] address: ${registryAddr.toString({ testOnly: true, bounceable: true })}`)
    console.log(`[registry] channel code hash: ${channelCode.hash().toString('hex')}`)

    // Check if already deployed
    const state = await client.getContractState(registryAddr)
    if (state.state === 'active') {
        console.log('[skip] Registry already deployed and active.')
        return
    }

    // 5. Send deploy
    console.log('[deploy] sending init message …')
    const seqno = await w.getSeqno()
    await w.sendTransfer({
        seqno,
        secretKey: keys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        messages: [
            internal({
                to: registryAddr,
                value: toNano('0.5'),
                init: registry.init,
                body: beginCell().endCell(),
                bounce: false,
            }),
        ],
    })

    // 6. Wait for deploy
    console.log('[wait] confirming on-chain …')
    let attempts = 0
    while (attempts < 40) {
        await new Promise(r => setTimeout(r, 3000))
        const s = await client.getContractState(registryAddr)
        if (s.state === 'active') {
            console.log('[wait] active!')
            break
        }
        attempts++
        process.stdout.write('.')
    }

    // 7. Verify via get-method
    const tonClient = client
    const reg = tonClient.open(Registry.createFromAddress(registryAddr))
    const cfg = await reg.getConfig()
    console.log('────────────────────────────────────────────────')
    console.log('✅ Registry deployed and live:')
    console.log(`   address (bounceable):     ${registryAddr.toString({ testOnly: true, bounceable: true })}`)
    console.log(`   address (non-bounceable): ${registryAddr.toString({ testOnly: true, bounceable: false })}`)
    console.log(`   admin:           ${cfg.admin.toString({ testOnly: true })}`)
    console.log(`   protocolFeeBps:  ${cfg.protocolFeeBps}`)
    console.log(`   totalChannels:   ${cfg.totalChannels}`)
    console.log('────────────────────────────────────────────────')
    console.log(`Tonviewer:   https://testnet.tonviewer.com/${registryAddr.toString({ testOnly: true })}`)
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
