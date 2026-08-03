import { Env, TransferRequest } from '../types';

export async function triggerGitHubWorkflow(env: Env, transferId: string, transferRequest: TransferRequest): Promise<{ success: boolean; error?: string }> {
    const token = env.GITHUB_TOKEN;
    if (!token) {
        console.error("GITHUB_TOKEN is missing.");
        return { success: false, error: "GITHUB_TOKEN تنظیم نشده است." };
    }

    // Determine the correct GitHub API dispatch endpoint
    let dispatchUrl = env.GITHUB_ACTIONS_WEBHOOK;
    if (!dispatchUrl || !dispatchUrl.startsWith('https://api.github.com')) {
        const repo = env.GITHUB_REPO || 'PouryaHOZ/uploalink-mtproto-worker';
        dispatchUrl = `https://api.github.com/repos/${repo}/dispatches`;
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
        const res = await fetch(dispatchUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Cloudflare-Worker'
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`GitHub Dispatch Failed [HTTP ${res.status}]:`, errorText);
            return { success: false, error: `GitHub API HTTP ${res.status}: ${errorText.slice(0, 100)}` };
        }

        console.log("✅ GitHub Action Triggered Successfully!");
        return { success: true };
    } catch (err: any) {
        console.error("Network error triggering GitHub Action:", err);
        return { success: false, error: err.message || String(err) };
    }
}