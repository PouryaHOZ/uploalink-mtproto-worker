import { CONSTANTS } from '../config/constants';
import { Platform } from '../types';

export function formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '۰ بایت';
    const k = 1024;
    const sizes = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = parseFloat((bytes / Math.pow(k, i)).toFixed(1));
    return `${toPersianDigits(val.toString())} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return 'چند ثانیه';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) {
        return `${toPersianDigits(mins.toString())} دقیقه و ${toPersianDigits(secs.toString())} ثانیه`;
    }
    return `${toPersianDigits(secs.toString())} ثانیه`;
}

export function toPersianDigits(str: string): string {
    const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    return str.replace(/\d/g, (x) => persianDigits[parseInt(x)]);
}

export function generateConnectionCode(): string {
    const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${part1}-${part2}`;
}

export function generatePlatformLink(platform: Platform, code: string): string {
    return platform === 'rubika' 
        ? `🔗 **ارتباط با روبیکا:**\n${CONSTANTS.RUBIKA_LINK}\n\n🔑 **کد یک‌بارمصرف شما:** \`${code}\`\n\n💡 کد بالا را کپی کرده و به آیدی بالا در روبیکا ارسال کنید.`
        : `🔗 **ارتباط با بله:**\n${CONSTANTS.BALE_LINK_PREFIX}${code}\n\n🔑 **کد یک‌بارمصرف شما:** \`${code}\`\n\n💡 روی لینک بالا کلیک کنید تا ربات بله فعال شود.`;
}

export function calculateEstimates(fileSize: number, isVideo: boolean, targetDestinations: ('bale' | 'rubika')[]) {
    const sizeMB = fileSize / (1024 * 1024);
    
    // Download time
    const downloadSec = sizeMB / CONSTANTS.PERFORMANCE_ESTIMATES.DOWNLOAD_SPEED_MBPS;
    
    // Uncompressed upload time
    let uploadUncompressedSec = 0;
    if (targetDestinations.includes('bale')) uploadUncompressedSec += sizeMB / CONSTANTS.PERFORMANCE_ESTIMATES.UPLOAD_BALE_MBPS;
    if (targetDestinations.includes('rubika')) uploadUncompressedSec += sizeMB / CONSTANTS.PERFORMANCE_ESTIMATES.UPLOAD_RUBIKA_MBPS;

    const totalUncompressedSec = Math.ceil(downloadSec + uploadUncompressedSec + 5);

    // Compressed stats (~60% reduction, size becomes 40%)
    const compressedSizeMB = sizeMB * 0.40;
    const compressSec = sizeMB / CONSTANTS.PERFORMANCE_ESTIMATES.COMPRESS_SPEED_MBPS;

    let uploadCompressedSec = 0;
    if (targetDestinations.includes('bale')) uploadCompressedSec += compressedSizeMB / CONSTANTS.PERFORMANCE_ESTIMATES.UPLOAD_BALE_MBPS;
    if (targetDestinations.includes('rubika')) uploadCompressedSec += compressedSizeMB / CONSTANTS.PERFORMANCE_ESTIMATES.UPLOAD_RUBIKA_MBPS;

    const totalCompressedSec = Math.ceil(downloadSec + compressSec + uploadCompressedSec + 10);

    return {
        originalSizeFormatted: formatBytes(fileSize),
        compressedSizeFormatted: formatBytes(compressedSizeMB * 1024 * 1024),
        reductionPercentage: '۶۰٪',
        uncompressedTimeFormatted: formatDuration(totalUncompressedSec),
        compressedTimeFormatted: formatDuration(totalCompressedSec)
    };
}