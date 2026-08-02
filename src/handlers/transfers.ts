import { Env, TransferRequest, Platform } from '../types';
import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { triggerGitHubWorkflow } from '../services/github';
import { calculateEstimates, formatBytes } from '../utils/helpers';

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
    const userConnectedAccounts = await kv.getConnectedAccount(transferRequest.userId || '');

    // Verify connections
    const availableDestinations: ('bale' | 'rubika')[] = [];
    if (userConnectedAccounts?.rubikaChatId) availableDestinations.push('rubika');
    if (userConnectedAccounts?.baleChatId) availableDestinations.push('bale');

    if (availableDestinations.length === 0) {
        await messenger.sendMessage(
            transferRequest.chatId,
            `❌ **خطای عدم اتصال:**\nشما به هیچ پلتفرمی (روبیکا یا بله) متصل نیستید.\nلطفاً ابتدا با ارسال دستور /link حساب خود را متصل کنید.`
        );
        return;
    }

    // STEP 1: Destination Selection
    if (!transferRequest.destinations || transferRequest.destinations.length === 0) {
        if (availableDestinations.length === 1) {
            // Auto-select single destination
            transferRequest.destinations = availableDestinations;
            const destName = availableDestinations[0] === 'rubika' ? 'روبیکا' : 'بله';
            await messenger.sendMessage(transferRequest.chatId, `📡 **ارسال خودکار به ${destName}...**`);
        } else {
            // Prompt for multi-destination pick
            const transferId = `TR${Date.now()}`;
            await kv.saveTransferRequest(transferId, transferRequest);

            await messenger.sendMessage(
                transferRequest.chatId,
                `📡 **فایل دریافتی:** ${transferRequest.fileName}\n` +
                `⚖️ **حجم:** ${formatBytes(transferRequest.fileSize)}\n\n` +
                `لطفاً مقصد ارسال فایل را انتخاب کنید:`,
                {
                    inline_keyboard: [
                        [{ text: '📌 بله', callback_data: `dest:bale:${transferId}` },
                         { text: '📌 روبیکا', callback_data: `dest:rubika:${transferId}` }],
                        [{ text: '🌐 ارسال به هر دو پلتفرم', callback_data: `dest:both:${transferId}` }]
                    ]
                }
            );
            return;
        }
    }

    // STEP 2: Compression Check for Videos
    if (transferRequest.isVideo) {
        const transferId = `TR${Date.now()}`;
        await kv.saveTransferRequest(transferId, transferRequest);

        const est = calculateEstimates(transferRequest.fileSize, true, transferRequest.destinations);

        const messageText = `🎬 **تنظیمات ویدیو پیش از ارسال:**\n\n` +
                            `📁 **نام فایل:** ${transferRequest.fileName}\n` +
                            `📏 **حجم اصلی:** ${est.originalSizeFormatted}\n` +
                            `⚡ **حجم تقریبی فشرده (480p):** ${est.compressedSizeFormatted} (${est.reductionPercentage} کاهش)\n\n` +
                            `لطفاً وضعیت فشرده‌سازی را انتخاب کنید:`;

        await messenger.sendMessage(transferRequest.chatId, messageText, {
            inline_keyboard: [
                [{ text: `⚡ فشرده‌سازی [~${est.compressedTimeFormatted}]`, callback_data: `comp:yes:${transferId}` }],
                [{ text: `📁 کیفیت اصلی [~${est.uncompressedTimeFormatted}]`, callback_data: `comp:no:${transferId}` }]
            ]
        });
        return;
    }

    // For Non-Video files, trigger workflow immediately
    await triggerGitHubWorkflow(env, kv, { ...transferRequest, shouldCompress: false });
    await messenger.sendMessage(transferRequest.chatId, `🚀 **پردازش و انتقال فایل آغاز شد.**`);
}