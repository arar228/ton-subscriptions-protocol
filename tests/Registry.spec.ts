import { toNano } from '@ton/core'
import '@ton/test-utils'

import { ERR } from '../wrappers/constants'
import { setupEnv, Env, PERIOD, AMOUNT_TON, RELAYER_BOUNTY } from './helpers'

describe('SubscriptionRegistry', () => {
    let env: Env

    beforeEach(async () => {
        env = await setupEnv()
    })

    it('initial config matches deploy params', async () => {
        const c = await env.registry.getConfig()
        expect(c.admin.equals(env.admin.address)).toBe(true)
        expect(c.protocolFeeBps).toBe(50)
        expect(c.totalChannels).toBe(0)
    })

    it('admin can update config', async () => {
        const newAdmin = env.deployer.address
        await env.registry.sendUpdateConfig(env.admin.getSender(), {
            value: toNano('0.05'),
            newAdmin,
            newFeeBps: 100,
        })
        const c = await env.registry.getConfig()
        expect(c.admin.equals(newAdmin)).toBe(true)
        expect(c.protocolFeeBps).toBe(100)
    })

    it('non-admin cannot update config', async () => {
        const r = await env.registry.sendUpdateConfig(env.user.getSender(), {
            value: toNano('0.05'),
            newAdmin: env.user.address,
            newFeeBps: 100,
        })
        expect(r.transactions).toHaveTransaction({
            from: env.user.address, to: env.registry.address,
            success: false, exitCode: ERR.NOT_ADMIN,
        })
    })

    it('rejects period below MIN_PERIOD', async () => {
        const r = await env.registry.sendDeployChannel(env.user.getSender(), {
            value: toNano('0.3'),
            creator: env.creator.address,
            jettonMaster: null,
            period: 30,                       // < MIN_PERIOD (60s in dev build)
            amount: AMOUNT_TON,
            relayerBounty: RELAYER_BOUNTY,
        })
        expect(r.transactions).toHaveTransaction({
            from: env.user.address, to: env.registry.address,
            success: false, exitCode: ERR.PERIOD_TOO_LOW,
        })
    })

    it('rejects period above MAX_PERIOD', async () => {
        const r = await env.registry.sendDeployChannel(env.user.getSender(), {
            value: toNano('0.3'),
            creator: env.creator.address,
            jettonMaster: null,
            period: 366 * 86400,
            amount: AMOUNT_TON,
            relayerBounty: RELAYER_BOUNTY,
        })
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.PERIOD_TOO_HIGH,
        })
    })

    it('rejects amount = 0', async () => {
        const r = await env.registry.sendDeployChannel(env.user.getSender(), {
            value: toNano('0.3'),
            creator: env.creator.address,
            jettonMaster: null,
            period: PERIOD,
            amount: 0n,
            relayerBounty: RELAYER_BOUNTY,
        })
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.AMOUNT_ZERO,
        })
    })

    it('rejects bounty below minimum', async () => {
        const r = await env.registry.sendDeployChannel(env.user.getSender(), {
            value: toNano('0.3'),
            creator: env.creator.address,
            jettonMaster: null,
            period: PERIOD,
            amount: AMOUNT_TON,
            relayerBounty: 1n,
        })
        expect(r.transactions).toHaveTransaction({
            success: false, exitCode: ERR.BOUNTY_TOO_LOW,
        })
    })

    it('get_channel_address is deterministic — same params = same address', async () => {
        const a = await env.registry.getChannelAddress(env.user.address, env.creator.address, null)
        const b = await env.registry.getChannelAddress(env.user.address, env.creator.address, null)
        expect(a.equals(b)).toBe(true)
    })

    it('counts deployed channels', async () => {
        await env.registry.sendDeployChannel(env.user.getSender(), {
            value: toNano('0.3'),
            creator: env.creator.address,
            jettonMaster: null,
            period: PERIOD,
            amount: AMOUNT_TON,
            relayerBounty: RELAYER_BOUNTY,
        })
        const c = await env.registry.getConfig()
        expect(c.totalChannels).toBe(1)
    })
})
