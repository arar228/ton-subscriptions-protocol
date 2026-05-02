// Единый источник правды для op-codes, статусов и кодов ошибок.
// Дублирует значения из contracts/*.tolk — менять синхронно.

export const OP = {
    DEPLOY_CHANNEL:           0x73d09313,
    PROCESS_PAYMENT:          0x70617970,
    CANCEL_SUBSCRIPTION:      0x636e6c00,
    TOP_UP_TON:               0x74705f74,
    PAUSE_SUBSCRIPTION:       0x70617573,
    RESUME_SUBSCRIPTION:      0x72736d65,
    UPDATE_CONFIG:            0x12fa3a3c,

    JETTON_TRANSFER:          0x0f8a7ea5,
    JETTON_TRANSFER_NOTIFY:   0x7362d09c,
    JETTON_EXCESSES:          0xd53276db,

    TEST_SET_BOUNCE_MODE:     0x74357301,
    TEST_FORCE_NOTIFY:        0x74357302,
} as const

export const STATUS = {
    UNINIT:               0,
    ACTIVE:               1,
    PAUSED_INSUFFICIENT:  2,
    PAUSED_BY_USER:       3,
    CANCELLED:            4,
} as const

export const ERR = {
    // channel
    NOT_REGISTRY:           400,
    NOT_USER:               401,
    NOT_TIME:               403,
    INSUFFICIENT_VAULT:     404,
    PAUSED:                 405,
    CANCELLED:              406,
    NOT_INITIALIZED:        407,
    ALREADY_INITIALIZED:    408,
    PENDING_CHARGE:         409,
    WRONG_JETTON:           411,
    BAD_STATUS_FOR_PAUSE:   420,
    BAD_STATUS_FOR_RESUME:  421,
    // registry
    NOT_ADMIN:              401,
    PERIOD_TOO_LOW:         410,
    PERIOD_TOO_HIGH:        411,
    AMOUNT_ZERO:            412,
    FEE_TOO_HIGH:           413,
    BOUNTY_TOO_LOW:         414,
    // mock
    FORCED_BOUNCE:          999,
} as const
