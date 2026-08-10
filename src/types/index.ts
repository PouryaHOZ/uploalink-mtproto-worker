export interface Env {
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    TELEGRAM_API_ID?: string;
    TELEGRAM_API_HASH?: string;
    TELEGRAM_SESSION_STRING?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;

    BALE_BOT_TOKEN?: string;
    BALE_CHAT_ID?: string;
    BALE_WEBHOOK_SECRET?: string;

    RUBIKA_BOT_TOKEN?: string;
    RUBIKA_CHAT_ID?: string;
    RUBIKA_WEBHOOK_SECRET?: string;

    GITHUB_ACTIONS_WEBHOOK: string;
    GITHUB_TOKEN: string;
    GITHUB_REPO: string;

    LINKS: KVNamespace;
    DB: D1Database;

    MAX_CONCURRENT_TRANSFERS?: string;
    RATE_LIMIT?: string;

    TELEGRAM_BASE_URL?: string;
    BALE_BASE_URL?: string;
    RUBIKA_BASE_URL?: string;

    JWT_SECRET?: string;

    // ===== Subscription & Payment =====
    DARAMET_API_TOKEN: string;
    DARAMET_USERNAME: string;
    DARAMET_BASE_URL?: string;
}

export type Platform = 'telegram' | 'bale' | 'rubika';

export interface TransferRequest {
    messageId: string | number;
    chatId: string;
    fileName: string;
    fileSize: number;
    isVideo: boolean;
    mimeType?: string;
    userId?: string;
    userName?: string;
    date?: number;
    fileId?: string;
    platform: Platform;
    destinations?: ('bale' | 'rubika')[];
    account?: string;
    shouldCompress?: boolean;
}

export interface ActiveTransfer {
    id: string;
    transferRequest: TransferRequest;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    error?: string;
    progress?: number;
}

export interface ConnectedAccount {
    rubikaChatId?: string;
    baleChatId?: string;
    telegramUserId?: string;
    telegramChatId?: string;
    connectedAt: number;
    lastUsed?: number;
}

export interface NormalizedMessage {
    chatId: string;
    userId: string;
    userName: string;
    text: string;
    isFile: boolean;
    isCallback: boolean;
    raw: any;
}

// ===== Subscription & Payment types =====

export type SubscriptionTier = 'trial' | 'shared' | 'none';
export type SubscriptionSource = 'auto_trial' | 'manual_trial' | 'paid';

export interface Subscription {
    user_id: string;
    tier: SubscriptionTier;
    start_date: number;
    expiry_date: number;
    daily_quota_bytes: number;
    per_file_limit_bytes: number;
    payment_ref?: string;
    activated_at: number;
    source: SubscriptionSource;
    created_at?: number;
    updated_at?: number;
}

export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'cancelled';
export type VerificationMethod = 'auto' | 'manual';

export interface PendingPayment {
    payment_id: string;
    message_id: number;
    message_text: string;
    user_id: string;
    chat_id: string;
    platform: Platform;
    amount: number;
    generated_at: number;
    link_expiry_at: number;
    message_lock_expiry_at: number;
    payment_window_expiry_at: number;
    display_deleted_at?: number;
    status: PaymentStatus;
    tracking_code?: string;
    verified_at?: number;
    verification_method?: VerificationMethod;
    reminder_sent: number;
    expires_at: number;
}

export interface DailyQuota {
    user_id: string;
    day: string;
    used_bytes: number;
    transfer_count: number;
    daily_limit: number;
    reserved_bytes: number;
    last_updated: number;
    expires_at: number;
}

export interface DarametDonation {
    id: string;
    trackingCode: string;
    amount: number;
    message: string;
    donorName?: string;
    date: number;
    status?: string;
}

export interface QuotaCheckResult {
    allowed: boolean;
    reason?: 'file_too_large' | 'quota_exceeded' | 'no_subscription' | 'error';
    details?: {
        fileSize?: number;
        perFileLimit?: number;
        dailyLimit?: number;
        usedBytes?: number;
        dayKey?: string;
    };
    quota?: {
        used_bytes: number;
        reserved_bytes: number;
        daily_limit: number;
    };
}