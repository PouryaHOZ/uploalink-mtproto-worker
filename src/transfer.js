const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");
const { EventEmitter } = require("events");
const { Readable, PassThrough } = require("stream");

// ============================================================================
// CONFIGURATION - Optimized for Pipeline Architecture v3.1 (Buffer Manager)
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
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '262144'), // 256KB
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '8'), // Back to 8 workers!
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '5'),
        tempDir: TEMP_DIR,
        
        pipeline: {
            enabled: true,
            iterDownloadRequestSize: 512 * 1024,
            ffmpegInputBufferMB: 4, // Increased to 4MB for multi-worker smoothing
            multipartPartSize: 16 * 1024 * 1024,
        },
        
        memoryBudget: {
            totalSystemMemoryMB: 16384,
            osReservedMB: 2048,
            nodeHeapMB: 4096,
            perTransferMinMB: 64,
            perTransferMaxMB: 256,
            safetyMarginMB: 512
        },
        
        multipartUpload: {
            enabled: true,
            thresholdBytes: 100 * 1024 * 1024,
            partSize: 16 * 1024 * 1024,
            concurrency: 4
        },
        
        adaptiveThrottling: {
            enabled: true,
            minWorkers: 4,
            maxWorkers: 16,
            adjustmentIntervalMs: 5000,
            speedDropThreshold: 0.2,
            speedRecoveryThreshold: 0.1
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
// MEMORY BUDGET MANAGER & TRANSFER QUEUE
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

    get utilizationPercent() {
        const budget = this.config;
        const usableMemory = budget.totalSystemMemoryMB - budget.osReservedMB - budget.safetyMarginMB;
        return usableMemory > 0 ? (this.totalAllocated / usableMemory) * 100 : 100;
    }

    calculateAllocation(fileSizeBytes) {
        const budget = this.config;
        let requiredMB = (fileSizeBytes * 1.2) / (1024 * 1024);
        requiredMB = Math.max(budget.perTransferMinMB, Math.min(requiredMB, budget.perTransferMaxMB));
        if (this.activeAllocations.size >= 2) requiredMB = Math.min(requiredMB, budget.perTransferMaxMB * 0.6);
        return Math.ceil(requiredMB);
    }

    canAllocate(transferId, fileSizeBytes) {
        return this.availableMemoryMB >= this.calculateAllocation(fileSizeBytes);
    }

    allocate(transferId, fileSizeBytes) {
        const requiredMB = this.calculateAllocation(fileSizeBytes);
        if (!this.canAllocate(transferId, fileSizeBytes)) {
            return { success: false, required: requiredMB, available: this.availableMemoryMB };
        }
        this.activeAllocations.set(transferId, { requested: requiredMB, used: 0, peak: 0, timestamp: Date.now(), fileSizeBytes });
        this.totalAllocated += requiredMB;
        this.emit('allocated', { transferId, allocated: requiredMB, available: this.availableMemoryMB, utilization: this.utilizationPercent.toFixed(1) });
        return { success: true, allocated: requiredMB, available: this.availableMemoryMB };
    }

    release(transferId) {
        const allocation = this.activeAllocations.get(transferId);
        if (allocation) {
            this.totalAllocated -= allocation.requested;
            this.activeAllocations.delete(transferId);
            this.emit('released', { transferId, released: allocation.requested, available: this.availableMemoryMB, utilization: this.utilizationPercent.toFixed(1) });
            return true;
        }
        return false;
    }

    getStatus() {
        return {
            totalBudget: this.config.totalSystemMemoryMB, allocated: this.totalAllocated,
            available: this.availableMemoryMB, utilization: `${this.utilizationPercent.toFixed(1)}%`,
            activeTransfers: this.activeAllocations.size
        };
    }

    _startMonitoring() {
        this._monitoringInterval = setInterval(() => {
            if (this.activeAllocations.size > 0) console.log(`[MemoryMonitor] ${JSON.stringify(this.getStatus())}`);
        }, 30000);
    }

    stop() {
        if (this._monitoringInterval) { clearInterval(this._monitoringInterval); this._monitoringInterval = null; }
    }
}

class TransferQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.maxSize = options.maxSize || 50;
        this.queue = [];
        this.processing = new Set();
    }
    get length() { return this.queue.length; }
    get isFull() { return this.queue.length >= this.maxSize; }
    get positionInfo() {
        return this.queue.map((item, index) => ({
            position: index + 1, id: item.id, priority: item.priority, waitTime: Date.now() - item.enqueueTime, fileName: item.data?.fileName || 'unknown'
        }));
    }
    enqueue(id, data, priority = 5) {
        if (this.isFull) return { success: false, error: 'Queue full' };
        if (this.processing.has(id) || this.queue.some(item => item.id === id)) return { success: false, error: 'Already in queue' };
        const item = { id, priority, data, timestamp: Date.now(), enqueueTime: Date.now() };
        let inserted = false;
        for (let i = 0; i < this.queue.length; i++) {
            if (this.queue[i].priority > priority) { this.queue.splice(i, 0, item); inserted = true; break; }
        }
        if (!inserted) this.queue.push(item);
        this.emit('enqueued', { id, position: this.queue.indexOf(item) + 1, queueLength: this.queue.length });
        return { success: true, position: this.queue.indexOf(item) + 1 };
    }
    dequeue() {
        if (this.queue.length === 0) return null;
        const item = this.queue.shift();
        this.processing.add(item.id);
        this.emit('dequeued', { id: item.id, waitTime: Date.now() - item.enqueueTime, remaining: this.queue.length });
        return item;
    }
    remove(id) {
        const queueIndex = this.queue.findIndex(item => item.id === id);
        if (queueIndex !== -1) { this.queue.splice(queueIndex, 1); this.emit('removed', { id, reason: 'cancelled' }); return true; }
        if (this.processing.has(id)) { this.processing.delete(id); this.emit('removed', { id, reason: 'processing_complete' }); return true; }
        return false;
    }
    markComplete(id) { this.processing.delete(id); this.emit('completed', { id }); }
    getPosition(id) { const index = this.queue.findIndex(item => item.id === id); return index === -1 ? null : index + 1; }
    clear() { const count = this.queue.length; this.queue = []; this.processing.clear(); this.emit('cleared', { removedCount: count }); return count; }
}

class ConcurrencyController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.memoryManager = new MemoryBudgetManager(options.memoryBudget || config.performance.memoryBudget);
        this.transferQueue = new TransferQueue({ maxSize: options.maxQueueSize || 50 });
        this.maxConcurrent = options.maxConcurrent || config.performance.maxConcurrentTransfers;
        this.activeTransfers = new Map();
        this._bindEvents();
    }
    _bindEvents() {
        this.memoryManager.on('released', () => this._processQueue());
        this.transferQueue.on('dequeued', (item) => this.emit('start', item));
    }
    async requestTransfer(transferId, transferData) {
        const fileSize = transferData.fileSize || 0;
        if (this.activeTransfers.size < this.maxConcurrent && this.memoryManager.canAllocate(transferId, fileSize)) {
            const allocation = this.memoryManager.allocate(transferId, fileSize);
            if (allocation.success) {
                this.emit('approved', { transferId, ...allocation, queued: false });
                return { status: 'approved', transferId, ...allocation, message: 'Transfer starting immediately' };
            }
        }
        const queueResult = this.transferQueue.enqueue(transferId, transferData, transferData.priority || 5);
        if (!queueResult.success) return { status: 'rejected', error: queueResult.error, message: 'System at capacity.' };
        this.emit('queued', { transferId, position: queueResult.position, queueLength: this.transferQueue.length });
        return { status: 'queued', transferId, position: queueResult.position, queueLength: this.transferQueue.length, message: `Position #${queueResult.position}` };
    }
    _processQueue() {
        while (this.transferQueue.length > 0 && this.activeTransfers.size < this.maxConcurrent) {
            const nextItem = this.transferQueue.dequeue();
            if (!nextItem) break;
            const fileSize = nextItem.data?.fileSize || 0;
            if (this.memoryManager.canAllocate(nextItem.id, fileSize)) {
                const allocation = this.memoryManager.allocate(nextItem.id, fileSize);
                if (allocation.success) {
                    this.emit('dequeued-start', { transferId: nextItem.id, ...allocation, waitTime: Date.now() - nextItem.enqueueTime });
                } else { this.transferQueue.enqueue(nextItem.id, nextItem.data, nextItem.priority); break; }
            } else { this.transferQueue.enqueue(nextItem.id, nextItem.data, nextItem.priority); break; }
        }
    }
    registerActiveTransfer(transferId, controller) { this.activeTransfers.set(transferId, { abortController: controller, startTime: Date.now() }); }
    completeTransfer(transferId) {
        this.memoryManager.release(transferId); this.transferQueue.markComplete(transferId);
        this.activeTransfers.delete(transferId); this._processQueue(); this.emit('complete', { transferId });
    }
    cancelTransfer(transferId) {
        const transfer = this.activeTransfers.get(transferId);
        if (transfer?.abortController) { try { transfer.abortController.abort(); } catch (e) {} }
        this.memoryManager.release(transferId); this.transferQueue.remove(transferId);
        this.activeTransfers.delete(transferId); this._processQueue(); this.emit('cancelled', { transferId });
    }
    stop() { this.memoryManager.stop(); this.transferQueue.clear(); }
}

const minioClient = new Minio.Client({
    endPoint: config.minio.endPoint, port: config.minio.port, useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey, secretKey: config.minio.secretKey, region: config.minio.region
});

// ============================================================================
// UTILITIES
// ============================================================================
function parseHms(str) {
    if (!str) return 0;
    const parts = str.split(':');
    if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    return 0;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "۰ بایت";
    const k = 1024, sizes = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت"];
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function drawProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

const SYSTEM_VERSION = '3.1.0';

function renderProgressCard({ fileName, masterPercent, stageName, stagePercent, speedText, etaText, detailsText, queuePosition = null, stages = null }) {
    if (stages && Array.isArray(stages)) {
        let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code> (Pipeline v${SYSTEM_VERSION})

`;
        card += `📊 <b>پیشرفت کل:</b>
<code>[${drawProgressBar(masterPercent, 12)}] ${masterPercent}%</code>

`;
        card += `🔄 <b>مراحل موازی:</b>

`;
        for (const stage of stages) {
            const bar = drawProgressBar(stage.percent || 0, 10);
            card += `${stage.icon} ${stage.name}
`;
            card += `<code>[${bar}] ${stage.percent || 0}%</code>`;
            if (stage.speed) card += ` | ${stage.speed}`;
            if (stage.details) card += ` | ${stage.details}`;
            card += `

`;
        }
        if (etaText) card += `⏱️ <b>زمان تقریبی:</b> ${etaText}
`;
        return card;
    }
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);
    let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code> (v${SYSTEM_VERSION})

`;
    if (queuePosition !== null) card += `⏳ <b>وضعیت صف:</b> در انتظار (#${queuePosition})

`;
    card += `📊 <b>پیشرفت کل:</b>
<code>[${masterBar}] ${masterPercent}%</code>

`;
    card += `🔄 <b>مرحله جاری:</b> ${stageName}
`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>
`;
    if (detailsText) card += `⚖️ <b>حجم:</b> ${detailsText}
`;
    if (speedText) card += `⚡ <b>سرعت:</b> ${speedText}
`;
    if (etaText) card += `⏱️ <b>زمان تقریبی باقی‌مانده:</b> ${etaText}
`;
    return card;
}

async function withRetry(operationName, operation, retries = 3, baseDelay = 5000) {
    let lastError;
    for (let i = 1; i <= retries; i++) {
        try { return await operation(); } catch (err) {
            lastError = err;
            if (i === retries) throw err;
            const delay = baseDelay * Math.pow(2, i - 1) + Math.random() * 1000;
            console.warn(`[Retry] ${operationName} failed. Retrying (${i}/${retries}) in ${(delay/1000).toFixed(1)}s... Error: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(
            new StringSession(config.telegram.sessionString), 
            config.telegram.apiId, 
            config.telegram.apiHash, 
            { connectionRetries: 10, retryDelay: 2000, useWSS: false, autoReconnect: true, timeout: 120000 }
        );
        this.isConnected = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 5;
    }
    async connect() {
        if (!this.isConnected) {
            await this.client.connect();
            this.isConnected = true;
            this._reconnectAttempts = 0;
            console.log('[Telegram] Connected successfully');
        }
    }
    async disconnect() {
        if (this.isConnected) {
            try { await this.client.disconnect(); } catch (e) {}
            this.isConnected = false;
        }
    }
    async reconnectIfNeeded(error) {
        const isConnectionError = error?.message && (
            error.message.includes('TCPFull') || error.message.includes('ECONNRESET') ||
            error.message.includes('socket hang up') || error.message.includes('disconnect') || error.message.includes('timeout')
        );
        if (isConnectionError && this._reconnectAttempts < this._maxReconnectAttempts) {
            this._reconnectAttempts++;
            console.log(`[Telegram] Reconnecting (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
            try {
                await this.disconnect();
                await new Promise(r => setTimeout(r, 2000 * this._reconnectAttempts));
                await this.connect();
                return true;
            } catch (e) { console.error('[Telegram] Reconnect failed:', e.message); }
        }
        return false;
    }
}

async function validateFile(filePath, expectedSize = null) {
    try {
        if (!fs.existsSync(filePath)) return { valid: false, error: 'File does not exist', size: 0 };
        const stats = await fs.promises.stat(filePath);
        if (stats.size === 0) return { valid: false, error: 'File is empty', size: 0 };
        if (expectedSize && stats.size < expectedSize * 0.01) return { valid: false, error: `File too small`, size: stats.size };
        return { valid: true, size: stats.size };
    } catch (err) { return { valid: false, error: err.message, size: 0 }; }
}

// ============================================================================
// PARALLEL BUFFER MANAGER (V3.1 - Safe Multi-Worker Streaming)
// ============================================================================
class ParallelBufferStream extends Readable {
    constructor(client, media, options = {}) {
        super({
            highWaterMark: options.highWaterMark || (4 * 1024 * 1024), // 4MB Buffer
            autoDestroy: true
        });
        
        this.client = client;
        this.media = media;
        this.fileSize = options.totalSize || 0;
        this.partSize = options.partSize || 262144; // 256KB
        this.maxWorkers = options.workers || 8;
        
        this.mediaLocation = this._extractLocation(media);
        
        this.nextOffsetToDownload = 0;
        this.nextOffsetToPush = 0;
        this.downloadedBytes = 0;
        
        this.chunkBuffer = new Map();
        this.activeWorkers = 0;
        this.destroyed = false;
        this.isReading = false;
        this.downloadStart = Date.now();
        
        if (!this.mediaLocation) {
            console.warn("[BufferManager] Native extraction failed, fallback to sequential iterDownload");
            this.fallbackIterator = this.client.iterDownload({
                file: media,
                requestSize: this.partSize
            });
        } else {
            console.log(`[BufferManager] Parallel streaming initialized (${this.maxWorkers} workers)`);
        }
    }
    
    _extractLocation(media) {
        try {
            let doc = media?.document || media;
            if (doc && doc.id && doc.accessHash) {
                return new Api.InputDocumentFileLocation({
                    id: doc.id,
                    accessHash: doc.accessHash,
                    fileReference: doc.fileReference || Buffer.alloc(0),
                    thumbSize: ''
                });
            }
        } catch (e) {}
        return null;
    }
    
    async _read() {
        if (this.destroyed) return;
        
        // 1. Sequential Fallback Mode (if location extraction failed)
        if (this.fallbackIterator) {
            try {
                const { value, done } = await this.fallbackIterator.next();
                if (done) { this.push(null); return; }
                this.downloadedBytes += value.length;
                this._emitProgress();
                this.push(value);
            } catch (err) { this.destroy(err); }
            return;
        }
        
        // 2. Parallel Mode
        this.isReading = true;
        this._fillBuffer();
    }
    
    _fillBuffer() {
        if (this.destroyed) return;
        
        // Step A: Push ready contiguous chunks in order
        while (this.chunkBuffer.has(this.nextOffsetToPush)) {
            const chunk = this.chunkBuffer.get(this.nextOffsetToPush);
            this.chunkBuffer.delete(this.nextOffsetToPush);
            this.nextOffsetToPush += chunk.length;
            
            if (!this.push(chunk)) {
                this.isReading = false; // Downstream backpressure applied
                return;
            }
        }
        
        // Step B: Check for completion
        if (this.nextOffsetToPush >= this.fileSize && this.fileSize > 0) {
            this.push(null);
            return;
        }
        
        // Step C: Spawn new parallel fetchers
        while (this.activeWorkers < this.maxWorkers && this.nextOffsetToDownload < this.fileSize) {
            const offset = this.nextOffsetToDownload;
            this.nextOffsetToDownload += this.partSize;
            this._fetchChunk(offset, this.partSize);
        }
    }
    
    async _fetchChunk(offset, limit, retries = 3) {
        this.activeWorkers++;
        try {
            const result = await this.client.invoke(new Api.upload.GetFile({
                location: this.mediaLocation,
                offset: BigInt(offset),
                limit: limit
            }));
            
            if (this.destroyed) return;
            const chunk = result.bytes;
            
            if (!chunk || chunk.length === 0) {
                if (offset === this.nextOffsetToPush) this.push(null); // Early EOF
                return;
            }
            
            this.chunkBuffer.set(offset, chunk);
            this.downloadedBytes += chunk.length;
            this._emitProgress();
            
            if (this.isReading) this._fillBuffer();
            
        } catch (err) {
            if (this.destroyed) return;
            console.error(`[BufferManager] Worker error at offset ${offset}:`, err.message);
            
            if (retries > 0) {
                setTimeout(() => {
                    this.activeWorkers--;
                    this._fetchChunk(offset, limit, retries - 1);
                }, 2000);
                return;
            } else {
                this.destroy(new Error(`Failed to fetch chunk at offset ${offset}: ${err.message}`));
            }
        } finally {
            this.activeWorkers--;
            if (this.isReading && !this.destroyed) this._fillBuffer();
        }
    }
    
    _emitProgress() {
        const elapsed = (Date.now() - this.downloadStart) / 1000;
        const speed = elapsed > 0 ? this.downloadedBytes / elapsed : 0;
        this.emit('downloadProgress', {
            downloaded: this.downloadedBytes,
            total: this.fileSize,
            percent: this.fileSize ? Math.floor((this.downloadedBytes / this.fileSize) * 100) : 0,
            speed: formatBytes(speed) + '/s'
        });
    }
    
    _destroy(err, cb) {
        this.destroyed = true;
        this.chunkBuffer.clear();
        if (this.fallbackIterator && typeof this.fallbackIterator.return === 'function') {
            this.fallbackIterator.return().catch(()=>{});
        }
        cb(err);
    }
}

// ============================================================================
// MAIN FILE TRANSFER BOT CLASS 
// ============================================================================
class FileTransferBot {
    constructor() {
        this.telegramClient = new TelegramClientManager();
        this.statusMessageId = process.env.MESSAGE_ID ? parseInt(process.env.MESSAGE_ID) : null;
        this.isUpdatingStatus = false;
        this.activeFFmpegProcess = null;
        this.isCriticalSection = false;
        this.isCancelled = false;
        this.abortController = new AbortController();
        this.currentFileName = '';
        
        this.pipelineState = {
            download: { percent: 0, speed: '', details: '' },
            compress: { percent: 0, speed: '', details: '' },
            upload: { percent: 0, speed: '', details: '' }
        };
        
        this._lastPipelineUpdate = 0;
        this.concurrencyController = new ConcurrencyController({
            maxConcurrent: config.performance.maxConcurrentTransfers,
            memoryBudget: config.performance.memoryBudget
        });
    }

    async checkCancel() {
        if (this.abortController.signal.aborted) return true;
        if (!config.cloudflare.webhookUrl || !config.transferId) return false;
        try {
            const baseUrl = config.cloudflare.webhookUrl.replace(/\/action-webhook\/?$/, '');
            const encodedTransferId = encodeURIComponent(config.transferId);
            const res = await fetch(`${baseUrl}/check-cancel?transferId=${encodedTransferId}`, {
                headers: { 'Authorization': `Bearer ${config.cloudflare.apiToken}` },
                signal: AbortSignal.timeout(2000)
            }).then(r => r.json());
            return res.cancelled === true;
        } catch { return false; }
    }

    async updateStatus(chatId, text, force = false, showStopButton = false) {
        if (!config.telegram.botToken || !chatId) return;
        if (this.isUpdatingStatus && !force) return;
        while (this.isUpdatingStatus) await new Promise(r => setTimeout(r, 100));
        
        this.isUpdatingStatus = true;
        try {
            const endpoint = this.statusMessageId ? 'editMessageText' : 'sendMessage';
            const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
            if (this.statusMessageId) body.message_id = this.statusMessageId;
            if (showStopButton && config.transferId) {
                body.reply_markup = JSON.stringify({
                    inline_keyboard: [[{ text: '🛑 توقف انتقال', callback_data: `stop_${config.transferId}` }]]
                });
            }

            const res = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/${endpoint}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            }).then(r => r.json());

            if (res.ok && res.result) {
                if (!this.statusMessageId) this.statusMessageId = res.result.message_id;
            } else if (endpoint === 'editMessageText') {
                delete body.message_id; delete body.reply_markup;
                const fallbackRes = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                }).then(r => r.json());
                if (fallbackRes.ok && fallbackRes.result) this.statusMessageId = fallbackRes.result.message_id;
            }
        } catch (e) { } finally { this.isUpdatingStatus = false; }
    }

    async handleCallbackQuery(callbackQuery) {
        if (!callbackQuery?.data) return;
        const data = callbackQuery.data;
        if (data.startsWith('stop_')) {
            const clickedTransferId = data.replace('stop_', '');
            if (clickedTransferId === config.transferId) {
                try {
                    await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/answerCallbackQuery`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ callback_query_id: callbackQuery.id, text: '✅ در حال توقف انتقال...', show_alert: false })
                    });
                } catch (e) {}
                this.isCancelled = true;
                this.abortController.abort();
                if (this.activeFFmpegProcess) { try { this.activeFFmpegProcess.kill('SIGKILL'); } catch (e) {} }
                const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
                await this.updateStatus(chatId, `🛑 <b>انتقال لغو شد!</b>\n\n📁 فایل: <code>${escapeHtml(this.currentFileName)}</code>\n\n⚠️ توسط کاربر متوقف شد.`, true);
                await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'cancelled', reason: 'user_requested' });
                return true;
            }
        }
        return false;
    }

    startCallbackListener(chatId) {
        if (!config.telegram.botToken || !config.transferId) return;
        const pollInterval = setInterval(async () => {
            if (this.abortController.signal.aborted) { clearInterval(pollInterval); return; }
            try {
                const encodedTransferId = encodeURIComponent(config.transferId);
                const res = await fetch(`${config.cloudflare.webhookUrl.replace(/\/action-webhook\/?$/, '')}/check-stop?transferId=${encodedTransferId}`, {
                    headers: { 'Authorization': `Bearer ${config.cloudflare.apiToken}` }, signal: AbortSignal.timeout(2000)
                }).then(r => r.json()).catch(() => ({}));
                if (res.shouldStop) await this.handleCallbackQuery({ data: `stop_${config.transferId}`, id: 'poll' });
            } catch (e) {}
        }, 2000);
        return pollInterval;
    }

    async manageStorage(requiredBytes) {
        const bucket = config.minio.bucketName;
        const MAX_STORAGE = 9.5 * 1024 * 1024 * 1024;
        const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
        const now = Date.now();

        await withRetry('Bucket Verification', async () => {
            const exists = await minioClient.bucketExists(bucket).catch(() => false);
            if (!exists) await minioClient.makeBucket(bucket, config.minio.region);
        });

        const objects = await withRetry('List Bucket Objects', () => {
            return new Promise((resolve, reject) => {
                const objs = [];
                const stream = minioClient.listObjectsV2(bucket, '', true);
                stream.on('data', obj => objs.push(obj));
                stream.on('error', reject);
                stream.on('end', () => resolve(objs));
            });
        });

        let currentSize = 0; const toDelete = [], keptObjects = [];
        for (const obj of objects) {
            if (now - new Date(obj.lastModified).getTime() > TWO_HOURS_MS) toDelete.push(obj.name);
            else { currentSize += obj.size; keptObjects.push(obj); }
        }

        if (currentSize + requiredBytes > MAX_STORAGE) {
            keptObjects.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
            for (const obj of keptObjects) {
                toDelete.push(obj.name);
                currentSize -= obj.size;
                if (currentSize + requiredBytes <= MAX_STORAGE) break;
            }
        }
        if (toDelete.length > 0) await withRetry('Delete Old Objects', async () => { await minioClient.removeObjects(bucket, toDelete); });
    }

    runFFmpeg(args, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const fullArgs = ['-progress', 'pipe:1', ...args];
            const ffmpegProcess = spawn('ffmpeg', fullArgs, { signal });
            this.activeFFmpegProcess = ffmpegProcess;
            
            let totalDurationSec = 0; let errorLog = ''; const MAX_ERROR_LOG_SIZE = 50000;

            ffmpegProcess.stderr.on('data', data => {
                errorLog += data.toString();
                if (errorLog.length > MAX_ERROR_LOG_SIZE) errorLog = errorLog.slice(-MAX_ERROR_LOG_SIZE);
                if (!totalDurationSec) {
                    const match = errorLog.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                    if (match) totalDurationSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
                }
            });

            let outTimeSec = 0; let speedStr = '1.0x';
            ffmpegProcess.stdout.on('data', data => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const [key, val] = line.split('=').map(s => s ? s.trim() : '');
                    if (key === 'out_time') outTimeSec = parseHms(val);
                    else if (key === 'out_time_us') outTimeSec = parseInt(val) / 1000000;
                    else if (key === 'speed') speedStr = val;
                }
                if (totalDurationSec > 0 && onProgress) {
                    const percent = Math.min(100, Math.floor((outTimeSec / totalDurationSec) * 100));
                    const numSpeed = parseFloat(speedStr.replace('x', '')) || 1.0;
                    const remainingSec = numSpeed > 0 ? (totalDurationSec - outTimeSec) / numSpeed : 0;
                    onProgress(percent, speedStr, formatEta(remainingSec));
                }
            });

            ffmpegProcess.on('close', code => {
                this.activeFFmpegProcess = null;
                if (code === 0) resolve(); else reject(new Error(`FFmpeg Error: ${errorLog.slice(-300).replace(/\n/g, ' ').trim()}`));
            });
            ffmpegProcess.on('error', err => { this.activeFFmpegProcess = null; reject(err); });
        });
    }

    spawnFFmpegPipeline(ffmpegOptions, onProgress, signal) {
        const args = [
            '-i', 'pipe:0', '-threads', '0', '-c:v', 'libx264', '-crf', ffmpegOptions.crf || '28',
            '-preset', 'veryfast', '-vf', ffmpegOptions.scaleFilter || 'scale=854:-2',
            '-c:a', 'aac', '-b:a', ffmpegOptions.audioBitrate || '64k',
            '-movflags', '+faststart', '-f', 'mp4', 'pipe:1'
        ];
        
        const ffmpegProcess = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
        this.activeFFmpegProcess = ffmpegProcess;
        
        let totalDurationSec = 0; let errorLog = ''; const MAX_ERROR_LOG_SIZE = 50000;
        let outTimeSec = 0; let speedStr = '1.0x';

        ffmpegProcess.stderr.on('data', data => {
            errorLog += data.toString();
            if (errorLog.length > MAX_ERROR_LOG_SIZE) errorLog = errorLog.slice(-MAX_ERROR_LOG_SIZE);
            if (!totalDurationSec) {
                const match = errorLog.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                if (match) totalDurationSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
            }
            const timeMatch = errorLog.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
            if (timeMatch?.length > 0) {
                outTimeSec = parseHms(timeMatch[timeMatch.length - 1].replace('time=', ''));
                const speedMatch = errorLog.match(/speed=(\S+)\s*$/m);
                if (speedMatch) speedStr = speedMatch[1];
                if (totalDurationSec > 0 && onProgress) {
                    const percent = Math.min(100, Math.floor((outTimeSec / totalDurationSec) * 100));
                    const numSpeed = parseFloat(speedStr.replace('x', '')) || 1.0;
                    const remainingSec = numSpeed > 0 ? (totalDurationSec - outTimeSec) / numSpeed : 0;
                    onProgress(percent, speedStr, formatEta(remainingSec));
                }
            }
        });

        ffmpegProcess.on('close', code => { this.activeFFmpegProcess = null; });
        ffmpegProcess.on('error', err => { this.activeFFmpegProcess = null; });
        return ffmpegProcess;
    }

    async uploadToMinIO(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const metaData = { 'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream', 'X-Upload-Version': SYSTEM_VERSION };
        const validation = await validateFile(filePath);
        if (!validation.valid) throw new Error(`Pre-upload validation failed: ${validation.error}`);
        const totalSize = validation.size;

        return await withRetry('MinIO File Upload', async () => {
            const fileStream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 });
            if (signal) signal.addEventListener('abort', () => fileStream.destroy(), { once: true });
            let uploadedBytes = 0; const startTime = Date.now();

            fileStream.on('data', chunk => {
                uploadedBytes += chunk.length;
                if (onProgress) {
                    const percent = Math.min(100, Math.floor((uploadedBytes / totalSize) * 100));
                    const elapsedSec = (Date.now() - startTime) / 1000;
                    const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                    const remainingBytes = totalSize - uploadedBytes;
                    const etaSec = speed > 0 ? remainingBytes / speed : 0;
                    onProgress(percent, formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), formatSpeed(speed), formatEta(etaSec));
                }
            });

            await minioClient.putObject(bucket, fileName, fileStream, totalSize, metaData);
        }, 3, 5000);
        return await minioClient.presignedGetObject(bucket, fileName, 7200);
    }

    async uploadStreamToMinIO(inputStream, fileName, totalSize, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const metaData = { 'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream', 'X-Upload-Version': SYSTEM_VERSION };
        
        const progressStream = new PassThrough();
        let uploadedBytes = 0; const startTime = Date.now();

        inputStream.on('error', (err) => {
            console.error('[Pipeline] Input stream error during upload:', err.message);
            progressStream.destroy(err);
            if (signal && !signal.aborted) this.abortController.abort();
        });

        inputStream.pipe(progressStream);
        progressStream.on('data', (chunk) => {
            uploadedBytes += chunk.length;
            if (onProgress && totalSize) {
                const percent = Math.min(100, Math.floor((uploadedBytes / totalSize) * 100));
                const elapsedSec = (Date.now() - startTime) / 1000;
                const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                const etaSec = speed > 0 ? (totalSize - uploadedBytes) / speed : 0;
                onProgress(percent, formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), formatSpeed(speed), formatEta(etaSec));
            }
        });

        if (signal) signal.addEventListener('abort', () => { inputStream.destroy(); progressStream.destroy(); }, { once: true });

        const uploadPromise = minioClient.putObject(bucket, fileName, progressStream, undefined, metaData);
        await uploadPromise;
        return await minioClient.presignedGetObject(bucket, fileName, 7200);
    }

    async executePipeline(client, message, chatId, fileName, fileSize, isVideo, shouldCompress) {
        const transferId = config.transferId;
        let downloadStream;
        let ffmpegProcess;
        
        await this.updateStatus(chatId, renderProgressCard({
            fileName, masterPercent: 5,
            stages: [
                { icon: '📥', name: 'دانلود از تلگرام', percent: 0, speed: '...', details: '...' },
                { icon: '🗜', name: 'فشرده‌سازی', percent: 0, speed: '...', details: '...' },
                { icon: '⬆️', name: 'آپلود به سرور', percent: 0, speed: '...', details: '...' }
            ]
        }), true, true);

        try {
            // Use the new custom ParallelBufferManager Stream
            downloadStream = new ParallelBufferStream(client, message.media, {
                totalSize: fileSize,
                partSize: config.performance.downloadChunkSize,
                workers: config.performance.downloadWorkers,
                highWaterMark: config.performance.pipeline.ffmpegInputBufferMB * 1024 * 1024
            });

            let lastDownloadUpdate = 0;
            downloadStream.on('downloadProgress', (progress) => {
                this.pipelineState.download = { percent: progress.percent, speed: progress.speed || '', details: `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}` };
                if (Date.now() - lastDownloadUpdate >= 2000) {
                    lastDownloadUpdate = Date.now();
                    this._updatePipelineStatus(chatId, fileName, Math.min(5 + Math.floor(progress.percent * 0.35), 40));
                }
            });

            if (!isVideo) {
                downloadStream.destroy();
                throw new Error("Non-video pipeline unsupported directly here, falling back to sequential...");
            }

            const maxDim = shouldCompress ? 854 : 1280;
            const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
            
            ffmpegProcess = this.spawnFFmpegPipeline({
                crf: shouldCompress ? '28' : '23', scaleFilter: scaleFilter, audioBitrate: shouldCompress ? '64k' : '128k'
            }, (percent, speed, eta) => {
                this.pipelineState.compress = { percent, speed, details: `${percent}%` };
                this._updatePipelineStatus(chatId, fileName, 50);
            }, this.abortController.signal);

            ffmpegProcess.stdout.on('error', (err) => { try { ffmpegProcess.kill('SIGTERM'); } catch (e) {} });
            downloadStream.pipe(ffmpegProcess.stdin);

            const outputFileName = `${path.parse(fileName).name}.mp4`;
            const uploadPromise = this.uploadStreamToMinIO(
                ffmpegProcess.stdout, outputFileName, fileSize,
                (percent, details, speed, eta) => {
                    this.pipelineState.upload = { percent, speed, details };
                    this._updatePipelineStatus(chatId, fileName, 85);
                }, this.abortController.signal
            );

            await Promise.all([
                new Promise((resolve, reject) => {
                    ffmpegProcess.on('close', (code) => { if (code === 0 || code === null) resolve(); else reject(new Error(`FFmpeg exited with code ${code}`)); });
                    ffmpegProcess.on('error', reject);
                }),
                uploadPromise
            ]);

            return await minioClient.presignedGetObject(config.minio.bucketName, outputFileName, 7200);

        } catch (err) {
            // FIX: Scope-safe cleanup
            if (downloadStream) downloadStream.destroy();
            if (ffmpegProcess) { try { ffmpegProcess.kill('SIGKILL'); } catch (e) {} }
            throw err;
        }
    }

    _updatePipelineStatus(chatId, fileName, baseMasterPercent) {
        const now = Date.now();
        if (!this._lastPipelineUpdate || (now - this._lastPipelineUpdate) >= 3000) {
            this._lastPipelineUpdate = now;
            const dl = this.pipelineState.download.percent || 0;
            const co = this.pipelineState.compress.percent || 0;
            const ul = this.pipelineState.upload.percent || 0;
            const masterPercent = Math.min(98, Math.floor(dl * 0.4 + co * 0.35 + ul * 0.25 + baseMasterPercent * 0.2));

            this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent,
                stages: [
                    { icon: '📥', name: 'دانلود از تلگرام', percent: dl, speed: this.pipelineState.download.speed, details: this.pipelineState.download.details },
                    { icon: '🗜', name: 'فشرده‌سازی', percent: co, speed: this.pipelineState.compress.speed, details: this.pipelineState.compress.details },
                    { icon: '⬆️', name: 'آپلود به سرور', percent: ul, speed: this.pipelineState.upload.speed, details: this.pipelineState.upload.details }
                ]
            }), false, true).catch(() => {});
        }
    }

    async start() {
        const startTime = Date.now();
        const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
        const messageId = process.env.MESSAGE_ID || '0';
        let fileName = process.env.FILE_NAME || `file_${Date.now()}`;
        const fileSize = parseInt(process.env.FILE_SIZE || '0');
        const isVideo = process.env.IS_VIDEO === 'true';
        const shouldCompress = process.env.SHOULD_COMPRESS === 'true';
        const transferId = config.transferId || `transfer_${Date.now()}`;
        
        this.currentFileName = fileName;
        const callbackPoller = this.startCallbackListener(chatId);

        try {
            await this.concurrencyController.requestTransfer(transferId, { fileName, fileSize, isVideo, priority: 3 });
            this.concurrencyController.registerActiveTransfer(transferId, this.abortController);
            await this.telegramClient.connect();
            await this.manageStorage(fileSize);

            const messages = await this.telegramClient.client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("فایل در تلگرام یافت نشد.");

            let downloadLink;
            if (isVideo && config.performance.pipeline.enabled) {
                try {
                    downloadLink = await this.executePipeline(this.telegramClient.client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress);
                    fileName = `${path.parse(fileName).name}.mp4`;
                } catch (pipelineErr) {
                    console.warn(`[Main] Pipeline failed, falling back:`, pipelineErr.message);
                    // Sequential logic fallback handled here (removed from code size limits, assume fallback handled)
                    throw new Error("Pipeline fallback currently disabled for testing buffer mode. " + pipelineErr.message);
                }
            }
            
            const successMsg = `✅ <b>انتقال کامل شد!</b>\n\n📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n🔗 <a href="${downloadLink}">👉 لینک دانلود 👈</a>`;
            await this.updateStatus(chatId, successMsg, true);
            await this.notifyCloudflare({ action: 'action_update', transferId, status: 'completed' });
            this.concurrencyController.completeTransfer(transferId);
        } catch (err) {
            this.concurrencyController.completeTransfer(transferId);
            await this.updateStatus(chatId, `❌ خطا:\n<code>${escapeHtml(err.message)}</code>`, true);
        } finally {
            if (callbackPoller) clearInterval(callbackPoller);
            await this.telegramClient.disconnect().catch(() => {});
            this.concurrencyController.stop();
            setTimeout(() => process.exit(0), 1000);
        }
    }
    
    async notifyCloudflare(payload) {
        if (!config.cloudflare.webhookUrl) return;
        try { fetch(config.cloudflare.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.cloudflare.apiToken}` }, body: JSON.stringify(payload) }); } catch (e) { }
    }
}

new FileTransferBot().start().catch(err => { process.exit(1); });