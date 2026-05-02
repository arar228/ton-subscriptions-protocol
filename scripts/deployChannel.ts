import { Address, toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { Registry } from '../wrappers/Registry'
import { Channel } from '../wrappers/Channel'

// ─────────────────────────────────────────────────────────────────────────
// Deploy SubscriptionChannel через Registry.
// Запускается USER'ом (не админом) — sender становится подписчиком (user
// поле канала). Указываешь creator-адрес, период, сумму, и (опционально)
// jetton master адрес для USDT-канала.
//
// Usage (testnet):
//   REGISTRY=EQ... CREATOR=EQ... AMOUNT=10 PERIOD_DAYS=30 \
//     npx blueprint run deployChannel --testnet --mnemonic
//
// Для USDT-канала добавь:
//   JETTON_MASTER=EQ...   (testnet USDT адрес)
// ─────────────────────────────────────────────────────────────────────────

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const registryAddr = Address.parse(must('REGISTRY'))
    const creatorAddr  = Address.parse(must('CREATOR'))
    const jettonMaster = process.env.JETTON_MASTER
        ? Address.parse(process.env.JETTON_MASTER)
        : null
    const periodDays   = Number(process.env.PERIOD_DAYS ?? '30')
    const amountStr    = must('AMOUNT')

    // amount: для TON — TON, для USDT — USDT (6 decimals)
    const amount: bigint = jettonMaster
        ? BigInt(Math.round(Number(amountStr) * 1_000_000))
        : toNano(amountStr)

    const period = periodDays * 86400
    const bounty = jettonMaster ? toNano('0.12') : toNano('0.05')

    ui.write('────────────────────────────────────────────────')
    ui.write(`Registry:       ${registryAddr.toString()}`)
    ui.write(`User (sender):  ${provider.sender().address!.toString()}`)
    ui.write(`Creator:        ${creatorAddr.toString()}`)
    ui.write(`Asset:          ${jettonMaster ? `USDT @ ${jettonMaster.toString()}` : 'native TON'}`)
    ui.write(`Amount/period:  ${amountStr}`)
    ui.write(`Period:         ${periodDays} days`)
    ui.write(`Relayer bounty: ${bounty} nano`)
    ui.write('────────────────────────────────────────────────')

    const confirm = await ui.choose('Deploy channel?', ['Yes', 'Abort'], (s) => s)
    if (confirm !== 'Yes') return

    const registry = provider.open(Registry.createFromAddress(registryAddr))
    const channelAddr = await registry.getChannelAddress(
        provider.sender().address!, creatorAddr, jettonMaster,
    )
    ui.write(`Predicted channel address: ${channelAddr.toString()}`)

    await registry.sendDeployChannel(provider.sender(), {
        value: toNano('0.6'),
        creator: creatorAddr,
        jettonMaster,
        period,
        amount,
        relayerBounty: bounty,
    })
    await provider.waitForDeploy(channelAddr, 30)

    const channel = provider.open(Channel.createFromAddress(channelAddr))
    const s = await channel.getSubscription()
    ui.write('────────────────────────────────────────────────')
    ui.write('✅ Channel deployed')
    ui.write(`   address:         ${channelAddr.toString()}`)
    ui.write(`   status:          ${s.status} (1=ACTIVE)`)
    ui.write(`   nextBillingTs:   ${new Date(s.nextBillingTs * 1000).toISOString()}`)
    ui.write(`   amountPerPeriod: ${s.amountPerPeriod}`)
    ui.write('────────────────────────────────────────────────')
    ui.write('NEXT: пополни vault — отправь USDT (или TON) на адрес канала.')
}

function must(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`Required env var not set: ${name}`)
    return v
}
