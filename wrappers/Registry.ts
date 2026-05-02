import {
    Address, beginCell, Cell, Contract, contractAddress, ContractProvider,
    Sender, SendMode, toNano,
} from '@ton/core'
import { OP } from './constants'

export type RegistryConfig = {
    admin: Address
    protocolFeeBps: number
    channelCode: Cell
}

export function registryConfigToCell(c: RegistryConfig): Cell {
    return beginCell()
        .storeAddress(c.admin)
        .storeUint(c.protocolFeeBps, 16)
        .storeRef(c.channelCode)
        .storeUint(0, 32)            // totalChannels
        .endCell()
}

export class Registry implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(config: RegistryConfig, code: Cell, workchain = 0): Registry {
        const data = registryConfigToCell(config)
        const init = { code, data }
        return new Registry(contractAddress(workchain, init), init)
    }

    static createFromAddress(address: Address): Registry {
        return new Registry(address)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint = toNano('0.5')) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        })
    }

    async sendDeployChannel(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            queryId?: bigint
            creator: Address
            jettonMaster: Address | null
            period: number
            amount: bigint
            relayerBounty: bigint
        },
    ) {
        const body = beginCell()
            .storeUint(OP.DEPLOY_CHANNEL, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeAddress(opts.creator)
            .storeAddress(opts.jettonMaster)         // null → addr_none
            .storeUint(opts.period, 32)
            .storeCoins(opts.amount)
            .storeCoins(opts.relayerBounty)
            .endCell()

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        })
    }

    async sendUpdateConfig(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            queryId?: bigint
            newAdmin: Address
            newFeeBps: number
        },
    ) {
        const body = beginCell()
            .storeUint(OP.UPDATE_CONFIG, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeAddress(opts.newAdmin)
            .storeUint(opts.newFeeBps, 16)
            .endCell()

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        })
    }

    async getConfig(provider: ContractProvider): Promise<{
        admin: Address
        protocolFeeBps: number
        totalChannels: number
    }> {
        const r = await provider.get('get_config', [])
        return {
            admin: r.stack.readAddress(),
            protocolFeeBps: r.stack.readNumber(),
            totalChannels: r.stack.readNumber(),
        }
    }

    async getChannelAddress(
        provider: ContractProvider,
        user: Address,
        creator: Address,
        jettonMaster: Address | null,
    ): Promise<Address> {
        const r = await provider.get('get_channel_address', [
            { type: 'slice', cell: beginCell().storeAddress(user).endCell() },
            { type: 'slice', cell: beginCell().storeAddress(creator).endCell() },
            { type: 'slice', cell: beginCell().storeAddress(jettonMaster).endCell() },
        ])
        return r.stack.readAddress()
    }
}
