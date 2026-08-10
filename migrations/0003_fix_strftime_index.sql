-- ============================================================
-- Migration 0003: Fix strftime() in partial index (D1 error)
-- 
-- PROBLEM: D1/SQLite does not allow non-deterministic functions
-- like strftime() in index definitions because the index would
-- need constant recalculation.
--
-- ERROR: "non-deterministic use of strftime() in an index: SQLITE_ERROR"
--
-- FIX: Drop the problematic partial index and replace with
-- a regular composite index. Query-time filtering handles
-- the conditions that were in the partial index WHERE clause.
-- ============================================================

-- Drop the problematic partial index (if it exists)
DROP INDEX IF EXISTS idx_msg_free;

-- Create replacement index without strftime()
-- This covers the same query patterns used in MessagePool.acquire():
-- - WHERE used = 0 AND (locked = 0 OR lock_expires_at <= ?)
CREATE INDEX IF NOT EXISTS idx_msg_free_fixed ON message_state(used, locked, lock_expires_at);

-- Verify the fix
SELECT 'Migration 0003 complete: Fixed strftime() index issue' as status;
