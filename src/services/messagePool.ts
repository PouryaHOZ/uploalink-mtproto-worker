import { Env } from '../types';
import { CONSTANTS } from '../config/constants';
import { MESSAGES, MESSAGE_COUNT } from '../data/messages';

export interface AcquiredMessage {
    messageId: number;
    text: string;
}

/**
 * MessagePool service — manages the 10,000-message corpus state in D1.
 *
 * Selection strategy: SEQUENTIAL — the first available (lowest message_id)
 * message that is neither locked nor used is claimed.
 *
 * The message text itself lives in src/data/messages.ts (bundled in Worker memory).
 * D1 only stores state (locked/used flags) to keep the table small and fast.
 */
export class MessagePool {
    constructor(private env: Env) {}

    /**
     * Atomically claim the first available message.
     * Uses a single UPDATE...RETURNING statement with a subquery to find MIN(message_id).
     * This is race-free under D1's single-threaded execution model.
     */
    async acquire(paymentId: string): Promise<AcquiredMessage | null> {
        const now = Date.now();
        const lockExpiry = now + CONSTANTS.PAYMENT.MESSAGE_LOCK_TTL_MS;

        const result = await this.env.DB.prepare(
            `UPDATE message_state
                SET locked = 1,
                    locked_by = ?1,
                    locked_at = ?2,
                    lock_expires_at = ?3
              WHERE message_id = (
                  SELECT MIN(message_id) FROM message_state
                   WHERE used = 0
                     AND (locked = 0 OR lock_expires_at <= ?4)
              )
            RETURNING message_id`
        )
        .bind(paymentId, now, lockExpiry, now)
        .first<{ message_id: number }>();

        if (!result) {
            // All 10,000 messages are locked or used — should not happen normally
            console.error('MessagePool: all 10,000 messages are locked/used');
            return null;
        }

        const messageId = result.message_id;
        const text = MESSAGES[messageId];

        if (text === undefined) {
            console.error(`MessagePool: message_id ${messageId} out of range (MESSAGE_COUNT=${MESSAGE_COUNT})`);
            return null;
        }

        return { messageId, text };
    }

    /**
     * Release a lock on a message (when user cancels or payment window expires).
     * Only releases if the message is not yet used.
     */
    async release(messageId: number): Promise<void> {
        await this.env.DB.prepare(
            `UPDATE message_state
                SET locked = 0,
                    locked_by = NULL,
                    locked_at = NULL,
                    lock_expires_at = NULL
              WHERE message_id = ?1
                AND used = 0`
        )
        .bind(messageId)
        .run();
    }

    /**
     * Mark a message as used (after payment is verified).
     * The message becomes unavailable for the MESSAGE_USED_COOLDOWN_DAYS period (90 days).
     */
    async markUsed(messageId: number, userId: string): Promise<void> {
        const now = Date.now();
        const usedExpiry = now + CONSTANTS.SUBSCRIPTION.MESSAGE_USED_COOLDOWN_DAYS * 24 * 3600 * 1000;

        await this.env.DB.prepare(
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
        )
        .bind(userId, now, usedExpiry, messageId)
        .run();
    }

    /**
     * Cleanup expired locks (called by cron).
     * Releases locks whose lock_expires_at has passed.
     */
    async cleanupExpiredLocks(): Promise<number> {
        const now = Date.now();
        const result = await this.env.DB.prepare(
            `UPDATE message_state
                SET locked = 0,
                    locked_by = NULL,
                    locked_at = NULL,
                    lock_expires_at = NULL
              WHERE locked = 1
                AND lock_expires_at <= ?1`
        )
        .bind(now)
        .run();

        return result.meta?.changes || 0;
    }

    /**
     * Recycle used messages whose cooldown has passed (called by cron every 6 hours).
     * Makes them available again for new payments.
     */
    async recycleUsedMessages(): Promise<number> {
        const now = Date.now();
        const result = await this.env.DB.prepare(
            `UPDATE message_state
                SET used = 0,
                    used_by = NULL,
                    used_at = NULL,
                    used_expires_at = NULL
              WHERE used = 1
                AND used_expires_at <= ?1`
        )
        .bind(now)
        .run();

        return result.meta?.changes || 0;
    }

    /**
     * Get statistics about the message pool.
     */
    async getStats(): Promise<{ total: number; locked: number; used: number; free: number }> {
        const result = await this.env.DB.prepare(
            `SELECT
                COUNT(*) as total,
                SUM(CASE WHEN locked = 1 THEN 1 ELSE 0 END) as locked,
                SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) as used
             FROM message_state`
        ).first<{ total: number; locked: number; used: number }>();

        const total = result?.total || MESSAGE_COUNT;
        const locked = result?.locked || 0;
        const used = result?.used || 0;

        return {
            total,
            locked,
            used,
            free: total - locked - used
        };
    }
}
