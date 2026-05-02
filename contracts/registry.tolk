tolk 1.3

// =============================================================================
// SubscriptionRegistry — Master-контракт протокола.
// Хранит конфиг и деплоит SubscriptionChannel с детерминированным адресом.
// =============================================================================

const OP_DEPLOY_CHANNEL: int = 0x73d09313;
const OP_UPDATE_CONFIG:  int = 0x12fa3a3c;

const ERR_NOT_ADMIN:        int = 401;
const ERR_PERIOD_TOO_LOW:   int = 410;
const ERR_PERIOD_TOO_HIGH:  int = 411;
const ERR_AMOUNT_ZERO:      int = 412;
const ERR_FEE_TOO_HIGH:     int = 413;
const ERR_BOUNTY_TOO_LOW:   int = 414;
const ERR_UNKNOWN_OP:       int = 0xffff;

const MIN_PERIOD:           int = 60;          // FIXME: testnet/dev — поднять до 3600 перед mainnet
const MAX_PERIOD:           int = 365 * 86400;
const MAX_FEE_BPS:          int = 1000;
// Калибровано под реальный TEP-74 (USDT Tether on TON):
//   - TON-канал: релейер тратит ~0.07 TON газа на process_payment.
//   - Jetton-канал: + 2 jetton-transfer'а × ~0.045 TON internal-transfer fee
//     контракт оплачивает из своих средств (JETTON_TRANSFER_GAS), но релейер
//     должен покрыть заход и storage delta ⇒ bounty 0.10+ TON.
const MIN_BOUNTY_TON:       int = 30000000;       // 0.03 TON
const MIN_BOUNTY_JETTON:    int = 100000000;      // 0.10 TON
const DEPLOY_VALUE:         int = 100000000;

// =============================================================================
// Storage
// =============================================================================
struct RegistryStorage {
    admin: address;
    protocolFeeBps: uint16;
    channelCode: cell;
    totalChannels: uint32;
}

fun loadStorage(): RegistryStorage {
    return RegistryStorage.fromCell(contract.getData());
}

fun saveStorage(st: RegistryStorage): void {
    contract.setData(st.toCell());
}

// =============================================================================
// Channel deployment helpers
// =============================================================================
// ВАЖНО: layout идентичен ChannelStorage в channel.tolk.
struct InitChannelIdentity {
    registry: address;
    user: address;
    creator: address;
}

struct InitChannelConfig {
    admin: address?;
    protocolFeeBps: uint16;
    period: uint32;
    amountPerPeriod: coins;
    relayerBounty: coins;
}

struct InitChannelStorage {
    status: uint8;
    identity: Cell<InitChannelIdentity>;
    config: Cell<InitChannelConfig>;
    jettonMaster: address?;
    nextBillingTs: uint32;
    pausedRemainder: uint32;
    vaultBalance: coins;
    pendingCharge: coins;
    jettonWallet: address?;
}

fun buildChannelInitData(registry: address, user: address, creator: address,
                         jettonMaster: address?): cell {
    val initIdentity: InitChannelIdentity = { registry, user, creator };
    val initConfig: InitChannelConfig = {
        admin: null,
        protocolFeeBps: 0,
        period: 0,
        amountPerPeriod: 0,
        relayerBounty: 0,
    };
    val initStorage: InitChannelStorage = {
        status: 0,
        identity: initIdentity.toCell(),
        config: initConfig.toCell(),
        jettonMaster: jettonMaster,
        nextBillingTs: 0,
        pausedRemainder: 0,
        vaultBalance: 0,
        pendingCharge: 0,
        jettonWallet: null,
    };
    return initStorage.toCell();
}

// =============================================================================
// Entry
// =============================================================================
fun onInternalMessage(in: InMessage) {
    var body = in.body;
    if (body.remainingBitsCount() < 32) {
        return;
    }

    val op = body.loadUint(32);
    val queryId = body.loadUint(64);
    val sender = in.senderAddress;
    var st = loadStorage();

    if (op == OP_DEPLOY_CHANNEL) {
        val creator      = body.loadAddress();
        val jettonMaster = body.loadAddressOpt();
        val period       = body.loadUint(32);
        val amount       = body.loadCoins();
        val bounty       = body.loadCoins();

        assert(period >= MIN_PERIOD,  ERR_PERIOD_TOO_LOW);
        assert(period <= MAX_PERIOD,  ERR_PERIOD_TOO_HIGH);
        assert(amount > 0,            ERR_AMOUNT_ZERO);
        val minBounty = jettonMaster == null ? MIN_BOUNTY_TON : MIN_BOUNTY_JETTON;
        assert(bounty >= minBounty,   ERR_BOUNTY_TOO_LOW);

        val initData = buildChannelInitData(contract.getAddress(), sender, creator, jettonMaster);
        val channelStateInit: ContractState = { code: st.channelCode, data: initData };

        val initBody = beginCell()
            .storeUint(OP_DEPLOY_CHANNEL, 32)
            .storeUint(queryId, 64)
            .storeAddress(st.admin)
            .storeUint(st.protocolFeeBps, 16)
            .storeUint(period, 32)
            .storeCoins(amount)
            .storeCoins(bounty)
            .endCell();

        createMessage({
            bounce: BounceMode.Only256BitsOfBody,
            value: DEPLOY_VALUE,
            dest: AutoDeployAddress {
                workchain: BASECHAIN as int8,
                stateInit: channelStateInit,
            },
            body: initBody,
        }).send(SEND_MODE_PAY_FEES_SEPARATELY);

        st.totalChannels = (st.totalChannels + 1) as uint32;
        saveStorage(st);
        return;
    }

    if (op == OP_UPDATE_CONFIG) {
        assert(sender == st.admin, ERR_NOT_ADMIN);
        val newAdmin = body.loadAddress();
        val newFee   = body.loadUint(16);
        assert(newFee <= MAX_FEE_BPS, ERR_FEE_TOO_HIGH);
        st.admin = newAdmin;
        st.protocolFeeBps = newFee as uint16;
        saveStorage(st);
        return;
    }

    throw ERR_UNKNOWN_OP;
}

fun onBouncedMessage(in: InMessageBounced) {
    return;
}

// =============================================================================
// Get-методы
// =============================================================================
get fun get_config(): (address, int, int) {
    val st = loadStorage();
    return (st.admin, st.protocolFeeBps, st.totalChannels);
}

get fun get_channel_code(): cell {
    return loadStorage().channelCode;
}

get fun get_channel_address(user: address, creator: address, jettonMasterSlice: slice): address {
    var jettonMaster: address? = null;
    var s = jettonMasterSlice;
    if (s.preloadUint(2) != 0) {
        jettonMaster = s.loadAddress();
    }
    val st = loadStorage();
    val initData = buildChannelInitData(contract.getAddress(), user, creator, jettonMaster);
    val stateInitCell = beginCell()
        .storeUint(0, 2)
        .storeMaybeRef(st.channelCode)
        .storeMaybeRef(initData)
        .storeUint(0, 1)
        .endCell();
    return address.fromWorkchainAndHash(BASECHAIN as int8, stateInitCell.hash());
}
