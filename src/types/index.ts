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
    MAX_CONCURRENT_TRANSFERS?: string;
    RATE_LIMIT?: string;
    
    TELEGRAM_BASE_URL?: string;
    BALE_BASE_URL?: string;
    RUBIKA_BASE_URL?: string;
    
    JWT_SECRET?: string;
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
    destinations?: ('bale' | 'rubika' | 'telegram')[];
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
    connectedAt: number;
    lastUsed?: number;
}

export interface NormalizedMessage {
    chatId: string;
    userId: string;
    userName: string;
    text: string;
    isFile: boolean;
    raw: any;
}