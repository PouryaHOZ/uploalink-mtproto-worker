import { Env, Platform } from './types';
import { CONSTANTS } from './config/constants';
import { KVService } from './services/kv';
import { TelegramPlatform } from './platforms/telegram';
import { BalePlatform } from './platforms/bale';
import { RubikaPlatform, parseRubikaUpdate } from './platforms/rubika';
import { Messenger } from './platforms/messenger';
import { handleStartCommand, handleConnectionCode, askLinkSelection, askUnlinkSelection, handleStatusCommand } from './handlers/commands';
import { createTransferRequest, processFileTransfer } from './handlers/transfers';
import { triggerGitHubWorkflow } from './services/github';
import { generateConnectionCode, generatePlatformLink, calculateEstimates } from './utils/helpers';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const kv = new KVService(env);

        try {
            if (path === '/health') return new Response(JSON.stringify({ status: 'healthy', timestamp: Date.now() }), { status: 200 });

            if (path === '/telegram') return await this.handleWebhook(request, env, kv, 'telegram');
            if (path === '/bale') return await this.handleWebhook(request, env, kv, 'bale');
            if (path === '/rubika') return await this.handleRubikaWebhook(request, env, kv);

            return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        } catch (error) {
            console.error('Error in fetch:', error);
            return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
        }
    },

    getMessenger(env: Env, platform: Platform): Messenger {
        if (platform === 'bale') return new BalePlatform(env);
        if (platform === 'rubika') return new RubikaPlatform(env);
        return new TelegramPlatform(env);
    },

    async handleWebhook(request: Request, env: Env, kv: KVService, platform: Platform): Promise<Response> {
        const update = await request.json();
        const messenger = this.getMessenger(env, platform);

        if (update.callback_query) {
            return await this.handleCallbackQuery(update.callback_query, env, kv, messenger, platform);
        }

        if (update.message) {
            return await this.processMessage(update.message, env, kv, messenger, platform);
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleRubikaWebhook(request: Request, env: Env, kv: KVService): Promise<Response> {
        const update = await request.json();
        const messenger = this.getMessenger(env, 'rubika');
        const normalized = parseRubikaUpdate(update);

        if (!normalized) return new Response(JSON.stringify({ status: 'ignored_unparsed' }), { status: 200 });

        const rawText = normalized.text;
        const chatId = normalized.chatId;
        const userId = normalized.userId;
        const messageId = normalized.raw.message_id || Date.now().toString();

        if (normalized.isCallback) {
            const simulatedQuery = {
                data: rawText,
                message: { chat: { id: chatId }, message_id: messageId },
                from: { id: userId },
                id: messageId
            };
            return await this.handleCallbackQuery(simulatedQuery, env, kv, messenger, 'rubika');
        }

        if (rawText) {
            const cleanText = rawText.trim().toLowerCase();

            if (cleanText.startsWith('/start')) {
                const parts = rawText.split(' ');
                const possibleCode = parts[1] ? parts[1].trim() : '';

                if (possibleCode.match(CONSTANTS.CODE_REGEX)) {
                    await handleConnectionCode(env, kv, messenger, possibleCode, chatId, 'rubika');
                    return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
                }

                await handleStartCommand(env, kv, messenger, chatId, 'rubika', { id: userId, first_name: normalized.userName });
                return new Response(JSON.stringify({ status: 'start_handled' }), { status: 200 });
            }

            if (cleanText.startsWith('/link')) {
                await askLinkSelection(messenger, chatId, 'rubika');
                return new Response(JSON.stringify({ status: 'link_handled' }), { status: 200 });
            }

            if (cleanText.startsWith('/unlink')) {
                await askUnlinkSelection(kv, messenger, chatId);
                return new Response(JSON.stringify({ status: 'unlink_handled' }), { status: 200 });
            }

            if (cleanText.startsWith('/status')) {
                await handleStatusCommand(kv, messenger, chatId);
                return new Response(JSON.stringify({ status: 'status_handled' }), { status: 200 });
            }

            if (rawText.match(CONSTANTS.CODE_REGEX)) {
                await handleConnectionCode(env, kv, messenger, rawText, chatId, 'rubika');
                return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
            }
        }

        if (normalized.isFile) {
            const transferReq = createTransferRequest(messageId, chatId, userId, normalized.raw, 'rubika');
            await processFileTransfer(env, kv, messenger, transferReq);
            return new Response(JSON.stringify({ status: 'file_processed' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async processMessage(message: any, env: Env, kv: KVService, messenger: Messenger, platform: Platform): Promise<Response> {
        const rawText = (message.text || message.caption || '').trim();
        const chatId = (message.chat?.id || message.chat_id || message.from?.id).toString();
        const userId = (message.from?.id || message.sender_id || 'unknown').toString();
        const messageId = (message.message_id).toString();

        if (rawText) {
            const cleanText = rawText.toLowerCase();

            if (cleanText.startsWith('/start')) {
                const parts = rawText.split(' ');
                const possibleCode = parts[1] ? parts[1].trim() : '';

                if (possibleCode.match(CONSTANTS.CODE_REGEX)) {
                    await handleConnectionCode(env, kv, messenger, possibleCode, chatId, platform, message.from);
                    return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
                }

                await handleStartCommand(env, kv, messenger, chatId, platform, message.from);
                return new Response(JSON.stringify({ status: 'start_handled' }), { status: 200 });
            }

            if (cleanText.startsWith('/link')) {
                await askLinkSelection(messenger, chatId, platform);
                return new Response(JSON.stringify({ status: 'link_handled' }), { status: 200 });
            }

            if (cleanText.startsWith('/unlink')) {
                await askUnlinkSelection(kv, messenger, chatId);
                return new Response(JSON.stringify({ status: 'unlink_handled' }), { status: 200 });
            }

            if (cleanText.startsWith('/status')) {
                await handleStatusCommand(kv, messenger, chatId);
                return new Response(JSON.stringify({ status: 'status_handled' }), { status: 200 });
            }

            if (rawText.match(CONSTANTS.CODE_REGEX)) {
                await handleConnectionCode(env, kv, messenger, rawText, chatId, platform, message.from);
                return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
            }
        }

        const isFile = !!(message.document || message.photo || message.video || message.audio || message.voice || message.file);
        if (isFile) {
            const transferReq = createTransferRequest(messageId, chatId, userId, message, platform);
            await processFileTransfer(env, kv, messenger, transferReq);
            return new Response(JSON.stringify({ status: 'file_processed' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleCallbackQuery(query: any, env: Env, kv: KVService, messenger: Messenger, platform: Platform): Promise<Response> {
        const data = query.data;
        const chatId = query.message?.chat?.id?.toString() || query.chat_id?.toString() || "";
        const messageId = query.message?.message_id?.toString() || query.message_id?.toString() || query.id;
        const userId = query.from?.id?.toString() || query.sender_id?.toString() || "";
        
        const parts = data.split(':');
        const action = parts[0];

        // 1. Handle Disabled Buttons
        if (action === 'disabled') {
            // Sends a popup alert instead of sending a message
            await messenger.answerCallbackQuery(query.id, '❌ این بخش فعلاً غیرفعال است و فایل‌ها فقط در فضای ابری آپلود می‌شوند.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        // 2. Handle New Link Generation Logic
        if (action === 'link_gen') {
            const shouldCompress = parts[1] === 'yes';
            const transferId = parts[2];
            const transferReq = await kv.getTransferRequest(transferId);

            if (transferReq) {
                transferReq.destinations = []; // Empty destinations
                await triggerGitHubWorkflow(env, kv, { ...transferReq, shouldCompress });
                
                await messenger.editMessageText(chatId, messageId, `✅ **درخواست آپلود ثبت شد.**\n🚀 پردازش فایل آغاز شد. لینک دانلود به‌زودی ارسال می‌شود...`);
            } else {
                await messenger.editMessageText(chatId, messageId, `❌ **خطا:** درخواست انتقال یافت نشد یا منقضی شده است.`);
            }
            await messenger.answerCallbackQuery(query.id, 'در حال پردازش...');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'link') {
            const targetPlatform = parts[1] as Platform;
            const session = await kv.getSession(userId);

            const code = generateConnectionCode();
            await kv.saveConnectionRequest(code, {
                telegramUserId: userId,
                targetPlatform,
                telegramChatId: chatId,
                userName: session?.userName || 'کاربر',
                expiresAt: Date.now() + CONSTANTS.EXPIRATION.CONNECTION_REQUEST * 1000
            });

            const linkMsg = generatePlatformLink(targetPlatform, code);
            await messenger.editMessageText(chatId, messageId, linkMsg);
            await messenger.answerCallbackQuery(query.id, 'کد ایجاد شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'unlink') {
            const targetPlatform = parts[1] as Platform;
            await kv.deletePlatformReverseAccount(targetPlatform, chatId);
            
            const connectedAcc = await kv.getConnectedAccount(userId);
            if (connectedAcc) {
                if (targetPlatform === 'rubika') connectedAcc.rubikaChatId = undefined;
                if (targetPlatform === 'bale') connectedAcc.baleChatId = undefined;
                await kv.saveConnectedAccount(userId, connectedAcc);
            }

            await messenger.editMessageText(chatId, messageId, `✅ **اتصال ${targetPlatform === 'bale' ? 'بله' : 'روبیکا'} قطع شد.**`);
            await messenger.answerCallbackQuery(query.id, 'حساب قطع شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    }
};