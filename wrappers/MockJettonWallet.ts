import {
    Address, beginCell, Cell, Contract, contractAddress, ContractProvider,
    Sender, SendMode, toNano,
} from '@ton/core'
import { OP } from './constants'

export type MockJettonWalletConfig = {
    owner: Address
    forceBounce: boolean
}

export function mockJettonWalletConfigToCell(c: MockJettonWalletConfig): Cell {
    return beginCell()
        .storeAddress(c.owner)
        .storeUint(c.forceBounce ? 1 : 0, 8)
        .endCell()
}

export class MockJettonWallet implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromConfig(config: MockJettonWalletConfig, code: Cell, workchain = 0): MockJettonWallet {
        const data = mockJettonWalletConfigToCell(config)
        const init = { code, data }
        return new MockJettonWallet(contractAddress(workchain, init), init)
    }

    static createFromAddress(address: Address): MockJettonWallet {
        return new MockJettonWallet(address)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint = toNano('0.1')) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        })
    }

    async sendSetBounceMode(
        provider: ContractProvider, via: Sender,
        forceBounce: boolean, value: bigint = toNano('0.02'),
    ) {
        const body = beginCell()
            .storeUint(OP.TEST_SET_BOUNCE_MODE, 32)
            .storeUint(0, 64)
            .storeUint(forceBounce ? 1 : 0, 1)
            .endCell()
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    // Эмулирует доставку transfer_notification на target (channel) — как если бы
    // настоящий JW получил internal_transfer от чужого JW.
    async sendForceNotify(
        provider: ContractProvider, via: Sender,
        opts: {
            value: bigint
            target: Address
            jettonAmount: bigint
            from: Address
            forwardValue: bigint
        },
    ) {
        const body = beginCell()
            .storeUint(OP.TEST_FORCE_NOTIFY, 32)
            .storeUint(0, 64)
            .storeAddress(opts.target)
            .storeCoins(opts.jettonAmount)
            .storeAddress(opts.from)
            .storeCoins(opts.forwardValue)
            .endCell()
        await provider.internal(via, { value: opts.value, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    async getMockState(provider: ContractProvider): Promise<{ owner: Address; forceBounce: boolean }> {
        const r = await provider.get('get_mock_state', [])
        return {
            owner: r.stack.readAddress(),
            forceBounce: r.stack.readNumber() !== 0,
        }
    }
}
