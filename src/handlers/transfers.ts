import { Env, TransferRequest, Platform } from '../types';
import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { formatBytes } from '../utils/helpers';

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
    const transferId = `TR${Date.now()}`;
    await kv.saveTransferRequest(transferId, transferRequest);

    const inline_keyboard: any[][] = [];

    if (transferRequest.isVideo) {
        const messageText = `🎬 **دریافت ویدیو:** ${transferRequest.fileName}\n` +
                            `📏 **حجم فایل:** ${formatBytes(transferRequest.fileSize)}\n\n` +
                            `لطفاً کیفیت خروجی را انتخاب کنید:\n` +
                            `🔹 **استاندارد:** حفظ ابعاد اصلی (تا سقف 720p) + بهینه‌سازی حجم\n` +
                            `🔸 **سبک:** فشرده‌سازی بسیار بالا (تا سقف 480p) جهت دانلود سریع`;

        inline_keyboard.push([{ text: '🔹 ساخت لینک (استاندارد / 720p)', callback_data: `link_gen:no:${transferId}` }]);
        inline_keyboard.push([{ text: '🔸 ساخت لینک (سبک / 480p)', callback_data: `link_gen:yes:${transferId}` }]);

        await messenger.sendMessage(transferRequest.chatId, messageText, { inline_keyboard });
    } else {
        const messageText = `📁 **دریافت فایل:** ${transferRequest.fileName}\n` +
                            `⚖️ **حجم:** ${formatBytes(transferRequest.fileSize)}\n\n` +
                            `لطفاً عملیات مورد نظر را انتخاب کنید:`;

        inline_keyboard.push([{ text: '🔗 ساخت لینک دانلود مستقیم', callback_data: `link_gen:no:${transferId}` }]);
        await messenger.sendMessage(transferRequest.chatId, messageText, { inline_keyboard });
    }
}