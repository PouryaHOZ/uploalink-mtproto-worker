import { Env, TransferRequest } from '../types';
import { KVService } from './kv';

export async function triggerGitHubWorkflow(env: Env, kv: KVService, transferRequest: TransferRequest): Promise<void> {
    if (!env.GITHUB_ACTIONS_WEBHOOK) {
        console.error("GITHUB_ACTIONS_WEBHOOK is not configured in the environment.");
        return;
    }

    const connectedAccounts = await kv.getConnectedAccount(transferRequest.userId || '');

    const transferId = `TR${Date.now()}`;
    await kv.saveActiveTransfer(transferId, {
        id: transferId,
        transferRequest,
        status: 'queued',
        createdAt: Date.now()
    });

    const payload = {
        event_type: 'forward_file',
        client_payload: {
            MESSAGE_ID: transferRequest.messageId.toString(),
            CHAT_ID: transferRequest.chatId,
            FILE_NAME: transferRequest.fileName,
            FILE_SIZE: transferRequest.fileSize.toString(),
            IS_VIDEO: transferRequest.isVideo ? 'true' : 'false',
            MIME_TYPE: transferRequest.mimeType || '',
            FILE_ID: transferRequest.fileId || '',
            DESTINATIONS: (transferRequest.destinations || []).join(','),
            SHOULD_COMPRESS: transferRequest.shouldCompress ? 'true' : 'false',
            BALE_CHAT_ID: connectedAccounts?.baleChatId || '',
            RUBIKA_CHAT_ID: connectedAccounts?.rubikaChatId || ''
        }
    };

    try {
        const res = await fetch(env.GITHUB_ACTIONS_WEBHOOK, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'User-Agent': 'Cloudflare-Worker'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`GitHub Action Trigger Failed [HTTP ${res.status}]:`, errorText);
        } else {
            console.log("✅ GitHub Action Triggered Successfully!");
        }
    } catch (err) {
        console.error("Network error triggering GitHub Action:", err);
    }
}