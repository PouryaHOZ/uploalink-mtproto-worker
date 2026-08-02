import { Env, TransferRequest, Platform } from '../types';
import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { triggerGitHubWorkflow } from '../services/github';
import { formatBytes } from '../utils/helpers';

export function createTransferRequest(message: any, platform: Platform): TransferRequest {
    return {
        messageId: message.message_id,
        chatId: (message.chat?.id || message.chat_id || message.from?.id).toString(),
        fileName: message.document?.file_name || message.file?.file_name || `file_${message.message_id}_${Date.now()}`,
        fileSize: message.document?.file_size || message.video?.file_size || message.file?.size || 0,
        isVideo: !!message.document?.mime_type?.startsWith('video/') || !!message.video || !!message.file?.file_name?.endsWith('.mp4'),
        mimeType: message.document?.mime_type || message.video?.mime_type || message.file?.mime_type,
        userId: (message.from?.id || message.sender_id || 'unknown').toString(),
        platform
    };
}

export async function processFileTransfer(env: Env, kv: KVService, messenger: Messenger, transferRequest: TransferRequest): Promise<void> {
    const userConnectedAccounts = await kv.getConnectedAccount(transferRequest.userId || '');

    if (!userConnectedAccounts?.rubikaChatId && !userConnectedAccounts?.baleChatId) {
        await messenger.sendMessage(transferRequest.chatId, `❌ **خطا:**\nشما به هیچ پلتفرمی متصل نیستید.\nلطفاً ابتدا با ارسال دستور /link حساب خود را متصل کنید.`);
        return;
    }

    let destinations: ('bale' | 'rubika')[] = [];
    if (userConnectedAccounts.rubikaChatId) destinations.push('rubika');
    if (userConnectedAccounts.baleChatId) destinations.push('bale');

    if (destinations.length === 1) {
        transferRequest.destinations = destinations;
    } else if (destinations.length > 1) {
        const transferId = `transfer_${Date.now()}`;
        await kv.saveTransferRequest(transferId, transferRequest);
        
        const options = destinations.map(dest => ({
            text: dest === 'rubika' ? '📌 روبیکا' : '📌 بله',
            callback_data: `select_destination_${dest}_${transferId}`
        }));

        await messenger.sendMessage(transferRequest.chatId, `📡 **ارسال به کدام پلتفرم؟**`, { inline_keyboard: [options] });
        return;
    }

    if (transferRequest.isVideo) {
        const transferId = `transfer_${Date.now()}`;
        await kv.saveTransferRequest(transferId, transferRequest);
        await messenger.sendMessage(transferRequest.chatId, `🎬 **ویدیو فشرده شود؟**\nحجم: ${formatBytes(transferRequest.fileSize)}`, {
            inline_keyboard: [
                [{ text: '⚡ بله (480p)', callback_data: `select_compression_yes_${transferId}` },
                 { text: '📁 خیر', callback_data: `select_compression_no_${transferId}` }]
            ]
        });
        return;
    }

    await triggerGitHubWorkflow(env, kv, { ...transferRequest, shouldCompress: false, account: 'both' });
}