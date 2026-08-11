import { Env, Platform } from '../types';
import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { PaymentService } from '../services/payment';
import { QuotaService } from '../services/quota';
import { MessagePool } from '../services/messagePool';
import { CONSTANTS } from '../config/constants';
import { formatBytes, toPersianDigits } from '../utils/helpers';
import { formatPersianDate, formatPersianTime, formatPersianDuration } from '../utils/persianDate';

/**
 * Handle /subscribe command.
 * Initiates a new payment flow or returns the existing active payment link.
 */
export async function handleSubscribeCommand(
    env: Env, kv: KVService, messenger: Messenger,
    chatId: string, userId: string, platform: Platform
): Promise<void> {
    if (!userId) {
        await messenger.sendMessage(chatId, '❌ شناسایی کاربر ناموفق بود. لطفاً دوباره /start را بزنید.');
        return;
    }

    const paymentService = new PaymentService(env);
    const result = await paymentService.createPendingPayment({ userId, chatId, platform });

    if (!result.success || !result.payment || !result.webintentUrl) {
        const errorMessages: Record<string, string> = {
            'pool_exhausted': '❌ **ظرفیت سیستم به موقت پر است.**\nلطفاً چند دقیقه بعد دوباره تلاش کنید.',
            'database_error': '❌ **خطا در ارتباط با پایگاه داده.**\nلطفاً چند لحظه بعد دوباره تلاش کنید.\n\n_اگر این خطا ادامه داشت، با پشتیبانی تماس بگیرید._',
            'd1_connection_error': '❌ **مشکل در اتصال به پایگاه داده.**\nسیستم در حال تلاش مجدد است...\nلطفاً ۱۰ ثانیه صبر کنید و دوباره /subscribe را بزنید.',
            'table_not_found': '❌ **خطای سیستمی: جدول پیام‌ها یافت نشد.**\nاین مشکل باید توسط مدیر سیستم برطرف شود.',
            'circuit_breaker_open': '⚠️ **پایگاه داده در حال حاضر در دسترس نیست.**\n\n' +
                'سیستم به صورت خودکار پس از _۱ دقیقه_ دوباره امتحان می‌کند.\n' +
                'لطفاً کمی صبر کنید و سپس /subscribe را بزنید.'
        };
        
        // Detect circuit breaker error for better messaging
        let errorKey = result.error || '';
        if (result.error?.includes('circuit breaker') || result.error?.includes('temporarily unavailable')) {
            errorKey = 'circuit_breaker_open';
        }
        
        // Log detailed error for debugging
        console.error('[Subscribe] Payment creation failed:', {
            error: result.error,
            userId: userId.substring(0, 8) + '...',
            timestamp: new Date().toISOString()
        });
        
        await messenger.sendMessage(
            chatId,
            errorMessages[errorKey] || `❌ **خطا در ایجاد درخواست پرداخت.**\n\nکد خطا: \`${result.error || 'unknown'}\`\nلطفاً چند دقیقه بعد دوباره تلاش کنید.`
        );
        return;
    }

    const payment = result.payment;
    const now = Date.now();

    const linkExpiresIn = formatPersianDuration(payment.link_expiry_at - now);
    const windowExpiresIn = formatPersianDuration(payment.payment_window_expiry_at - now);
    const windowExpiresAt = formatPersianTime(payment.payment_window_expiry_at);

    // Show different message for reused payments
    let headerMessage: string;
    if (result.reused) {
        headerMessage = `🔄 **اشتراک مجدد — ${toPersianDigits('80000')} تومان**\n\n` +
            `✅ *پیام اختصاصی قبلی شما بازیابی شد*\n` +
            `تایمرها از نو شروع شده‌اند!`;
    } else {
        headerMessage = `💎 **خرید اشتراک ۳۰ روزه — ${toPersianDigits('80000')} تومان**`;
    }

    const message =
        `${headerMessage}\n\n` +
        `🔗 **لینک پرداخت:**\n${result.webintentUrl}\n\n` +
        `⚠️ **توجه بسیار مهم:**\n` +
        `• روی لینک بالا کلیک کنید\n` +
        `• در صفحه باز شده، روی دکمه «تأیید و پرداخت» کلیک کنید\n` +
        `• به لینک، مبلغ یا پیام **هیچ تغییری** ایجاد نکنید\n` +
        `• در غیر این صورت، اشتراک شما فعال نخواهد شد\n\n` +
        `⏰ **لینک تا ${linkExpiresIn} فعال است.**\n` +
        `🔄 اگر لینک منقضی شد، با کد رهگیری از /verify استفاده کنید.\n\n` +
        `📋 **پنجره پرداخت:** ${windowExpiresIn} (تا ساعت ${windowExpiresAt})`;

    const inlineKeyboard = {
        inline_keyboard: [
            [{ text: '✅ پرداخت کردم — تأیید', callback_data: `sub_verify_input:${payment.payment_id}` }],
            [{ text: '❌ لغو درخواست', callback_data: `sub_cancel:${payment.payment_id}` }]
        ]
    };

    await messenger.sendMessage(chatId, message, inlineKeyboard);
}

/**
 * Handle /verify command.
 * Allows user to manually verify a payment by entering the tracking code.
 *
 * Two modes:
 *   - /verify (no code): asks user to send the tracking code
 *   - /verify CODE: attempts verification
 */
export async function handleVerifyCommand(
    env: Env, kv: KVService, messenger: Messenger,
    chatId: string, userId: string, trackingCode?: string
): Promise<void> {
    if (!userId) {
        await messenger.sendMessage(chatId, '❌ شناسایی کاربر ناموفق بود.');
        return;
    }

    if (!trackingCode) {
        await messenger.sendMessage(
            chatId,
            `📝 **تأیید دستی پرداخت**\n\n` +
            `کد رهگیری پرداخت خود را به این شکل ارسال کنید:\n` +
            `\`/verify 12345678\`\n\n` +
            `💡 کد رهگیری را از صفحه پرداخت دارمت یا پیامک تأیید می‌توانید پیدا کنید.`
        );
        return;
    }

    const paymentService = new PaymentService(env);

    // Check if user has an active pending payment
    const pending = await paymentService.getActivePendingPayment(userId);
    if (!pending) {
        await messenger.sendMessage(
            chatId,
            '❌ **درخواست پرداخت فعالی برای شما یافت نشد.**\n\n' +
            'برای خرید اشتراک از /subscribe استفاده کنید.'
        );
        return;
    }

    await messenger.sendMessage(chatId, '⏳ در حال استعلام پرداخت از دارمت...');

    const result = await paymentService.verifyByTrackingCode(userId, trackingCode.trim());

    if (result.success) {
        if (result.alreadyActive) {
            await messenger.sendMessage(
                chatId,
                '✅ **این پرداخت قبلاً تأیید شده و اشتراک شما فعال است.**'
            );
            return;
        }
        await sendSubscriptionActivatedMessage(env, messenger, chatId, pending.payment_id, 'manual');
    } else {
        const errorMessages: Record<string, string> = {
            'no_pending_payment': 'درخواست پرداخت فعالی برای شما یافت نشد. با /subscribe شروع کنید.',
            'tracking_code_not_found': 'کد رهگیری در سیستم دارمت یافت نشد. ممکن است هنوز ثبت نشده باشد (چند دقیقه صبر کنید و دوباره تلاش کنید).',
            'amount_mismatch': 'مبلغ پرداختی با اشتراک همخوانی ندارد (باید ۸۰,۰۰۰ تومان باشد).',
            'date_before_payment_request': 'این پرداخت قبل از درخواست اشتراک شما ثبت شده است.',
            'message_mismatch': 'این کد رهگیری متعلق به درخواست شما نیست. پیام دونیت باید دقیقاً همان‌طور باشد که ربات تنظیم کرده بود.',
            'verification_failed': 'تأیید پرداخت ناموفق بود.',
            'payment_not_pending': 'این درخواست پرداخت قبلاً پردازش شده است.',
            'api_error': 'خطا در ارتباط با سرور دارمت. لطفاً چند دقیقه بعد دوباره تلاش کنید.'
        };
        await messenger.sendMessage(
            chatId,
            `❌ **تأیید ناموفق:**\n\n${errorMessages[result.error || ''] || 'خطای ناشناخته.'}`
        );
    }
}

/**
 * Handle /sub_status command.
 * Shows user's subscription status, daily quota usage, and pending payments.
 */
export async function handleSubStatusCommand(
    env: Env, kv: KVService, messenger: Messenger,
    chatId: string, userId: string
): Promise<void> {
    if (!userId) {
        await messenger.sendMessage(chatId, '❌ شناسایی کاربر ناموفق بود.');
        return;
    }

    const quotaService = new QuotaService(env);
    const paymentService = new PaymentService(env);
    const messagePool = new MessagePool(env);

    const sub = await quotaService.getSubscriptionForDisplay(userId);
    const usage = await quotaService.getTodayUsage(userId);
    const pending = await paymentService.getActivePendingPayment(userId);

    let message = '📊 **وضعیت اشتراک و سهمیه**\n\n';

    if (sub && sub.expiry_date > Date.now()) {
        const remaining = sub.expiry_date - Date.now();
        const tierName = sub.tier === 'shared' ? 'اشتراکی' : 'آزمایشی';
        message += `💎 **اشتراک:** ${tierName}\n`;
        message += `⏰ **انقضا:** ${formatPersianDate(sub.expiry_date)}\n`;
        message += `⏳ **باقی‌مانده:** ${formatPersianDuration(remaining)}\n\n`;
    } else if (sub && sub.expiry_date <= Date.now()) {
        message += `❌ **اشتراک شما منقضی شده است.**\n`;
        message += `برای تمدید: /subscribe\n\n`;
    } else {
        message += `🆓 **بدون اشتراک فعال** — از سهمیه آزمایشی استفاده می‌کنید.\n`;
        message += `برای خرید اشتراک: /subscribe\n\n`;
    }

    if (usage) {
        const usedPercent = Math.round((usage.usedBytes / usage.dailyLimit) * 100);
        const remainingBytes = Math.max(0, usage.dailyLimit - usage.usedBytes - usage.reservedBytes);
        message += `📊 **سهمیه امروز (Asia/Tehran):**\n`;
        message += `• استفاده‌شده: ${formatBytes(usage.usedBytes)}\n`;
        message += `• در حال انتقال: ${formatBytes(usage.reservedBytes)}\n`;
        message += `• باقی‌مانده: ${formatBytes(remainingBytes)}\n`;
        message += `• کل سهمیه: ${formatBytes(usage.dailyLimit)}\n`;
        message += `• تعداد انتقال: ${toPersianDigits(usage.transferCount.toString())}\n\n`;
    }

    if (pending) {
        const windowRemaining = pending.payment_window_expiry_at - Date.now();
        if (windowRemaining > 0) {
            message += `⏳ **پرداخت در انتظار:**\n`;
            message += `• مبلغ: ${toPersianDigits(pending.amount.toString())} تومان\n`;
            message += `• باقی‌مانده پنجره: ${formatPersianDuration(windowRemaining)}\n\n`;
        }
    }

    await messenger.sendMessage(chatId, message);
}

/**
 * Send a "subscription activated" notification to the user.
 */
export async function sendSubscriptionActivatedMessage(
    env: Env, messenger: Messenger,
    chatId: string, paymentId: string, method: 'auto' | 'manual'
): Promise<void> {
    const quotaService = new QuotaService(env);
    const paymentService = new PaymentService(env);
    const payment = await paymentService.getPendingPayment(paymentId);

    let expiryDate = Date.now() + CONSTANTS.SUBSCRIPTION.DURATION_DAYS * 24 * 3600 * 1000;
    if (payment) {
        const sub = await quotaService.getSubscription(payment.user_id);
        if (sub) expiryDate = sub.expiry_date;
    }

    const methodText = method === 'auto' ? 'تأیید خودکار 🤖' : 'تأیید دستی ✋';

    await messenger.sendMessage(
        chatId,
        `✅ **اشتراک شما با موفقیت فعال شد!**\n\n` +
        `💎 **اشتراک اشتراکی — ۳۰ روز**\n` +
        `📊 **سهمیه روزانه:** ${formatBytes(CONSTANTS.SUBSCRIPTION.SHARED_DAILY_QUOTA_BYTES)}\n` +
        `📦 **حداکثر حجم هر فایل:** ${formatBytes(CONSTANTS.SUBSCRIPTION.SHARED_PER_FILE_LIMIT_BYTES)}\n` +
        `⏰ **تاریخ انقضا:** ${formatPersianDate(expiryDate)}\n\n` +
        `📝 **روش تأیید:** ${methodText}\n\n` +
        `🎉 از این پس می‌توانید فایل‌های خود را با سهمیه کامل ارسال کنید.`
    );
}
