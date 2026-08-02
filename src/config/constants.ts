export const CONSTANTS = {
    CODE_REGEX: /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$|^[A-Za-z0-9]{8}$/,
    EXPIRATION: {
        RATE_LIMIT: 60,            // 1 دقیقه
        CONNECTION_REQUEST: 600,   // 10 دقیقه
        STATE_TRANSFER: 1800,      // 30 دقیقه
        ACTIVE_TRANSFER: 86400,    // 24 ساعت
        SESSION: 86400             // 24 ساعت
    },
    RUBIKA_LINK: 'rubika.ir/uploalinkbot',
    BALE_LINK_PREFIX: 'ble.ir/uploalinkbot?start='
};