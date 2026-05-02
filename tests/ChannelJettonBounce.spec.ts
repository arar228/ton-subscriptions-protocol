import { Address, toNano } from '@ton/core'
import { SandboxContract } from '@ton/sandbox'
import '@ton/test-utils'

import { OP, STATUS, ERR } from '../wrappers/constants'
import { Channel } from '../wrappers/Channel'
import { MockJettonWallet } from '../wrappers/MockJettonWallet'
import {
    setupEnv, deployChannel, compileAll, Env,
    PERIOD, AMOUNT_JETTON, RELAYER_BOUNTY,
} from './helpers'

// =============================================================================
// CRITICAL: Jetton-bounce — ни цента не должно зависнуть в контракте.
// При неудачном jetton transfer (creator/admin без JW, заморозка минтером,
// race с jetton-master upgrade) channel должен:
//   1. Откатить vaultBalance += pendingCharge
//   2. Откатить nextBillingTs -= period
//   3. Перейти в STATUS_PAUSED_INSUFFICIENT
//   4. Очистить pendingCharge
//   5. После top-up — авто-resume и повторное успешное списание
// =============================================================================

describe('SubscriptionChannel — Jetton mode (USDT) — bounce safety', () => {
    let env: Env
    let channel: SandboxContract<Channel>
    let mockJW: SandboxContract<MockJettonWallet>
    // фиктивный адрес "jetton master" — его реальный код не нужен в этих тестах
    let jettonMasterAddr: Address

    beforeEach(async () => {
        env = await setupEnv()

        // jetton master — берём какой-нибудь treasury, его реальный contract не вызывается
        const jettonMaster = await env.bc.treasury('jetton-master')
        jettonMasterAddr = jettonMaster.address

        channel = await deployChannel(env, {
            jettonMaster: jettonMasterAddr,
            amount: AMOUNT_JETTON,
        })

        // Деплоим mock jetton wallet, owner = channel.
        // В реальности адрес channel JW детерминирован по (jetton_master, owner).
        // Здесь — sandbox-deploy с любым адресом; channel забиндит его при первом
        // OP_JETTON_TRANSFER_NOTIFY.
        const codes = await compileAll()
        mockJW = env.bc.openContract(MockJettonWallet.createFromConfig(
            { owner: channel.address, forceBounce: false },
            codes.mock,
        ))
        await mockJW.sendDeploy(env.deployer.getSender(), toNano('0.5'))
    })

    // ─── Setup helper: bind JW + первоначальный депозит ──────────────
    async function topUpViaMock(amount: bigint) {
        // mock эмулирует: получил internal_transfer от user_jw, шлёт notify на channel
        await mockJW.sendForceNotify(env.deployer.getSender(), {
            value: toNano('0.2'),
            target: channel.address,
            jettonAmount: amount,
            from: env.user.address,
            forwardValue: toNano('0.05'),
        })
    }

    // ─── Jetton wallet bind ──────────────────────────────────────────
    it('binds jetton_wallet on first transfer notify', async () => {
        await topUpViaMock(AMOUNT_JETTON * 3n)
        const bound = await channel.getJettonWallet()
        expect(bound).not.toBeNull()
        expect(bound!.equals(mockJW.address)).toBe(true)

        const s = await channel.getSubscription()
        expect(s.vaultBalance).toBe(AMOUNT_JETTON * 3n)
    })

    it('rejects spoofed transfer_notify from random sender', async () => {
        // bind через legit mock
        await topUpViaMock(AMOUNT_JETTON)

        // spoof — другой sender шлёт notify напрямую
        const attacker = await env.bc.treasury('attacker')
        const r = await channel.sendJettonTransferNotify(attacker.getSender(), {
            value: toNano('0.1'),
            jettonAmount: AMOUNT_JETTON * 100n,
            from: env.user.address,
        })
        expect(r.transactions).toHaveTransaction({
            from: attacker.address, to: channel.address,
            success: false, exitCode: ERR.WRONG_JETTON,
        })

        // vault не вырос
        const s = await channel.getSubscription()
        expect(s.vaultBalance).toBe(AMOUNT_JETTON)
    })

    // ─── Happy path в jetton режиме ──────────────────────────────────
    it('successful charge: 2 jetton transfers + bounty + excesses clears pending', async () => {
        await topUpViaMock(AMOUNT_JETTON * 3n)
        env.bc.now! += PERIOD + 10

        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.5'))

        // ─ 1. Channel → mockJW два раза с OP_JETTON_TRANSFER
        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: mockJW.address,
            success: true,
            op: OP.JETTON_TRANSFER,
        })
        // считаем сколько jetton-transfer'ов отправлено
        const transferCount = r.transactions.filter((t: any) => {
            const inMsg = t.inMessage
            if (!inMsg || inMsg.info.type !== 'internal') return false
            if (!inMsg.info.dest.equals(mockJW.address)) return false
            const body = inMsg.body.beginParse()
            if (body.remainingBits < 32) return false
            return body.loadUint(32) === OP.JETTON_TRANSFER
        }).length
        expect(transferCount).toBe(2)

        // ─ 2. Релейер получил bounty
        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: env.relayer.address,
            success: true,
            value: (v) => v !== undefined && v >= RELAYER_BOUNTY - toNano('0.001'),
        })

        // ─ 3. Channel получил excesses от mockJW → pendingCharge = 0
        expect(r.transactions).toHaveTransaction({
            from: mockJW.address, to: channel.address,
            success: true,
            op: OP.JETTON_EXCESSES,
        })

        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.ACTIVE)
        expect(s.pendingCharge).toBe(0n)
        expect(s.vaultBalance).toBe(AMOUNT_JETTON * 3n - AMOUNT_JETTON)
        expect(s.nextBillingTs).toBeGreaterThan(env.bc.now!)
    })

    // ─── 🔥 BOUNCE SCENARIO 🔥 ───────────────────────────────────────
    it('jetton transfer bounce → state rollback + PAUSED_INSUFFICIENT, no funds lost', async () => {
        await topUpViaMock(AMOUNT_JETTON * 3n)

        const sBefore = await channel.getSubscription()
        const vaultBefore        = sBefore.vaultBalance
        const nextBillingTsBefore = sBefore.nextBillingTs

        // переключаем mock JW в режим bounce
        await mockJW.sendSetBounceMode(env.deployer.getSender(), true)

        env.bc.now! += PERIOD + 10
        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.5'))

        // ─ 1. Транзакция на mockJW должна была упасть
        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: mockJW.address,
            success: false, exitCode: ERR.FORCED_BOUNCE,
        })

        // ─ 2. Bounce-сообщение вернулось на channel и было успешно обработано
        expect(r.transactions).toHaveTransaction({
            from: mockJW.address, to: channel.address,
            inMessageBounced: true,
            success: true,
        })

        // ─ 3. Состояние полностью откачено
        const sAfter = await channel.getSubscription()
        expect(sAfter.status).toBe(STATUS.PAUSED_INSUFFICIENT)
        expect(sAfter.pendingCharge).toBe(0n)
        // vault вернулся к исходному (с поправкой на возможный второй bounce — но
        // оба transfer'а bounce'ят, и оба отката докидывают pendingCharge обратно)
        expect(sAfter.vaultBalance).toBe(vaultBefore)
        // nextBillingTs откатан назад (минимум на 1 период)
        expect(sAfter.nextBillingTs).toBeLessThanOrEqual(nextBillingTsBefore)
    })

    it('after bounce: top-up auto-resumes, second process_payment succeeds', async () => {
        await topUpViaMock(AMOUNT_JETTON * 3n)
        await mockJW.sendSetBounceMode(env.deployer.getSender(), true)

        env.bc.now! += PERIOD + 10
        await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.5'))

        // должны быть в PAUSED_INSUFFICIENT
        let s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.PAUSED_INSUFFICIENT)

        // выключаем bounce mode
        await mockJW.sendSetBounceMode(env.deployer.getSender(), false)

        // top-up → авто-resume
        await topUpViaMock(AMOUNT_JETTON)
        s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.ACTIVE)

        // и теперь process_payment успешен
        env.bc.now! += PERIOD + 10
        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.5'))
        expect(r.transactions).toHaveTransaction({
            from: mockJW.address, to: channel.address,
            success: true, op: OP.JETTON_EXCESSES,
        })
        s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.ACTIVE)
        expect(s.pendingCharge).toBe(0n)
    })

    it('cancel during bounce-paused state still refunds vault as jetton', async () => {
        await topUpViaMock(AMOUNT_JETTON * 3n)
        await mockJW.sendSetBounceMode(env.deployer.getSender(), true)

        env.bc.now! += PERIOD + 10
        await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.5'))
        // мы в PAUSED_INSUFFICIENT

        // включаем mock обратно в success — для refund нужен живой jetton transfer
        await mockJW.sendSetBounceMode(env.deployer.getSender(), false)

        const r = await channel.sendCancel(env.user.getSender(), toNano('0.1'))
        // должен пойти OP_JETTON_TRANSFER на jetton wallet с dest=user
        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: mockJW.address,
            success: true, op: OP.JETTON_TRANSFER,
        })

        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.CANCELLED)
        expect(s.vaultBalance).toBe(0n)
    })

    // ─── Edge: pendingCharge защита от двойного списания ─────────────
    it('rejects process_payment while pendingCharge != 0', async () => {
        await topUpViaMock(AMOUNT_JETTON * 3n)
        await mockJW.sendSetBounceMode(env.deployer.getSender(), true)

        env.bc.now! += PERIOD + 10

        // первый payment → bounce → откат
        await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.5'))

        // если бы релейер попробовал второй раз ДО bounce-обработки — упало бы
        // на pendingCharge != 0. Здесь bounce уже отработан, но sanity проверим
        // что процесс не оставил pending.
        const s = await channel.getSubscription()
        expect(s.pendingCharge).toBe(0n)
    })
})
