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
import { generateConnectionCode, generatePlatformLink } from './utils/helpers';

async function processQueue(env: Env, kv: KVService, messenger: Messenger) {
    const MAX_CONCURRENT = parseInt(env.MAX_CONCURRENT_TRANSFERS || '3');
    const validActiveTransfers = await kv.sweepAndGetActiveTransfers();

    if (validActiveTransfers.length >= MAX_CONCURRENT) return;

    const queue = await kv.getQueue();
    if (queue.length === 0) return;

    const transferId = queue[0];
    await kv.dequeueTransfer(transferId);

    const req = await kv.getTransferRequest(transferId);
    if (!req) {
        await processQueue(env, kv, messenger);
        return;
    }

    const triggerResult = await triggerGitHubWorkflow(env, transferId, req);
    if (triggerResult.success) {
        await kv.saveActiveTransfer(transferId, {
            id: transferId,
            transferRequest: req,
            status: 'processing',
            createdAt: Date.now()
        });
        
        await messenger.sendMessage(
            req.chatId, 
            `🚀 **نوبت شما فرا رسید!**\n\n\`[██░░░░░░░░] 20%\`\n⏳ **در حال استارت سرور پردازش ابری...**`,
            { inline_keyboard: [[{ text: '🛑 لغو انتقال', callback_data: `cancel_transfer:${transferId}` }]] }
        );
    } else {
        await messenger.sendMessage(req.chatId, `❌ **خطا در شروع سرور پردازش:**\n\`${triggerResult.error}\``);
        await processQueue(env, kv, messenger);
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const kv = new KVService(env);

        try {
            if (path === '/health') return new Response(JSON.stringify({ status: 'healthy' }), { status: 200 });

            // Cancellation Check Endpoint for transfer.js
            if (path === '/check-cancel') {
                const transferId = url.searchParams.get('transferId');
                if (!transferId) return new Response(JSON.stringify({ cancelled: false }), { status: 400 });
                const isCancelled = await kv.getCancelFlag(transferId);
                return new Response(JSON.stringify({ cancelled: isCancelled }), { status: 200 });
            }

            if (path === '/action-webhook' && request.method === 'POST') {
                const payload = await request.json() as any;
                if (payload.action === 'action_update') {
                    const { transferId, status, retryable } = payload;
                    const activeReq = await kv.getActiveTransfer(transferId);
                    
                    if (activeReq) {
                        await kv.removeActiveTransfer(transferId);
                        await kv.deleteCancelFlag(transferId);
                        const messenger = new TelegramPlatform(env);

                        if (status === 'failed' && retryable) {
                            await kv.enqueueTransfer(transferId);
                            const pos = await kv.getQueuePosition(transferId);
                            await messenger.sendMessage(
                                activeReq.transferRequest.chatId, 
                                `⚠️ **یک خطای شبکه‌ای موقت رخ داد.**\nدرخواست شما مجدداً به صف بازگشت (موقعیت: ${pos}).`, 
                                { inline_keyboard: [[{ text: '❌ انصراف از صف', callback_data: `queue_cancel:${transferId}` }]] }
                            );
                        }
                    }
                    await processQueue(env, kv, new TelegramPlatform(env));
                    return new Response(JSON.stringify({ ok: true }), { status: 200 });
                }
            }

            if (path === '/telegram') return await this.handleWebhook(request, env, kv, 'telegram');
            if (path === '/bale') return await this.handleWebhook(request, env, kv, 'bale');
            if (path === '/rubika') return await this.handleRubikaWebhook(request, env, kv);

            return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        } catch (error) {
            console.error('Error in fetch:', error);
            return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
        }
    },

    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        const kv = new KVService(env);
        await kv.sweepAndGetActiveTransfers();
        await processQueue(env, kv, new TelegramPlatform(env));
    },

    getMessenger(env: Env, platform: Platform): Messenger {
        if (platform === 'bale') return new BalePlatform(env);
        if (platform === 'rubika') return new RubikaPlatform(env);
        return new TelegramPlatform(env);
    },

    async handleWebhook(request: Request, env: Env, kv: KVService, platform: Platform): Promise<Response> {
        const update = await request.json() as any;
        const messenger = this.getMessenger(env, platform);

        if (update.callback_query) return await this.handleCallbackQuery(update.callback_query, env, kv, messenger, platform);
        if (update.message) return await this.processMessage(update.message, env, kv, messenger, platform);

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
            return await this.handleCallbackQuery({ data: rawText, message: { chat: { id: chatId }, message_id: messageId }, from: { id: userId }, id: messageId }, env, kv, messenger, 'rubika');
        }

        if (rawText) {
            const cleanText = rawText.trim().toLowerCase();
            if (cleanText.startsWith('/start')) {
                await handleStartCommand(env, kv, messenger, chatId, 'rubika', { id: userId, first_name: normalized.userName });
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
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
                await handleStartCommand(env, kv, messenger, chatId, platform, message.from);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/status')) {
                await handleStatusCommand(kv, messenger, chatId);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
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
        
        const parts = data.split(':');
        const action = parts[0];

        if (action === 'disabled') {
            await messenger.answerCallbackQuery(query.id, '❌ این بخش فعلاً غیرفعال است.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'queue_cancel') {
            const transferId = parts[1];
            await kv.dequeueTransfer(transferId);
            await messenger.editMessageText(chatId, messageId, `🛑 **درخواست شما از صف لغو شد.**`);
            await processQueue(env, kv, messenger);
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'cancel_transfer') {
            const transferId = parts[1];
            
            // Check if it's currently active
            const activeTransfer = await kv.getActiveTransfer(transferId);
            if (activeTransfer) {
                await kv.setCancelFlag(transferId);
                await messenger.answerCallbackQuery(query.id, '⏳ درخواست لغو ثبت شد. در حال متوقف‌سازی فرآیند...');
            } else {
                // If it was in queue
                await kv.dequeueTransfer(transferId);
                await messenger.editMessageText(chatId, messageId, `🛑 **فرآیند انتقال لغو شد.**`);
                await messenger.answerCallbackQuery(query.id, 'انتقال لغو شد.');
                await processQueue(env, kv, messenger);
            }
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'link_gen') {
            const shouldCompress = parts[1] === 'yes';
            const transferId = parts[2];
            const transferReq = await kv.getTransferRequest(transferId);

            if (transferReq) {
                transferReq.shouldCompress = shouldCompress;
                await kv.saveTransferRequest(transferId, transferReq);

                const MAX_CONCURRENT = parseInt(env.MAX_CONCURRENT_TRANSFERS || '3');
                const activeTransfers = await kv.sweepAndGetActiveTransfers();

                if (activeTransfers.length < MAX_CONCURRENT) {
                    const triggerResult = await triggerGitHubWorkflow(env, transferId, transferReq);
                    if (triggerResult.success) {
                        await kv.saveActiveTransfer(transferId, {
                            id: transferId,
                            transferRequest: transferReq,
                            status: 'processing',
                            createdAt: Date.now()
                        });

                        await messenger.editMessageText(
                            chatId, 
                            messageId, 
                            `🚀 **درخواست پذیرفته شد!**\n\n\`[██░░░░░░░░] 20%\`\n⏳ **در حال استارت سرور پردازش ابری...**`,
                            { inline_keyboard: [[{ text: '🛑 لغو انتقال', callback_data: `cancel_transfer:${transferId}` }]] }
                        );
                        await messenger.answerCallbackQuery(query.id, 'پردازش آغاز شد.');
                        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
                    } else {
                        await messenger.editMessageText(chatId, messageId, `❌ **خطا در ارسال درخواست به سرور پردازش:**\n\`${triggerResult.error}\``);
                        await messenger.answerCallbackQuery(query.id, 'خطا در اجرای درخواست.');
                        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
                    }
                }

                await kv.enqueueTransfer(transferId);
                const position = await kv.getQueuePosition(transferId);

                await messenger.editMessageText(
                    chatId, 
                    messageId, 
                    `⏳ **ظرفیت پردازش هم‌زمان پر است؛ شما در صف قرار گرفتید.**\n\n📍 موقعیت شما در صف: **${position}**\n\nسیستم به محض آزاد شدن سرورها، فایل شما را به صورت خودکار پردازش می‌کند.`, 
                    { inline_keyboard: [[{ text: '❌ انصراف از صف', callback_data: `queue_cancel:${transferId}` }]] }
                );
                await messenger.answerCallbackQuery(query.id, 'در صف قرار گرفتید.');
                return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            } else {
                await messenger.editMessageText(chatId, messageId, `❌ **خطا:** درخواست یافت نشد یا منقضی شده است.`);
            }
            await messenger.answerCallbackQuery(query.id, 'درخواست ثبت شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    }
};