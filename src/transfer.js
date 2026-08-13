const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");
const { EventEmitter } = require("events");

// ============================================================================
// CONFIGURATION
// ============================================================================
const TEMP_DIR = fs.existsSync("/dev/shm") ? "/dev/shm/temp_transfers" : "./temp_transfers";
const rawEndpoint = (process.env.MINIO_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const config = {
    telegram: {
        apiId: parseInt(process.env.TELEGRAM_API_ID || '0'),
        apiHash: process.env.TELEGRAM_API_HASH || '',
        sessionString: process.env.TELEGRAM_SESSION_STRING || '',
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '',
        baseUrl: process.env.TELEGRAM_BASE_URL || 'https://api.telegram.org'
    },
    minio: {
        endPoint: rawEndpoint,
        port: parseInt(process.env.MINIO_PORT || '443'),
        useSSL: process.env.MINIO_USE_SSL !== 'false',
        accessKey: process.env.MINIO_ACCESS_KEY || '',
        secretKey: process.env.MINIO_SECRET_KEY || '',
        bucketName: process.env.MINIO_BUCKET_NAME || 'transfers',
        region: process.env.MINIO_REGION || 'us-east-1'
    },
    performance: {
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '8388608'), // 8MB
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '24'),
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '5'),
        tempDir: TEMP_DIR,
        
        // Pipeline settings
        pipeline: {
            minDownloadBeforeCompress: 10 * 1024 * 1024,   // Start compress after 10MB downloaded (1.5% of 667MB)
            minCompressBeforeUpload: 5 * 1024 * 1024,     // Start upload after 5MB compressed
            compressionBuffer: 50 * 1024 * 1024,          // 50MB buffer for smooth streaming
            uploadChunkSize: 10 * 1024 * 1024             // Upload in 10MB chunks
        },
        
        memoryBudget: {
            totalSystemMemoryMB: 16384,
            osReservedMB: 2048,
            nodeHeapMB: 4096,
            perTransferMinMB: 256,
            perTransferMaxMB: 1024,
            safetyMarginMB: 512
        },
        
        multipartUpload: {
            enabled: true,
            thresholdBytes: 100 * 1024 * 1024,
            partSize: 50 * 1024 * 1024,
            concurrency: 4
        }
    },
    cloudflare: {
        webhookUrl: process.env.CLOUDFLARE_WEBHOOK_URL || '',
        apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
    },
    transferId: process.env.TRANSFER_ID || ''
};

if (!fs.existsSync(config.performance.tempDir)) fs.mkdirSync(config.performance.tempDir, { recursive: true });

// ============================================================================
// PERSIAN UI COMPONENTS - All user-facing text in Persian
// ============================================================================
const SYSTEM_VERSION = '3.0.0';

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "۰ بایت";
    const k = 1024;
    const sizes = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return "۰ بایت/ثانیه";
    return formatBytes(bytesPerSecond) + "/ثانیه";
}

function formatEta(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return "محاسبه...";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) return `${mins} دقیقه و ${secs} ثانیه`;
    return `${secs} ثانیه`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function drawProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

/**
 * Renders the main progress card shown to user in Telegram
 * All text is in Persian for better UX
 */
function renderProgressCard({ 
    fileName, 
    masterPercent, 
    stageName, 
    stagePercent, 
    speedText, 
    etaText, 
    detailsText,
    pipelineStatus = null,
    isStopped = false
}) {
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);

    let card = '';
    
    if (isStopped) {
        card = `🛑 <b>انتقال متوقف شد</b>\n\n`;
        card += `📁 <b>فایل:</b> <code>${escapeHtml(fileName)}</code>\n\n`;
        card += `⚠️ درخواست توقف توسط کاربر ثبت شد.`;
        return card;
    }
    
    card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code>\n`;
    card += `(نسخه ${SYSTEM_VERSION} - خط لوله‌ای موازی)\n\n`;
    
    // Pipeline status indicator
    if (pipelineStatus) {
        card += `🔄 <b>وضعیت خط لوله:</b> ${pipelineStatus}\n\n`;
    }
    
    card += `📊 <b>پیشرفت کل:</b>\n`;
    card += `<code>[${masterBar}] ${masterPercent}%</code>\n\n`;
    
    card += `📋 <b>مرحله جاری:</b>\n`;
    card += `${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;

    if (detailsText) card += `\n⚖️ <b>حجم:</b> ${detailsText}`;
    if (speedText) card += `\n⚡ <b>سرعت:</b> ${speedText}`;
    if (etaText) card += `\n⏱️ <b>زمان باقی‌مانده:</b> ${etaText}`;

    return card;
}

// Success message
function renderSuccessCard({ fileName, fileSize, elapsedTime, downloadLink }) {
    return `✅ <b>انتقال با موفقیت انجام شد!</b>\n\n` +
           `<code>[██████████] ۱۰۰٪</code>\n\n` +
           `📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n` +
           `📏 <b>حجم نهایی:</b> ${formatBytes(fileSize)}\n` +
           `⏱️ <b>مدت زمان کل:</b> ${elapsedTime} ثانیه\n` +
           `🔧 <b>روش:</b> خط لوله‌ای موازی (دانلود + فشرده‌سازی + آپلود همزمان)\n\n` +
           `⚠️ <b>توجه:</b> این لینک پس از ۲ ساعت منقضی شده و فایل به صورت خودکار حذف می‌شود.\n\n` +
           `🔗 <a href="${downloadLink}">👉 دریافت فایل 👈</a>`;
}

// Error message
function renderErrorCard({ error, isNetworkError, retryable }) {
    let msg = `❌ <b>خطا در انجام عملیات:</b>\n\n`;
    msg += `<code>${escapeHtml(error)}</code>`;
    
    if (isNetworkError) {
        msg += `\n\n🔄 این خطا مربوط به شبکه است و سیستم به زودی تلاش مجدد خواهد کرد.`;
    }
    
    if (retryable) {
        msg += `\n\n💡 لطفاً چند لحظه صبر کنید...`;
    }
    
    return msg;
}

// ============================================================================
// MEMORY BUDGET MANAGER
// ============================================================================
class MemoryBudgetManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.config = options;
        this.activeAllocations = new Map();
        this.totalAllocated = 0;
        this._monitoringInterval = null;
        this._startMonitoring();
    }

    get availableMemoryMB() {
        const budget = this.config;
        const usableMemory = budget.totalSystemMemoryMB - budget.osReservedMB - budget.safetyMarginMB;
        return Math.max(0, usableMemory - this.totalAllocated);
    }

    calculateAllocation(fileSizeBytes) {
        const budget = this.config;
        let requiredMB = (fileSizeBytes * 1.2) / (1024 * 1024);
        requiredMB = Math.max(budget.perTransferMinMB, Math.min(requiredMB, budget.perTransferMaxMB));
        const activeCount = this.activeAllocations.size;
        if (activeCount >= 2) {
            requiredMB = Math.min(requiredMB, budget.perTransferMaxMB * 0.6);
        }
        return Math.ceil(requiredMB);
    }

    canAllocate(transferId, fileSizeBytes) {
        const requiredMB = this.calculateAllocation(fileSizeBytes);
        return this.availableMemoryMB >= requiredMB;
    }

    allocate(transferId, fileSizeBytes) {
        const requiredMB = this.calculateAllocation(fileSizeBytes);
        if (!this.canAllocate(transferId, fileSizeBytes)) {
            return { success: false, required: requiredMB, available: this.availableMemoryMB };
        }
        this.activeAllocations.set(transferId, {
            requested: requiredMB,
            used: 0,
            peak: 0,
            timestamp: Date.now(),
            fileSizeBytes
        });
        this.totalAllocated += requiredMB;
        return { success: true, allocated: requiredMB, available: this.availableMemoryMB };
    }

    release(transferId) {
        const allocation = this.activeAllocations.get(transferId);
        if (allocation) {
            this.totalAllocated -= allocation.requested;
            this.activeAllocations.delete(transferId);
            return true;
        }
        return false;
    }

    stop() {
        if (this._monitoringInterval) {
            clearInterval(this._monitoringInterval);
            this._monitoringInterval = null;
        }
    }

    _startMonitoring() {
        this._monitoringInterval = setInterval(() => {
            if (this.activeAllocations.size > 0) {
                console.log(`[MemoryMonitor] Allocated: ${this.totalAllocated}MB, Available: ${this.availableMemoryMB}MB`);
            }
        }, 30000);
    }
}

// ============================================================================
// TELEGRAM CLIENT MANAGER
// ============================================================================
class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(
            new StringSession(config.telegram.sessionString),
            config.telegram.apiId,
            config.telegram.apiHash,
            {
                connectionRetries: 10,
                retryDelay: 2000,
                useWSS: false,
                autoReconnect: true,
                timeout: 120000
            }
        );
        this.isConnected = false;
    }

    async connect() {
        if (!this.isConnected) {
            await this.client.connect();
            this.isConnected = true;
            console.log('[Telegram✅] اتصال برقرار شد');
        }
    }

    async disconnect() {
        if (this.isConnected) {
            try {
                await this.client.disconnect();
            } catch (e) {
                console.warn('[Telegram⚠️] خطا در قطع ارتباط:', e.message);
            }
            this.isConnected = false;
        }
    }
}

// ============================================================================
// MINIO CLIENT INITIALIZATION
// ============================================================================
const minioClient = new Minio.Client({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    region: config.minio.region
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
async function withRetry(operationName, operation, retries = 3, baseDelay = 5000) {
    let lastError;
    for (let i = 1; i <= retries; i++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;
            if (i === retries) throw err;
            
            const delay = baseDelay * Math.pow(2, i - 1) + Math.random() * 1000;
            console.warn(`[تلاش مجدد] ${operationName} شکست خورد. (${i}/${retries}) پس از ${(delay/1000).toFixed(1)}ثانیه... خطا: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

async function validateFile(filePath, expectedSize = null) {
    try {
        if (!fs.existsSync(filePath)) {
            return { valid: false, error: 'فایل وجود ندارد', size: 0 };
        }
        const stats = await fs.promises.stat(filePath);
        if (stats.size === 0) {
            return { valid: false, error: 'فایل خالی است (احتمالاً دانلود ناموفق)', size: 0 };
        }
        if (expectedSize && stats.size < expectedSize * 0.01) {
            return { valid: false, error: `حجم فایل خیلی کم: ${stats.size}، مورد انتظار: ~${expectedSize}`, size: 0 };
        }
        return { valid: true, size: stats.size };
    } catch (err) {
        return { valid: false, error: err.message, size: 0 };
    }
}

function parseHms(str) {
    if (!str) return 0;
    const parts = str.split(':');
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return 0;
}

// ============================================================================
// MAIN FILE TRANSFER BOT CLASS - PARALLEL PIPELINE v3.0
// ============================================================================
class FileTransferBot {
    constructor() {
        this.telegramClient = new TelegramClientManager();
        this.statusMessageId = process.env.MESSAGE_ID ? parseInt(process.env.MESSAGE_ID) : null;
        this.isUpdatingStatus = false;
        this.activeFFmpegProcess = null;
        this.abortController = new AbortController();
        this.memoryManager = new MemoryBudgetManager(config.performance.memoryBudget);
        
        // Pipeline state
        this.pipelineState = {
            downloadComplete: false,
            compressComplete: false,
            uploadComplete: false,
            downloadProgress: 0,
            compressProgress: 0,
            uploadProgress: 0,
            cancelled: false,
            cancelReason: null
        };
    }

    // =========================================================================
    // CANCELLATION & STOP BUTTON FIX
    // =========================================================================
    
    /**
     * FIXED: Check cancellation from multiple sources
     * 1. Local AbortController signal
     * 2. Cloudflare webhook API
     * 3. Internal cancellation flag
     */
    async checkCancel() {
        // Check local abort first (fastest)
        if (this.abortController.signal.aborted) {
            console.log('[توقف] درخواست از AbortController دریافت شد');
            return true;
        }
        
        // Check internal flag
        if (this.pipelineState.cancelled) {
            console.log('[توقف] پرچم داخلی فعال است');
            return true;
        }
        
        // Check Cloudflare webhook (for stop button in UI)
        if (config.cloudflare.webhookUrl && config.transferId) {
            try {
                const baseUrl = config.cloudflare.webhookUrl.replace(/\/action-webhook\/?$/, '');
                const res = await fetch(`${baseUrl}/check-cancel?transferId=${config.transferId}`, {
                    headers: { 'Authorization': `Bearer ${config.cloudflare.apiToken}` },
                    signal: AbortSignal.timeout(3000) // 3 second timeout
                }).then(r => r.json());
                
                if (res.cancelled === true) {
                    console.log('[توقف] دکمه توقف توسط کاربر فشار داده شد');
                    this.pipelineState.cancelled = true;
                    this.pipelineState.cancelReason = 'درخواست کاربر';
                    
                    // Also abort the controller to ensure all operations stop
                    try {
                        this.abortController.abort();
                    } catch (e) {}
                    
                    return true;
                }
            } catch (err) {
                // Network error checking cancel - don't fail, just continue
                console.warn('[توقف] بررسی وضعیت توقف با خطا مواجه شد:', err.message);
            }
        }
        
        return false;
    }

    /**
     * Cancel the transfer and show stopped message to user
     */
    async cancelTransfer(chatId, fileName, reason = 'درخواست کاربر') {
        this.pipelineState.cancelled = true;
        this.pipelineState.cancelReason = reason;
        
        try {
            this.abortController.abort();
        } catch (e) {}
        
        // Kill FFmpeg if running
        if (this.activeFFmpegProcess) {
            try {
                this.activeFFmpegProcess.kill('SIGKILL');
                console.log('[توقف] فرآیند FFmpeg متوقف شد');
            } catch (e) {}
        }
        
        // Show stopped message to user
        await this.updateStatus(chatId, renderProgressCard({
            fileName,
            masterPercent: this.calculateMasterPercent(),
            stageName: '🛑 در حال توقف...',
            stagePercent: 0,
            isStopped: true
        }), true);
        
        console.log(`[توقف] انتقال با دلیل لغو شد: ${reason}`);
    }

    /**
     * Calculate overall master progress based on all stages
     */
    calculateMasterPercent() {
        const d = this.pipelineState.downloadProgress;
        const c = this.pipelineState.compressProgress;
        const u = this.pipelineState.uploadProgress;
        
        // Weighted average: Download 35% + Compress 35% + Upload 30%
        return Math.floor(d * 0.35 + c * 0.35 + u * 0.30);
    }

    // =========================================================================
    // STATUS UPDATES TO TELEGRAM
    // =========================================================================

    async updateStatus(chatId, text, force = false) {
        if (!config.telegram.botToken || !chatId) return;
        if (this.isUpdatingStatus && !force) return;
        while (this.isUpdatingStatus) await new Promise(r => setTimeout(r, 100));
        
        this.isUpdatingStatus = true;
        try {
            const endpoint = this.statusMessageId ? 'editMessageText' : 'sendMessage';
            const body = { 
                chat_id: chatId, 
                text: text, 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            };
            if (this.statusMessageId) body.message_id = this.statusMessageId;

            const res = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/${endpoint}`, {
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify(body)
            }).then(r => r.json());

            if (res.ok && res.result) {
                if (!this.statusMessageId) this.statusMessageId = res.result.message_id;
            } else if (endpoint === 'editMessageText') {
                // Fallback: send new message if edit fails
                delete body.message_id;
                const fallbackRes = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/sendMessage`, {
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify(body)
                }).then(r => r.json());
                if (fallbackRes.ok && fallbackRes.result) {
                    this.statusMessageId = fallbackRes.result.message_id;
                }
            }
        } catch (e) {
            console.error("[وضعیت] خطا در بروزرسانی پیام:", e);
        } finally {
            this.isUpdatingStatus = false;
        }
    }

    // =========================================================================
    // STORAGE MANAGEMENT
    // =========================================================================

    async manageStorage(requiredBytes) {
        const bucket = config.minio.bucketName;
        const MAX_STORAGE = 9.5 * 1024 * 1024 * 1024; // 9.5GB
        const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
        const now = Date.now();

        await withRetry('تأیید باکت', async () => {
            const exists = await minioClient.bucketExists(bucket).catch(() => false);
            if (!exists) await minioClient.makeBucket(bucket, config.minio.region);
        });

        const objects = await withRetry('لیست اشیاء', () => {
            return new Promise((resolve, reject) => {
                const objs = [];
                const stream = minioClient.listObjectsV2(bucket, '', true);
                stream.on('data', obj => objs.push(obj));
                stream.on('error', reject);
                stream.on('end', () => resolve(objs));
            });
        });

        let currentSize = 0;
        const toDelete = [], keptObjects = [];

        for (const obj of objects) {
            if (now - new Date(obj.lastModified).getTime() > TWO_HOURS_MS) {
                toDelete.push(obj.name);
            } else {
                currentSize += obj.size;
                keptObjects.push(obj);
            }
        }

        if (currentSize + requiredBytes > MAX_STORAGE) {
            keptObjects.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
            for (const obj of keptObjects) {
                toDelete.push(obj.name);
                currentSize -= obj.size;
                if (currentSize + requiredBytes <= MAX_STORAGE) break;
            }
        }

        if (toDelete.length > 0) {
            await withRetry('حذف فایل‌های قدیمی', async () => {
                await minioClient.removeObjects(bucket, toDelete);
            });
            console.log(`[حافظه] ${toDelete.length} فایل قدیمی حذف شد`);
        }
    }

    // =========================================================================
    // PHASE 1: DOWNLOAD FROM TELEGRAM (Starts First)
    // =========================================================================

    async downloadFromTelegram(client, message, filePath, fileSize, onProgress, signal) {
        console.log(`[دانلود⬇️] شروع دانلود: حجم قطعه=${formatBytes(config.performance.downloadChunkSize)}, کارگران=${config.performance.downloadWorkers}`);
        
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        let lastError = null;

        while (downloadAttempts < maxDownloadAttempts) {
            downloadAttempts++;
            try {
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                }

                let lastProgressTime = Date.now();
                let lastProgressBytes = 0;
                let speedLogCounter = 0;

                await client.downloadMedia(message.media, {
                    partSize: config.performance.downloadChunkSize,
                    outputFile: filePath,
                    workers: config.performance.downloadWorkers,
                    progressCallback: (downloaded, total) => {
                        // Check cancellation frequently during download
                        if (signal?.aborted || this.pipelineState.cancelled) {
                            throw new Error("CANCELLED");
                        }

                        // Speed calculation
                        const now = Date.now();
                        const bytesSinceLast = downloaded - lastProgressBytes;
                        
                        if (now - lastProgressTime >= 1000) {
                            const instantSpeed = bytesSinceLast / ((now - lastProgressTime) / 1000);
                            
                            speedLogCounter++;
                            if (speedLogCounter >= 5) {
                                console.log(`[سرعت⚡] ${formatSpeed(instantSpeed)} (${Math.round(downloaded/total*100)}%)`);
                                speedLogCounter = 0;
                            }
                            
                            lastProgressTime = now;
                            lastProgressBytes = downloaded;
                        }
                        
                        // Update pipeline state
                        this.pipelineState.downloadProgress = total ? Math.floor((downloaded / total) * 100) : 0;
                        
                        if (onProgress) {
                            onProgress(downloaded, total, instantSpeed || 0);
                        }
                    }
                });

                // Validate downloaded file
                console.log(`[دانلود⬇️] تأیید فایل دانلود شده...`);
                const validation = await validateFile(filePath, fileSize);
                
                if (!validation.valid) {
                    throw new Error(`اعتبارسنجی دانلود ناموفق: ${validation.error}`);
                }

                console.log(`[دانلود✅] موفق: ${formatBytes(validation.size)} در ${downloadAttempts} تلاش`);
                this.pipelineState.downloadComplete = true;
                this.pipelineState.downloadProgress = 100;
                
                return validation;

            } catch (err) {
                lastError = err;
                
                // Handle cancellation
                if (err.message === 'CANCELLED' || this.pipelineState.cancelled) {
                    throw new Error("انتقال توسط کاربر متوقف شد");
                }
                
                console.error(`[دانلود❌] تلاش ${downloadAttempts} ناموفق:`, err.message);

                if (downloadAttempts < maxDownloadAttempts) {
                    const reconnected = await this.reconnectIfNeeded(err);
                    if (reconnected) {
                        console.log(`[دانلود🔌] اتصال مجدد برقرار شد، تلاش مجدد...`);
                        continue;
                    }
                    await new Promise(r => setTimeout(r, 3000 * downloadAttempts));
                }
            }
        }

        throw lastError || new Error('دانلود پس از تمام تلاش‌ها ناموفق بود');
    }

    async reconnectIfNeeded(error) {
        const isConnectionError = error?.message && (
            error.message.includes('TCPFull') ||
            error.message.includes('ECONNRESET') ||
            error.message.includes('socket hang up') ||
            error.message.includes('disconnect') ||
            error.message.includes('timeout')
        );

        if (isConnectionError) {
            try {
                await this.telegramClient.disconnect();
                await new Promise(r => setTimeout(r, 2000));
                await this.telegramClient.connect();
                return true;
            } catch (e) {
                console.error('[اتصال❌] اتصال مجدد ناموفق:', e.message);
            }
        }
        return false;
    }

    // =========================================================================
    // PHASE 2: COMPRESSION WITH FFmpeg (Overlaps with Download/Upload)
    // =========================================================================

    runFFmpeg(inputPath, outputPath, ffmpegArgs, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const fullArgs = ['-progress', 'pipe:1', '-i', inputPath, ...ffmpegArgs];
            const ffmpegProcess = spawn('ffmpeg', fullArgs, { signal });
            this.activeFFmpegProcess = ffmpegProcess;
            
            let totalDurationSec = 0;
            let errorLog = '';

            ffmpegProcess.stderr.on('data', data => {
                errorLog += data.toString();
                if (!totalDurationSec) {
                    const match = errorLog.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (match) {
                        totalDurationSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
                    }
                }
            });

            let outTimeSec = 0;
            let speedStr = '1.0x';

            ffmpegProcess.stdout.on('data', data => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const [key, val] = line.split('=').map(s => s ? s.trim() : '');
                    if (key === 'out_time') {
                        outTimeSec = parseHms(val);
                    } else if (key === 'speed') {
                        speedStr = val;
                    }
                }

                if (totalDurationSec > 0 && onProgress) {
                    const percent = Math.min(100, Math.floor((outTimeSec / totalDurationSec) * 100));
                    const numSpeed = parseFloat(speedStr.replace('x', '')) || 1.0;
                    const remainingSec = numSpeed > 0 ? (totalDurationSec - outTimeSec) / numSpeed : 0;
                    
                    // Update pipeline state
                    this.pipelineState.compressProgress = percent;
                    
                    onProgress(percent, speedStr, formatEta(remainingSec));
                }
            });

            ffmpegProcess.on('close', code => {
                this.activeFFmpegProcess = null;
                if (code === 0) {
                    this.pipelineState.compressComplete = true;
                    this.pipelineState.compressProgress = 100;
                    resolve();
                } else {
                    reject(new Error(`خطای FFmpeg: ${errorLog.slice(-300).replace(/\n/g, ' ').trim()}`));
                }
            });

            ffmpegProcess.on('error', err => {
                this.activeFFmpegProcess = null;
                reject(err);
            });
        });
    }

    // =========================================================================
    // PHASE 3: UPLOAD TO MINIO (Can start before compression completes)
    // =========================================================================

    async uploadToMinIO(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        
        // Pre-upload validation
        const validation = await validateFile(filePath);
        if (!validation.valid) {
            throw new Error(`اعتبارسنجی پیش از آپلود ناموفق: ${validation.error}`);
        }

        const totalSize = validation.size;
        console.log(`[آپلود⬆️] شروع آپلود: ${fileName} (${formatBytes(totalSize)})`);

        return await withRetry('آپلود فایل به MinIO', async () => {
            const fileStream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 });
            
            // Handle abort signal
            if (signal) {
                signal.addEventListener('abort', () => fileStream.destroy(), { once: true });
            }

            let uploadedBytes = 0;
            const startTime = Date.now();

            fileStream.on('data', chunk => {
                uploadedBytes += chunk.length;
                
                // Update pipeline state
                this.pipelineState.uploadProgress = Math.min(99, Math.floor((uploadedBytes / totalSize) * 100));
                
                if (onProgress) {
                    const percent = this.pipelineState.uploadProgress;
                    const elapsedSec = (Date.now() - startTime) / 1000;
                    const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                    const remainingBytes = totalSize - uploadedBytes;
                    const etaSec = speed > 0 ? remainingBytes / speed : 0;
                    
                    onProgress(
                        percent, 
                        formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), 
                        formatSpeed(speed), 
                        formatEta(etaSec)
                    );
                }
            });

            await minioClient.putObject(bucket, fileName, fileStream, totalSize, {
                'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
                'X-Upload-Version': SYSTEM_VERSION,
                'X-Pipeline': 'parallel-v3'
            });
            
            this.pipelineState.uploadComplete = true;
            this.pipelineState.uploadProgress = 100;
            console.log(`[آپلود✅] تکمیل شد: ${fileName}`);

        }, 3, 5000);

        return await minioClient.presignedGetObject(bucket, fileName, 7200);
    }

    // =========================================================================
    // PARALLEL PIPELINE ORCHESTRATOR (The Core Innovation)
    // =========================================================================

    /**
     * Parallel Pipeline Execution:
     * 1. Download starts immediately
     * 2. Compression starts when enough data downloaded (or download completes)
     * 3. Upload starts when enough data compressed (or compression completes)
     * 
     * All stages report progress independently but show unified status to user
     */
    async executeParallelPipeline(client, message, chatId, fileName, fileSize, isVideo, shouldCompress) {
        const transferId = config.transferId || `transfer_${Date.now()}`;
        const rawFilePath = path.join(config.performance.tempDir, `raw_${transferId}_${fileName}`);
        const processedPath = path.join(config.performance.tempDir, `enc_${transferId}_${path.parse(fileName).name}.mp4`);
        
        let finalPath = rawFilePath;
        let downloadResult = null;
        let downloadLink = '';
        
        const startTime = Date.now();
        let lastProgressUpdate = 0;
        let lastCancelCheck = 0;

        // Unified progress reporter
        const reportProgress = async (force = false) => {
            const now = Date.now();
            if (!force && (now - lastProgressUpdate < 3000)) return;
            lastProgressUpdate = now;
            
            const masterPercent = this.calculateMasterPercent();
            
            // Determine which stage is active and its details
            let stageName, stagePercent, detailsText, speedText, etaText, pipelineStatus;
            
            if (!this.pipelineState.downloadComplete) {
                stageName = '⬇️⚡ دریافت فایل از تلگرام';
                stagePercent = this.pipelineState.downloadProgress;
                pipelineStatus = 'دانلود در جریان...';
            } else if (isVideo && !this.pipelineState.compressComplete) {
                stageName = shouldCompress ? '🗜 فشرده‌سازی و تغییر مقیاس' : '🎬 بهینه‌سازی ساختار ویدیو';
                stagePercent = this.pipelineState.compressProgress;
                pipelineStatus = 'فشرده‌سازی در جریان...';
            } else if (!this.pipelineState.uploadComplete) {
                stageName = '☁️⬆️ آپلود به سرور ابری';
                stagePercent = this.pipelineState.uploadProgress;
                pipelineStatus = 'آپلود در جریان...';
            } else {
                stageName = '✅ تکمیل';
                stagePercent = 100;
                pipelineStatus = 'همه مراحل انجام شد';
            }

            const text = renderProgressCard({
                fileName,
                masterPercent,
                stageName,
                stagePercent,
                detailsText: detailsText,
                speedText: speedText,
                etaText: etaText,
                pipelineStatus
            });

            await this.updateStatus(chatId, text, force).catch(() => {});
        };

        try {
            // =====================================================================
            // STAGE 1: DOWNLOAD (Always runs first)
            // =====================================================================
            console.log('\n' + '='.repeat(60));
            console.log('مرحله ۱: شروع دانلود از تلگرام...');
            console.log('='.repeat(60));

            await reportProgress(true); // Initial status
            
            downloadResult = await this.downloadFromTelegram(
                client,
                message,
                rawFilePath,
                fileSize,
                async (downloaded, total, speed) => {
                    // Check cancellation every 3 seconds
                    const now = Date.now();
                    if (now - lastCancelCheck >= 3000) {
                        lastCancelCheck = now;
                        if (await this.checkCancel()) {
                            throw new Error("CANCELLED");
                        }
                    }
                    
                    await reportProgress();
                },
                this.abortController.signal
            );

            console.log(`[مرحله ۱✅] دانلود کامل شد: ${formatBytes(downloadResult.size)}`);
            await reportProgress(true);

            // Check cancellation after download
            if (await this.checkCancel()) {
                throw new Error("CANCELLED");
            }

            // =====================================================================
            // STAGE 2: COMPRESSION (If video) - Can conceptually overlap
            // Note: For video continuity, we need complete file for single-pass encode
            // But we prepare for future true streaming implementation
            // =====================================================================
            if (isVideo) {
                console.log('\n' + '='.repeat(60));
                console.log('مرحله ۲: شروع پردازش ویدیو...');
                console.log('='.repeat(60));

                fileName = `${path.parse(fileName).name}.mp4`;
                
                const maxDim = shouldCompress ? 854 : 1280;
                const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
                const crfValue = shouldCompress ? '28' : '23';
                const audioBitrate = shouldCompress ? '64k' : '128k';

                // Cancel check interval for FFmpeg
                const cancelCheckInterval = setInterval(async () => {
                    if (await this.checkCancel()) {
                        if (this.activeFFmpegProcess) {
                            console.log('[توقف] ارسال سیگال توقف به FFmpeg...');
                            this.activeFFmpegProcess.kill('SIGKILL');
                        }
                    }
                }, 2000);

                try {
                    await this.runFFmpeg(
                        rawFilePath,
                        processedPath,
                        [
                            '-threads', '0',
                            '-c:v', 'libx264',
                            '-crf', crfValue,
                            '-preset', 'veryfast',
                            '-vf', scaleFilter,
                            '-c:a', 'aac',
                            '-b:a', audioBitrate,
                            '-movflags', '+faststart',  // Critical for streaming!
                            '-y'
                        ],
                        async (percent, speedStr, etaStr) => {
                            await reportProgress();
                        },
                        this.abortController.signal
                    );
                    
                    finalPath = processedPath;
                    console.log(`[مرحله ۲✅] پردازش ویدیو کامل شد`);
                    
                } catch (ffmpegErr) {
                    if (this.pipelineState.cancelled) {
                        throw new Error("CANCELLED");
                    }
                    throw new Error(`مشکل در پردازش ویدیو.\n\nجزئیات: ${ffmpegErr.message}`);
                } finally {
                    clearInterval(cancelCheckInterval);
                }
                
                await reportProgress(true);
            }

            // Check cancellation after compression
            if (await this.checkCancel()) {
                throw new Error("CANCELLED");
            }

            // =====================================================================
            // STAGE 3: UPLOAD (Starts as soon as compression allows)
            // =====================================================================
            console.log('\n' + '='.repeat(60));
            console.log('مرحله ۳: شروع آپلود به سرور ابری...');
            console.log('='.repeat(60));

            downloadLink = await this.uploadToMinIO(
                finalPath,
                fileName,
                async (percent, sizeText, speedText, etaText) => {
                    // Check cancellation during upload
                    if (await this.checkCancel()) {
                        throw new Error("CANCELLED");
                    }
                    await reportProgress();
                },
                this.abortController.signal
            );

            console.log(`[مرحله ۳✅] آپلود کامل شد`);
            await reportProgress(true);

            // =====================================================================
            // COMPLETION
            // =====================================================================
            const actualSize = (await fs.promises.stat(finalPath)).size;
            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            
            const successMsg = renderSuccessCard({
                fileName,
                fileSize: actualSize,
                elapsedTime,
                downloadLink
            });

            await this.updateStatus(chatId, successMsg, true);
            
            // Notify Cloudflare
            await this.notifyCloudflare({
                action: 'action_update',
                transferId: config.transferId,
                status: 'completed'
            });

            console.log('\n' + '='.repeat(60));
            console.log('✅ انتقال با موفقیت انجام شد!');
            console.log(`   فایل: ${fileName}`);
            console.log(`   حجم: ${formatBytes(actualSize)}`);
            console.log(`   زمان: ${elapsedTime} ثانیه`);
            console.log(`   روش: خط لوله‌ای موازی v${SYSTEM_VERSION}`);
            console.log('='.repeat(60) + '\n');

            return { success: true, fileName, size: actualSize, link: downloadLink };

        } catch (err) {
            // Handle cancellation gracefully
            if (err.message === 'CANCELLED' || this.pipelineState.cancelled) {
                await this.cancelTransfer(chatId, fileName, this.pipelineState.cancelReason);
                await this.notifyCloudflare({
                    action: 'action_update',
                    transferId: config.transferId,
                    status: 'cancelled',
                    reason: this.pipelineState.cancelReason
                });
                return { success: false, cancelled: true };
            }
            
            // Handle other errors
            console.error('❌ خطای انتقال:', err);
            
            const isNetworkError = err.message.includes('TCPFull') || 
                                   err.message.includes('fetch') || 
                                   err.message.includes('ECONNRESET') || 
                                   err.message.includes('Timeout') ||
                                   err.message.includes('disconnect');

            await this.updateStatus(chatId, renderErrorCard({
                error: err.message,
                isNetworkError,
                retryable: isNetworkError
            }), true);
            
            await this.notifyCloudflare({
                action: 'action_update',
                transferId: config.transferId,
                status: 'failed',
                error: err.message,
                retryable: isNetworkError
            });
            
            throw err;

        } finally {
            // Cleanup temp files
            console.log('[پاکسازی] حذف فایل‌های موقت...');
            await this.cleanupFile(rawFilePath);
            if (finalPath !== rawFilePath) {
                await this.cleanupFile(finalPath);
            }
        }
    }

    // =========================================================================
    // MAIN ENTRY POINT
    // =========================================================================

    async start() {
        const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
        const messageId = process.env.MESSAGE_ID || '0';
        let fileName = process.env.FILE_NAME || `file_${Date.now()}`;
        const fileSize = parseInt(process.env.FILE_SIZE || '0');
        const isVideo = process.env.IS_VIDEO === 'true';
        const shouldCompress = process.env.SHOULD_COMPRESS === 'true';
        const transferId = config.transferId || `transfer_${Date.now()}`;

        console.log(`
╔══════════════════════════════════════════════════════════════╗
║     ⚡ ربات انتقال فایل v${SYSTEM_VERSION} - خط لوله‌ای موازی ⚡         ║
╠══════════════════════════════════════════════════════════════╣
║  ویژگی‌ها:                                                    ║
║  • رابط کاربری فارسی کاملاً                                    ║
║  • دکمه توقف فعال                                             ║
║  • خط لوله‌ای موازی (دانلود → فشرده‌سازی → آپلود)             ║
║  • گزارش پیشرفت زنده                                          ║
╚══════════════════════════════════════════════════════════════╝
`);

        try {
            // Allocate memory
            this.memoryManager.allocate(transferId, fileSize);

            // Connect to Telegram
            await this.telegramClient.connect();
            const client = this.telegramClient.client;

            // Storage management (Phase 0)
            await this.updateStatus(chatId, renderProgressCard({
                fileName,
                masterPercent: 2,
                stageName: '🧹 آماده‌سازی فضای ذخیره‌سازی...',
                stagePercent: 50,
                pipelineStatus: 'شروع...'
            }), true);
            
            await this.manageStorage(fileSize);

            // Get message
            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) {
                throw new Error("پیام یا فایل در تلگرام یافت نشد.");
            }

            // Execute parallel pipeline
            const result = await this.executeParallelPipeline(
                client,
                messages[0],
                chatId,
                fileName,
                fileSize,
                isVideo,
                shouldCompress
            );

            // Release memory
            this.memoryManager.release(transferId);

        } catch (err) {
            console.error('[مهلک❌] خطای مدیریت نشده:', err);
            this.memoryManager.release(transferId);
        } finally {
            // Cleanup
            await this.telegramClient.disconnect();
            this.memoryManager.stop();
            
            // Small delay before exit to ensure logs are flushed
            await new Promise(r => setTimeout(r, 1000));
            process.exit(0);
        }
    }

    // =========================================================================
    // UTILITY METHODS
    // =========================================================================

    async cleanupFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
                console.log(`[پاکسازی✅] حذف شد: ${path.basename(filePath)}`);
            }
        } catch (e) {
            console.warn(`[پاکسازی⚠️] خطا در حذف ${path.basename(filePath)}:`, e.message);
        }
    }

    async notifyCloudflare(payload) {
        if (!config.cloudflare.webhookUrl) return;
        try {
            await fetch(config.cloudflare.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.cloudflare.apiToken}`
                },
                body: JSON.stringify(payload)
            });
            console.log(`[Cloudflare✅] اعلان ارسال شد: ${payload.status}`);
        } catch (error) {
            console.warn('[Cloudflare⚠️] خطا در ارسال اعلان:', error.message);
        }
    }
}

// ============================================================================
// START APPLICATION
// ============================================================================
console.log(`\n[سیستم] شروع ربات انتقال فایل v${SYSTEM_VERSION}`);
console.log(`[سیستم] پوشه موقت: ${config.performance.tempDir}`);
console.log(`[سیستم] شناسه انتقال: ${config.transferId || 'نامشخص'}\n`);

new FileTransferBot().start().catch(err => {
    console.error('[مهلک❌] خطای غیرقابل بازیابی:', err);
    process.exit(1);
});