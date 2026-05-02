import {
    Address, beginCell, Cell, Contract, ContractProvider,
    Sender, SendMode, toNano,
} from '@ton/core'
import { OP } from './constants'

export type ChannelSubscription = {
    status: number
    user: Address
    creator: Address
    jettonMaster: Address | null
    period: number
    amountPerPeriod: bigint
    nextBillingTs: number
    pausedRemainder: number
    vaultBalance: bigint
    pendingCharge: bigint
    protocolFeeBps: number
}

export class Channel implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address): Channel {
        return new Channel(address)
    }

    // ─── Top-up ───────────────────────────────────────────────────────
    async sendTopUpTon(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint = 0n,
    ) {
        const body = beginCell()
            .storeUint(OP.TOP_UP_TON, 32)
            .storeUint(queryId, 64)
            .endCell()
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        })
    }

    // ─── Process payment ──────────────────────────────────────────────
    async sendProcessPayment(
        provider: ContractProvider,
        via: Sender,
        value: bigint = toNano('0.3'),
        queryId: bigint = 0n,
    ) {
        const body = beginCell()
            .storeUint(OP.PROCESS_PAYMENT, 32)
            .storeUint(queryId, 64)
            .endCell()
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        })
    }

    // ─── Pause / Resume / Cancel ──────────────────────────────────────
    async sendPause(
        provider: ContractProvider, via: Sender,
        value: bigint = toNano('0.05'), queryId: bigint = 0n,
    ) {
        const body = beginCell()
            .storeUint(OP.PAUSE_SUBSCRIPTION, 32)
            .storeUint(queryId, 64)
            .endCell()
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    async sendResume(
        provider: ContractProvider, via: Sender,
        value: bigint = toNano('0.05'), queryId: bigint = 0n,
    ) {
        const body = beginCell()
            .storeUint(OP.RESUME_SUBSCRIPTION, 32)
            .storeUint(queryId, 64)
            .endCell()
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    async sendCancel(
        provider: ContractProvider, via: Sender,
        value: bigint = toNano('0.05'), queryId: bigint = 0n,
    ) {
        const body = beginCell()
            .storeUint(OP.CANCEL_SUBSCRIPTION, 32)
            .storeUint(queryId, 64)
            .endCell()
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    // ─── Jetton: симуляция notify (для тестов) ────────────────────────
    // В реальности jetton_wallet шлёт notify сам. В sandbox-тесте мы просто
    // отправляем notify напрямую от мокового sender'а (который должен совпасть
    // с jettonWallet канала, см. mock в тестах).
    async sendJettonTransferNotify(
        provider: ContractProvider, via: Sender,
        opts: {
            value: bigint
            jettonAmount: bigint
            from: Address
            queryId?: bigint
        },
    ) {
        const body = beginCell()
            .storeUint(OP.JETTON_TRANSFER_NOTIFY, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeCoins(opts.jettonAmount)
            .storeAddress(opts.from)
            .storeUint(0, 1)             // empty forward_payload
            .endCell()
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        })
    }

    // ─── Get-методы ───────────────────────────────────────────────────
    async getSubscription(provider: ContractProvider): Promise<ChannelSubscription> {
        const r = await provider.get('get_subscription_data', [])
        const status          = r.stack.readNumber()
        const user            = r.stack.readAddress()
        const creator         = r.stack.readAddress()
        const jettonMasterRaw = r.stack.readAddressOpt()
        const period          = r.stack.readNumber()
        const amountPerPeriod = r.stack.readBigNumber()
        const nextBillingTs   = r.stack.readNumber()
        const pausedRemainder = r.stack.readNumber()
        const vaultBalance    = r.stack.readBigNumber()
        const pendingCharge   = r.stack.readBigNumber()
        const protocolFeeBps  = r.stack.readNumber()
        return {
            status, user, creator,
            jettonMaster: jettonMasterRaw,
            period, amountPerPeriod,
            nextBillingTs, pausedRemainder,
            vaultBalance, pendingCharge, protocolFeeBps,
        }
    }

    async getJettonWallet(provider: ContractProvider): Promise<Address | null> {
        const r = await provider.get('get_jetton_wallet', [])
        return r.stack.readAddressOpt()
    }

    async isDueForPayment(provider: ContractProvider): Promise<boolean> {
        const r = await provider.get('is_due_for_payment', [])
        return r.stack.readNumber() !== 0
    }
}
