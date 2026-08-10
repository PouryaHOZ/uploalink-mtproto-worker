-- ============================================================
-- Migration 0002: Seed message_state with 10,000 empty rows
-- (text lives in src/data/messages.ts, this table only tracks state)
-- ============================================================

WITH RECURSIVE seq(n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 9999
)
INSERT INTO message_state (message_id, locked, used)
SELECT n, 0, 0 FROM seq;
