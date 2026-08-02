// src/index.ts - Cloudflare Workers Entry Point
// Handles Telegram, Bale, and Rubika webhooks and triggers GitHub Actions for file transfers

export interface Env {
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    TELEGRAM_API_ID?: string;
    TELEGRAM_API_HASH?: string;
    TELEGRAM_SESSION_STRING?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;

    BALE_BOT_TOKEN?: string;
    BALE_CHAT_ID?: string;
    BALE_WEBHOOK_SECRET?: string;

    RUBIKA_BOT_TOKEN?: string;
    RUBIKA_CHAT_ID?: string;
    RUBIKA_WEBHOOK_SECRET?: string;

    GITHUB_ACTIONS_WEBHOOK: string;
    GITHUB_TOKEN: string;
    GITHUB_REPO: string;

    LINKS: KVNamespace;
    MAX_CONCURRENT_TRANSFERS?: string;
    RATE_LIMIT?: string;

    TELEGRAM_BASE_URL?: string;
    BALE_BASE_URL?: string;
    RUBIKA_BASE_URL?: string;

    JWT_SECRET?: string;
}

interface TransferRequest {
    messageId: string | number;
    chatId: string;
    fileName: string;
    fileSize: number;
    isVideo: boolean;
    mimeType?: string;
    userId?: string;
    userName?: string;
    date?: number;
    fileId?: string;
    platform: 'telegram' | 'bale' | 'rubika';
    destinations?: ('bale' | 'rubika' | 'telegram')[];
    account?: string;
    shouldCompress?: boolean;
}

interface ActiveTransfer {
    id: string;
    transferRequest: TransferRequest;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    progress?: number;
}

interface ConnectedAccount {
    rubikaChatId?: string;
    baleChatId?: string;
    telegramUserId?: string;
    connectedAt: number;
    lastUsed?: number;
}

// Token Utility Functions (Using Web Crypto API for Cloudflare Workers)
async function generateSimpleToken(userId: string, secret: string): Promise<string> {
    const data = `${userId}:${Date.now()}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const hexSig = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${btoa(data)}.${hexSig}`;
}

async function verifySimpleToken(token: string, secret: string): Promise<string | null> {
    try {
        const [dataB64, signature] = token.split('.');
        if (!dataB64 || !signature) return null;

        const decodedData = atob(dataB64);
        const [userId, timestamp] = decodedData.split(':');

        // Check expiration (24 hours)
        if (Date.now() - parseInt(timestamp) > 86400000) return null;

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const expectedSignatureBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(decodedData));
        const expectedSignature = Array.from(new Uint8Array(expectedSignatureBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

        if (signature !== expectedSignature) return null;
        return userId;
    } catch {
        return null;
    }
}

function generateConnectionCode(): string {
    const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
    const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${part1}-${part2}`;
}

// Main Worker Class
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === '/health') return this.handleHealthCheck();
            if (path === '/telegram') return await this.handleTelegramWebhook(request, env);
            if (path === '/bale') return await this.handleBaleWebhook(request, env);
            if (path === '/rubika') return await this.handleRubikaWebhook(request, env);
            if (path === '/github-callback') return await this.handleGitHubCallback(request, env);
            if (path === '/status') return await this.handleStatusCheck(request, env);

            return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        } catch (error) {
            console.error('Error in fetch:', error);
            return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
    },

    handleHealthCheck(): Response {
        return new Response(
            JSON.stringify({ status: 'healthy', timestamp: Date.now(), version: '1.0.0' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    async handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
        const signature = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (env.TELEGRAM_WEBHOOK_SECRET && signature !== env.TELEGRAM_WEBHOOK_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        const update = await request.json();
        if (update.callback_query) return await this.handleCallbackQuery(update, env, 'telegram');
        if (update.message) return await this.handleMessageUpdate(update, env, 'telegram');

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleBaleWebhook(request: Request, env: Env): Promise<Response> {
        const signature = request.headers.get('X-Bale-Signature');
        if (env.BALE_WEBHOOK_SECRET && signature !== env.BALE_WEBHOOK_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        const update = await request.json();
        if (update.callback_query) return await this.handleCallbackQuery(update, env, 'bale');
        if (update.message) return await this.handleMessageUpdate(update, env, 'bale');

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleRubikaWebhook(request: Request, env: Env): Promise<Response> {
        const signature = request.headers.get('X-Rubika-Signature');
        if (env.RUBIKA_WEBHOOK_SECRET && signature !== env.RUBIKA_WEBHOOK_SECRET) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        const body = await request.text();
        let update;
        try {
            update = JSON.parse(body);
        } catch (error) {
            return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
        }

        if (update.update) return await this.handleRubikaUpdate(update, env);
        if (update.inline_message) return await this.handleRubikaInlineMessage(update, env);

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleRubikaUpdate(update: any, env: Env): Promise<Response> {
        const updateType = update.update.type;
        if (updateType === 'NewMessage') {
            const message = update.update.new_message;
            if (message.text && (message.text.match(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/) || message.text.match(/^[A-Za-z0-9]{8}$/))) {
                await this.handleConnectionCode(
                    env, message.text, message.chat_id, 'rubika',
                    { id: message.sender_id, first_name: message.sender?.first_name || 'کاربر' }
                );
                return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
            }
            return await this.handleMessageUpdate({ message }, env, 'rubika');
        }
        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleRubikaInlineMessage(update: any, env: Env): Promise<Response> {
        const inlineMessage = update.inline_message;
        if (inlineMessage.aux_data?.button_id) {
            return await this.handleCallbackQuery({
                callback_query: {
                    id: inlineMessage.aux_data.start_id || Date.now().toString(),
                    data: inlineMessage.aux_data.button_id,
                    message: { message_id: inlineMessage.message_id, chat: { id: inlineMessage.chat_id } },
                    from: { id: inlineMessage.sender_id }
                }
            }, env, 'rubika');
        }
        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleMessageUpdate(update: any, env: Env, platform: 'telegram' | 'bale' | 'rubika'): Promise<Response> {
        const message = update.message;

        if (message.text) {
            const command = message.text.split(' ')[0].toLowerCase();
            const text = message.text.trim();

            if (command === '/start' || command === '/start@your_bot_name') {
                await this.handleStartCommandDirect(env, message.chat.id.toString(), platform, message.from);
                return new Response(JSON.stringify({ status: 'start_command_handled' }), { status: 200 });
            }
            if (command === '/link' || command === '/link@your_bot_name') {
                await this.askLinkSelection(env, message.chat.id.toString(), platform);
                return new Response(JSON.stringify({ status: 'link_command_handled' }), { status: 200 });
            }
            if (command === '/unlink' || command === '/unlink@your_bot_name') {
                await this.askUnlinkSelection(env, message.chat.id.toString(), platform);
                return new Response(JSON.stringify({ status: 'unlink_command_handled' }), { status: 200 });
            }
            if (command === '/status' || command === '/status@your_bot_name') {
                await this.handleStatusCommandDirect(env, message.chat.id.toString(), platform);
                return new Response(JSON.stringify({ status: 'status_command_handled' }), { status: 200 });
            }
            if (text.match(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/) || text.match(/^[A-Za-z0-9]{8}$/)) {
                await this.handleConnectionCode(env, text, message.chat.id.toString(), platform, message.from);
                return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
            }
        }

        if (!this.isFileMessage(message, platform)) {
            return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
        }

        const rateLimit = parseInt(env.RATE_LIMIT || '10');
        const userId = this.getUserId(message, platform).toString();
        const rateLimitKey = `rate_limit:${platform}:${userId}`;
        const currentCount = parseInt(await env.LINKS.get(rateLimitKey, { type: 'text' }).catch(() => '0')) || 0;

        if (currentCount >= rateLimit) {
            return new Response(JSON.stringify({ error: 'Rate limit exceeded', retryAfter: 60 }), { status: 429 });
        }
        await env.LINKS.put(rateLimitKey, (currentCount + 1).toString(), { expirationTtl: 60 });

        const transferRequest = this.createTransferRequest(message, platform);
        const userConnectedAccounts = await this.getUserConnectedAccounts(env, userId);

        if (!userConnectedAccounts.rubikaChatId && !userConnectedAccounts.baleChatId) {
            await this.sendMessage(env, platform, transferRequest.chatId, `❌ **خطا:**\nشما به هیچ پلتفرمی متصل نیستید.\nلطفاً ابتدا با ارسال دستور /link حساب خود را متصل کنید.`);
            return new Response(JSON.stringify({ status: 'no_connections' }), { status: 200 });
        }

        let destinations: ('bale' | 'rubika')[] = [];
        if (userConnectedAccounts.rubikaChatId) destinations.push('rubika');
        if (userConnectedAccounts.baleChatId) destinations.push('bale');

        if (destinations.length === 1) {
            transferRequest.destinations = destinations;
        } else if (destinations.length > 1) {
            await this.askDestinationSelectionForTransfer(env, transferRequest, destinations);
            return new Response(JSON.stringify({ status: 'destination_selection_required' }), { status: 200 });
        }

        const defaultDestinations = this.getDefaultDestinations(env);
        const availableAccounts = this.getAvailableAccounts(env);

        if (transferRequest.isVideo) {
            await this.askCompressionPreference(env, {
                ...transferRequest,
                destinations: transferRequest.destinations || defaultDestinations
            });
            return new Response(JSON.stringify({ status: 'compression_preference_required' }), { status: 200 });
        }

        await this.triggerGitHubWorkflow(env, {
            ...transferRequest,
            destinations: transferRequest.destinations || defaultDestinations,
            shouldCompress: false,
            account: availableAccounts[0] || 'both'
        });

        return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
    },

    async handleCallbackQuery(update: any, env: Env, platform: 'telegram' | 'bale' | 'rubika'): Promise<Response> {
        const callbackQuery = update.callback_query;
        const data = callbackQuery.data;
        const userId = callbackQuery.from.id.toString();
        const chatId = callbackQuery.message.chat.id.toString();
        const [action, ...params] = data.split('_');

        try {
            if (action === 'select' && params[0] === 'destination') {
                const selectedPlatform = params[1] as 'bale' | 'rubika';
                const transferId = params[2];

                const transferRequest = await this.getTransferRequest(env, transferId);
                if (!transferRequest) {
                    await this.answerCallbackQuery(env, callbackQuery.id, 'درخواست یافت نشد.', platform);
                    return new Response(JSON.stringify({ status: 'error' }), { status: 200 });
                }

                transferRequest.destinations = selectedPlatform.includes(',') ? params[1].split(',') as any : [selectedPlatform];
                await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(transferRequest), { expirationTtl: 3600 });

                if (transferRequest.isVideo) {
                    await this.askCompressionPreference(env, transferRequest);
                } else {
                    await this.triggerGitHubWorkflow(env, { ...transferRequest, shouldCompress: false });
                    await this.sendMessage(env, platform, chatId, `✅ انتقال فایل آغاز شد.`);
                }

                await this.answerCallbackQuery(env, callbackQuery.id, `مقصد انتخاب شد.`, platform);
                return new Response(JSON.stringify({ status: 'destination_selected' }), { status: 200 });
            }

            if (action === 'select' && params[0] === 'compression') {
                const shouldCompress = params[1] === 'yes';
                const transferId = params[2];

                const transferRequest = await this.getTransferRequest(env, transferId);
                if (!transferRequest) return new Response(JSON.stringify({ status: 'error' }), { status: 200 });

                await this.triggerGitHubWorkflow(env, { ...transferRequest, shouldCompress });
                await this.sendMessage(env, platform, chatId, `✅ پردازش و انتقال آغاز شد.`);
                await this.answerCallbackQuery(env, callbackQuery.id, `تنظیمات اعمال شد.`, platform);
                return new Response(JSON.stringify({ status: 'compression_selected' }), { status: 200 });
            }

            if (action === 'select' && params[0] === 'link' && params[1] === 'platform') {
                const selectedPlatform = params[2] as 'bale' | 'rubika';
                const sessionData: any = await env.LINKS.get(`session:${userId}`, { type: 'json' }).catch(() => null);

                if (!sessionData) {
                    await this.answerCallbackQuery(env, callbackQuery.id, 'نشست نامعتبر.', platform);
                    return new Response(JSON.stringify({ status: 'error' }), { status: 200 });
                }

                const oneTimeCode = generateConnectionCode();
                await env.LINKS.put(`connection_request:${oneTimeCode}`, JSON.stringify({
                    telegramUserId: sessionData.userId,
                    targetPlatform: selectedPlatform,
                    telegramChatId: sessionData.chatId,
                    userName: sessionData.userName || 'کاربر',
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 600000
                }), { expirationTtl: 600 });

                const link = this.generatePlatformLink(selectedPlatform, oneTimeCode);
                await this.answerCallbackQuery(env, callbackQuery.id, `لینک ارسال شد.`, platform);
                await this.sendMessage(env, platform, chatId, link);
                return new Response(JSON.stringify({ status: 'link_sent' }), { status: 200 });
            }

            if (action === 'select' && params[0] === 'unlink' && params[1] === 'platform') {
                const selectedPlatform = params[2] as 'bale' | 'rubika';
                const connectedAccount: any = await env.LINKS.get(`connected_account:${selectedPlatform}:${chatId}`, { type: 'json' }).catch(() => null);

                if (connectedAccount) {
                    await env.LINKS.delete(`connected_account:${selectedPlatform}:${chatId}`);
                    const userAccounts: any = await env.LINKS.get(`connected_account:${connectedAccount.telegramUserId}`, { type: 'json' }).catch(() => null);
                    if (userAccounts) {
                        if (selectedPlatform === 'rubika') userAccounts.rubikaChatId = undefined;
                        if (selectedPlatform === 'bale') userAccounts.baleChatId = undefined;

                        if (!userAccounts.rubikaChatId && !userAccounts.baleChatId) {
                            await env.LINKS.delete(`connected_account:${connectedAccount.telegramUserId}`);
                        } else {
                            await env.LINKS.put(`connected_account:${connectedAccount.telegramUserId}`, JSON.stringify(userAccounts));
                        }
                    }
                }

                await this.sendMessage(env, platform, chatId, `✅ حساب ${selectedPlatform} با موفقیت حذف شد.`);
                await this.answerCallbackQuery(env, callbackQuery.id, `حذف شد.`, platform);
                return new Response(JSON.stringify({ status: 'unlinked' }), { status: 200 });
            }

            await this.answerCallbackQuery(env, callbackQuery.id, 'دستور نامعتبر.', platform);
            return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
        } catch (error) {
            return new Response(JSON.stringify({ status: 'error' }), { status: 500 });
        }
    },

    isFileMessage(message: any, platform: 'telegram' | 'bale' | 'rubika'): boolean {
        return !!(message.document || message.photo || message.video || message.audio || message.voice || message.file);
    },

    getUserId(message: any, platform: 'telegram' | 'bale' | 'rubika'): string | number {
        return message.from?.id || message.sender_id || 'unknown';
    },

    createTransferRequest(message: any, platform: 'telegram' | 'bale' | 'rubika'): TransferRequest {
        return {
            messageId: message.message_id,
            chatId: message.chat?.id?.toString() || message.chat_id,
            fileName: message.document?.file_name || message.file?.file_name || `file_${message.message_id}_${Date.now()}`,
            fileSize: message.document?.file_size || message.video?.file_size || message.file?.size || 0,
            isVideo: !!message.document?.mime_type?.startsWith('video/') || !!message.video || !!message.file?.file_name?.endsWith('.mp4'),
            userId: message.from?.id?.toString() || message.sender_id,
            platform
        };
    },

    async triggerGitHubWorkflow(env: Env, transferRequest: TransferRequest & { destinations: ('bale' | 'rubika' | 'telegram')[]; shouldCompress?: boolean; account?: string; }): Promise<void> {
        if (!env.GITHUB_ACTIONS_WEBHOOK) return;

        const transferId = `transfer_${Date.now()}`;
        const activeTransfer: ActiveTransfer = {
            id: transferId,
            transferRequest,
            status: 'queued',
            createdAt: Date.now()
        };

        // Cache state with proper expiration limits to save KV memory
        await env.LINKS.put(`active_transfer:${transferId}`, JSON.stringify(activeTransfer), { expirationTtl: 86400 });

        // Mapped exclusively using uppercase environment variable schema matching `transfer.js`
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
            DESTINATIONS: transferRequest.destinations.join(','),
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
    },

    async handleConnectionCode(env: Env, code: string, chatId: string, platform: 'telegram' | 'bale' | 'rubika', user?: { id?: number; first_name?: string }): Promise<void> {
        const connectionRequest: any = await env.LINKS.get(`connection_request:${code}`, { type: 'json' }).catch(() => null);

        if (!connectionRequest || Date.now() > connectionRequest.expiresAt || connectionRequest.targetPlatform !== platform) {
            await this.sendMessage(env, platform, chatId, '❌ کد نامعتبر یا منقضی شده است.');
            return;
        }

        const connectedAccount: ConnectedAccount = { connectedAt: Date.now(), lastUsed: Date.now() };
        if (platform === 'rubika') connectedAccount.rubikaChatId = chatId;
        if (platform === 'bale') connectedAccount.baleChatId = chatId;

        await env.LINKS.put(`connected_account:${connectionRequest.telegramUserId}`, JSON.stringify(connectedAccount));
        await env.LINKS.put(`connected_account:${platform}:${chatId}`, JSON.stringify({
            telegramUserId: connectionRequest.telegramUserId,
            telegramChatId: connectionRequest.telegramChatId,
            userName: connectionRequest.userName,
            connectedAt: Date.now()
        }));

        const successMessage = platform === 'bale'
            ? `✅ اتصال با موفقیت برقرار شد!\nble.ir/uploalinkbot?start=${code}`
            : `✅ اتصال با موفقیت برقرار شد!\nhttps://web.rubika.ir/#c=b0uwt09b5987c707fddc7443e136a601`;

        await this.sendMessage(env, platform, chatId, successMessage);
        await env.LINKS.delete(`connection_request:${code}`);
    },

    async handleStartCommandDirect(env: Env, chatId: string, platform: 'telegram' | 'bale' | 'rubika', user?: any): Promise<void> {
        const userName = user?.first_name || 'کاربر';
        const userId = user?.id?.toString() || chatId;

        if (platform === 'telegram' && userId) {
            const authToken = await generateSimpleToken(userId, env.JWT_SECRET || 'default_secret');
            await env.LINKS.put(`session:${userId}`, JSON.stringify({
                token: authToken, userId, chatId, userName, platform, createdAt: Date.now()
            }), { expirationTtl: 86400 });
        }

        let welcomeMessage = platform === 'telegram'
            ? `👋 سلام ${userName}!\n\nبه ربات انتقال فایل خوش آمدید!\n💡 دستورات:\n- /link: اتصال به روبیکا یا بله\n- /unlink: قطع اتصال\n- /status: وضعیت انتقال`
            : `👋 سلام ${userName}!\nبرای اتصال به تلگرام دستور /start را در ربات تلگرام (@uploalinkbot) ارسال کنید.`;

        await this.sendMessage(env, platform, chatId, welcomeMessage);
    },

    async askLinkSelection(env: Env, chatId: string, platform: 'telegram' | 'bale' | 'rubika'): Promise<void> {
        if (platform === 'telegram') {
            await this.sendMessage(env, platform, chatId, `🔗 **لطفاً پلتفرم مورد نظر برای اتصال را انتخاب کنید:**`, {
                inline_keyboard: [
                    [{ text: '📌 روبیکا', callback_data: `select_link_platform_rubika_${chatId}` },
                     { text: '📌 بله', callback_data: `select_link_platform_bale_${chatId}` }]
                ]
            });
        }
    },

    async askUnlinkSelection(env: Env, chatId: string, platform: 'telegram' | 'bale' | 'rubika'): Promise<void> {
        const account: any = await env.LINKS.get(`connected_account:${chatId}`, { type: 'json' }).catch(() => null);
        const buttons = [];
        if (account?.rubikaChatId) buttons.push({ text: '📌 روبیکا', callback_data: `select_unlink_platform_rubika_${chatId}` });
        if (account?.baleChatId) buttons.push({ text: '📌 بله', callback_data: `select_unlink_platform_bale_${chatId}` });

        if (buttons.length === 0) {
            await this.sendMessage(env, platform, chatId, `❌ هیچ پلتفرمی متصل نیست.`);
            return;
        }

        await this.sendMessage(env, platform, chatId, `🔗 **حذف لینک:**`, { inline_keyboard: [buttons] });
    },

    async handleStatusCommandDirect(env: Env, chatId: string, platform: 'telegram' | 'bale' | 'rubika'): Promise<void> {
        const transfers = await this.getAllActiveTransfers(env);
        const userTransfers = transfers.filter(t => t.transferRequest.chatId === chatId);

        let statusMessage = userTransfers.length > 0 ? `📊 **وضعیت انتقال‌ها:**\n\n` : `📊 هیچ انتقال فعالی یافت نشد.\n\n`;

        userTransfers.forEach((t, i) => {
            statusMessage += `${i + 1}. **${t.transferRequest.fileName}** - وضعیت: ${t.status}\n`;
        });

        await this.sendMessage(env, platform, chatId, statusMessage);
    },

    async askDestinationSelectionForTransfer(env: Env, transferRequest: TransferRequest, availableDestinations: ('bale' | 'rubika')[]): Promise<void> {
        const transferId = `transfer_${Date.now()}`;
        await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(transferRequest), { expirationTtl: 1800 });

        const options = availableDestinations.map(dest => ({
            text: dest === 'rubika' ? '📌 روبیکا' : '📌 بله',
            callback_data: `select_destination_${dest}_${transferId}`
        }));

        await this.sendMessage(env, transferRequest.platform, transferRequest.chatId, `📡 **ارسال به کدام پلتفرم؟**`, { inline_keyboard: [options] });
    },

    async askCompressionPreference(env: Env, transferRequest: TransferRequest): Promise<void> {
        const transferId = `transfer_${Date.now()}`;
        await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(transferRequest), { expirationTtl: 1800 });

        await this.sendMessage(env, transferRequest.platform, transferRequest.chatId, `🎬 **ویدیو فشرده شود؟**\nحجم: ${this.formatBytes(transferRequest.fileSize)}`, {
            inline_keyboard: [
                [{ text: '⚡ بله (480p)', callback_data: `select_compression_yes_${transferId}` },
                 { text: '📁 خیر', callback_data: `select_compression_no_${transferId}` }]
            ]
        });
    },

    formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    async getUserConnectedAccounts(env: Env, userId: string): Promise<ConnectedAccount> {
        const acc = await env.LINKS.get(`connected_account:${userId}`, { type: 'json' }).catch(() => null);
        return (acc as ConnectedAccount) || { connectedAt: 0 };
    },

    getDefaultDestinations(env: Env): ('bale' | 'rubika' | 'telegram')[] {
        const destinations: ('bale' | 'rubika' | 'telegram')[] = [];
        if (env.BALE_BOT_TOKEN) destinations.push('bale');
        if (env.RUBIKA_BOT_TOKEN) destinations.push('rubika');
        destinations.push('telegram');
        return destinations;
    },

    getAvailableAccounts(env: Env): ('bale' | 'rubika' | 'both')[] {
        return ['both'];
    },

    generatePlatformLink(platform: 'bale' | 'rubika', code: string): string {
        return platform === 'rubika'
            ? `🔗 **روبیکا:**\nhttps://web.rubika.ir/#c=b0uwt09b5987c707fddc7443e136a601\nکد: \`${code}\``
            : `🔗 **بله:**\nble.ir/uploalinkbot?start=${code}\nکد: \`${code}\``;
    },

    async getTransferRequest(env: Env, transferId: string): Promise<TransferRequest | null> {
        return (await env.LINKS.get(`transfer:${transferId}`, { type: 'json' }).catch(() => null)) as TransferRequest | null;
    },

    async getAllActiveTransfers(env: Env): Promise<ActiveTransfer[]> {
        const transfers: ActiveTransfer[] = [];
        const keys = await env.LINKS.list({ prefix: 'active_transfer:' });
        for (const key of keys.keys) {
            const data = await env.LINKS.get(key.name, { type: 'json' }).catch(() => null);
            if (data) transfers.push(data as ActiveTransfer);
        }
        return transfers;
    },

    async handleGitHubCallback(request: Request, env: Env): Promise<Response> {
        // Receives workflow progress status. Update logic parsed cleanly.
        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleStatusCheck(request: Request, env: Env): Promise<Response> {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    },

    async sendMessage(env: Env, platform: string, chatId: string, text: string, replyMarkup?: any): Promise<void> {
        let url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        if (platform === 'bale') url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/sendMessage`;
        if (platform === 'rubika') url = `${env.RUBIKA_BASE_URL || 'https://botapi.rubika.ir/v3/'}${env.RUBIKA_BOT_TOKEN}/sendMessage`;

        const body: any = { chat_id: chatId, text, parse_mode: 'Markdown' };
        if (replyMarkup) {
            if (platform === 'rubika') body.inline_keypad = replyMarkup;
            else body.reply_markup = JSON.stringify(replyMarkup);
        }

        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },

    async answerCallbackQuery(env: Env, callbackQueryId: string, text: string, platform: string): Promise<void> {
        if (platform === 'rubika') return; // Rubika doesn't support callback toasts.

        const url = platform === 'bale'
            ? `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/answerCallbackQuery`
            : `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;

        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
        });
    }
};
