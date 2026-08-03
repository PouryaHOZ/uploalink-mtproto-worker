import { Env, TransferRequest } from '../types';

export async function triggerGitHubWorkflow(env: Env, transferId: string, transferRequest: TransferRequest): Promise<boolean> {
    if (!env.GITHUB_ACTIONS_WEBHOOK || !env.GITHUB_TOKEN) {
        console.error("GitHub Action configurations are missing.");
        return false;
    }

    const payload = {
        event_type: 'forward_file',
        client_payload: {
            TRANSFER_ID: transferId,
            MESSAGE_ID: transferRequest.messageId.toString(),
            CHAT_ID: transferRequest.chatId,
            FILE_NAME: transferRequest.fileName,
            FILE_SIZE: transferRequest.fileSize.toString(),
            IS_VIDEO: transferRequest.isVideo ? 'true' : 'false',
            SHOULD_COMPRESS: transferRequest.shouldCompress ? 'true' : 'false'
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
            return false;
        }
        return true;
    } catch (err) {
        console.error("Network error triggering GitHub Action:", err);
        return false;
    }
}