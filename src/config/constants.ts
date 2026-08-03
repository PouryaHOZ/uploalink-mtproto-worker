// نسخه جدید (v0.3.6): رفع خطای تعریف تکراری SYSTEM_VERSION و اصلاح فایل transfer.js
export const SYSTEM_VERSION = '0.3.8';
export const LAST_UPDATE_PERSIAN = 'بازگردانی متد checkCancel در کلاس FileTransferBot و برطرف کردن خطای لغو فرآیند.';

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