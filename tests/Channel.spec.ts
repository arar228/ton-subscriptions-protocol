import { toNano } from '@ton/core'
import '@ton/test-utils'

import { STATUS, ERR } from '../wrappers/constants'
import {
    setupEnv, deployChannel, Env,
    PERIOD, AMOUNT_TON, RELAYER_BOUNTY,
} from './helpers'
import { SandboxContract } from '@ton/sandbox'
import { Channel } from '../wrappers/Channel'

describe('SubscriptionChannel — TON mode', () => {
    let env: Env
    let channel: SandboxContract<Channel>

    beforeEach(async () => {
        env = await setupEnv()
        channel = await deployChannel(env)
    })

    // ─── Happy path ───────────────────────────────────────────────────
    it('initialises channel with ACTIVE status and zero vault', async () => {
        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.ACTIVE)
        expect(s.user.equals(env.user.address)).toBe(true)
        expect(s.creator.equals(env.creator.address)).toBe(true)
        expect(s.jettonMaster).toBeNull()
        expect(s.amountPerPeriod).toBe(AMOUNT_TON)
        expect(s.period).toBe(PERIOD)
        expect(s.vaultBalance).toBe(0n)
        expect(s.pendingCharge).toBe(0n)
    })

    it('accepts TON top-up and increases vault', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        const s = await channel.getSubscription()
        // gas немного отъедает, но vault должен быть близко к депозиту
        expect(s.vaultBalance).toBeGreaterThan(toNano('29.5'))
        expect(s.vaultBalance).toBeLessThanOrEqual(toNano('30'))
    })

    it('happy path: distributes 99.5% / 0.5% and pays relayer bounty', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        env.bc.now! += PERIOD + 10

        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))

        const expectedCreator = AMOUNT_TON * 9950n / 10000n
        const expectedAdmin   = AMOUNT_TON - expectedCreator

        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: env.creator.address,
            success: true,
            value: (v) => v !== undefined && v >= expectedCreator - toNano('0.001'),
        })
        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: env.admin.address,
            success: true,
            value: (v) => v !== undefined && v >= expectedAdmin - toNano('0.001'),
        })
        expect(r.transactions).toHaveTransaction({
            from: channel.address, to: env.relayer.address,
            success: true,
            value: (v) => v !== undefined && v >= RELAYER_BOUNTY - toNano('0.001'),
        })

        const s = await channel.getSubscription()
        expect(s.vaultBalance).toBeLessThanOrEqual(toNano('30') - AMOUNT_TON)
    })

    // ─── Negative: timing ─────────────────────────────────────────────
    it('rejects process_payment before nextBillingTs', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))
        expect(r.transactions).toHaveTransaction({
            from: env.relayer.address, to: channel.address,
            success: false, exitCode: ERR.NOT_TIME,
        })
    })

    it('rejects double process_payment in the same period', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        env.bc.now! += PERIOD + 10
        await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))

        const r2 = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))
        expect(r2.transactions).toHaveTransaction({
            success: false, exitCode: ERR.NOT_TIME,
        })
    })

    // ─── Negative: balance ────────────────────────────────────────────
    it('rejects process_payment with insufficient vault', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('5'))   // < 10
        env.bc.now! += PERIOD + 10
        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.INSUFFICIENT_VAULT,
        })
    })

    // ─── Pause / Resume ───────────────────────────────────────────────
    it('user pauses; status → PAUSED_BY_USER, remainder saved', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        env.bc.now! += 10 * 86400
        await channel.sendPause(env.user.getSender())

        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.PAUSED_BY_USER)
        expect(s.pausedRemainder).toBeGreaterThan(19 * 86400)
        expect(s.pausedRemainder).toBeLessThan(21 * 86400)
    })

    it('non-user cannot pause', async () => {
        const r = await channel.sendPause(env.creator.getSender())
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.NOT_USER,
        })
    })

    it('process_payment rejected while PAUSED_BY_USER', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        env.bc.now! += PERIOD + 10
        await channel.sendPause(env.user.getSender())
        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.PAUSED,
        })
    })

    it('resume preserves remainder; no instant charge after long pause', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        env.bc.now! += 10 * 86400
        await channel.sendPause(env.user.getSender())

        const sBefore = await channel.getSubscription()
        const remainder = sBefore.pausedRemainder

        // user держит на паузе 3 месяца
        env.bc.now! += 90 * 86400
        await channel.sendResume(env.user.getSender())

        const sAfter = await channel.getSubscription()
        expect(sAfter.status).toBe(STATUS.ACTIVE)
        expect(sAfter.nextBillingTs).toBe(env.bc.now! + remainder)

        // КРИТИЧНО: списание не должно стать сразу due
        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.NOT_TIME,
        })
    })

    it('top-up does NOT auto-resume PAUSED_BY_USER', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('5'))
        await channel.sendPause(env.user.getSender())
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.PAUSED_BY_USER)
    })

    it('cannot resume from non-paused state', async () => {
        const r = await channel.sendResume(env.user.getSender())
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.BAD_STATUS_FOR_RESUME,
        })
    })

    // ─── Cancel ───────────────────────────────────────────────────────
    it('user cancels and gets vault refund', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        const balBefore = await env.user.getBalance()

        await channel.sendCancel(env.user.getSender())
        const balAfter = await env.user.getBalance()
        // refund должен прийти; учитываем gas
        expect(balAfter - balBefore).toBeGreaterThan(toNano('29'))

        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.CANCELLED)
        expect(s.vaultBalance).toBe(0n)
    })

    it('non-user cannot cancel', async () => {
        const r = await channel.sendCancel(env.creator.getSender())
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.NOT_USER,
        })
    })

    it('cannot process_payment after cancel', async () => {
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        env.bc.now! += PERIOD + 10
        await channel.sendCancel(env.user.getSender())

        const r = await channel.sendProcessPayment(env.relayer.getSender(), toNano('0.3'))
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.PAUSED,
        })
    })

    // ─── is_due_for_payment getter ────────────────────────────────────
    it('is_due_for_payment reflects readiness correctly', async () => {
        expect(await channel.isDueForPayment()).toBe(false)
        await channel.sendTopUpTon(env.user.getSender(), toNano('30'))
        expect(await channel.isDueForPayment()).toBe(false)         // not yet time
        env.bc.now! += PERIOD + 10
        expect(await channel.isDueForPayment()).toBe(true)
    })
})
