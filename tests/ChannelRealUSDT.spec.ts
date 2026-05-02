import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { compile } from '@ton/blueprint'
import '@ton/test-utils'

import { OP, STATUS } from '../wrappers/constants'
import { Registry } from '../wrappers/Registry'
import { Channel } from '../wrappers/Channel'
import { JettonMinter, jettonContentToCell } from '../contracts/jetton-tether/wrappers/JettonMinter'
import { JettonWallet } from '../contracts/jetton-tether/wrappers/JettonWallet'

// Patched mint: overshoot value (2 TON) so action phase has reserves for both
// internal_transfer (total_ton_amount=1) and storage/forward fees.
async function mintUSDT(
    via: SandboxContract<TreasuryContract>,
    minterAddr: Address,
    to: Address,
    jettonAmount: bigint,
) {
    return via.send({
        to: minterAddr,
        value: toNano('2'),
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        body: JettonMinter.mintMessage(to, jettonAmount, null, null, null, toNano('0.05'), toNano('1')),
    })
}

// =============================================================================
// REAL USDT INTEGRATION — против настоящего Tether (stablecoin-contract).
// Hash минтера 18d5b6e7… совпадает с production USDT на TON mainnet.
// Эти тесты — последний gate перед mainnet deploy: подтверждают, что наш
// SubscriptionChannel совместим с реальным TEP-74-кошельком от Tether.
// =============================================================================

const USDT_DECIMALS = 6n
const USDT = (n: number) => BigInt(Math.round(n * 1_000_000)) // n USDT → min units

describe('SubscriptionChannel — REAL USDT (Tether stablecoin-contract)', () => {
    let bc: Blockchain
    let admin:    SandboxContract<TreasuryContract>     // protocol admin
    let user:     SandboxContract<TreasuryContract>
    let creator:  SandboxContract<TreasuryContract>
    let relayer:  SandboxContract<TreasuryContract>
    let deployer: SandboxContract<TreasuryContract>
    let usdtAdmin: SandboxContract<TreasuryContract>    // USDT minter admin

    let registry: SandboxContract<Registry>
    let usdt:     SandboxContract<JettonMinter>
    let channel:  SandboxContract<Channel>

    let codes: { registry: Cell; channel: Cell; tetherMinter: Cell; tetherWallet: Cell }

    const PERIOD = 30 * 86400
    const SUB_AMOUNT = USDT(10)        // 10 USDT / month
    const FEE_BPS = 50                  // 0.5%

    beforeAll(async () => {
        const [registryCode, channelCode, tetherMinter, tetherWallet] = await Promise.all([
            compile('Registry'),
            compile('Channel'),
            compile('TetherMinter'),
            compile('TetherWallet'),
        ])
        codes = { registry: registryCode, channel: channelCode, tetherMinter, tetherWallet }
    }, 60_000)

    beforeEach(async () => {
        bc = await Blockchain.create()
        bc.now = 1_700_000_000

        admin     = await bc.treasury('admin')
        user      = await bc.treasury('user')
        creator   = await bc.treasury('creator')
        relayer   = await bc.treasury('relayer')
        deployer  = await bc.treasury('deployer')
        usdtAdmin = await bc.treasury('usdt-admin')

        // ─── Deploy real USDT minter ─────────────────────────────────────
        usdt = bc.openContract(JettonMinter.createFromConfig(
            {
                admin: usdtAdmin.address,
                wallet_code: codes.tetherWallet,
                jetton_content: jettonContentToCell({ uri: 'https://tether.to/usdt-ton.json' }),
            },
            codes.tetherMinter,
        ))
        await usdt.sendDeploy(usdtAdmin.getSender(), toNano('1'))

        // ─── Mint USDT для user'а ────────────────────────────────────────
        await mintUSDT(usdtAdmin, usdt.address, user.address, USDT(1000))

        // ─── Deploy SubscriptionRegistry ─────────────────────────────────
        registry = bc.openContract(Registry.createFromConfig(
            { admin: admin.address, protocolFeeBps: FEE_BPS, channelCode: codes.channel },
            codes.registry,
        ))
        await registry.sendDeploy(deployer.getSender(), toNano('1'))

        // ─── Deploy SubscriptionChannel через Registry (jetton-mode) ────
        await registry.sendDeployChannel(user.getSender(), {
            value: toNano('0.5'),
            creator: creator.address,
            jettonMaster: usdt.address,
            period: PERIOD,
            amount: SUB_AMOUNT,
            relayerBounty: toNano('0.12'),
        })

        const channelAddr = await registry.getChannelAddress(
            user.address, creator.address, usdt.address,
        )
        channel = bc.openContract(Channel.createFromAddress(channelAddr))
    })

    // helper: получить адрес jetton-wallet'а кого-либо
    const jwOf = async (owner: Address) => usdt.getWalletAddress(owner)
    // helper: текущий jetton-balance кого-либо (0 если wallet не задеплоен)
    const balanceOf = async (owner: Address): Promise<bigint> => {
        const jwAddr = await jwOf(owner)
        const jw = bc.openContract(JettonWallet.createFromAddress(jwAddr))
        return jw.getJettonBalance()
    }

    // ── 1. User шлёт реальный jetton transfer на channel ─────────────
    it('TOFU bind: real USDT transfer from user → channel binds correct jetton_wallet', async () => {
        const userJwAddr = await jwOf(user.address)
        const userJw = bc.openContract(JettonWallet.createFromAddress(userJwAddr))

        const userBalanceBefore = await userJw.getJettonBalance()
        expect(userBalanceBefore).toBe(USDT(1000))

        // user → user_jw → channel_jw → notify(channel)
        await userJw.sendTransfer(user.getSender(),
            toNano('0.3'),                    // gas
            USDT(30),                          // 30 USDT (3 месяца аванса)
            channel.address,
            user.address,                      // response_destination
            null,
            toNano('0.05'),                    // forward_ton_amount (ENOUGH чтобы notify дошло)
            null,                              // empty forward_payload
        )

        // channel должен забиндить свой channel_jw_address
        const expectedChannelJw = await jwOf(channel.address)
        const boundJw = await channel.getJettonWallet()
        expect(boundJw).not.toBeNull()
        expect(boundJw!.equals(expectedChannelJw)).toBe(true)

        // vault содержит зачисленные USDT
        const s = await channel.getSubscription()
        expect(s.vaultBalance).toBe(USDT(30))
        expect(s.status).toBe(STATUS.ACTIVE)

        // user'у потратилось 30 USDT
        expect(await userJw.getJettonBalance()).toBe(USDT(1000) - USDT(30))
    })

    // ── 2. Полный жизненный цикл: deposit → charge → distribute ──────
    it('happy path: real charge — creator gets 99.5%, admin gets 0.5%', async () => {
        const userJwAddr = await jwOf(user.address)
        const userJw = bc.openContract(JettonWallet.createFromAddress(userJwAddr))

        // user депонирует 30 USDT
        await userJw.sendTransfer(user.getSender(),
            toNano('0.3'), USDT(30), channel.address, user.address,
            null, toNano('0.05'), null,
        )

        const sBefore = await channel.getSubscription()
        expect(sBefore.vaultBalance).toBe(USDT(30))

        // время прошло
        bc.now! += PERIOD + 10

        // запоминаем балансы получателей ДО списания
        const creatorBalBefore = await balanceOf(creator.address)
        const adminBalBefore   = await balanceOf(admin.address)

        // релейер триггерит process_payment
        const r = await channel.sendProcessPayment(relayer.getSender(), toNano('0.5'))

        // проверяем что транзакции до channel_jw УСПЕШНЫ
        const channelJwAddr = await jwOf(channel.address)
        expect(r.transactions).toHaveTransaction({
            from: channel.address,
            to: channelJwAddr,
            success: true,
            op: OP.JETTON_TRANSFER,
        })

        // финальные балансы
        const creatorBalAfter = await balanceOf(creator.address)
        const adminBalAfter   = await balanceOf(admin.address)

        const expectedCreatorCut = SUB_AMOUNT * 9950n / 10000n
        const expectedAdminCut   = SUB_AMOUNT - expectedCreatorCut

        expect(creatorBalAfter - creatorBalBefore).toBe(expectedCreatorCut)
        expect(adminBalAfter   - adminBalBefore  ).toBe(expectedAdminCut)
        expect(expectedCreatorCut).toBe(USDT(9.95))
        expect(expectedAdminCut  ).toBe(USDT(0.05))

        // vault уменьшился на полную сумму
        const sAfter = await channel.getSubscription()
        expect(sAfter.vaultBalance).toBe(USDT(30) - SUB_AMOUNT)
        expect(sAfter.pendingCharge).toBe(0n)        // excesses пришли, флаг очищен
        expect(sAfter.status).toBe(STATUS.ACTIVE)
        expect(sAfter.nextBillingTs).toBe(sBefore.nextBillingTs + PERIOD)
    })

    // ── 3. Релейер получает bounty ───────────────────────────────────
    it('relayer earns bounty after successful real-USDT charge', async () => {
        const userJwAddr = await jwOf(user.address)
        const userJw = bc.openContract(JettonWallet.createFromAddress(userJwAddr))
        await userJw.sendTransfer(user.getSender(),
            toNano('0.3'), USDT(30), channel.address, user.address,
            null, toNano('0.05'), null,
        )

        bc.now! += PERIOD + 10
        const r = await channel.sendProcessPayment(relayer.getSender(), toNano('0.3'))

        expect(r.transactions).toHaveTransaction({
            from: channel.address,
            to: relayer.address,
            success: true,
            // bounty = 0.12 TON (jetton mode default), минус мелкий вычет
            value: (v) => v !== undefined && v >= toNano('0.11'),
        })
    })

    // ── 4. Cancel возвращает USDT user'у ─────────────────────────────
    it('cancel during paused state refunds vault as real USDT to user', async () => {
        const userJwAddr = await jwOf(user.address)
        const userJw = bc.openContract(JettonWallet.createFromAddress(userJwAddr))
        await userJw.sendTransfer(user.getSender(),
            toNano('0.3'), USDT(30), channel.address, user.address,
            null, toNano('0.05'), null,
        )

        const userBalBefore = await userJw.getJettonBalance()

        await channel.sendCancel(user.getSender(), toNano('0.3'))

        const s = await channel.getSubscription()
        expect(s.status).toBe(STATUS.CANCELLED)
        expect(s.vaultBalance).toBe(0n)

        const userBalAfter = await userJw.getJettonBalance()
        expect(userBalAfter - userBalBefore).toBe(USDT(30))   // refund equals deposit
    })
})
