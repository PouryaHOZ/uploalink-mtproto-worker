import { Env } from '../types';
import { CONSTANTS } from '../config/constants';

/**
 * Storage service — manages cloud storage cleanup and file lifecycle.
 *
 * Files should be automatically deleted after FILE_TTL_MS (2 hours).
 * This service tracks uploads and provides cleanup functionality.
 *
 * Note: Actual file deletion is performed by the external processing server (MinIO).
 * This service tracks what SHOULD be deleted and can trigger cleanup via webhook.
 */
export class StorageService {
    constructor(private env: Env) {}

    /**
     * Record a file upload for tracking/cleanup purposes.
     * Called when a file is successfully uploaded to cloud storage.
     */
    async recordFileUpload(params: {
        transferId: string;
        fileName: string;
        fileSize: number;
        userId: string;
        storagePath?: string;
    }): Promise<void> {
        const now = Date.now();
        const expiresAt = now + CONSTANTS.STORAGE.FILE_TTL_MS;

        await this.env.DB.prepare(
            `INSERT INTO file_uploads
                (transfer_id, file_name, file_size, user_id, storage_path,
                 uploaded_at, expires_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active')
             ON CONFLICT(transfer_id) DO UPDATE
                SET file_name = ?2,
                    file_size = ?3,
                    expires_at = ?7,
                    status = 'active'`
        )
        .bind(
            params.transferId,
            params.fileName,
            params.fileSize,
            params.userId,
            params.storagePath || null,
            now,
            expiresAt
        )
        .run();

        console.log(`[Storage] Recorded upload: ${params.fileName} (${params.transferId}), expires at ${new Date(expiresAt).toISOString()}`);
    }

    /**
     * Mark a file as deleted (called by external server after actual deletion).
     */
    async markFileDeleted(transferId: string): Promise<void> {
        await this.env.DB.prepare(
            `UPDATE file_uploads
                SET status = 'deleted',
                    deleted_at = ?1
              WHERE transfer_id = ?2 AND status = 'active'`
        )
        .bind(Date.now(), transferId)
        .run();
    }

    /**
     * Get files that should be deleted (expired but still marked as active).
     * These are candidates for cleanup.
     */
    async getExpiredFiles(limit: number = 100): Promise<Array<{
        transfer_id: string;
        file_name: string;
        storage_path: string | null;
        expires_at: number;
        user_id: string;
    }>> {
        const now = Date.now();

        const result = await this.env.DB.prepare(
            `SELECT transfer_id, file_name, storage_path, expires_at, user_id
             FROM file_uploads
             WHERE status = 'active' AND expires_at <= ?1
             ORDER BY expires_at ASC
             LIMIT ?2`
        )
        .bind(now, limit)
        .all();

        return result.results || [];
    }

    /**
     * Get storage usage statistics.
     */
    async getStorageStats(): Promise<{
        totalFiles: number;
        activeFiles: number;
        expiredFiles: number;
        totalBytes: number;
        expiringSoon: number; // Files expiring in next 30 minutes
    }> {
        const now = Date.now();
        const soonThreshold = now + 30 * 60 * 1000; // 30 minutes

        const stats = await this.env.DB.prepare(
            `SELECT
                COUNT(*) as total_files,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_files,
                SUM(CASE WHEN status = 'active' AND expires_at <= ?1 THEN 1 ELSE 0 END) as expired_files,
                SUM(CASE WHEN status = 'active' THEN file_size ELSE 0 END) as total_bytes,
                SUM(CASE WHEN status = 'active' AND expires_at <= ?2 THEN 1 ELSE 0 END) as expiring_soon
             FROM file_uploads`
        )
        .bind(now, soonThreshold)
        .first<{
            total_files: number;
            active_files: number;
            expired_files: number;
            total_bytes: number;
            expiring_soon: number;
        }>();

        return {
            totalFiles: stats?.total_files || 0,
            activeFiles: stats?.active_files || 0,
            expiredFiles: stats?.expired_files || 0,
            totalBytes: stats?.total_bytes || 0,
            expiringSoon: stats?.expiring_soon || 0
        };
    }

    /**
     * Cleanup expired files from tracking database.
     * Returns the number of files marked for cleanup.
     *
     * Note: This only updates the database records.
     * Actual file deletion from MinIO/S3 should be handled by:
     * 1. The external processing server's manageStorage() function
     * 2. Or a separate cleanup worker with S3/MinIO access
     */
    async cleanupExpiredRecords(): Promise<number> {
        const now = Date.now();

        const result = await this.env.DB.prepare(
            `UPDATE file_uploads
                SET status = 'cleanup_pending',
                    cleanup_requested_at = ?1
              WHERE status = 'active' AND expires_at <= ?1`
        )
        .bind(now)
        .run();

        const count = result.meta?.changes || 0;

        if (count > 0) {
            console.log(`[Storage] Marked ${count} expired files for cleanup`);
        }

        return count;
    }

    /**
     * Permanently remove old cleanup-pending records (after confirmed deletion).
     * Call this after external server confirms files are deleted.
     */
    async purgeCleanupRecords(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
        const cutoff = Date.now() - olderThanMs;

        const result = await this.env.DB.prepare(
            `DELETE FROM file_uploads
             WHERE status IN ('cleanup_pending', 'deleted')
               AND (deleted_at IS NULL OR deleted_at < ?1)
               AND expires_at < ?1`
        )
        .bind(cutoff)
        .run();

        return result.meta?.changes || 0;
    }
}
