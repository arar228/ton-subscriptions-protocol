import { Address, toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { Registry } from '../wrappers/Registry'

// ─────────────────────────────────────────────────────────────────────────
// Deploy SubscriptionRegistry — master-контракт протокола.
//
// Usage:
//   npx blueprint run deployRegistry --testnet --mnemonic
//   npx blueprint run deployRegistry --mainnet --tonconnect      # рекомендуется
//
// На mainnet используй --tonconnect (не --mnemonic): seed phrase не должна
// проходить через локальный CLI без HW-wallet'а.
// ─────────────────────────────────────────────────────────────────────────

// Config: подкрути перед деплоем
const PROTOCOL_FEE_BPS = 50         // 0.5%
const ADMIN_ADDRESS_OVERRIDE: Address | null = null   // null = sender deployer'а

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const adminAddr = ADMIN_ADDRESS_OVERRIDE ?? provider.sender().address!

    ui.write('────────────────────────────────────────────────')
    ui.write(`Network:        ${(provider as any).network() ?? 'unknown'}`)
    ui.write(`Admin:          ${adminAddr.toString()}`)
    ui.write(`Fee (bps):      ${PROTOCOL_FEE_BPS} (=${PROTOCOL_FEE_BPS / 100}%)`)
    ui.write('────────────────────────────────────────────────')

    if (process.env.AUTO_CONFIRM !== '1') {
        const confirm = await ui.choose(
            'Deploy with these params?',
            ['Yes, deploy', 'Abort'],
            (s) => s,
        )
        if (confirm !== 'Yes, deploy') {
            ui.write('Aborted.')
            return
        }
    }

    const channelCode  = await compile('Channel')
    const registryCode = await compile('Registry')

    const registry = provider.open(Registry.createFromConfig(
        {
            admin: adminAddr,
            protocolFeeBps: PROTOCOL_FEE_BPS,
            channelCode,
        },
        registryCode,
    ))

    ui.write(`Registry address: ${registry.address.toString()}`)
    ui.write(`Channel code hash: ${channelCode.hash().toString('hex')}`)
    ui.write('')

    await registry.sendDeploy(provider.sender(), toNano('0.5'))
    await provider.waitForDeploy(registry.address, 30)

    const cfg = await registry.getConfig()
    ui.write('────────────────────────────────────────────────')
    ui.write('✅ Deployed and live')
    ui.write(`   admin:           ${cfg.admin.toString()}`)
    ui.write(`   protocolFeeBps:  ${cfg.protocolFeeBps}`)
    ui.write(`   totalChannels:   ${cfg.totalChannels}`)
    ui.write('────────────────────────────────────────────────')
    ui.write('')
    ui.write('NEXT STEPS:')
    ui.write('  1. Save Registry address to .env:')
    ui.write(`     REGISTRY_ADDRESS=${registry.address.toString()}`)
    ui.write('  2. Verify code on Tonviewer:')
    ui.write(`     https://tonviewer.com/${registry.address.toString()}?section=method&item=verify`)
    ui.write('  3. Submit source via verifier.ton.org for tonscan verification.')
}
