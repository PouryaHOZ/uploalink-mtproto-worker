// نسخه جدید (v0.3.6): رفع خطای تعریف تکراری SYSTEM_VERSION و اصلاح فایل transfer.js
export const SYSTEM_VERSION = '0.7.0';
export const LAST_UPDATE_PERSIAN = 'افزودن سیستم اشتراک و پرداخت دارمت با سهمیه روزانه و تأیید خودکار پرداخت.';

export const CONSTANTS = {
    CODE_REGEX: /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$|^[A-Za-z0-9]{8}$/,
    EXPIRATION: {
        RATE_LIMIT: 60,            // 1 minute
        CONNECTION_REQUEST: 600,   // 10 minutes
        STATE_TRANSFER: 1800,      // 30 minutes
        ACTIVE_TRANSFER: 86400,    // 24 hours
        SESSION: 86400             // 24 hours
    },
    RUBIKA_LINK: 'rubika.ir/uploalinkbot',
    BALE_LINK_PREFIX: 'ble.ir/uploalinkbot?start=',
    PERFORMANCE_ESTIMATES: {
        DOWNLOAD_SPEED_MBPS: 20,
        COMPRESS_SPEED_MBPS: 2,
        UPLOAD_BALE_MBPS: 4,
        UPLOAD_RUBIKA_MBPS: 6
    },
    SUBSCRIPTION: {
        PRICE_TOMAN: 80000,
        DURATION_DAYS: 30,
        TRIAL_DURATION_DAYS: 7,
        TRIAL_DAILY_QUOTA_BYTES: 500 * 1024 * 1024,         // 500 MB/day
        SHARED_DAILY_QUOTA_BYTES: 5 * 1024 * 1024 * 1024,    // 5 GB/day
        SHARED_PER_FILE_LIMIT_BYTES: 2 * 1024 * 1024 * 1024, // 2 GB/file
        MESSAGE_USED_COOLDOWN_DAYS: 90
    },
    PAYMENT: {
        LINK_TTL_MS: 60 * 60 * 1000,             // 1 hour
        MESSAGE_LOCK_TTL_MS: 3 * 60 * 60 * 1000, // 3 hours
        PAYMENT_WINDOW_TTL_MS: 3 * 60 * 60 * 1000, // 3 hours
        RECORD_TTL_MS: 4 * 60 * 60 * 1000,       // 4 hours (extra hour for cleanup)
        REMINDER_AFTER_MS: 60 * 60 * 1000,       // 1 hour (when link expires)
        VERIFY_BATCH_SIZE: 5,
        VERIFY_MAX_PENDING: 20
    },
    DARAMET: {
        BASE_URL: 'https://daramet.com',
        SEARCH_ENDPOINT: '/api/v2/Donates/Search',
        MESSAGES_ENDPOINT: '/api/v2/Donates/Messages',
        MESSAGES_LEGACY_ENDPOINT: '/api/Donates/Messages',
        GOAL_ENDPOINT: '/api/v2/Goal',
        TOTAL_ENDPOINT: '/api/v2/Total',
        HIGH_TO_LOW_ENDPOINT: '/api/Donates/HighToLow'
    }
};