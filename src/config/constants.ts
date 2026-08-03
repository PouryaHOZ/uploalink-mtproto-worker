// نسخه جدید (v0.2.1): رفع خطای عدم دسترسی به فایل‌سیستم در کلودفلر ورکرز و اصلاح خروجی‌های فایل handler
export const SYSTEM_VERSION = '0.2.1';
export const LAST_UPDATE_PERSIAN = 'رفع خطای mkdirSync در محیط کلودفلر ورکرز و اصلاح خروجی‌های توابع پردازش فایل.';

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
        DOWNLOAD_SPEED_MBPS: 20,   // MTProto speed on GitHub Runner (~20 MB/s)
        COMPRESS_SPEED_MBPS: 2,    // FFmpeg re-encoding speed (~2 MB/s input)
        UPLOAD_BALE_MBPS: 4,       // Bale upload speed (~4 MB/s)
        UPLOAD_RUBIKA_MBPS: 6      // Rubika upload speed (~6 MB/s)
    }
};