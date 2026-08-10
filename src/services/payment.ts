import { Env, PendingPayment, VerificationMethod } from '../types';
import { CONSTANTS } from '../config/constants';
import { DarametClient } from './daramet';
import { QuotaService } from './quota';
import { MessagePool, AcquiredMessage } from './messagePool';

/**
 * Payment service — manages pending payments and verification.
 *
 * Flow:
 *   1. createPendingPayment(userId, chatId, platform) → acquires a message, builds webintent URL
 *   2. Cron (every 2 min): runAutoVerifier() → queries Daramet API for each pending payment
 *   3. Manual /verify CODE: findDonationByTrackingCode() → matches against pending payment
 *   4. Cron (every hour): reminder + cleanup expired
 */
export class PaymentService {
    private daramet: DarametClient;
    private quota: QuotaService;
    private messagePool: MessagePool;

    constructor(private env: Env) {
        this.daramet = new DarametClient(env);
        this.quota = new QuotaService(env);
        this.messagePool = new MessagePool(env);
    }

    /**
     * Generate a unique payment ID (UUID v4-like).
     */
    private generatePaymentId(): string {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).substring(2, 10);
        return `PAY_${ts}_${rand}`;
    }

    /**
     * Create a new pending payment for a user.
     * - Checks no other pending payment exists for this user
     * - Acquires a message atomically from the pool
     * - Inserts a pending_payment row with TTLs
     * - Returns the webintent URL for the user to click
     */
    async createPendingPayment(params: {
        userId: string;
        chatId: string;
        platform: 'telegram' | 'bale' | 'rubika';
    }): Promise<{ success: boolean; payment?: PendingPayment; webintentUrl?: string; error?: string }> {
        const { userId, chatId, platform } = params;
        const now = Date.now();

        // 1. Check if user already has an active pending payment
        const existing = await this.env.DB.prepare(
            `SELECT payment_id FROM pending_payments
             WHERE user_id = ?1 AND status = 'pending' AND payment_window_expiry_at > ?2
             LIMIT 1`
        )
        .bind(userId, now)
        .first<{ payment_id: string }>();

        if (existing) {
            // Return existing payment so user can re-use the link
            const existingPayment = await this.getPendingPayment(existing.payment_id);
            if (existingPayment) {
                const webintentUrl = this.daramet.buildWebintentUrl(
                    existingPayment.amount,
                    existingPayment.message_text
                );
                return {
                    success: true,
                    payment: existingPayment,
                    webintentUrl
                };
            }
        }

        // 2. Acquire a message from the pool (atomic)
        const paymentId = this.generatePaymentId();
        let acquired: AcquiredMessage | null;
        try {
            acquired = await this.messagePool.acquire(paymentId);
        } catch (dbError) {
            console.error('Failed to acquire message from pool:', dbError);
            return { success: false, error: 'database_error' };
        }
        
        if (!acquired) {
            return { success: false, error: 'pool_exhausted' };
        }

        // 3. Insert pending_payment record
        const linkExpiry = now + CONSTANTS.PAYMENT.LINK_TTL_MS;
        const lockExpiry = now + CONSTANTS.PAYMENT.MESSAGE_LOCK_TTL_MS;
        const windowExpiry = now + CONSTANTS.PAYMENT.PAYMENT_WINDOW_TTL_MS;
        const recordExpiry = now + CONSTANTS.PAYMENT.RECORD_TTL_MS;

        await this.env.DB.prepare(
            `INSERT INTO pending_payments
                (payment_id, message_id, message_text, user_id, chat_id, platform,
                 amount, generated_at, link_expiry_at, message_lock_expiry_at,
                 payment_window_expiry_at, status, reminder_sent, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', 0, ?12)`
        )
        .bind(
            paymentId,
            acquired.messageId,
            acquired.text,
            userId, chatId, platform,
            CONSTANTS.SUBSCRIPTION.PRICE_TOMAN,
            now, linkExpiry, lockExpiry, windowExpiry, recordExpiry
        )
        .run();

        const payment: PendingPayment = {
            payment_id: paymentId,
            message_id: acquired.messageId,
            message_text: acquired.text,
            user_id: userId,
            chat_id: chatId,
            platform,
            amount: CONSTANTS.SUBSCRIPTION.PRICE_TOMAN,
            generated_at: now,
            link_expiry_at: linkExpiry,
            message_lock_expiry_at: lockExpiry,
            payment_window_expiry_at: windowExpiry,
            status: 'pending',
            reminder_sent: 0,
            expires_at: recordExpiry
        };

        const webintentUrl = this.daramet.buildWebintentUrl(payment.amount, payment.message_text);

        return { success: true, payment, webintentUrl };
    }

    /**
     * Get a pending payment by ID.
     */
    async getPendingPayment(paymentId: string): Promise<PendingPayment | null> {
        const result = await this.env.DB.prepare(
            `SELECT * FROM pending_payments WHERE payment_id = ?1`
        )
        .bind(paymentId)
        .first<PendingPayment>();

        return result || null;
    }

    /**
     * Get the most recent active pending payment for a user.
     */
    async getActivePendingPayment(userId: string): Promise<PendingPayment | null> {
        const now = Date.now();
        const result = await this.env.DB.prepare(
            `SELECT * FROM pending_payments
             WHERE user_id = ?1 AND status = 'pending' AND payment_window_expiry_at > ?2
             ORDER BY generated_at DESC
             LIMIT 1`
        )
        .bind(userId, now)
        .first<PendingPayment>();

        return result || null;
    }

    /**
     * Cancel a pending payment (user-initiated).
     * Releases the message lock so it can be reused.
     */
    async cancelPendingPayment(paymentId: string, userId: string): Promise<{ success: boolean; error?: string }> {
        const payment = await this.getPendingPayment(paymentId);
        if (!payment) return { success: false, error: 'not_found' };
        if (payment.user_id !== userId) return { success: false, error: 'not_owner' };
        if (payment.status !== 'pending') return { success: false, error: 'already_processed' };

        const now = Date.now();
        await this.env.DB.batch([
            // Mark as cancelled
            this.env.DB.prepare(
                `UPDATE pending_payments
                    SET status = 'cancelled', verified_at = ?1
                  WHERE payment_id = ?2 AND status = 'pending'`
            ).bind(now, paymentId),
            // Release the message lock
            this.env.DB.prepare(
                `UPDATE message_state
                    SET locked = 0, locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
                  WHERE message_id = ?1 AND used = 0`
            ).bind(payment.message_id)
        ]);

        return { success: true };
    }

    /**
     * Verify a pending payment by tracking code (manual /verify command).
     * Calls Daramet API, matches donation against pending payment.
     */
    async verifyByTrackingCode(
        userId: string,
        trackingCode: string
    ): Promise<{ success: boolean; alreadyActive?: boolean; error?: string }> {
        const pending = await this.getActivePendingPayment(userId);
        if (!pending) {
            return { success: false, error: 'no_pending_payment' };
        }

        const result = await this.daramet.findDonationByTrackingCode(
            trackingCode,
            pending.message_text,
            pending.amount,
            pending.generated_at
        );

        if (!result.matched || !result.donation) {
            return { success: false, error: result.reason || 'verification_failed' };
        }

        return await this.activateSubscription(
            pending.payment_id,
            pending.message_id,
            pending.user_id,
            pending.chat_id,
            pending.platform,
            result.donation.trackingCode,
            'manual'
        );
    }

    /**
     * Activate a subscription after payment is verified.
     * Atomic: marks payment as paid, marks message as used, activates subscription.
     * Returns early if payment was already processed (idempotent).
     */
    async activateSubscription(
        paymentId: string,
        messageId: number,
        userId: string,
        chatId: string,
        platform: 'telegram' | 'bale' | 'rubika',
        trackingCode: string,
        method: VerificationMethod
    ): Promise<{ success: boolean; alreadyActive?: boolean; error?: string }> {
        const now = Date.now();

        // 1. Atomically mark payment as paid (only if currently pending)
        const updateResult = await this.env.DB.prepare(
            `UPDATE pending_payments
                SET status = 'paid',
                    tracking_code = ?1,
                    verified_at = ?2,
                    verification_method = ?3
              WHERE payment_id = ?4 AND status = 'pending'`
        )
        .bind(trackingCode, now, method, paymentId)
        .run();

        if (!updateResult.meta?.changes) {
            // Already processed (maybe by parallel auto-verifier)
            const existing = await this.getPendingPayment(paymentId);
            if (existing && existing.status === 'paid') {
                return { success: true, alreadyActive: true };
            }
            return { success: false, error: 'payment_not_pending' };
        }

        // 2. Mark message as used (90-day cooldown) + activate subscription (atomic batch)
        await this.env.DB.batch([
            // Mark message as used
            this.env.DB.prepare(
                `UPDATE message_state
                    SET used = 1,
                        used_by = ?1,
                        used_at = ?2,
                        used_expires_at = ?3,
                        locked = 0,
                        locked_by = NULL,
                        locked_at = NULL,
                        lock_expires_at = NULL
                  WHERE message_id = ?4`
            ).bind(userId, now, now + CONSTANTS.SUBSCRIPTION.MESSAGE_USED_COOLDOWN_DAYS * 24 * 3600 * 1000, messageId),

            // Activate (or extend) subscription
            this.env.DB.prepare(
                `INSERT INTO subscriptions
                    (user_id, tier, start_date, expiry_date, daily_quota_bytes,
                     per_file_limit_bytes, payment_ref, activated_at, source)
                 VALUES (?1, 'shared', ?2, ?3, ?4, ?5, ?6, ?2, 'paid')
                 ON CONFLICT(user_id) DO UPDATE
                    SET tier = 'shared',
                        expiry_date = CASE
                            WHEN expiry_date > ?2 THEN expiry_date + ?7
                            ELSE ?3
                        END,
                        daily_quota_bytes = ?4,
                        per_file_limit_bytes = ?5,
                        payment_ref = ?6,
                        activated_at = ?2,
                        source = 'paid',
                        updated_at = ?2`
            ).bind(
                userId, now, now + CONSTANTS.SUBSCRIPTION.DURATION_DAYS * 24 * 3600 * 1000,
                CONSTANTS.SUBSCRIPTION.SHARED_DAILY_QUOTA_BYTES,
                CONSTANTS.SUBSCRIPTION.SHARED_PER_FILE_LIMIT_BYTES,
                paymentId,
                CONSTANTS.SUBSCRIPTION.DURATION_DAYS * 24 * 3600 * 1000
            )
        ]);

        return { success: true };
    }

    /**
     * Run automatic verification of pending payments (called by cron every 2 minutes).
     * Queries Daramet API for each pending payment (up to MAX_PENDING).
     * Uses batched concurrency for efficiency.
     */
    async runAutoVerifier(notifyCallback?: (payment: PendingPayment, success: boolean, error?: string) => Promise<void>): Promise<{
        checked: number;
        verified: number;
        failed: number;
    }> {
        const now = Date.now();

        // Get pending payments whose payment window is still open
        const result = await this.env.DB.prepare(
            `SELECT * FROM pending_payments
             WHERE status = 'pending'
               AND payment_window_expiry_at > ?1
             ORDER BY generated_at ASC
             LIMIT ?2`
        )
        .bind(now, CONSTANTS.PAYMENT.VERIFY_MAX_PENDING)
        .all<PendingPayment>();

        const pending = result.results || [];
        if (pending.length === 0) {
            return { checked: 0, verified: 0, failed: 0 };
        }

        let verified = 0;
        let failed = 0;

        // Process in batches of VERIFY_BATCH_SIZE
        for (let i = 0; i < pending.length; i += CONSTANTS.PAYMENT.VERIFY_BATCH_SIZE) {
            const batch = pending.slice(i, i + CONSTANTS.PAYMENT.VERIFY_BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(async (payment) => {
                    try {
                        const donation = await this.daramet.findDonationByMessage(
                            payment.message_text,
                            payment.amount,
                            payment.generated_at
                        );

                        if (donation) {
                            const result = await this.activateSubscription(
                                payment.payment_id,
                                payment.message_id,
                                payment.user_id,
                                payment.chat_id,
                                payment.platform,
                                donation.trackingCode,
                                'auto'
                            );
                            if (result.success) {
                                if (notifyCallback) await notifyCallback(payment, true);
                                return 'verified';
                            } else {
                                return 'failed';
                            }
                        }
                        return 'not_found';
                    } catch (err) {
                        console.error(`Auto-verify failed for ${payment.payment_id}:`, err);
                        return 'error';
                    }
                })
            );

            for (const r of results) {
                if (r.status === 'fulfilled') {
                    if (r.value === 'verified') verified++;
                    else if (r.value === 'failed') failed++;
                } else {
                    failed++;
                }
            }
        }

        return { checked: pending.length, verified, failed };
    }

    /**
     * Send reminders for payments whose link has expired but payment window is still open.
     * Called by cron every hour.
     */
    async sendLinkExpiryReminders(notifyCallback: (payment: PendingPayment) => Promise<void>): Promise<number> {
        const now = Date.now();
        const result = await this.env.DB.prepare(
            `SELECT * FROM pending_payments
             WHERE status = 'pending'
               AND link_expiry_at <= ?1
               AND payment_window_expiry_at > ?1
               AND reminder_sent = 0`
        )
        .bind(now)
        .all<PendingPayment>();

        let sent = 0;
        for (const payment of result.results || []) {
            try {
                await notifyCallback(payment);
                await this.env.DB.prepare(
                    `UPDATE pending_payments SET reminder_sent = 1 WHERE payment_id = ?1`
                )
                .bind(payment.payment_id)
                .run();
                sent++;
            } catch (err) {
                console.error(`Failed to send reminder for ${payment.payment_id}:`, err);
            }
        }
        return sent;
    }

    /**
     * Cleanup expired pending payments (called by cron every hour).
     * Marks expired payments and releases their message locks.
     */
    async cleanupExpiredPayments(notifyCallback?: (payment: PendingPayment) => Promise<void>): Promise<number> {
        const now = Date.now();

        // Find payments whose window has expired but still pending
        const result = await this.env.DB.prepare(
            `SELECT * FROM pending_payments
             WHERE status = 'pending'
               AND payment_window_expiry_at <= ?1`
        )
        .bind(now)
        .all<PendingPayment>();

        let cleaned = 0;
        for (const payment of result.results || []) {
            try {
                // Mark as expired and release the message
                await this.env.DB.batch([
                    this.env.DB.prepare(
                        `UPDATE pending_payments SET status = 'expired' WHERE payment_id = ?1`
                    ).bind(payment.payment_id),
                    this.env.DB.prepare(
                        `UPDATE message_state
                            SET locked = 0, locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
                          WHERE message_id = ?1 AND used = 0`
                    ).bind(payment.message_id)
                ]);

                if (notifyCallback) await notifyCallback(payment);
                cleaned++;
            } catch (err) {
                console.error(`Failed to cleanup payment ${payment.payment_id}:`, err);
            }
        }
        return cleaned;
    }

    /**
     * Delete old non-pending payment records (called by cron every 2 minutes).
     * Records older than 24 hours past their expires_at are deleted.
     */
    async deleteOldRecords(): Promise<number> {
        // expires_at is stored in milliseconds (Date.now()), so compare with ms
        const cutoffMs = Date.now() - 86400 * 1000;
        const result = await this.env.DB.prepare(
            `DELETE FROM pending_payments
             WHERE status IN ('paid', 'expired', 'cancelled')
               AND expires_at < ?1`
        )
        .bind(cutoffMs)
        .run();

        return result.meta?.changes || 0;
    }
}
