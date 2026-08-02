import { Env, TransferRequest } from '../types';
import { KVService } from './kv';

export async function triggerGitHubWorkflow(env: Env, kv: KVService, transferRequest: TransferRequest): Promise<void> {
    if (!env.GITHUB_ACTIONS_WEBHOOK) return;

    const transferId = `transfer_${Date.now()}`;
    await kv.saveActiveTransfer(transferId, {
        id: transferId,
        transferRequest,
        status: 'queued',
        createdAt: Date.now()
    });

    const payload = {
        event: 'forward_file',
        MESSAGE_ID: transferRequest.messageId.toString(),
        CHAT_ID: transferRequest.chatId,
        TELEGRAM_CHAT_ID: transferRequest.chatId,
        FILE_NAME: transferRequest.fileName,
        FILE_SIZE: transferRequest.fileSize.toString(),
        IS_VIDEO: transferRequest.isVideo ? 'true' : 'false',
        MIME_TYPE: transferRequest.mimeType || '',
        FILE_ID: transferRequest.fileId || '',
        DESTINATIONS: (transferRequest.destinations || []).join(','),
        SHOULD_COMPRESS: transferRequest.shouldCompress ? 'true' : 'false',
        ACCOUNT: transferRequest.account || 'both',
        USER_ID: transferRequest.userId || '',
        PLATFORM: transferRequest.platform
    };

    await fetch(env.GITHUB_ACTIONS_WEBHOOK, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'User-Agent': 'uploalink-mtproto-worker'
        },
        body: JSON.stringify(payload)
    });
}