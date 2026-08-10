import { Env } from '../types';
import { CONSTANTS } from '../config/constants';
import { MESSAGES, MESSAGE_COUNT } from '../data/messages';

export interface AcquiredMessage {
    messageId: number;
    text: string;
}

/**
 * Circuit breaker state for D1 connections
 * Prevents hammering D1 when it's consistently failing
 */
interface CircuitBreakerState {
    isOpen: boolean;
    failureCount: number;
    lastFailureTime: number;
    nextRetryTime: number;
}

/**
 * MessagePool service — manages the 10,000-message corpus state in D1.
 *
 * Selection strategy: SEQUENTIAL — the first available (lowest message_id)
 * message that is neither locked nor used is claimed.
 *
 * Features:
 * - Retry logic with exponential backoff
 * - Circuit breaker pattern to prevent cascade failures
 * - Two-step query fallback (SELECT + UPDATE) for complex queries
 * - Health check endpoint for monitoring
 *
 * The message text itself lives in src/data/messages.ts (bundled in Worker memory).
 * D1 only stores state (locked/used flags) to keep the table small and fast.
 */
export class MessagePool {
    private maxRetries = 3;
    private retryDelayMs = 1000;
    
    // Circuit breaker settings
    private circuitBreaker: CircuitBreakerState = {
        isOpen: false,
        failureCount: 0,
        lastFailureTime: 0,
        nextRetryTime: 0
    };
    private readonly circuitBreakerThreshold = 5; // Open after 5 consecutive failures
    private readonly circuitBreakerResetMs = 60000; // Try again after 60 seconds

    constructor(private env: Env) {}

    /**
     * Atomically claim the first available message.
     * 
     * Strategy:
     * 1. Check circuit breaker first (fail fast if D1 is down)
     * 2. Try optimized single-query approach (UPDATE...RETURNING with subquery)
     * 3. Fallback to two-step approach (SELECT then UPDATE) if needed
     * 4. Retry on transient errors with exponential backoff
     * 
     * @throws {Error} If D1 query fails after all retries
     */
    async acquire(paymentId: string): Promise<AcquiredMessage | null> {
        const now = Date.now();
        
        // CIRCUIT BREAKER CHECK: Fail fast if D1 is known to be down
        if (this.circuitBreaker.isOpen) {
            if (now < this.circuitBreaker.nextRetryTime) {
                const waitMs = this.circuitBreaker.nextRetryTime - now;
                console.error(`[MessagePool] Circuit breaker OPEN - D1 unavailable. Retry in ${waitMs}ms`);
                throw new Error(
                    `D1 database temporarily unavailable (circuit breaker open). ` +
                    `Please try again in ${Math.ceil(waitMs / 1000)} seconds.`
                );
            }
            // Time to try again - reset circuit breaker
            console.log('[MessagePool] Circuit breaker half-open - attempting reset');
            this.circuitBreaker.isOpen = false;
            this.circuitBreaker.failureCount = 0;
        }

        // Verify DB binding exists before querying
        if (!this.env.DB) {
            throw new Error('D1 database binding (DB) is not configured in wrangler.jsonc');
        }

        const lockExpiry = now + CONSTANTS.PAYMENT.MESSAGE_LOCK_TTL_MS;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                let messageId: number | null = null;

                // STRATEGY 1: Optimized single-query approach (UPDATE...RETURNING)
                try {
                    messageId = await this.acquireSingleQuery(paymentId, now, lockExpiry);
                } catch (singleQueryError) {
                    console.warn(`[MessagePool] Single-query failed, trying two-step fallback:`, 
                        singleQueryError.message);
                    
                    // STRATEGY 2: Fallback to two-step approach
                    messageId = await this.acquireTwoStep(paymentId, now, lockExpiry);
                }

                if (!messageId) {
                    // All messages locked/used
                    console.error('[MessagePool] All messages are locked/used');
                    return null;
                }

                // Get message text from bundled data
                const text = MESSAGES[messageId];
                if (text === undefined) {
                    console.error(`[MessagePool] message_id ${messageId} out of range (MESSAGE_COUNT=${MESSAGE_COUNT})`);
                    return null;
                }

                // SUCCESS! Reset circuit breaker failure count
                this.circuitBreaker.failureCount = 0;
                
                if (attempt > 1) {
                    console.log(`[MessagePool] Acquired message ${messageId} on attempt ${attempt}/${this.maxRetries}`);
                }

                return { messageId, text };

            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                
                // Detailed error logging
                console.error(`[MessagePool] D1 error (attempt ${attempt}/${this.maxRetries}):`, {
                    error: lastError.message,
                    name: lastError.name,
                    paymentId: paymentId.substring(0, 12) + '...',
                    timestamp: new Date().toISOString()
                });

                // Update circuit breaker
                this.circuitBreaker.failureCount++;
                this.circuitBreaker.lastFailureTime = now;

                // Check if we should give up (non-retryable or max retries reached)
                const isRetryable = this.isRetryableError(lastError);
                
                if (!isRetryable || attempt === this.maxRetries) {
                    // Open circuit breaker if too many failures
                    if (this.circuitBreaker.failureCount >= this.circuitBreakerThreshold) {
                        this.openCircuitBreaker();
                    }
                    
                    console.error(`[MessagePool] Failed after ${attempt} attempts. Error:`, lastError.message);
                    throw new Error(
                        `Database error in MessagePool.acquire: ${lastError.message}`
                    );
                }

                // Exponential backoff before retry
                const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
                console.log(`[MessagePool] Retrying in ${delay}ms... (${this.circuitBreaker.failureCount} consecutive failures)`);
                await this.sleep(delay);
            }
        }

        // Should never reach here, but TypeScript needs it
        throw lastError || new Error('Unknown error in MessagePool.acquire');
    }

    /**
     * Strategy 1: Single-query atomic acquire using UPDATE...RETURNING with subquery
     * This is the most efficient but may fail on some D1 configurations
     */
    private async acquireSingleQuery(
        paymentId: string, 
        now: number, 
        lockExpiry: number
    ): Promise<number | null> {
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

        return result?.message_id || null;
    }

    /**
     * Strategy 2: Two-step fallback (SELECT then UPDATE)
     * More compatible with different D1 configurations
     */
    private async acquireTwoStep(
        paymentId: string, 
        now: number, 
        lockExpiry: number
    ): Promise<number | null> {
        // Step 1: Find the first available message
        const available = await this.env.DB.prepare(
            `SELECT message_id FROM message_state
             WHERE used = 0
               AND (locked = 0 OR lock_expires_at <= ?1)
             ORDER BY message_id ASC
             LIMIT 1`
        )
        .bind(now)
        .first<{ message_id: number }>();

        if (!available) {
            return null; // No available messages
        }

        // Step 2: Try to lock it (might fail if another request grabbed it first)
        const updateResult = await this.env.DB.prepare(
            `UPDATE message_state
                SET locked = 1,
                    locked_by = ?1,
                    locked_at = ?2,
                    lock_expires_at = ?3
              WHERE message_id = ?4
                AND used = 0
                AND (locked = 0 OR lock_expires_at <= ?5)`
        )
        .bind(paymentId, now, lockExpiry, available.message_id, now)
        .run();

        // Check if the update actually affected a row
        if (!updateResult.meta?.changes || updateResult.meta.changes === 0) {
            // Someone else grabbed it - recursively try next one (with recursion limit)
            return this.acquireWithRecursionLimit(paymentId, now, lockExpiry, 3);
        }

        return available.message_id;
    }

    /**
     * Recursive helper for two-step acquisition with limit to prevent infinite loops
     */
    private async acquireWithRecursionLimit(
        paymentId: string, 
        now: number, 
        lockExpiry: number,
        remainingAttempts: number
    ): Promise<number | null> {
        if (remainingAttempts <= 0) {
            console.warn('[MessagePool] Two-step acquire recursion limit reached');
            return null;
        }

        return this.acquireTwoStep(paymentId, now, lockExpiry);
    }

    /**
     * Determine if an error is retryable (transient vs permanent)
     */
    private isRetryableError(err: Error): boolean {
        const msg = err.message.toLowerCase();
        
        // These errors indicate permanent issues - don't retry
        const nonRetryablePatterns = [
            'no such table',
            'no such column',
            'syntax error',
            'constraint failed',
            'unique constraint',
            'database binding',
            'not configured',
            'near "("'  // SQL syntax errors often show like this
        ];

        for (const pattern of nonRetryablePatterns) {
            if (msg.includes(pattern)) {
                console.warn(`[MessagePool] Non-retryable error detected: ${pattern}`);
                return false;
            }
        }

        // Everything else (timeouts, connection errors, internal D1 errors) is retryable
        return true;
    }

    /**
     * Open the circuit breaker to stop hammering D1
     */
    private openCircuitBreaker(): void {
        this.circuitBreaker.isOpen = true;
        this.circuitBreaker.nextRetryTime = Date.now() + this.circuitBreakerResetMs;
        console.error(
            `[MessagePool] ⚠️ CIRCUIT BREAKER OPENED - D1 appears down. ` +
            `Will retry after ${new Date(this.circuitBreaker.nextRetryTime).toISOString()}`
        );
    }

    /**
     * Manually reset circuit breaker (for testing or admin use)
     */
    resetCircuitBreaker(): void {
        this.circuitBreaker = {
            isOpen: false,
            failureCount: 0,
            lastFailureTime: 0,
            nextRetryTime: 0
        };
        console.log('[MessagePool] Circuit breaker manually reset');
    }

    /**
     * Get current circuit breaker status (for monitoring)
     */
    getCircuitBreakerStatus(): CircuitBreakerState & { threshold: number; resetAfterMs: number } {
        return {
            ...this.circuitBreaker,
            threshold: this.circuitBreakerThreshold,
            resetAfterMs: this.circuitBreakerResetMs
        };
    }

    /**
     * Simple sleep utility for retry delays
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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

    /**
     * Health check - verifies D1 database is accessible and has required tables.
     * Call this on Worker startup or when diagnosing issues.
     */
    async healthCheck(): Promise<{
        healthy: boolean;
        dbAccessible: boolean;
        tablesExist: boolean;
        hasData: boolean;
        messageCount?: number;
        circuitBreaker: CircuitBreakerState;
        error?: string
    }> {
        const result = {
            healthy: false,
            dbAccessible: false,
            tablesExist: false,
            hasData: false,
            messageCount: undefined as number | undefined,
            circuitBreaker: { ...this.circuitBreaker },
            error: undefined as string | undefined
        };

        try {
            // Check 1: DB binding exists
            if (!this.env.DB) {
                result.error = 'D1 binding (DB) not found in environment bindings';
                console.error('[HealthCheck] ❌', result.error);
                return result;
            }

            // Check 2: Can execute simple query (connection test)
            const tableCheck = await this.env.DB.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='message_state'`
            ).first<{ name: string }>();

            result.dbAccessible = true;

            if (!tableCheck) {
                result.error = '⚠️ message_state table does NOT exist. Run: npx wrangler d1 migrations apply tg-bot-db --remote';
                console.error('[HealthCheck] ❌', result.error);
                
                // List existing tables for debugging
                try {
                    const tables = await this.env.DB.prepare(
                        `SELECT name FROM sqlite_master WHERE type='table'`
                    ).all<{ name: string }>();
                    console.error('[HealthCheck] Existing tables:', tables.results?.map(t => t.name));
                } catch (e) {
                    // Ignore
                }
                
                return result;
            }

            result.tablesExist = true;

            // Check 3: Table has data
            const countResult = await this.env.DB.prepare(
                `SELECT COUNT(*) as cnt FROM message_state`
            ).first<{ cnt: number }>();

            result.messageCount = countResult?.cnt || 0;
            result.hasData = result.messageCount > 0;

            if (!result.hasData) {
                result.warning = 'Table exists but is empty. Run seed migration.';
            }

            // Final health determination
            result.healthy = result.hasData && !this.circuitBreaker.isOpen;

            console.log(
                `[HealthCheck] ✅ DB OK | Messages: ${result.messageCount} | ` +
                `Circuit Breaker: ${this.circuitBreaker.isOpen ? 'OPEN' : 'CLOSED'}`
            );

            return result;

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            result.error = `Health check exception: ${errorMsg}`;
            console.error('[HealthCheck] 💥', result.error);
            return result;
        }
    }
}
