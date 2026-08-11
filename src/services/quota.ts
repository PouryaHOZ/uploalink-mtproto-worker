import { Env, Subscription, QuotaCheckResult, TransferRequest } from '../types';
import { CONSTANTS } from '../config/constants';
import { getPersianDateKey } from '../utils/persianDate';

/**
 * Quota service — manages daily quota limits per user with atomic operations.
 *
 * Strategy:
 *   1. Check user subscription (or auto-trial)
 *   2. Atomic INSERT...ON CONFLICT DO UPDATE...RETURNING to reserve quota
 *   3. On transfer complete: convert reserved → used
 *   4. On transfer fail: release reserved
 *
 * All operations use D1's atomic single-statement semantics.
 */

export class QuotaService {
    constructor(private env: Env) {}

    /**
     * Get the effective subscription for a user.
     * Returns the active subscription, or null if none / expired.
     */
    async getSubscription(userId: string): Promise<Subscription | null> {
        const now = Date.now();
        const result = await this.env.DB.prepare(
            `SELECT * FROM subscriptions
             WHERE user_id = ?1 AND expiry_date > ?2
             LIMIT 1`
        )
        .bind(userId, now)
        .first<Subscription>();

        return result || null;
    }

    /**
     * Get the active subscription (even if expired) for display purposes.
     */
    async getSubscriptionForDisplay(userId: string): Promise<Subscription | null> {
        const result = await this.env.DB.prepare(
            `SELECT * FROM subscriptions WHERE user_id = ?1 LIMIT 1`
        )
        .bind(userId)
        .first<Subscription>();

        return result || null;
    }

    /**
     * Determine the effective limits for a user.
     * If they have an active subscription, use those limits.
     * Otherwise, give them auto-trial limits (500MB/day).
     */
    async getEffectiveLimits(userId: string): Promise<{
        tier: 'trial' | 'shared';
        dailyLimitBytes: number;
        perFileLimitBytes: number;
        expiryDate: number | null;
    }> {
        const sub = await this.getSubscription(userId);
        if (sub) {
            return {
                tier: sub.tier as 'trial' | 'shared',
                dailyLimitBytes: sub.daily_quota_bytes,
                perFileLimitBytes: sub.per_file_limit_bytes,
                expiryDate: sub.expiry_date
            };
        }
        return {
            tier: 'trial',
            dailyLimitBytes: CONSTANTS.SUBSCRIPTION.TRIAL_DAILY_QUOTA_BYTES,
            perFileLimitBytes: 0,
            expiryDate: null
        };
    }

    /**
     * Check if a transfer is allowed and reserve quota atomically.
     * Returns { allowed: true } if quota was reserved, or { allowed: false, reason } if not.
     *
     * Uses INSERT...ON CONFLICT DO UPDATE...WHERE...RETURNING for atomic check-and-reserve.
     * If the WHERE clause fails (would exceed limit), the UPDATE returns no rows.
     */
    async checkAndReserve(req: TransferRequest): Promise<QuotaCheckResult> {
        const userId = req.userId;
        if (!userId) {
            // Backward compatibility: allow transfers without userId
            return { allowed: true };
        }

        const now = Date.now();
        const dayKey = getPersianDateKey(now);
        const fileSize = req.fileSize || 0;

        const limits = await this.getEffectiveLimits(userId);

        // Check per-file limit (shared tier: 2GB max per file)
        if (limits.perFileLimitBytes > 0 && fileSize > limits.perFileLimitBytes) {
            return {
                allowed: false,
                reason: 'file_too_large',
                details: {
                    fileSize,
                    perFileLimit: limits.perFileLimitBytes
                }
            };
        }

        // Atomic check-and-reserve using UPSERT with conditional WHERE
        // - If row doesn't exist: INSERT with reserved_bytes = fileSize
        // - If row exists: UPDATE reserved_bytes += fileSize WHERE total + fileSize <= daily_limit
        // - If WHERE fails: RETURNING returns no rows => quota exceeded
        const expiresAt = Math.floor(now / 1000) + 49 * 3600; // 49 hours

        const result = await this.env.DB.prepare(
            `INSERT INTO daily_quota (user_id, day, used_bytes, transfer_count, daily_limit, reserved_bytes, last_updated, expires_at)
             VALUES (?1, ?2, 0, 0, ?3, ?4, ?5, ?6)
             ON CONFLICT(user_id, day) DO UPDATE
                 SET daily_limit = ?3,
                     reserved_bytes = reserved_bytes + ?4,
                     last_updated = ?5
             WHERE used_bytes + reserved_bytes + ?4 <= daily_limit
             RETURNING used_bytes, reserved_bytes, daily_limit`
        )
        .bind(userId, dayKey, limits.dailyLimitBytes, fileSize, now, expiresAt)
        .first<{ used_bytes: number; reserved_bytes: number; daily_limit: number }>();

        if (!result) {
            // Quota exceeded
            return {
                allowed: false,
                reason: 'quota_exceeded',
                details: {
                    dailyLimit: limits.dailyLimitBytes,
                    dayKey
                }
            };
        }

        return {
            allowed: true,
            quota: {
                used_bytes: result.used_bytes,
                reserved_bytes: result.reserved_bytes,
                daily_limit: result.daily_limit
            }
        };
    }

    /**
     * Convert reserved bytes to used bytes (after transfer completes successfully).
     */
    async confirmUsage(userId: string, fileSize: number): Promise<void> {
        if (!userId) return;
        const now = Date.now();
        const dayKey = getPersianDateKey(now);

        await this.env.DB.prepare(
            `UPDATE daily_quota
                SET reserved_bytes = MAX(0, reserved_bytes - ?1),
                    used_bytes = used_bytes + ?1,
                    transfer_count = transfer_count + 1,
                    last_updated = ?2
              WHERE user_id = ?3 AND day = ?4`
        )
        .bind(fileSize, now, userId, dayKey)
        .run();
    }

    /**
     * Release reserved bytes (when transfer fails or is cancelled).
     */
    async releaseReserved(userId: string, fileSize: number): Promise<void> {
        if (!userId) return;
        const now = Date.now();
        const dayKey = getPersianDateKey(now);

        await this.env.DB.prepare(
            `UPDATE daily_quota
                SET reserved_bytes = MAX(0, reserved_bytes - ?1),
                    last_updated = ?2
              WHERE user_id = ?3 AND day = ?4`
        )
        .bind(fileSize, now, userId, dayKey)
        .run();
    }

    /**
     * Get the current day's quota usage for display.
     */
    async getTodayUsage(userId: string): Promise<{
        usedBytes: number;
        reservedBytes: number;
        dailyLimit: number;
        transferCount: number;
    } | null> {
        const now = Date.now();
        const dayKey = getPersianDateKey(now);

        const result = await this.env.DB.prepare(
            `SELECT used_bytes, reserved_bytes, daily_limit, transfer_count
             FROM daily_quota
             WHERE user_id = ?1 AND day = ?2`
        )
        .bind(userId, dayKey)
        .first<{ used_bytes: number; reserved_bytes: number; daily_limit: number; transfer_count: number }>();

        if (!result) {
            const limits = await this.getEffectiveLimits(userId);
            return {
                usedBytes: 0,
                reservedBytes: 0,
                dailyLimit: limits.dailyLimitBytes,
                transferCount: 0
            };
        }

        return {
            usedBytes: result.used_bytes,
            reservedBytes: result.reserved_bytes,
            dailyLimit: result.daily_limit,
            transferCount: result.transfer_count
        };
    }

    /**
     * Cleanup expired daily_quota rows (called by cron).
     */
    async cleanupExpiredQuota(): Promise<number> {
        const nowSec = Math.floor(Date.now() / 1000);
        const result = await this.env.DB.prepare(
            `DELETE FROM daily_quota WHERE expires_at <= ?1`
        )
        .bind(nowSec)
        .run();

        return result.meta?.changes || 0;
    }

    /**
     * Reset daily quota for a user (called when they subscribe).
     * This gives them a fresh quota for the current day immediately.
     */
    async resetDailyQuota(userId: string): Promise<void> {
        const now = Date.now();
        const dayKey = getPersianDateKey(now);

        // Delete today's quota record so user starts fresh
        await this.env.DB.prepare(
            `DELETE FROM daily_quota WHERE user_id = ?1 AND day = ?2`
        )
        .bind(userId, dayKey)
        .run();

        console.log(`[Quota] Daily quota reset for user ${userId} on ${dayKey} (subscription activated)`);
    }

    /**
     * Activate a subscription for a user (after payment verified).
     * If user has an active subscription, extend it (sum dates).
     * Otherwise, create a new one starting now.
     */
    async activateSubscription(params: {
        userId: string;
        paymentRef: string;
        method: 'auto' | 'manual';
    }): Promise<{ startDate: number; expiryDate: number; extended: boolean }> {
        const now = Date.now();
        const durationMs = CONSTANTS.SUBSCRIPTION.DURATION_DAYS * 24 * 3600 * 1000;
        const sharedLimit = CONSTANTS.SUBSCRIPTION.SHARED_DAILY_QUOTA_BYTES;

        // Try to extend existing active subscription
        const extendResult = await this.env.DB.prepare(
            `UPDATE subscriptions
                SET tier = 'shared',
                    expiry_date = expiry_date + ?1,
                    daily_quota_bytes = ?2,
                    per_file_limit_bytes = ?3,
                    payment_ref = ?4,
                    activated_at = ?5,
                    source = 'paid',
                    updated_at = ?5
              WHERE user_id = ?6 AND expiry_date > ?5
            RETURNING start_date, expiry_date`
        )
        .bind(durationMs, sharedLimit, CONSTANTS.SUBSCRIPTION.SHARED_PER_FILE_LIMIT_BYTES, params.paymentRef, now, params.userId)
        .first<{ start_date: number; expiry_date: number }>();

        if (extendResult) {
            return {
                startDate: extendResult.start_date,
                expiryDate: extendResult.expiry_date,
                extended: true
            };
        }

        // No active subscription — create a new one
        await this.env.DB.prepare(
            `INSERT INTO subscriptions
                (user_id, tier, start_date, expiry_date, daily_quota_bytes,
                 per_file_limit_bytes, payment_ref, activated_at, source)
             VALUES (?1, 'shared', ?2, ?3, ?4, ?5, ?6, ?7, 'paid')
             ON CONFLICT(user_id) DO UPDATE
                SET tier = 'shared',
                    start_date = ?2,
                    expiry_date = ?3,
                    daily_quota_bytes = ?4,
                    per_file_limit_bytes = ?5,
                    payment_ref = ?6,
                    activated_at = ?7,
                    source = 'paid',
                    updated_at = ?7`
        )
        .bind(
            params.userId, now, now + durationMs,
            sharedLimit, CONSTANTS.SUBSCRIPTION.SHARED_PER_FILE_LIMIT_BYTES,
            params.paymentRef, now
        )
        .run();

        return {
            startDate: now,
            expiryDate: now + durationMs,
            extended: false
        };
    }
}
