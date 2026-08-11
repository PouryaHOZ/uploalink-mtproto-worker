import { Env, TransferRequest, Platform } from '../types';
import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { formatBytes } from '../utils/helpers';
import { QuotaService } from '../services/quota';

export function createTransferRequest(messageId: string, chatId: string, userId: string, rawMessage: any, platform: Platform): TransferRequest {
    return {
        messageId,
        chatId,
        fileName: rawMessage.document?.file_name || rawMessage.file?.file_name || `file_${messageId}_${Date.now()}`,
        fileSize: rawMessage.document?.file_size || rawMessage.video?.file_size || rawMessage.file?.size || 0,
        isVideo: !!rawMessage.document?.mime_type?.startsWith('video/') || !!rawMessage.video || !!rawMessage.file?.file_name?.endsWith('.mp4'),
        mimeType: rawMessage.document?.mime_type || rawMessage.video?.mime_type || rawMessage.file?.mime_type,
        userId,
        platform
    };
}

export async function processFileTransfer(env: Env, kv: KVService, messenger: Messenger, transferRequest: TransferRequest): Promise<void> {
    // ===== Early File Size Validation =====
    // Check file size limits BEFORE any processing or quota reservation
    // This catches oversized files immediately and provides clear feedback
    if (transferRequest.fileSize > 0 && transferRequest.userId) {
        const quotaService = new QuotaService(env);
        const limits = await quotaService.getEffectiveLimits(transferRequest.userId);

        // Check per-file size limit (shared tier: 2GB max per file)
        if (limits.perFileLimitBytes > 0 && transferRequest.fileSize > limits.perFileLimitBytes) {
            await messenger.sendMessage(
                transferRequest.chatId,
                `❌ <b>حجم فایل بیش از حد مجاز است.</b>\n\n` +
                `📏 <b>حجم فایل شما:</b> ${formatBytes(transferRequest.fileSize)}\n` +
                `📊 <b>حداکثر مجاز:</b> ${formatBytes(limits.perFileLimitBytes)}\n\n` +
                `💡 لطفاً فایل کوچک‌تری ارسال کنید یا از قابلیت فشرده‌سازی ویدیو استفاده کنید.`,
                { inline_keyboard: [[{ text: '💎 اطلاعات اشتراک', callback_data: 'sub_status' }]] }
            );
            return;
        }

        // Warn for very large files (even if under limit)
        const LARGE_FILE_WARNING = 1.5 * 1024 * 1024 * 1024; // 1.5GB
        if (transferRequest.fileSize > LARGE_FILE_WARNING && limits.tier === 'trial') {
            await messenger.sendMessage(
                transferRequest.chatId,
                `⚠️ <b>توجه: حجم فایل زیاد است</b>\n\n` +
                `این فایل (${formatBytes(transferRequest.fileSize)}) نیمی از سهمیه روزانه آزمایشی شما را اشغال می‌کند.\n\n` +
                `💡 پیشنهاد: با خرید اشتراک، سهمیه روزانه خود را به ۵ گیگابایت افزایش دهید.`,
                { inline_keyboard: [[{ text: '💎 خرید اشتراک', callback_data: 'sub_buy' }]] }
            );
            // Don't return - let the user decide to continue
        }
    }

    // ===== Quota Gate =====
    // Check user's daily quota and reserve bytes atomically before allowing the transfer.
    // If quota is exceeded or file is too large, deny the transfer with a helpful message.
    if (transferRequest.userId) {
        const quotaService = new QuotaService(env);
        const quotaCheck = await quotaService.checkAndReserve(transferRequest);
        if (!quotaCheck.allowed) {
            const reason = quotaCheck.reason || 'unknown';
            let errorMsg = '❌ <b>انتقال فایل امکان‌پذیر نیست.</b>\n\n';

            if (reason === 'file_too_large') {
                const fileSize = quotaCheck.details?.fileSize || transferRequest.fileSize;
                const perFileLimit = quotaCheck.details?.perFileLimit || 0;
                errorMsg +=
                    `📦 <b>حجم فایل بیش از حد مجاز است.</b>\n` +
                    `• حجم فایل شما: ${formatBytes(fileSize)}\n` +
                    `• حداکثر مجاز هر فایل: ${formatBytes(perFileLimit)}\n\n` +
                    `💡 برای انتقال فایل‌های بزرگ‌تر، اشتراک اشتراکی را تهیه کنید.`;
            } else if (reason === 'quota_exceeded') {
                const dailyLimit = quotaCheck.details?.dailyLimit || 0;
                errorMsg +=
                    `📊 <b>سهمیه روزانه شما تکمیل شده است.</b>\n` +
                    `• سهمیه روزانه: ${formatBytes(dailyLimit)}\n\n` +
                    `💡 سهمیه هر روز ساعت ۰۰:۰۰ (به وقت تهران) بازنشانی می‌شود.\n` +
                    `برای دریافت سهمیه بیشتر: /subscribe`;
            }

            await messenger.sendMessage(
                transferRequest.chatId,
                errorMsg,
                { inline_keyboard: [[{ text: '💎 خرید اشتراک', callback_data: `sub_buy` }]] }
            );
            return;
        }
    }

    const transferId = `TR${Date.now()}`;
    await kv.saveTransferRequest(transferId, transferRequest);

    const inline_keyboard: any[][] = [];

    if (transferRequest.isVideo) {
        const messageText = `🎬 <b>دریافت ویدیو:</b> ${transferRequest.fileName}\n` +
                            `📏 <b>حجم فایل:</b> ${formatBytes(transferRequest.fileSize)}\n\n` +
                            `لطفاً کیفیت خروجی را انتخاب کنید:\n` +
                            `🔹 <b>استاندارد:</b> حفظ ابعاد اصلی (تا سقف 720p) + بهینه‌سازی حجم\n` +
                            `🔸 <b>سبک:</b> فشرده‌سازی بسیار بالا (تا سقف 480p) جهت دانلود سریع`;

        inline_keyboard.push([{ text: '🔹 ساخت لینک (استاندارد / 720p)', callback_data: `link_gen:no:${transferId}` }]);
        inline_keyboard.push([{ text: '🔸 ساخت لینک (سبک / 480p)', callback_data: `link_gen:yes:${transferId}` }]);

        await messenger.sendMessage(transferRequest.chatId, messageText, { inline_keyboard });
    } else {
        const messageText = `📁 <b>دریافت فایل:</b> ${transferRequest.fileName}\n` +
                            `⚖️ <b>حجم:</b> ${formatBytes(transferRequest.fileSize)}\n\n` +
                            `لطفاً عملیات مورد نظر را انتخاب کنید:`;

        inline_keyboard.push([{ text: '🔗 ساخت لینک دانلود مستقیم', callback_data: `link_gen:no:${transferId}` }]);
        await messenger.sendMessage(transferRequest.chatId, messageText, { inline_keyboard });
    }
}
