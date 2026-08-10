/**
 * Persian (Jalali) date utilities with Asia/Tehran timezone awareness.
 * Cloudflare Workers run in UTC, so we must convert to Asia/Tehran explicitly.
 */

const TEHRAN_TZ = 'Asia/Tehran';

/**
 * Get current time in Asia/Tehran as a Date.
 * Workers support Intl with timeZone, so we build it manually.
 */
export function getTehranNow(): Date {
    const now = new Date();
    // Convert to Tehran time by formatting and parsing back
    const tehranString = now.toLocaleString('en-US', { timeZone: TEHRAN_TZ });
    return new Date(tehranString);
}

/**
 * Get a date key (YYYY-MM-DD) for the current day in Asia/Tehran.
 * Used as the daily quota partition key.
 */
export function getPersianDateKey(timestampMs: number = Date.now()): string {
    const date = new Date(timestampMs);
    // Use Intl to get YYYY-MM-DD in Asia/Tehran
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TEHRAN_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const year = parts.find(p => p.type === 'year')?.value || '1970';
    const month = parts.find(p => p.type === 'month')?.value || '01';
    const day = parts.find(p => p.type === 'day')?.value || '01';

    return `${year}-${month}-${day}`;
}

/**
 * Convert Gregorian date to Persian (Jalali) and return formatted Persian date string.
 * Returns like: "۱۴ شهریور ۱۴۰۵"
 */
export function formatPersianDate(timestampMs: number): string {
    try {
        const formatter = new Intl.DateTimeFormat('fa-IR', {
            timeZone: TEHRAN_TZ,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        return formatter.format(new Date(timestampMs));
    } catch {
        return new Date(timestampMs).toISOString();
    }
}

/**
 * Format a duration in milliseconds as a Persian relative string.
 * Example: "۳۰ روز" or "۱۲ ساعت و ۳۰ دقیقه"
 */
export function formatPersianDuration(ms: number): string {
    if (ms <= 0) return 'منقضی';
    const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    const toPersian = (n: number | string) => String(n).replace(/\d/g, d => persianDigits[parseInt(d)]);

    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${toPersian(days)} روز`;
    if (hours > 0) return `${toPersian(hours)} ساعت و ${toPersian(minutes)} دقیقه`;
    if (minutes > 0) return `${toPersian(minutes)} دقیقه`;
    return `${toPersian(seconds)} ثانیه`;
}

/**
 * Get hour:minute for a timestamp in Asia/Tehran, in Persian digits.
 * Example: "۱۵:۳۰"
 */
export function formatPersianTime(timestampMs: number): string {
    try {
        const formatter = new Intl.DateTimeFormat('fa-IR', {
            timeZone: TEHRAN_TZ,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        return formatter.format(new Date(timestampMs));
    } catch {
        return new Date(timestampMs).toISOString().substring(11, 16);
    }
}
