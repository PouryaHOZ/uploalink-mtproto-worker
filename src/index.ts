import { Env, Platform } from './types';
import { CONSTANTS, SYSTEM_VERSION, LAST_UPDATE_PERSIAN } from './config/constants';
import { KVService } from './services/kv';
import { TelegramPlatform } from './platforms/telegram';
import { BalePlatform } from './platforms/bale';
import { RubikaPlatform, parseRubikaUpdate } from './platforms/rubika';
import { Messenger } from './platforms/messenger';
import { handleStartCommand, handleConnectionCode, askLinkSelection, askUnlinkSelection, handleStatusCommand } from './handlers/commands';
import { createTransferRequest, processFileTransfer } from './handlers/transfers';
import { handleSubscribeCommand, handleVerifyCommand, handleSubStatusCommand, sendSubscriptionActivatedMessage } from './handlers/subscriptions';
import { triggerGitHubWorkflow } from './services/github';
import { generateConnectionCode, generatePlatformLink, formatBytes } from './utils/helpers';
import { PaymentService } from './services/payment';
import { QuotaService } from './services/quota';
import { MessagePool } from './services/messagePool';
import { StorageService } from './services/storage';

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
            `⚡ <b>مقداردهی و راه‌اندازی سرور:</b>\n\n` +
            `<code>[███░░░░░░░] 30%</code>\n` +
            `📌 <b>مرحله:</b> تخصیص منابع ابری و دریافت اسکریپت...`,
            { inline_keyboard: [[{ text: '🛑 لغو انتقال', callback_data: `cancel_transfer:${transferId}` }]] }
        );
    } else {
        await messenger.sendMessage(req.chatId, `❌ <b>خطا در شروع سرور پردازش:</b>\n<code>${triggerResult.error}</code>`);
        await processQueue(env, kv, messenger);
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const kv = new KVService(env);

        try {
            // Enhanced health endpoint with D1 status
            if (path === '/health') {
                const healthData: Record<string, any> = { 
                    status: 'healthy',
                    version: SYSTEM_VERSION,
                    timestamp: new Date().toISOString()
                };
                
                // Check D1 database health
                try {
                    const messagePool = new MessagePool(env);
                    const dbHealth = await messagePool.healthCheck();
                    healthData.database = dbHealth;
                    
                    // Include circuit breaker status
                    healthData.circuitBreaker = messagePool.getCircuitBreakerStatus();
                    
                    if (!dbHealth.healthy) {
                        healthData.status = 'degraded';
                        
                        // More specific status based on issue
                        if (dbHealth.error?.includes('table does not exist')) {
                            healthData.status = 'unhealthy';
                            healthData.actionRequired = 'Run migrations: npx wrangler d1 migrations apply tg-bot-db --remote';
                        } else if (dbHealth.circuitBreaker?.isOpen) {
                            healthData.status = 'degraded';
                            healthData.reason = 'Circuit breaker open - D1 experiencing issues';
                        }
                    }
                } catch (dbErr) {
                    healthData.status = 'degraded';
                    healthData.database = {
                        healthy: false,
                        error: dbErr instanceof Error ? dbErr.message : 'Unknown DB error'
                    };
                }
                
                const statusCode = healthData.status === 'healthy' ? 200 : 
                                   healthData.status === 'unhealthy' ? 503 : 200;
                                   
                return new Response(JSON.stringify(healthData, null, 2), { 
                    status: statusCode,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Admin endpoint to reset stuck message pool (all messages locked/used)
            // GET /admin/reset-messages?secret=YOUR_ADMIN_SECRET
            if (path === '/admin/reset-messages') {
                const adminSecret = env.ADMIN_SECRET || 'change-me-in-wrangler-config';
                const providedSecret = url.searchParams.get('secret');
                
                if (!providedSecret || providedSecret !== adminSecret) {
                    return new Response(JSON.stringify({ 
                        error: 'Unauthorized. Provide valid secret parameter.' 
                    }), { status: 401 });
                }

                const messagePool = new MessagePool(env);
                
                try {
                    // Reset all locked and used states
                    await env.DB.prepare(`
                        UPDATE message_state 
                        SET locked = 0, 
                            locked_by = NULL, 
                            locked_at = NULL, 
                            lock_expires_at = NULL,
                            used = 0,
                            used_by = NULL,
                            used_at = NULL,
                            used_expires_at = NULL
                    `).run();

                    // Get fresh stats
                    const stats = await messagePool.getStats();
                    
                    console.log(`[Admin] Message pool reset complete. Available: ${stats.free}/${stats.total}`);
                    
                    return new Response(JSON.stringify({
                        success: true,
                        message: 'Message pool reset successfully',
                        stats,
                        timestamp: new Date().toISOString()
                    }), { 
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                } catch (err) {
                    console.error('[Admin] Failed to reset messages:', err);
                    return new Response(JSON.stringify({
                        success: false,
                        error: err instanceof Error ? err.message : 'Unknown error'
                    }), { status: 500 });
                }
            }

            // Admin endpoint to cleanup expired locks only
            // GET /admin/cleanup-locks?secret=YOUR_ADMIN_SECRET
            if (path === '/admin/cleanup-locks') {
                const adminSecret = env.ADMIN_SECRET || 'change-me-in-wrangler-config';
                const providedSecret = url.searchParams.get('secret');
                
                if (!providedSecret || providedSecret !== adminSecret) {
                    return new Response(JSON.stringify({ 
                        error: 'Unauthorized. Provide valid secret parameter.' 
                    }), { status: 401 });
                }

                const messagePool = new MessagePool(env);
                
                try {
                    const cleanedCount = await messagePool.cleanupExpiredLocks();
                    const recycledCount = await messagePool.recycleUsedMessages();
                    const stats = await messagePool.getStats();
                    
                    return new Response(JSON.stringify({
                        success: true,
                        message: 'Cleanup completed',
                        cleaned: cleanedCount,
                        recycled: recycledCount,
                        stats,
                        timestamp: new Date().toISOString()
                    }), { 
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                } catch (err) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: err instanceof Error ? err.message : 'Unknown error'
                    }), { status: 500 });
                }
            }

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
                                `⚠️ <b>یک خطای شبکه‌ای موقت رخ داد.</b>\nدرخواست شما مجدداً به صف بازگشت (موقعیت: ${pos}).`,
                                { inline_keyboard: [[{ text: '❌ انصراف از صف', callback_data: `queue_cancel:${transferId}` }]] }
                            );
                        } else if (status === 'completed') {
                            // Confirm quota usage (convert reserved → used)
                            const req = activeReq.transferRequest;
                            if (req.userId && req.fileSize > 0) {
                                try {
                                    const quotaService = new QuotaService(env);
                                    await quotaService.confirmUsage(req.userId, req.fileSize);
                                } catch (err) {
                                    console.error('Failed to confirm quota usage:', err);
                                }
                            }
                        } else if (status === 'failed' && !retryable) {
                            // Release reserved quota on permanent failure
                            const req = activeReq.transferRequest;
                            if (req.userId && req.fileSize > 0) {
                                try {
                                    const quotaService = new QuotaService(env);
                                    await quotaService.releaseReserved(req.userId, req.fileSize);
                                } catch (err) {
                                    console.error('Failed to release reserved quota:', err);
                                }
                            }
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

        // Always run: queue processing (existing)
        await kv.sweepAndGetActiveTransfers();
        await processQueue(env, kv, new TelegramPlatform(env));

        // New cron tasks based on schedule
        const cron = event.cron;

        if (cron === '*/2 * * * *') {
            // Every 2 minutes: auto-verify pending payments + cleanup TTL records + storage cleanup
            ctx.waitUntil((async () => {
                try {
                    const paymentService = new PaymentService(env);
                    const quotaService = new QuotaService(env);
                    const messagePool = new MessagePool(env);
                    const storageService = new StorageService(env);

                    // Run auto-verifier
                    await paymentService.runAutoVerifier(async (payment, success) => {
                        if (success) {
                            const messenger = new TelegramPlatform(env);
                            await sendSubscriptionActivatedMessage(
                                env, messenger, payment.chat_id, payment.payment_id, 'auto'
                            );
                        }
                    });

                    // Cleanup expired quota rows
                    await quotaService.cleanupExpiredQuota();

                    // Cleanup expired message locks
                    await messagePool.cleanupExpiredLocks();

                    // Delete old non-pending payment records
                    await paymentService.deleteOldRecords();

                    // ===== STORAGE CLEANUP: Mark expired files for deletion =====
                    // Files older than 2 hours are marked as cleanup_pending
                    // The external processing server (MinIO) handles actual file deletion
                    try {
                        const expiredCount = await storageService.cleanupExpiredRecords();
                        if (expiredCount > 0) {
                            console.log(`[Cron] Storage cleanup: ${expiredCount} files marked for deletion`);

                            // Optionally purge old cleanup records (once per hour effectively due to */2)
                            await storageService.purgeCleanupRecords();
                        }

                        // Log storage stats periodically (every ~10 minutes due to random)
                        if (Math.random() < 0.2) { // ~20% chance each run = every 10 mins avg
                            const stats = await storageService.getStorageStats();
                            console.log(`[Storage] Stats: ${stats.activeFiles} active files, ${stats.expiredFiles} expired, ${formatBytes(stats.totalBytes)} total`);
                        }
                    } catch (storageErr) {
                        console.error('[Cron] Storage cleanup failed:', storageErr);
                        // Don't fail the entire cron job if storage cleanup fails
                    }
                } catch (err) {
                    console.error('Cron */2 failed:', err);
                }
            })());
        }

        if (cron === '0 * * * *') {
            // Every hour: send link expiry reminders + cleanup expired payments
            ctx.waitUntil((async () => {
                try {
                    const paymentService = new PaymentService(env);

                    // Send reminders for payments whose link expired but window still open
                    await paymentService.sendLinkExpiryReminders(async (payment) => {
                        const messenger = new TelegramPlatform(env);
                        await messenger.sendMessage(
                            payment.chat_id,
                            `⚠️ <b>لینک پرداخت شما منقضی شد.</b>\n\n` +
                            `اگر پرداخت را انجام داده‌اید، کد رهگیری را با /verify ارسال کنید:\n` +
                            `<code>/verify 12345678</code>\n\n` +
                            `اگر هنوز پرداخت نکرده‌اید، می‌توانید با /subscribe دوباره درخواست دهید.\n` +
                            `پنجره پرداخت هنوز باز است.`,
                            { inline_keyboard: [[{ text: '📝 تأیید دستی', callback_data: `sub_verify_input:${payment.payment_id}` }]] }
                        );
                    });

                    // Cleanup payments whose payment window has expired
                    await paymentService.cleanupExpiredPayments(async (payment) => {
                        const messenger = new TelegramPlatform(env);
                        await messenger.sendMessage(
                            payment.chat_id,
                            `⏰ <b>پنجره پرداخت به پایان رسید.</b>\n\n` +
                            `برای دریافت اشتراک، /subscribe را دوباره بزنید.`
                        );
                    });
                } catch (err) {
                    console.error('Cron hourly failed:', err);
                }
            })());
        }

        if (cron === '0 */6 * * *') {
            // Every 6 hours: recycle used messages whose cooldown has passed (90 days)
            ctx.waitUntil((async () => {
                try {
                    const messagePool = new MessagePool(env);
                    const recycled = await messagePool.recycleUsedMessages();
                    if (recycled > 0) {
                        console.log(`Recycled ${recycled} messages back into the pool`);
                    }
                } catch (err) {
                    console.error('Cron recycle failed:', err);
                }
            })());
        }

        if (cron === '0 0 * * *') {
            // Daily at midnight UTC: optional admin report (placeholder)
            ctx.waitUntil((async () => {
                try {
                    console.log('Daily report cron executed');
                } catch (err) {
                    console.error('Daily report failed:', err);
                }
            })());
        }
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
            if (cleanText.startsWith('/subscribe')) {
                await handleSubscribeCommand(env, kv, messenger, chatId, userId, 'rubika');
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/verify')) {
                const parts = rawText.trim().split(/\s+/);
                const code = parts.slice(1).join(' ');
                await handleVerifyCommand(env, kv, messenger, chatId, userId, code);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/sub_status')) {
                await handleSubStatusCommand(env, kv, messenger, chatId, userId);
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

        // Check if user needs new deployment notification
        const userVer = await kv.getUserVersion(userId);
        if (userVer !== SYSTEM_VERSION) {
            await kv.saveUserVersion(userId, SYSTEM_VERSION);
            await messenger.sendMessage(
                chatId,
                `🎉 <b>نسخه جدید سیستم (v${SYSTEM_VERSION}) منتشر شد!</b>\n\n` +
                `📝 <b>تغییرات این آپدیت:</b>\n${LAST_UPDATE_PERSIAN}`
            );
        }

        if (rawText) {
            const cleanText = rawText.toLowerCase();
            if (cleanText.startsWith('/start')) {
                await handleStartCommand(env, kv, messenger, chatId, platform, message.from);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/status')) {
                await handleStatusCommand(env, kv, messenger, chatId, userId);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/subscribe')) {
                await handleSubscribeCommand(env, kv, messenger, chatId, userId, platform);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/verify')) {
                const parts = rawText.trim().split(/\s+/);
                const code = parts.slice(1).join(' ');
                await handleVerifyCommand(env, kv, messenger, chatId, userId, code);
                return new Response(JSON.stringify({ status: 'handled' }), { status: 200 });
            }
            if (cleanText.startsWith('/sub_status')) {
                await handleSubStatusCommand(env, kv, messenger, chatId, userId);
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
        const userId = query.from?.id?.toString() || "";

        const parts = data.split(':');
        const action = parts[0];

        if (action === 'disabled') {
            await messenger.answerCallbackQuery(query.id, '❌ این بخش فعلاً غیرفعال است.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        // ===== Subscription callbacks =====
        if (action === 'sub_buy') {
            await messenger.answerCallbackQuery(query.id, 'در حال ایجاد درخواست پرداخت...');
            await handleSubscribeCommand(env, kv, messenger, chatId, userId, platform);
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'sub_status') {
            await messenger.answerCallbackQuery(query.id, 'در حال دریافت وضعیت...');
            await handleSubStatusCommand(env, kv, messenger, chatId, userId);
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'sub_verify_input') {
            const paymentId = parts[1];
            
            // NEW: Try auto-verification first before asking for manual code
            await messenger.answerCallbackQuery(query.id, '⏳ در حال بررسی خودکار پرداخت...');
            
            const paymentService = new PaymentService(env);
            const payment = await paymentService.getPendingPayment(paymentId);
            
            if (!payment) {
                await messenger.sendMessage(
                    chatId,
                    '❌ <b>درخواست پرداخت یافت نشد.</b>\n\nممکن است لغو شده باشد.',
                    { inline_keyboard: [[{ text: '🔄 خرید اشتراک جدید', callback_data: 'sub_buy' }]] }
                );
                return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            }
            
            // Show "checking" message
            await messenger.sendMessage(chatId, '⏳ <b>در حال استعلام از دارمت...</b>\nلطفاً صبر کنید.');
            
            try {
                // Try to find donation by message text (same as auto-verifier)
                const donation = await paymentService.darametClient.findDonationByMessage(
                    payment.message_text,
                    payment.amount,
                    payment.generated_at
                );
                
                if (donation) {
                    // FOUND! Auto-activate subscription
                    console.log(`[Auto-Verify] Found donation ${donation.trackingCode} for payment ${paymentId}`);
                    
                    const result = await paymentService.activateSubscription(
                        payment.payment_id,
                        payment.message_id,
                        payment.user_id,
                        payment.chat_id,
                        payment.platform,
                        donation.trackingCode,
                        'auto'
                    );
                    
                    if (result.success) {
                        await sendSubscriptionActivatedMessage(env, messenger, chatId, payment.payment_id, 'auto');
                        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
                    } else {
                        await messenger.sendMessage(chatId, '❌ <b>خطا در فعال‌سازی اشتراک.</b>\nلطفاً کد رهگیری را دستی وارد کنید.');
                    }
                } else {
                    // Not found by message, show manual entry with helpful info
                    console.log(`[Auto-Verify] No donation found for payment ${paymentId}, showing manual entry`);
                }
            } catch (err) {
                console.error(`[Auto-Verify] API error for payment ${paymentId}:`, err);
                await messenger.sendMessage(chatId, '⚠️ <b>خطا در ارتباط با دارمت.</b>\nلطفاً کد رهگیری را دستی وارد کنید.');
            }
            
            // Fallback to manual entry
            await messenger.sendMessage(
                chatId,
                `📝 <b>تأیید دستی پرداخت</b>\n\n` +
                `کد رهگیری پرداخت خود را به این شکل ارسال کنید:\n` +
                `<code>/verify 12345678</code>\n\n` +
                `💡 کد رهگیری را از صفحه پرداخت دارمت یا پیامک تأیید می‌توانید پیدا کنید.`,
                { inline_keyboard: [[{ text: '❌ لغو درخواست', callback_data: `sub_cancel:${paymentId}` }]] }
            );
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        if (action === 'sub_cancel') {
            const paymentId = parts[1];
            
            // NEW: Show confirmation prompt first
            await messenger.answerCallbackQuery(query.id, 'در حال بررسی...');
            
            const paymentService = new PaymentService(env);
            const payment = await paymentService.getPendingPayment(paymentId);
            
            // Build confirmation message with time remaining info
            let timeInfo = '';
            if (payment) {
                const windowRemaining = payment.payment_window_expiry_at - Date.now();
                if (windowRemaining > 0) {
                    const minutes = Math.ceil(windowRemaining / 60000);
                    timeInfo = `\n⏰ *پنجره پرداخت:* ${minutes} دقیقه باقی‌مانده`;
                }
            }
            
            await messenger.sendMessage(
                chatId,
                `🤔 <b>آیا از لغو پرداخت مطمئن هستید؟</b>${timeInfo}\n\n` +
                `⚠️ <i>توجه:</i>\n` +
                `• پیام اختصاصی شما قفل خواهد ماند تا پایان پنجره پرداخت (۳ ساعت)\n` +
                `• اگر دوباره /subscribe بزنید، همان پیام به شما داده می‌شود\n` +
                `• تایمرها از نو شروع خواهند شد`,
                { inline_keyboard: [
                    [
                        { text: '✅ بله، لغو شود', callback_data: `sub_cancel_confirm:${paymentId}` },
                        { text: '❌ بازگشت', callback_data: `sub_cancel_abort:${paymentId}` }
                    ]
                ]}
            );
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        // Confirm cancellation (after user confirms)
        if (action === 'sub_cancel_confirm') {
            const paymentId = parts[1];
            const paymentService = new PaymentService(env);
            
            // Cancel but KEEP message locked (don't release lock)
            const result = await paymentService.cancelPaymentKeepMessageLocked(paymentId, userId);
            
            if (result.success) {
                await messenger.editMessageText(chatId, messageId, `🛑 <b>درخواست پرداخت لغو شد.</b>\n\n` +
                    `🔒 پیام اختصاصی شما تا پایان پنجره پرداخت قفل باقی می‌ماند.\n` +
                    `🔄 برای شروع مجدد، /subscribe را بزنید.`);
                await messenger.answerCallbackQuery(query.id, '✅ درخواست لغو شد.');
                
                console.log(`[Cancel] Payment ${paymentId} cancelled by user ${userId}, message remains locked`);
            } else {
                await messenger.answerCallbackQuery(query.id, `❌ ${result.error || 'خطا در لغو'}`);
            }
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        // Abort cancellation (user changed their mind)
        if (action === 'sub_cancel_abort') {
            await messenger.answerCallbackQuery(query.id, '↩️ لغو لغو شد! درخواست شما فعال است.');
            await messenger.sendMessage(
                chatId,
                '✅ <b>درخواست پرداخت شما همچنان فعال است.</b>\n\n' +
                'هر زمان که آماده بودید، پرداخت کنید یا کد رهگیری را وارد کنید.',
                { inline_keyboard: [[{ text: '✅ پرداخت کردم — تأیید', callback_data: `sub_verify_input:${parts[1]}` }]] }
            );
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        // ===== Existing callbacks =====
        if (action === 'queue_cancel') {
            const transferId = parts[1];
            await kv.dequeueTransfer(transferId);
            await messenger.editMessageText(chatId, messageId, `🛑 <b>درخواست شما از صف لغو شد.</b>`);
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

                // Release reserved quota on cancel
                const req = activeTransfer.transferRequest;
                if (req.userId && req.fileSize > 0) {
                    try {
                        const quotaService = new QuotaService(env);
                        await quotaService.releaseReserved(req.userId, req.fileSize);
                    } catch (err) {
                        console.error('Failed to release reserved quota on cancel:', err);
                    }
                }
            } else {
                // If it was in queue
                await kv.dequeueTransfer(transferId);
                await messenger.editMessageText(chatId, messageId, `🛑 <b>فرآیند انتقال لغو شد.</b>`);
                await messenger.answerCallbackQuery(query.id, 'انتقال لغو شد.');

                // Release reserved quota
                const req = await kv.getTransferRequest(transferId);
                if (req?.userId && req.fileSize > 0) {
                    try {
                        const quotaService = new QuotaService(env);
                        await quotaService.releaseReserved(req.userId, req.fileSize);
                    } catch (err) {
                        console.error('Failed to release reserved quota on queue cancel:', err);
                    }
                }
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
                            `🚀 <b>درخواست پذیرفته شد!</b>\n\n<code>[██░░░░░░░░] 20%</code>\n⏳ <b>در حال استارت سرور پردازش ابری...</b>`,
                            { inline_keyboard: [[{ text: '🛑 لغو انتقال', callback_data: `cancel_transfer:${transferId}` }]] }
                        );
                        await messenger.answerCallbackQuery(query.id, 'پردازش آغاز شد.');
                        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
                    } else {
                        // Failed to trigger — release reserved quota
                        if (transferReq.userId && transferReq.fileSize > 0) {
                            try {
                                const quotaService = new QuotaService(env);
                                await quotaService.releaseReserved(transferReq.userId, transferReq.fileSize);
                            } catch (err) {
                                console.error('Failed to release reserved quota on trigger fail:', err);
                            }
                        }
                        await messenger.editMessageText(chatId, messageId, `❌ <b>خطا در ارسال درخواست به سرور پردازش:</b>\n<code>${triggerResult.error}</code>`);
                        await messenger.answerCallbackQuery(query.id, 'خطا در اجرای درخواست.');
                        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
                    }
                }

                await kv.enqueueTransfer(transferId);
                const position = await kv.getQueuePosition(transferId);

                await messenger.editMessageText(
                    chatId,
                    messageId,
                    `⏳ <b>ظرفیت پردازش هم‌زمان پر است؛ شما در صف قرار گرفتید.</b>\n\n📍 موقعیت شما در صف: <b>${position}</b>\n\nسیستم به محض آزاد شدن سرورها، فایل شما را به صورت خودکار پردازش می‌کند.`,
                    { inline_keyboard: [[{ text: '❌ انصراف از صف', callback_data: `queue_cancel:${transferId}` }]] }
                );
                await messenger.answerCallbackQuery(query.id, 'در صف قرار گرفتید.');
                return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            } else {
                await messenger.editMessageText(chatId, messageId, `❌ <b>خطا:</b> درخواست یافت نشد یا منقضی شده است.`);
            }
            await messenger.answerCallbackQuery(query.id, 'درخواست ثبت شد.');
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }

        return new Response(JSON.stringify({ status: 'ignored' }), { status: 200 });
    }
};
