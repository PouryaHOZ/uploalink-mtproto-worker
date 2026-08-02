import { CONSTANTS } from '../config/constants';
import { Platform } from '../types';

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function generateConnectionCode(): string {
    const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${part1}-${part2}`;
}

export function generatePlatformLink(platform: Platform, code: string): string {
    return platform === 'rubika' 
        ? `🔗 **روبیکا:**\n${CONSTANTS.RUBIKA_LINK}\n\n📌 کد یکبار مصرف: \`${code}\`\n\n💡 برای اتصال، کد بالا را به @uploalinkbot در روبیکا ارسال کنید.`
        : `🔗 **بله:**\n${CONSTANTS.BALE_LINK_PREFIX}${code}\n\n📌 کد یکبار مصرف: \`${code}\`\n\n💡 برای اتصال، کد بالا را به @uploalinkbot در بله ارسال کنید.`;
}