// src/index.ts - Cloudflare Workers Entry Point
// Handles Telegram, Bale, and Rubika webhooks and triggers GitHub Actions for file transfers

export interface Env {
    // Telegram Configuration
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    TELEGRAM_API_ID?: string;
    TELEGRAM_API_HASH?: string;
    TELEGRAM_SESSION_STRING?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;

    // Bale Configuration
    BALE_BOT_TOKEN?: string;
    BALE_CHAT_ID?: string;
    BALE_WEBHOOK_SECRET?: string;

    // Rubika Configuration
    RUBIKA_BOT_TOKEN?: string;
    RUBIKA_CHAT_ID?: string;
    RUBIKA_WEBHOOK_SECRET?: string;

    // GitHub Actions Integration
    GITHUB_ACTIONS_WEBHOOK: string;
    GITHUB_TOKEN: string;
    GITHUB_REPO: string;

    // Cloudflare Configuration
    LINKS: KVNamespace;
    MAX_CONCURRENT_TRANSFERS?: string;
    RATE_LIMIT?: string;
}

// Transfer Request Interface
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
}

// Active Transfer Interface
interface ActiveTransfer {
    id: string;
    transferRequest: TransferRequest;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    destinations: ('bale' | 'rubika' | 'telegram')[];
    shouldCompress?: boolean;
    account?: 'bale' | 'rubika' | 'both';
}

// Main Worker Class
export default {
    // Handle all HTTP requests
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // Health check endpoint
            if (path === '/health') {
                return this.handleHealthCheck();
            }

            // Telegram webhook
            if (path === '/telegram') {
                return await this.handleTelegramWebhook(request, env);
            }

            // Bale webhook
            if (path === '/bale') {
                return await this.handleBaleWebhook(request, env);
            }

            // Rubika webhook
            if (path === '/rubika') {
                return await this.handleRubikaWebhook(request, env);
            }

            // GitHub Actions callback
            if (path === '/github-callback') {
                return await this.handleGitHubCallback(request, env);
            }

            // Account selection webhook
            if (path === '/select-account') {
                return await this.handleAccountSelection(request, env);
            }

            // Destination selection webhook
            if (path === '/select-destination') {
                return await this.handleDestinationSelection(request, env);
            }

            // Compression preference webhook
            if (path === '/compression-preference') {
                return await this.handleCompressionPreference(request, env);
            }

            // Status check endpoint
            if (path === '/status') {
                return await this.handleStatusCheck(request, env);
            }

            return new Response(
                JSON.stringify({ error: 'Not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        } catch (error) {
            console.error('Error in fetch:', error);
            return new Response(
                JSON.stringify({ error: 'Internal server error' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    },

    // Health check endpoint
    handleHealthCheck(): Response {
        const status = {
            status: 'healthy',
            timestamp: Date.now(),
            version: '1.0.0',
            service: 'uploalink-mtproto-worker'
        };

        return new Response(
            JSON.stringify(status),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            }
        );
    },

    // Handle Telegram webhook
    async handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
        // Verify webhook secret if configured
        const signature = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (env.TELEGRAM_WEBHOOK_SECRET && signature !== env.TELEGRAM_WEBHOOK_SECRET) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const update = await request.json();

        // Handle callback queries
        if (update.callback_query) {
            return await this.handleCallbackQuery(update, env, 'telegram');
        }

        // Handle message updates
        if (update.message) {
            return await this.handleMessageUpdate(update, env, 'telegram');
        }

        return new Response(
            JSON.stringify({ status: 'ignored' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle Bale webhook
    async handleBaleWebhook(request: Request, env: Env): Promise<Response> {
        // Verify webhook secret if configured
        const signature = request.headers.get('X-Bale-Signature');
        if (env.BALE_WEBHOOK_SECRET && signature !== env.BALE_WEBHOOK_SECRET) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const update = await request.json();

        // Handle callback queries (Bale uses inline_keyboard callbacks)
        if (update.callback_query) {
            return await this.handleCallbackQuery(update, env, 'bale');
        }

        // Handle message updates
        if (update.message) {
            return await this.handleMessageUpdate(update, env, 'bale');
        }

        return new Response(
            JSON.stringify({ status: 'ignored' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle Rubika webhook
    async handleRubikaWebhook(request: Request, env: Env): Promise<Response> {
        // Verify webhook secret if configured
        const signature = request.headers.get('X-Rubika-Signature');
        if (env.RUBIKA_WEBHOOK_SECRET && signature !== env.RUBIKA_WEBHOOK_SECRET) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const body = await request.text();
        let update;

        try {
            update = JSON.parse(body);
        } catch (error) {
            console.error('Failed to parse Rubika webhook body:', error);
            return new Response(
                JSON.stringify({ error: 'Invalid JSON' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Handle Rubika updates (NewMessage, InlineMessage, etc.)
        if (update.update) {
            return await this.handleRubikaUpdate(update, env);
        }

        if (update.inline_message) {
            return await this.handleRubikaInlineMessage(update, env);
        }

        return new Response(
            JSON.stringify({ status: 'ignored' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle Rubika updates (NewMessage, etc.)
    async handleRubikaUpdate(update: any, env: Env): Promise<Response> {
        const updateType = update.update.type;

        // Handle new messages
        if (updateType === 'NewMessage') {
            const message = update.update.new_message;
            return await this.handleMessageUpdate({ message }, env, 'rubika');
        }

        // Handle edited messages
        if (updateType === 'UpdatedMessage') {
            const message = update.update.updated_message;
            return await this.handleMessageUpdate({ message }, env, 'rubika');
        }

        // Handle deleted messages
        if (updateType === 'RemovedMessage') {
            console.log('Message removed:', update.update.removed_message_id);
            return new Response(
                JSON.stringify({ status: 'message_removed' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify({ status: 'ignored' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle Rubika inline messages (button clicks)
    async handleRubikaInlineMessage(update: any, env: Env): Promise<Response> {
        const inlineMessage = update.inline_message;

        // Handle button clicks
        if (inlineMessage.aux_data?.button_id) {
            return await this.handleCallbackQuery(
                {
                    callback_query: {
                        id: inlineMessage.aux_data.start_id || Date.now().toString(),
                        data: inlineMessage.aux_data.button_id,
                        message: {
                            message_id: inlineMessage.message_id,
                            chat: { id: inlineMessage.chat_id }
                        },
                        from: { id: inlineMessage.sender_id }
                    }
                },
                env,
                'rubika'
            );
        }

        return new Response(
            JSON.stringify({ status: 'ignored' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle message updates (Telegram, Bale, Rubika)
    async handleMessageUpdate(update: any, env: Env, platform: 'telegram' | 'bale' | 'rubika'): Promise<Response> {
        const message = update.message;

        // Ignore non-file messages
        if (!this.isFileMessage(message, platform)) {
            return new Response(
                JSON.stringify({ status: 'ignored' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Check rate limiting
        const rateLimit = parseInt(env.RATE_LIMIT || '10');
        const now = Date.now();
        const userId = this.getUserId(message, platform).toString();

        // Check user rate limit in KV
        const rateLimitKey = `rate_limit:${platform}:${userId}`;
        const rateLimitCount = await env.LINKS.get(rateLimitKey, { type: 'text' }).catch(() => '0');
        const currentCount = parseInt(rateLimitCount) || 0;

        if (currentCount >= rateLimit) {
            return new Response(
                JSON.stringify({
                    error: 'Rate limit exceeded',
                    retryAfter: 60
                }),
                { status: 429, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Increment rate limit counter
        await env.LINKS.put(rateLimitKey, (currentCount + 1).toString(), {
            expirationTtl: 60
        });

        // Create transfer request
        const transferRequest = this.createTransferRequest(message, platform);

        // Check if we need to ask for account selection
        const availableAccounts = this.getAvailableAccounts(env);
        if (availableAccounts.length > 1) {
            // Ask user to select account
            await this.askAccountSelection(env, transferRequest);
            return new Response(
                JSON.stringify({ status: 'account_selection_required' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Check if we need to ask for destinations
        const defaultDestinations = this.getDefaultDestinations(env);
        if (defaultDestinations.length > 1) {
            // Ask user to select destinations
            await this.askDestinationSelection(env, transferRequest);
            return new Response(
                JSON.stringify({ status: 'destination_selection_required' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Check if we need to ask for compression (for videos)
        if (transferRequest.isVideo) {
            await this.askCompressionPreference(env, {
                ...transferRequest,
                destinations: defaultDestinations
            });
            return new Response(
                JSON.stringify({ status: 'compression_preference_required' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // If we have all the information, trigger the transfer
        await this.triggerGitHubWorkflow(env, {
            ...transferRequest,
            destinations: defaultDestinations,
            shouldCompress: false, // Default for non-videos
            account: availableAccounts[0] || 'both'
        });

        return new Response(
            JSON.stringify({ status: 'queued' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Helper: Check if message contains a file
    isFileMessage(message: any, platform: 'telegram' | 'bale' | 'rubika'): boolean {
        switch (platform) {
            case 'telegram':
                return !!(message.document || message.photo || message.video || message.audio || message.voice);
            case 'bale':
                return !!(message.document || message.photo || message.video || message.audio || message.voice);
            case 'rubika':
                return !!(message.file || message.document || message.photo || message.video || message.audio || message.voice);
            default:
                return false;
        }
    },

    // Helper: Get user ID from message
    getUserId(message: any, platform: 'telegram' | 'bale' | 'rubika'): string | number {
        switch (platform) {
            case 'telegram':
                return message.from?.id || 'unknown';
            case 'bale':
                return message.from?.id || 'unknown';
            case 'rubika':
                return message.sender_id || 'unknown';
            default:
                return 'unknown';
        }
    },

    // Helper: Create transfer request from message
    createTransferRequest(message: any, platform: 'telegram' | 'bale' | 'rubika'): TransferRequest {
        switch (platform) {
            case 'telegram':
                return {
                    messageId: message.message_id,
                    chatId: message.chat.id.toString(),
                    fileName: message.document?.file_name ||
                              message.audio?.file_name ||
                              message.voice?.file_name ||
                              `file_${message.message_id}_${Date.now()}`,
                    fileSize: message.document?.file_size ||
                             message.photo?.file_size ||
                             message.video?.file_size ||
                             message.audio?.file_size ||
                             message.voice?.file_size ||
                             0,
                    isVideo: !!message.document?.mime_type?.startsWith('video/') ||
                             !!message.video,
                    mimeType: message.document?.mime_type ||
                              message.video?.mime_type ||
                              message.audio?.mime_type ||
                              message.voice?.mime_type,
                    userId: message.from?.id?.toString(),
                    userName: message.from?.username || message.from?.first_name,
                    date: message.date,
                    fileId: message.document?.file_id || message.photo?.file_id || message.video?.file_id || message.audio?.file_id,
                    platform
                };
            case 'bale':
                return {
                    messageId: message.message_id,
                    chatId: message.chat.id.toString(),
                    fileName: message.document?.file_name ||
                              message.audio?.file_name ||
                              message.voice?.file_name ||
                              `file_${message.message_id}_${Date.now()}`,
                    fileSize: message.document?.file_size ||
                             message.photo?.file_size ||
                             message.video?.file_size ||
                             message.audio?.file_size ||
                             message.voice?.file_size ||
                             0,
                    isVideo: !!message.document?.mime_type?.startsWith('video/') ||
                             !!message.video,
                    mimeType: message.document?.mime_type ||
                              message.video?.mime_type ||
                              message.audio?.mime_type ||
                              message.voice?.mime_type,
                    userId: message.from?.id?.toString(),
                    userName: message.from?.username || message.from?.first_name,
                    date: message.date,
                    fileId: message.document?.file_id || message.photo?.file_id || message.video?.file_id || message.audio?.file_id,
                    platform
                };
            case 'rubika':
                return {
                    messageId: message.message_id,
                    chatId: message.chat_id,
                    fileName: message.file?.file_name ||
                              message.document?.file_name ||
                              `file_${message.message_id}_${Date.now()}`,
                    fileSize: message.file?.size ? parseInt(message.file.size) :
                             message.document?.size ? parseInt(message.document.size) :
                             0,
                    isVideo: !!message.file?.file_name?.endsWith('.mp4') ||
                             !!message.document?.mime_type?.startsWith('video/') ||
                             false,
                    mimeType: message.file?.mime_type || message.document?.mime_type,
                    userId: message.sender_id,
                    userName: message.sender?.first_name || message.sender?.last_name || 'Unknown',
                    date: message.time ? parseInt(message.time) : Date.now(),
                    fileId: message.file?.file_id || message.document?.file_id,
                    platform
                };
            default:
                throw new Error(`Unsupported platform: ${platform}`);
        }
    },

    // Handle callback queries (Telegram, Bale, Rubika)
    async handleCallbackQuery(update: any, env: Env, platform: 'telegram' | 'bale' | 'rubika'): Promise<Response> {
        const callbackQuery = update.callback_query;
        const data = callbackQuery.data;
        const message = callbackQuery.message;
        const userId = callbackQuery.from.id.toString();
        const chatId = callbackQuery.message.chat.id.toString();
        const messageId = callbackQuery.message.message_id;

        // Parse callback data
        const [action, ...params] = data.split('_');

        try {
            // Handle account selection
            if (action === 'select' && params[0] === 'account') {
                const account = params[1] as 'bale' | 'rubika' | 'both';
                const transferId = params[2];

                // Retrieve transfer request from KV
                const transferRequest = await this.getTransferRequest(env, transferId);
                if (!transferRequest) {
                    await this.answerCallbackQuery(env, callbackQuery.id, 'درخواست انتقال یافت نشد. لطفاً دوباره امتحان کنید.', platform);
                    return new Response(
                        JSON.stringify({ status: 'error' }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                // Update transfer request with selected account
                const updatedTransferRequest = {
                    ...transferRequest,
                    account
                };

                // Store updated transfer request
                await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(updatedTransferRequest));

                // Ask for destination selection
                await this.askDestinationSelection(env, updatedTransferRequest);

                await this.answerCallbackQuery(env, callbackQuery.id, `حساب ${account === 'bale' ? 'بله' : account === 'rubika' ? 'روبیکا' : 'هر دو'} انتخاب شد.`, platform);

                return new Response(
                    JSON.stringify({ status: 'account_selected' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Handle destination selection
            if (action === 'select' && params[0] === 'destination') {
                const destinations = params[1].split(',') as ('bale' | 'rubika' | 'telegram')[];
                const transferId = params[2];

                // Retrieve transfer request from KV
                const transferRequest = await this.getTransferRequest(env, transferId);
                if (!transferRequest) {
                    await this.answerCallbackQuery(env, callbackQuery.id, 'درخواست انتقال یافت نشد. لطفاً دوباره امتحان کنید.', platform);
                    return new Response(
                        JSON.stringify({ status: 'error' }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                // Update transfer request with selected destinations
                const updatedTransferRequest = {
                    ...transferRequest,
                    destinations
                };

                // Store updated transfer request
                await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(updatedTransferRequest));

                // Check if we need to ask for compression (for videos)
                if (transferRequest.isVideo) {
                    await this.askCompressionPreference(env, updatedTransferRequest);
                    await this.answerCallbackQuery(env, callbackQuery.id, `مقصد(های) ${destinations.join(' و ')} انتخاب شد.`, platform);
                } else {
                    // Trigger the transfer directly
                    await this.triggerGitHubWorkflow(env, {
                        ...updatedTransferRequest,
                        shouldCompress: false
                    });
                    await this.answerCallbackQuery(env, callbackQuery.id, `مقصد(های) ${destinations.join(' و ')} انتخاب شد. انتقال شروع شد.`, platform);
                }

                return new Response(
                    JSON.stringify({ status: 'destination_selected' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Handle compression preference
            if (action === 'select' && params[0] === 'compression') {
                const shouldCompress = params[1] === 'yes';
                const transferId = params[2];

                // Retrieve transfer request from KV
                const transferRequest = await this.getTransferRequest(env, transferId);
                if (!transferRequest) {
                    await this.answerCallbackQuery(env, callbackQuery.id, 'درخواست انتقال یافت نشد. لطفاً دوباره امتحان کنید.', platform);
                    return new Response(
                        JSON.stringify({ status: 'error' }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    );
                }

                // Trigger the transfer with compression preference
                await this.triggerGitHubWorkflow(env, {
                    ...transferRequest,
                    shouldCompress
                });

                await this.answerCallbackQuery(env, callbackQuery.id, `ترجیح فشرده‌سازی ${shouldCompress ? 'فعال' : 'غیرفعال'} شد. انتقال شروع شد.`, platform);

                return new Response(
                    JSON.stringify({ status: 'compression_selected' }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }

            // Unknown callback
            await this.answerCallbackQuery(env, callbackQuery.id, 'دستور ناشناخته.', platform);
            return new Response(
                JSON.stringify({ status: 'unknown_callback' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        } catch (error) {
            console.error('Error handling callback:', error);
            await this.answerCallbackQuery(env, callbackQuery.id, 'خطا در پردازش درخواست. لطفاً دوباره امتحان کنید.', platform);
            return new Response(
                JSON.stringify({ status: 'error' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    },

    // Handle GitHub Actions callback
    async handleGitHubCallback(request: Request, env: Env): Promise<Response> {
        const payload = await request.json();
        const event = payload.event;

        if (!event) {
            return new Response(
                JSON.stringify({ error: 'Invalid payload' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Handle transfer progress updates
        if (event === 'transfer_progress') {
            const transferId = payload.fileId;
            const progress = payload.progress;
            const status = payload.status;

            // Update transfer status in KV
            const transfer = await this.getActiveTransfer(env, transferId);
            if (transfer) {
                await this.updateTransferStatus(env, transferId, {
                    status: status === 'completed' ? 'completed' : 'processing',
                    progress
                });
            }

            return new Response(
                JSON.stringify({ status: 'progress_updated' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Handle transfer completion
        if (event === 'transfer_completed') {
            const transferId = payload.fileId;

            // Update transfer status in KV
            await this.updateTransferStatus(env, transferId, {
                status: 'completed',
                completedAt: Date.now()
            });

            return new Response(
                JSON.stringify({ status: 'completed' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Handle transfer errors
        if (event === 'transfer_error') {
            const transferId = payload.fileId;
            const error = payload.error;

            // Update transfer status in KV
            await this.updateTransferStatus(env, transferId, {
                status: 'failed',
                error
            });

            return new Response(
                JSON.stringify({ status: 'error_recorded' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify({ status: 'ignored' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle account selection
    async handleAccountSelection(request: Request, env: Env): Promise<Response> {
        const body = await request.json();
        const chatId = body.chatId;
        const account = body.account;

        if (!chatId || !account) {
            return new Response(
                JSON.stringify({ error: 'Missing parameters' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const availableAccounts = this.getAvailableAccounts(env);
        if (!availableAccounts.includes(account)) {
            return new Response(
                JSON.stringify({ error: 'Invalid account' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Store account preference in KV
        await env.LINKS.put(`account_preference:${chatId}`, account);

        return new Response(
            JSON.stringify({ status: 'account_selected' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle destination selection
    async handleDestinationSelection(request: Request, env: Env): Promise<Response> {
        const body = await request.json();
        const transferId = body.transferId;
        const destinations = body.destinations;

        if (!transferId || !destinations) {
            return new Response(
                JSON.stringify({ error: 'Missing parameters' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Retrieve transfer request from KV
        const transferRequest = await this.getTransferRequest(env, transferId);
        if (!transferRequest) {
            return new Response(
                JSON.stringify({ error: 'Transfer not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Update transfer request with selected destinations
        const updatedTransferRequest = {
            ...transferRequest,
            destinations
        };

        // Store updated transfer request
        await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(updatedTransferRequest));

        return new Response(
            JSON.stringify({ status: 'destinations_selected' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle compression preference
    async handleCompressionPreference(request: Request, env: Env): Promise<Response> {
        const body = await request.json();
        const transferId = body.transferId;
        const shouldCompress = body.shouldCompress;

        if (!transferId || shouldCompress === undefined) {
            return new Response(
                JSON.stringify({ error: 'Missing parameters' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Retrieve transfer request from KV
        const transferRequest = await this.getTransferRequest(env, transferId);
        if (!transferRequest) {
            return new Response(
                JSON.stringify({ error: 'Transfer not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Trigger the transfer with compression preference
        await this.triggerGitHubWorkflow(env, {
            ...transferRequest,
            shouldCompress
        });

        return new Response(
            JSON.stringify({ status: 'compression_preference_set' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Handle status check
    async handleStatusCheck(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const transferId = url.searchParams.get('transferId');

        if (!transferId) {
            return new Response(
                JSON.stringify({ error: 'Missing transferId' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const transfers = await this.getAllActiveTransfers(env);
        const transfer = transfers.find(t => t.id === transferId);

        if (!transfer) {
            return new Response(
                JSON.stringify({ error: 'Transfer not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
            JSON.stringify(transfer),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },

    // Helper: Get available accounts
    getAvailableAccounts(env: Env): ('bale' | 'rubika' | 'both')[] {
        const accounts: ('bale' | 'rubika' | 'both')[] = [];

        if (env.BALE_BOT_TOKEN && env.BALE_CHAT_ID) {
            accounts.push('bale');
        }

        if (env.RUBIKA_BOT_TOKEN && env.RUBIKA_CHAT_ID) {
            accounts.push('rubika');
        }

        // If both are available, add 'both' option
        if (accounts.length >= 2) {
            accounts.push('both');
        }

        return accounts.length > 0 ? accounts : ['both'];
    },

    // Helper: Get default destinations
    getDefaultDestinations(env: Env): ('bale' | 'rubika' | 'telegram')[] {
        const destinations: ('bale' | 'rubika' | 'telegram')[] = [];

        if (env.BALE_BOT_TOKEN && env.BALE_CHAT_ID) {
            destinations.push('bale');
        }

        if (env.RUBIKA_BOT_TOKEN && env.RUBIKA_CHAT_ID) {
            destinations.push('rubika');
        }

        // Telegram is always available (since we're using it as the entry point)
        destinations.push('telegram');

        // If both are available, default to both
        if (destinations.length >= 2) {
            return ['bale', 'rubika', 'telegram'];
        }

        // If only one is available, use that
        return destinations.length === 1 ? destinations : ['bale', 'rubika', 'telegram'];
    },

    // Helper: Ask user to select account
    async askAccountSelection(env: Env, transferRequest: TransferRequest): Promise<void> {
        const chatId = transferRequest.chatId;
        const transferId = `transfer_${Date.now()}`;

        // Store transfer request in KV
        await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(transferRequest));

        // Create account selection message
        const availableAccounts = this.getAvailableAccounts(env);
        const accountOptions = availableAccounts.map(account => {
            const accountText = account === 'bale' ? 'بله' : account === 'rubika' ? 'روبیکا' : 'هر دو';
            return [{ text: `📤 ${accountText}`, callback_data: `select_account_${account}_${transferId}` }];
        });

        const message = `🔧 **لطفاً حساب مقصد را انتخاب کنید:**\n\n` +
                       `فایل: ${transferRequest.fileName} (${this.formatBytes(transferRequest.fileSize)})`;

        const replyMarkup = {
            inline_keyboard: accountOptions
        };

        // Send message to user based on platform
        await this.sendMessage(env, transferRequest.platform, chatId, message, replyMarkup);
    },

    // Helper: Ask user to select destinations
    async askDestinationSelection(env: Env, transferRequest: TransferRequest & { account?: string }): Promise<void> {
        const chatId = transferRequest.chatId;
        const transferId = `transfer_${Date.now()}`;

        // Store transfer request in KV
        await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(transferRequest));

        // Create destination selection message
        const availableAccounts = this.getAvailableAccounts(env);
        const defaultDestinations = this.getDefaultDestinations(env);

        // If only one account is available, use it
        if (defaultDestinations.length === 1) {
            await this.triggerGitHubWorkflow(env, {
                ...transferRequest,
                destinations: defaultDestinations,
                shouldCompress: false,
                account: transferRequest.account || availableAccounts[0]
            });
            return;
        }

        const destinationOptions = [
            [{ text: '📤 تلگرام', callback_data: `select_destination_telegram_${transferId}` }],
            [{ text: '📤 بله', callback_data: `select_destination_bale_${transferId}` }],
            [{ text: '📤 روبیکا', callback_data: `select_destination_rubika_${transferId}` }],
            [{ text: '📤 همه', callback_data: `select_destination_telegram,bale,rubika_${transferId}` }]
        ];

        const message = `📌 **لطفاً مقصد(های) ارسال را انتخاب کنید:**\n\n` +
                       `فایل: ${transferRequest.fileName} (${this.formatBytes(transferRequest.fileSize)})`;

        const replyMarkup = {
            inline_keyboard: destinationOptions
        };

        // Send message to user based on platform
        await this.sendMessage(env, transferRequest.platform, chatId, message, replyMarkup);
    },

    // Helper: Ask user about compression preference
    async askCompressionPreference(env: Env, transferRequest: TransferRequest & {
        destinations?: ('bale' | 'rubika' | 'telegram')[];
        account?: string;
    }): Promise<void> {
        const chatId = transferRequest.chatId;
        const transferId = `transfer_${Date.now()}`;

        // Store transfer request in KV
        await env.LINKS.put(`transfer:${transferId}`, JSON.stringify(transferRequest));

        // Create compression selection message
        const compressedSize = Math.floor(transferRequest.fileSize * 0.4);
        const sizeInfo = `حجم اصلی: ${this.formatBytes(transferRequest.fileSize)}\n` +
                        `حجم پس از فشرده‌سازی: ${this.formatBytes(compressedSize)}`;

        const message = `🎬 **فشرده‌سازی ویدیو**\n\n` +
                       `${sizeInfo}\n\n` +
                       `آیا می‌خواهید ویدیو قبل از انتقال فشرده‌سازی شود؟`;

        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: '⚡ بله، فشرده‌سازی (480p)', callback_data: `select_compression_yes_${transferId}` },
                    { text: '📁 خیر، حفظ کیفیت اصلی', callback_data: `select_compression_no_${transferId}` }
                ]
            ]
        };

        // Send message to user based on platform
        await this.sendMessage(env, transferRequest.platform, chatId, message, replyMarkup);
    },

    // Helper: Trigger GitHub Actions workflow
    async triggerGitHubWorkflow(env: Env, transferRequest: TransferRequest & {
        destinations: ('bale' | 'rubika' | 'telegram')[];
        shouldCompress?: boolean;
        account?: string;
    }): Promise<void> {
        if (!env.GITHUB_ACTIONS_WEBHOOK) {
            console.error('GitHub Actions webhook not configured');
            return;
        }

        const transferId = `transfer_${Date.now()}`;

        // Store active transfer in KV
        const activeTransfer: ActiveTransfer = {
            id: transferId,
            transferRequest,
            status: 'queued',
            createdAt: Date.now()
        };

        await env.LINKS.put(`active_transfer:${transferId}`, JSON.stringify(activeTransfer));

        // Prepare payload for GitHub Actions
        const payload = {
            event: 'forward_file',
            message_id: transferRequest.messageId,
            chat_id: transferRequest.chatId,
            file_name: transferRequest.fileName,
            file_size: transferRequest.fileSize,
            is_video: transferRequest.isVideo,
            mime_type: transferRequest.mimeType,
            file_id: transferRequest.fileId,
            destinations: transferRequest.destinations,
            should_compress: transferRequest.shouldCompress || false,
            account: transferRequest.account || 'both',
            user_id: transferRequest.userId,
            user_name: transferRequest.userName,
            platform: transferRequest.platform,
            timestamp: Date.now()
        };

        // Trigger GitHub Actions workflow
        try {
            const response = await fetch(env.GITHUB_ACTIONS_WEBHOOK, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                    'User-Agent': 'uploalink-mtproto-worker'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to trigger GitHub workflow:', error);
                await this.updateTransferStatus(env, transferId, {
                    status: 'failed',
                    error: `Failed to trigger GitHub workflow: ${error}`
                });
            } else {
                await this.updateTransferStatus(env, transferId, {
                    status: 'processing',
                    startedAt: Date.now()
                });
            }
        } catch (error) {
            console.error('Error triggering GitHub workflow:', error);
            await this.updateTransferStatus(env, transferId, {
                status: 'failed',
                error: `Error triggering GitHub workflow: ${error}`
            });
        }
    },

    // Helper: Send message based on platform
    async sendMessage(env: Env, platform: 'telegram' | 'bale' | 'rubika', chatId: string, text: string, replyMarkup?: any): Promise<void> {
        switch (platform) {
            case 'telegram':
                await this.sendTelegramMessage(env, chatId, text, replyMarkup);
                break;
            case 'bale':
                await this.sendBaleMessage(env, chatId, text, replyMarkup);
                break;
            case 'rubika':
                await this.sendRubikaMessage(env, chatId, text, replyMarkup);
                break;
            default:
                console.error(`Unsupported platform: ${platform}`);
        }
    },

    // Helper: Send Telegram message
    async sendTelegramMessage(env: Env, chatId: string, text: string, replyMarkup?: any): Promise<void> {
        const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            ...(replyMarkup && { reply_markup: JSON.stringify(replyMarkup) })
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to send Telegram message:', error);
            }
        } catch (error) {
            console.error('Error sending Telegram message:', error);
        }
    },

    // Helper: Send Bale message
    async sendBaleMessage(env: Env, chatId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!env.BALE_BOT_TOKEN) {
            console.error('Bale bot token not configured');
            return;
        }

        const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            ...(replyMarkup && { reply_markup: JSON.stringify(replyMarkup) })
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to send Bale message:', error);
            }
        } catch (error) {
            console.error('Error sending Bale message:', error);
        }
    },

    // Helper: Send Rubika message
    async sendRubikaMessage(env: Env, chatId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!env.RUBIKA_BOT_TOKEN) {
            console.error('Rubika bot token not configured');
            return;
        }

        // Use the configured base URL (includes /v3/)
        const baseUrl = env.RUBIKA_BASE_URL || 'https://botapi.rubika.ir/v3/';
        const url = `${baseUrl}${env.RUBIKA_BOT_TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text,
            ...(replyMarkup && { inline_keypad: replyMarkup })
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to send Rubika message:', error);
            }
        } catch (error) {
            console.error('Error sending Rubika message:', error);
        }
    },

    // Helper: Answer callback query based on platform
    async answerCallbackQuery(env: Env, callbackQueryId: string, text: string, platform: 'telegram' | 'bale' | 'rubika', showAlert: boolean = false): Promise<void> {
        switch (platform) {
            case 'telegram':
                await this.answerTelegramCallbackQuery(env, callbackQueryId, text, showAlert);
                break;
            case 'bale':
                await this.answerBaleCallbackQuery(env, callbackQueryId, text, showAlert);
                break;
            case 'rubika':
                await this.answerRubikaCallbackQuery(env, callbackQueryId, text, showAlert);
                break;
            default:
                console.error(`Unsupported platform: ${platform}`);
        }
    },

    // Helper: Answer Telegram callback query
    async answerTelegramCallbackQuery(env: Env, callbackQueryId: string, text: string, showAlert: boolean = false): Promise<void> {
        const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
        const body = {
            callback_query_id: callbackQueryId,
            text,
            show_alert: showAlert
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to answer Telegram callback query:', error);
            }
        } catch (error) {
            console.error('Error answering Telegram callback query:', error);
        }
    },

    // Helper: Answer Bale callback query
    async answerBaleCallbackQuery(env: Env, callbackQueryId: string, text: string, showAlert: boolean = false): Promise<void> {
        if (!env.BALE_BOT_TOKEN) {
            console.error('Bale bot token not configured');
            return;
        }

        const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/answerCallbackQuery`;
        const body = {
            callback_query_id: callbackQueryId,
            text,
            show_alert: showAlert
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.error('Failed to answer Bale callback query:', error);
            }
        } catch (error) {
            console.error('Error answering Bale callback query:', error);
        }
    },

    // Helper: Answer Rubika callback query
    async answerRubikaCallbackQuery(env: Env, callbackQueryId: string, text: string, showAlert: boolean = false): Promise<void> {
        if (!env.RUBIKA_BOT_TOKEN) {
            console.error('Rubika bot token not configured');
            return;
        }

        // Rubika does not have a direct answerCallbackQuery method.
        // Instead, we edit the original message to show the response.
        // This is a workaround since Rubika's API does not support answering callback queries directly.
        console.log(`Rubika callback query answered (no direct API support): ${text}`);
    },

    // Helper: Notify user
    async notifyUser(env: Env, chatId: string, message: string, platform: 'telegram' | 'bale' | 'rubika' = 'telegram'): Promise<void> {
        await this.sendMessage(env, platform, chatId, message);
    },

    // Helper: Get transfer request from KV
    async getTransferRequest(env: Env, transferId: string): Promise<TransferRequest | null> {
        const data = await env.LINKS.get(`transfer:${transferId}`, { type: 'json' }).catch(() => null);
        return data as TransferRequest | null;
    },

    // Helper: Get active transfer from KV
    async getActiveTransfer(env: Env, transferId: string): Promise<ActiveTransfer | null> {
        const data = await env.LINKS.get(`active_transfer:${transferId}`, { type: 'json' }).catch(() => null);
        return data as ActiveTransfer | null;
    },

    // Helper: Get all active transfers from KV
    async getAllActiveTransfers(env: Env): Promise<ActiveTransfer[]> {
        const transfers: ActiveTransfer[] = [];
        const keys = await env.LINKS.list({ prefix: 'active_transfer:' });

        for (const key of keys.keys) {
            const data = await env.LINKS.get(key.name, { type: 'json' }).catch(() => null);
            if (data) {
                transfers.push(data as ActiveTransfer);
            }
        }

        return transfers;
    },

    // Helper: Update transfer status in KV
    async updateTransferStatus(env: Env, transferId: string, updates: Partial<ActiveTransfer>): Promise<void> {
        const transfer = await this.getActiveTransfer(env, transferId);
        if (!transfer) {
            return;
        }

        const updatedTransfer = {
            ...transfer,
            ...updates
        };

        await env.LINKS.put(`active_transfer:${transferId}`, JSON.stringify(updatedTransfer));
    },

    // Helper: Format bytes to human-readable string
    formatBytes(bytes: number): string {
        if (!bytes || bytes === 0) return '0 بایت';
        const k = 1024;
        const sizes = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
};
