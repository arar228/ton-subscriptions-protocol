import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Address, Cell, toNano } from '@ton/core'
import { compile } from '@ton/blueprint'

import { Registry } from '../wrappers/Registry'
import { Channel } from '../wrappers/Channel'
import { MockJettonWallet } from '../wrappers/MockJettonWallet'

export const PERIOD = 30 * 86400
export const AMOUNT_TON       = toNano('10')        // 10 TON / month
export const AMOUNT_JETTON    = 10_000_000n         // 10 USDT (6 decimals)
export const FEE_BPS          = 50                  // 0.5%
export const RELAYER_BOUNTY        = toNano('0.05') // legacy default (TON режим)
export const RELAYER_BOUNTY_TON    = toNano('0.05')
export const RELAYER_BOUNTY_JETTON = toNano('0.12') // покрывает min 0.10 TON

export type Env = {
    bc: Blockchain
    admin:    SandboxContract<TreasuryContract>
    user:     SandboxContract<TreasuryContract>
    creator:  SandboxContract<TreasuryContract>
    relayer:  SandboxContract<TreasuryContract>
    deployer: SandboxContract<TreasuryContract>
    registry: SandboxContract<Registry>
    channelCode: Cell
    registryCode: Cell
    mockJWCode: Cell
}

let cachedCodes: { registry: Cell; channel: Cell; mock: Cell } | null = null

export async function compileAll(): Promise<{ registry: Cell; channel: Cell; mock: Cell }> {
    if (!cachedCodes) {
        const [registry, channel, mock] = await Promise.all([
            compile('Registry'),
            compile('Channel'),
            compile('MockJettonWallet'),
        ])
        cachedCodes = { registry, channel, mock }
    }
    return cachedCodes
}

export async function setupEnv(opts?: { now?: number }): Promise<Env> {
    const bc = await Blockchain.create()
    bc.now = opts?.now ?? 1_700_000_000

    const codes = await compileAll()

    const admin    = await bc.treasury('admin')
    const user     = await bc.treasury('user')
    const creator  = await bc.treasury('creator')
    const relayer  = await bc.treasury('relayer')
    const deployer = await bc.treasury('deployer')

    const registry = bc.openContract(Registry.createFromConfig(
        {
            admin: admin.address,
            protocolFeeBps: FEE_BPS,
            channelCode: codes.channel,
        },
        codes.registry,
    ))

    const r = await registry.sendDeploy(deployer.getSender(), toNano('1'))
    if (!r.transactions.every((t) => (t as any).description?.aborted !== true)) {
        // best-effort sanity
    }

    return {
        bc, admin, user, creator, relayer, deployer, registry,
        channelCode:  codes.channel,
        registryCode: codes.registry,
        mockJWCode:   codes.mock,
    }
}

export async function deployChannel(
    env: Env,
    opts?: {
        jettonMaster?: Address | null
        period?: number
        amount?: bigint
        relayerBounty?: bigint
    },
): Promise<SandboxContract<Channel>> {
    const jettonMaster  = opts?.jettonMaster ?? null
    const period        = opts?.period ?? PERIOD
    const amount        = opts?.amount ?? (jettonMaster ? AMOUNT_JETTON : AMOUNT_TON)
    const relayerBounty = opts?.relayerBounty
        ?? (jettonMaster ? RELAYER_BOUNTY_JETTON : RELAYER_BOUNTY_TON)

    await env.registry.sendDeployChannel(env.user.getSender(), {
        value: toNano('0.3'),
        creator: env.creator.address,
        jettonMaster,
        period,
        amount,
        relayerBounty,
    })

    const channelAddr = await env.registry.getChannelAddress(
        env.user.address, env.creator.address, jettonMaster,
    )
    return env.bc.openContract(Channel.createFromAddress(channelAddr))
}
