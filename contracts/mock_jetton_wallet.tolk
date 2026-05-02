tolk 1.3

// =============================================================================
// MockJettonWallet — упрощённый jetton-wallet для тестов SubscriptionChannel.
// Имитирует поведение TEP-74 jetton wallet'а для исходящего OP_JETTON_TRANSFER:
//   - forceBounce=1 → throw → исходное сообщение делает bounce обратно;
//   - forceBounce=0 → шлёт transfer_notification на dest и excesses на response.
// =============================================================================

const OP_JETTON_TRANSFER:        int = 0x0f8a7ea5;
const OP_JETTON_EXCESSES:        int = 0xd53276db;
const OP_JETTON_TRANSFER_NOTIFY: int = 0x7362d09c;

const OP_TEST_SET_BOUNCE_MODE:   int = 0x74357301;
const OP_TEST_FORCE_NOTIFY:      int = 0x74357302;

const ERR_FORCED_BOUNCE: int = 999;

struct MockStorage {
    owner: address;
    forceBounce: uint8;
}

fun loadStorage(): MockStorage {
    return MockStorage.fromCell(contract.getData());
}

fun saveStorage(st: MockStorage): void {
    contract.setData(st.toCell());
}

fun onInternalMessage(in: InMessage) {
    var body = in.body;
    if (body.remainingBitsCount() < 32) {
        return;
    }

    val op = body.loadUint(32);
    val queryId = body.loadUint(64);
    var st = loadStorage();

    if (op == OP_JETTON_TRANSFER) {
        if (st.forceBounce != 0) {
            throw ERR_FORCED_BOUNCE;
        }
        val amount        = body.loadCoins();
        val destination   = body.loadAddress();
        val responseDest  = body.loadAddressOpt();
        body.skipBits(1);                       // null custom_payload
        val fwdAmount     = body.loadCoins();

        if (fwdAmount > 0) {
            val notifyBody = beginCell()
                .storeUint(OP_JETTON_TRANSFER_NOTIFY, 32)
                .storeUint(queryId, 64)
                .storeCoins(amount)
                .storeAddress(st.owner)
                .storeUint(0, 1)
                .endCell();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: fwdAmount,
                dest: destination,
                body: notifyBody,
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        if (responseDest != null) {
            val excessesBody = beginCell()
                .storeUint(OP_JETTON_EXCESSES, 32)
                .storeUint(queryId, 64)
                .endCell();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 1,
                dest: responseDest!,
                body: excessesBody,
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }
        return;
    }

    if (op == OP_TEST_SET_BOUNCE_MODE) {
        st.forceBounce = body.loadUint(1) as uint8;
        saveStorage(st);
        return;
    }

    if (op == OP_TEST_FORCE_NOTIFY) {
        val target   = body.loadAddress();
        val amount   = body.loadCoins();
        val from     = body.loadAddress();
        val fwdValue = body.loadCoins();

        val notifyBody = beginCell()
            .storeUint(OP_JETTON_TRANSFER_NOTIFY, 32)
            .storeUint(queryId, 64)
            .storeCoins(amount)
            .storeAddress(from)
            .storeUint(0, 1)
            .endCell();
        createMessage({
            bounce: BounceMode.NoBounce,
            value: fwdValue,
            dest: target,
            body: notifyBody,
        }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        return;
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    return;
}

get fun get_mock_state(): (address, int) {
    val st = loadStorage();
    return (st.owner, st.forceBounce);
}
