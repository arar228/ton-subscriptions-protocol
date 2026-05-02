tolk 1.3

// =============================================================================
// SubscriptionChannel — Vault контракт для пары (user ↔ creator).
// Хранит депозит, отслеживает next_billing_timestamp, обрабатывает списания
// от релейера, паузу/возобновление пользователем и cancel с возвратом.
// =============================================================================

// ─── Op codes ──────────────────────────────────────────────────────────────
const OP_DEPLOY_CHANNEL:           int = 0x73d09313;
const OP_PROCESS_PAYMENT:          int = 0x70617970;
const OP_CANCEL_SUBSCRIPTION:      int = 0x636e6c00;
const OP_TOP_UP_TON:               int = 0x74705f74;
const OP_PAUSE_SUBSCRIPTION:       int = 0x70617573;
const OP_RESUME_SUBSCRIPTION:      int = 0x72736d65;

const OP_JETTON_TRANSFER:          int = 0x0f8a7ea5;
const OP_JETTON_TRANSFER_NOTIFY:   int = 0x7362d09c;
const OP_JETTON_EXCESSES:          int = 0xd53276db;

// ─── Errors ────────────────────────────────────────────────────────────────
const ERR_NOT_REGISTRY:            int = 400;
const ERR_NOT_USER:                int = 401;
const ERR_NOT_TIME:                int = 403;
const ERR_INSUFFICIENT_VAULT:      int = 404;
const ERR_PAUSED:                  int = 405;
const ERR_CANCELLED:               int = 406;
const ERR_NOT_INITIALIZED:         int = 407;
const ERR_ALREADY_INITIALIZED:     int = 408;
const ERR_PENDING_CHARGE:          int = 409;
const ERR_WRONG_JETTON:            int = 411;
const ERR_BAD_STATUS_FOR_PAUSE:    int = 420;
const ERR_BAD_STATUS_FOR_RESUME:   int = 421;
const ERR_UNKNOWN_OP:              int = 0xffff;

// ─── Status ────────────────────────────────────────────────────────────────
const STATUS_UNINIT:               int = 0;
const STATUS_ACTIVE:               int = 1;
const STATUS_PAUSED_INSUFFICIENT:  int = 2;
const STATUS_PAUSED_BY_USER:       int = 3;
const STATUS_CANCELLED:            int = 4;

const BPS_DENOM:                   int = 10000;
const JETTON_TRANSFER_GAS:         int = 50000000;     // 0.05 TON

// =============================================================================
// Storage — split на 3 cell'а (root + 2 ref'а)
// =============================================================================
struct ChannelIdentity {
    registry: address;
    user: address;
    creator: address;
}

struct ChannelConfig {
    admin: address?;              // null до init
    protocolFeeBps: uint16;
    period: uint32;
    amountPerPeriod: coins;
    relayerBounty: coins;
}

struct ChannelStorage {
    status: uint8;
    identity: Cell<ChannelIdentity>;
    config: Cell<ChannelConfig>;
    jettonMaster: address?;       // null = TON режим (в root для hot-path access)
    nextBillingTs: uint32;
    pausedRemainder: uint32;
    vaultBalance: coins;
    pendingCharge: coins;
    jettonWallet: address?;       // bound при первой Jetton-нотификации
}

fun loadStorage(): ChannelStorage {
    return ChannelStorage.fromCell(contract.getData());
}

fun saveStorage(st: ChannelStorage): void {
    contract.setData(st.toCell());
}

// =============================================================================
// Helpers
// =============================================================================

fun buildJettonTransferBody(amount: coins, dest: address, responseDest: address,
                            fwdAmount: coins, queryId: int): cell {
    return beginCell()
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(dest)
        .storeAddress(responseDest)
        .storeUint(0, 1)              // null custom_payload
        .storeCoins(fwdAmount)
        .storeUint(0, 1)              // empty forward_payload (inline)
        .endCell();
}

// =============================================================================
// Bounce handler — компенсирует неудавшийся jetton-transfer
// =============================================================================
fun onBouncedMessage(in: InMessageBounced) {
    var body = in.bouncedBody;
    body.skipBouncedPrefix();
    if (body.remainingBitsCount() < 32) {
        return;
    }
    val op = body.loadUint(32);
    var st = loadStorage();
    val cfg = st.config.load();

    if (op == OP_JETTON_TRANSFER) {
        if (st.pendingCharge > 0) {
            st.vaultBalance += st.pendingCharge;
            st.pendingCharge = 0;
            st.nextBillingTs = (st.nextBillingTs - cfg.period) as uint32;
            st.status = STATUS_PAUSED_INSUFFICIENT as uint8;
            saveStorage(st);
        }
        return;
    }

    // bounce TON-перевода creator/admin: пауза
    if (st.status == STATUS_ACTIVE) {
        st.status = STATUS_PAUSED_INSUFFICIENT as uint8;
        saveStorage(st);
    }
}

// =============================================================================
// Entry
// =============================================================================
fun onInternalMessage(in: InMessage) {
    var body = in.body;

    // bare TON transfer = top-up для TON-канала
    if (body.remainingBitsCount() < 32) {
        var st0 = loadStorage();
        val id0 = st0.identity.load();
        if (st0.status == STATUS_ACTIVE && st0.jettonMaster == null) {
            st0.vaultBalance += in.valueCoins;
            saveStorage(st0);
        }
        return;
    }

    val op = body.loadUint(32);
    val queryId = body.loadUint(64);
    val sender = in.senderAddress;
    var st = loadStorage();
    val identity = st.identity.load();

    // ─── 1. INIT (от Registry) ────────────────────────────────────────
    if (op == OP_DEPLOY_CHANNEL) {
        assert(st.status == STATUS_UNINIT, ERR_ALREADY_INITIALIZED);
        assert(sender == identity.registry, ERR_NOT_REGISTRY);

        val newConfig: ChannelConfig = {
            admin: body.loadAddress(),
            protocolFeeBps: body.loadUint(16) as uint16,
            period: body.loadUint(32) as uint32,
            amountPerPeriod: body.loadCoins(),
            relayerBounty: body.loadCoins(),
        };
        st.config = newConfig.toCell();
        st.nextBillingTs   = (blockchain.now() + newConfig.period) as uint32;
        st.pausedRemainder = 0;
        st.vaultBalance    = 0;
        st.pendingCharge   = 0;
        st.jettonWallet    = null;
        st.status          = STATUS_ACTIVE as uint8;
        saveStorage(st);
        return;
    }

    assert(st.status != STATUS_UNINIT, ERR_NOT_INITIALIZED);

    // ─── 2. Top-up (TON) ──────────────────────────────────────────────
    if (op == OP_TOP_UP_TON) {
        assert(st.jettonMaster == null, ERR_WRONG_JETTON);
        st.vaultBalance += in.valueCoins;
        val cfg = st.config.load();
        if (st.status == STATUS_PAUSED_INSUFFICIENT && st.vaultBalance >= cfg.amountPerPeriod) {
            st.status = STATUS_ACTIVE as uint8;
        }
        saveStorage(st);
        return;
    }

    // ─── 3. Top-up (Jetton notify от channel-jw) ─────────────────────
    if (op == OP_JETTON_TRANSFER_NOTIFY) {
        assert(st.jettonMaster != null, ERR_WRONG_JETTON);
        val amount = body.loadCoins();
        if (st.jettonWallet == null) {
            st.jettonWallet = sender;
        } else {
            assert(sender == st.jettonWallet!, ERR_WRONG_JETTON);
        }
        st.vaultBalance += amount;
        val cfg = st.config.load();
        if (st.status == STATUS_PAUSED_INSUFFICIENT && st.vaultBalance >= cfg.amountPerPeriod) {
            st.status = STATUS_ACTIVE as uint8;
        }
        saveStorage(st);
        return;
    }

    // ─── 4. Excesses от Jetton-wallet ────────────────────────────────
    if (op == OP_JETTON_EXCESSES) {
        if (st.pendingCharge > 0) {
            st.pendingCharge = 0;
            saveStorage(st);
        }
        return;
    }

    // ─── 5. Process payment ──────────────────────────────────────────
    if (op == OP_PROCESS_PAYMENT) {
        assert(st.status == STATUS_ACTIVE, ERR_PAUSED);
        val cfg = st.config.load();
        assert(blockchain.now() >= st.nextBillingTs, ERR_NOT_TIME);
        assert(st.pendingCharge == 0, ERR_PENDING_CHARGE);
        assert(st.vaultBalance >= cfg.amountPerPeriod, ERR_INSUFFICIENT_VAULT);

        val total      = cfg.amountPerPeriod;
        val protoCut   = total * (cfg.protocolFeeBps as int) / BPS_DENOM;
        val creatorCut = total - protoCut;

        st.vaultBalance -= total;
        st.nextBillingTs = (st.nextBillingTs + cfg.period) as uint32;

        if (st.jettonMaster == null) {
            // TON mode
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: creatorCut,
                dest: identity.creator,
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);

            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: protoCut,
                dest: cfg.admin!,
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);

            createMessage({
                bounce: BounceMode.NoBounce,
                value: cfg.relayerBounty,
                dest: sender,
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        } else {
            assert(st.jettonWallet != null, ERR_WRONG_JETTON);
            st.pendingCharge = total;

            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: JETTON_TRANSFER_GAS,
                dest: st.jettonWallet!,
                body: buildJettonTransferBody(creatorCut, identity.creator, contract.getAddress(), 1, queryId),
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);

            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: JETTON_TRANSFER_GAS,
                dest: st.jettonWallet!,
                body: buildJettonTransferBody(protoCut, cfg.admin!, contract.getAddress(), 1, queryId + 1),
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);

            createMessage({
                bounce: BounceMode.NoBounce,
                value: cfg.relayerBounty,
                dest: sender,
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        saveStorage(st);
        return;
    }

    // ─── 6. Pause ────────────────────────────────────────────────────
    if (op == OP_PAUSE_SUBSCRIPTION) {
        assert(sender == identity.user, ERR_NOT_USER);
        assert(st.status == STATUS_ACTIVE, ERR_BAD_STATUS_FOR_PAUSE);
        assert(st.pendingCharge == 0, ERR_PENDING_CHARGE);

        val nowTs = blockchain.now() as uint32;
        val remainder: uint32 = st.nextBillingTs > nowTs ? (st.nextBillingTs - nowTs) as uint32 : (0 as uint32);
        st.pausedRemainder = remainder;
        st.status = STATUS_PAUSED_BY_USER as uint8;
        saveStorage(st);
        return;
    }

    // ─── 7. Resume ───────────────────────────────────────────────────
    if (op == OP_RESUME_SUBSCRIPTION) {
        assert(sender == identity.user, ERR_NOT_USER);
        assert(st.status == STATUS_PAUSED_BY_USER, ERR_BAD_STATUS_FOR_RESUME);

        val cfg = st.config.load();
        val gap: uint32 = st.pausedRemainder > 0 ? st.pausedRemainder : cfg.period;
        st.nextBillingTs = ((blockchain.now() as uint32) + gap) as uint32;
        st.pausedRemainder = 0;
        st.status = STATUS_ACTIVE as uint8;
        saveStorage(st);
        return;
    }

    // ─── 8. Cancel ───────────────────────────────────────────────────
    if (op == OP_CANCEL_SUBSCRIPTION) {
        assert(sender == identity.user, ERR_NOT_USER);
        assert(st.status != STATUS_CANCELLED, ERR_CANCELLED);
        assert(st.pendingCharge == 0, ERR_PENDING_CHARGE);

        val refund = st.vaultBalance;
        st.vaultBalance = 0;
        st.status = STATUS_CANCELLED as uint8;

        if (refund > 0) {
            if (st.jettonMaster == null) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: refund,
                    dest: identity.user,
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            } else if (st.jettonWallet != null) {
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    value: JETTON_TRANSFER_GAS,
                    dest: st.jettonWallet!,
                    body: buildJettonTransferBody(refund, identity.user, identity.user, 1, queryId),
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
        }

        saveStorage(st);
        return;
    }

    throw ERR_UNKNOWN_OP;
}

// =============================================================================
// Get-методы
// =============================================================================

get fun get_subscription_data(): (int, address, address, address?, int, int, int, int, int, int, int) {
    val st = loadStorage();
    val id = st.identity.load();
    val cfg = st.config.load();
    return (
        st.status,
        id.user,
        id.creator,
        st.jettonMaster,
        cfg.period,
        cfg.amountPerPeriod,
        st.nextBillingTs,
        st.pausedRemainder,
        st.vaultBalance,
        st.pendingCharge,
        cfg.protocolFeeBps
    );
}

get fun get_jetton_wallet(): address? {
    return loadStorage().jettonWallet;
}

get fun is_due_for_payment(): bool {
    val st = loadStorage();
    val cfg = st.config.load();
    return st.status == STATUS_ACTIVE
        && blockchain.now() >= st.nextBillingTs
        && st.vaultBalance >= cfg.amountPerPeriod
        && st.pendingCharge == 0;
}
