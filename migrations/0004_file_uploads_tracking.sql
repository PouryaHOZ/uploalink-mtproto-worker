-- Track file uploads for automatic cleanup
-- Files are auto-deleted after FILE_TTL_MS (2 hours)
CREATE TABLE IF NOT EXISTS file_uploads (
    transfer_id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL,
    storage_path TEXT,
    uploaded_at INTEGER NOT NULL,       -- Timestamp when uploaded
    expires_at INTEGER NOT NULL,         -- When this file should be deleted (uploaded_at + 2 hours)
    status TEXT NOT NULL DEFAULT 'active', -- active, cleanup_pending, deleted
    deleted_at INTEGER,                  -- When actually deleted from storage
    cleanup_requested_at INTEGER,        -- When cleanup was first requested
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Index for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_file_uploads_expires ON file_uploads(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_file_uploads_user ON file_uploads(user_id, status);
