-- ============================================================
-- Migration 0001: Initial schema for subscription system
-- ============================================================

-- ===== 1) Subscriptions =====
CREATE TABLE IF NOT EXISTS subscriptions (
    user_id              TEXT PRIMARY KEY,
    tier                 TEXT NOT NULL CHECK (tier IN ('trial', 'shared', 'none')),
    start_date           INTEGER NOT NULL,
    expiry_date          INTEGER NOT NULL,
    daily_quota_bytes    INTEGER NOT NULL,
    per_file_limit_bytes INTEGER NOT NULL DEFAULT 0,
    payment_ref          TEXT,
    activated_at         INTEGER NOT NULL,
    source               TEXT NOT NULL CHECK (source IN ('auto_trial', 'manual_trial', 'paid')),
    created_at           INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
    updated_at           INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_sub_expiry ON subscriptions(expiry_date);
CREATE INDEX IF NOT EXISTS idx_sub_tier_expiry ON subscriptions(tier, expiry_date);

-- ===== 2) Pending payments =====
CREATE TABLE IF NOT EXISTS pending_payments (
    payment_id                TEXT PRIMARY KEY,
    message_id                INTEGER NOT NULL,
    message_text              TEXT NOT NULL,
    user_id                   TEXT NOT NULL,
    chat_id                   TEXT NOT NULL,
    platform                  TEXT NOT NULL,
    amount                    INTEGER NOT NULL,
    generated_at              INTEGER NOT NULL,
    link_expiry_at            INTEGER NOT NULL,
    message_lock_expiry_at    INTEGER NOT NULL,
    payment_window_expiry_at  INTEGER NOT NULL,
    display_deleted_at        INTEGER,
    status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
    tracking_code             TEXT,
    verified_at               INTEGER,
    verification_method       TEXT CHECK (verification_method IN ('auto', 'manual')),
    reminder_sent             INTEGER DEFAULT 0,
    expires_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pp_status_expiry ON pending_payments(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pp_user_status ON pending_payments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_pp_user_active ON pending_payments(user_id) WHERE status = 'pending';

-- ===== 3) Daily quota =====
CREATE TABLE IF NOT EXISTS daily_quota (
    user_id         TEXT NOT NULL,
    day             TEXT NOT NULL,
    used_bytes      INTEGER NOT NULL DEFAULT 0,
    transfer_count  INTEGER NOT NULL DEFAULT 0,
    daily_limit     INTEGER NOT NULL,
    reserved_bytes  INTEGER NOT NULL DEFAULT 0,
    last_updated    INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_quota_expiry ON daily_quota(expires_at);

-- ===== 4) Message pool state (text is in src/data/messages.ts) =====
CREATE TABLE IF NOT EXISTS message_state (
    message_id        INTEGER PRIMARY KEY,
    locked            INTEGER NOT NULL DEFAULT 0,
    locked_by         TEXT,
    locked_at         INTEGER,
    lock_expires_at   INTEGER,
    used              INTEGER NOT NULL DEFAULT 0,
    used_by           TEXT,
    used_at           INTEGER,
    used_expires_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_free ON message_state(message_id)
    WHERE used = 0 AND (locked = 0 OR lock_expires_at <= CAST(strftime('%s','now') AS INTEGER));
CREATE INDEX IF NOT EXISTS idx_msg_lock_expiry ON message_state(lock_expires_at) WHERE locked = 1;
CREATE INDEX IF NOT EXISTS idx_msg_used_expiry ON message_state(used_expires_at) WHERE used = 1;

-- ===== 5) Settings (mutable without redeploy) =====
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('subscription_price_toman', '80000', CAST(strftime('%s','now') AS INTEGER)),
    ('subscription_duration_days', '30', CAST(strftime('%s','now') AS INTEGER)),
    ('trial_daily_quota_mb', '500', CAST(strftime('%s','now') AS INTEGER)),
    ('trial_duration_days', '7', CAST(strftime('%s','now') AS INTEGER)),
    ('shared_daily_quota_mb', '5120', CAST(strftime('%s','now') AS INTEGER)),
    ('shared_per_file_mb', '2048', CAST(strftime('%s','now') AS INTEGER)),
    ('payment_link_ttl_minutes', '60', CAST(strftime('%s','now') AS INTEGER)),
    ('payment_window_ttl_hours', '3', CAST(strftime('%s','now') AS INTEGER)),
    ('message_used_cooldown_days', '90', CAST(strftime('%s','now') AS INTEGER));

PRAGMA optimize;
