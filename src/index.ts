import { Env, Platform } from './types';
import { CONSTANTS } from './config/constants';
import { KVService } from './services/kv';
import { TelegramPlatform } from './platforms/telegram';
import { BalePlatform } from './platforms/bale';
import { RubikaPlatform, parseRubikaUpdate } from './platforms/rubika';
import { Messenger } from './platforms/messenger';
import { handleStartCommand, handleConnectionCode, askLinkSelection, askUnlinkSelection, handleStatusCommand } from './handlers/commands';
import { createTransferRequest, processFileTransfer } from './handlers/transfers';
import { generateConnectionCode, generatePlatformLink } from './utils/helpers';
import { triggerGitHubWorkflow } from './services/github';

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

        if (!normalized) return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });

        if (normalized.text) {
            const rawText = normalized.text;
            const textWithoutStart = rawText.startsWith('/start ') ? rawText.replace('/start ', '').trim() : rawText;

            if (textWithoutStart.match(CONSTANTS.CODE_REGEX)) {
                await handleConnectionCode(env, kv, messenger, textWithoutStart, normalized.chatId, 'rubika');
                return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
            }
        }

        if (normalized.isFile) {
            const transferReq = createTransferRequest(normalized.raw, 'rubika');
            await processFileTransfer(env, kv, messenger, transferReq);
            return new Response(JSON.stringify({ status: 'file_processed' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async processMessage(message: any, env: Env, kv: KVService, messenger: Messenger, platform: Platform): Promise<Response> {
        const rawText = (message.text || '').trim();
        const chatId = (message.chat?.id || message.chat_id || message.from?.id).toString();

        if (rawText) {
            if (rawText.toLowerCase().startsWith('/start')) {
                const parts = rawText.split(' ');
                const possibleCode = parts[1] ? parts[1].trim() : '';

                if (possibleCode.match(CONSTANTS.CODE_REGEX)) {
                    await handleConnectionCode(env, kv, messenger, possibleCode, chatId, platform, message.from);
                    return new Response(JSON.stringify({ status: 'code_handled' }), { status: 200 });
                }

                await handleStartCommand(env, kv, messenger, chatId, platform, message.from);
                return new Response(JSON.stringify({ status: 'start_handled' }), { status: 200 });
            }

            if (rawText.toLowerCase().startsWith('/link')) {
                await askLinkSelection(messenger, chatId, platform);
                return new Response(JSON.stringify({ status: 'link_handled' }), { status: 200 });
            }

            if (rawText.toLowerCase().startsWith('/unlink')) {
                await askUnlinkSelection(kv, messenger, chatId);
                return new Response(JSON.stringify({ status: 'unlink_handled' }), { status: 200 });
            }

            if (rawText.toLowerCase().startsWith('/status')) {
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
            const transferReq = createTransferRequest(message, platform);
            await processFileTransfer(env, kv, messenger, transferReq);
            return new Response(JSON.stringify({ status: 'file_processed' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    },

    async handleCallbackQuery(query: any, env: Env, kv: KVService, messenger: Messenger, platform: Platform): Promise<Response> {
        const data = query.data;
        const chatId = query.message.chat.id.toString();
        const userId = query.from.id.toString();
        const [action, ...params] = data.split('_');

        if (action === 'select' && params[0] === 'destination') {
            const selectedPlatform = params[1] as Platform;
            const transferId = params[2];
            const transferReq = await kv.getTransferRequest(transferId);

            if (transferReq) {
                transferReq.destinations = [selectedPlatform];
                await kv.saveTransferRequest(transferId, transferReq);

                if (transferReq.isVideo) {
                    await messenger.sendMessage(chatId, `🎬 **ویدیو فشرده شود؟**`, {
                        inline_keyboard: [
                            [{ text: '⚡ بله (480p)', callback_data: `select_compression_yes_${transferId}` },
                             { text: '📁 خیر', callback_data: `select_compression_no_${transferId}` }]
                        ]
                    });
                } else {
                    await triggerGitHubWorkflow(env, kv, { ...transferReq, shouldCompress: false });
                    await messenger.sendMessage(chatId, `✅ انتقال فایل آغاز شد.`);
                }
            }
            await messenger.answerCallbackQuery(query.id, 'مقصد انتخاب شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'select' && params[0] === 'compression') {
            const shouldCompress = params[1] === 'yes';
            const transferId = params[2];
            const transferReq = await kv.getTransferRequest(transferId);

            if (transferReq) {
                await triggerGitHubWorkflow(env, kv, { ...transferReq, shouldCompress });
                await messenger.sendMessage(chatId, `✅ پردازش و انتقال آغاز شد.`);
            }
            await messenger.answerCallbackQuery(query.id, 'تنظیمات اعمال شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'select' && params[0] === 'link' && params[1] === 'platform') {
            const selectedPlatform = params[2] as Platform;
            const session = await kv.getSession(userId);

            if (session) {
                const code = generateConnectionCode();
                await kv.saveConnectionRequest(code, {
                    telegramUserId: session.userId,
                    targetPlatform: selectedPlatform,
                    telegramChatId: session.chatId,
                    userName: session.userName,
                    expiresAt: Date.now() + CONSTANTS.EXPIRATION.CONNECTION_REQUEST * 1000
                });

                const link = generatePlatformLink(selectedPlatform, code);
                await messenger.sendMessage(chatId, link);
            }
            await messenger.answerCallbackQuery(query.id, 'لینک ارسال شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'select' && params[0] === 'unlink' && params[1] === 'platform') {
            const selectedPlatform = params[2] as Platform;
            const connectedAccount = await kv.getPlatformReverseAccount(selectedPlatform, chatId);

            if (connectedAccount) {
                await kv.deletePlatformReverseAccount(selectedPlatform, chatId);
                await messenger.sendMessage(chatId, `✅ حساب ${selectedPlatform} با موفقیت حذف شد.`);
            }
            await messenger.answerCallbackQuery(query.id, 'حذف شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    }
};