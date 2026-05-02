import { Address } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Registry } from '../wrappers/Registry'

// Read-only smoke check после деплоя:
//   REGISTRY=EQ... npx blueprint run readRegistry --testnet
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const addr = Address.parse(must('REGISTRY'))
    const reg = provider.open(Registry.createFromAddress(addr))

    const cfg = await reg.getConfig()
    ui.write(`admin:           ${cfg.admin.toString()}`)
    ui.write(`protocolFeeBps:  ${cfg.protocolFeeBps}`)
    ui.write(`totalChannels:   ${cfg.totalChannels}`)
}

function must(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`Required env var not set: ${name}`)
    return v
}
