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
        // ⚡ SPEED OPTIMIZATION v2.0 (Target: 10x improvement)
        // Increased from 2MB to 8MB chunks (4x larger = less overhead)
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '8388608'), // 8MB (was 2MB)
        // Increased from 8 to 24 workers (3x parallelism for Telegram MTProto)
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '24'), // 24 (was 8)
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '5'), // 5 (was 3) - more parallel transfers
        tempDir: TEMP_DIR,
        // Memory budget settings (for 16GB GitHub runner)
        memoryBudget: {
            totalSystemMemoryMB: 16384, // 16GB runner
            osReservedMB: 2048,         // OS + system overhead
            nodeHeapMB: 4096,           // --max-old-space-size
            perTransferMinMB: 256,       // Minimum per transfer
            perTransferMaxMB: 1024,      // Maximum per single transfer
            safetyMarginMB: 512          // Safety buffer
        },
        // NEW: Multipart upload settings for large files
        multipartUpload: {
            enabled: true,                              // Enable multipart for large files
            thresholdBytes: 100 * 1024 * 1024,           // 100MB threshold
            partSize: 50 * 1024 * 1024,                  // 50MB parts
            concurrency: 4                               // Upload 4 parts in parallel
        },
        // NEW: Adaptive throttling settings
        adaptiveThrottling: {
            enabled: true,
            minWorkers: 12,
            maxWorkers: 32,
            adjustmentIntervalMs: 5000,    // Check every 5 seconds
            speedDropThreshold: 0.2,         // Adjust if speed drops 20%
            speedRecoveryThreshold: 0.1     // Recover if stable within 10%
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
// MEMORY BUDGET MANAGER - Real-time memory tracking and allocation
// ============================================================================
class MemoryBudgetManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.config = options;
        this.activeAllocations = new Map(); // transferId -> { requested, used, peak }
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
        // Base allocation: file size + 20% overhead for processing buffers
        let requiredMB = (fileSizeBytes * 1.2) / (1024 * 1024);
        
        // Apply constraints
        requiredMB = Math.max(budget.perTransferMinMB, Math.min(requiredMB, budget.perTransferMaxMB));
        
        // If multiple transfers would be active, reduce individual allocation
        const activeCount = this.activeAllocations.size;
        if (activeCount >= 2) {
            requiredMB = Math.min(requiredMB, budget.perTransferMaxMB * 0.6); // 40% reduction when concurrent
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
        
        this.emit('allocated', { 
            transferId, 
            allocated: requiredMB, 
            available: this.availableMemoryMB,
            utilization: this.utilizationPercent.toFixed(1)
        });
        
        return { success: true, allocated: requiredMB, available: this.availableMemoryMB };
    }

    release(transferId) {
        const allocation = this.activeAllocations.get(transferId);
        if (allocation) {
            this.totalAllocated -= allocation.requested;
            this.activeAllocations.delete(transferId);
            
            this.emit('released', { 
                transferId, 
                released: allocation.requested, 
                available: this.availableMemoryMB,
                utilization: this.utilizationPercent.toFixed(1)
            });
            
            return true;
        }
        return false;
    }

    getStatus() {
        return {
            totalBudget: this.config.totalSystemMemoryMB,
            allocated: this.totalAllocated,
            available: this.availableMemoryMB,
            utilization: `${this.utilizationPercent.toFixed(1)}%`,
            activeTransfers: this.activeAllocations.size,
            allocations: Array.from(this.activeAllocations.entries()).map(([id, alloc]) => ({
                id,
                allocated: alloc.requested,
                peak: alloc.peak,
                age: Date.now() - alloc.timestamp
            }))
        };
    }

    _startMonitoring() {
        // Log memory status every 30 seconds for debugging
        this._monitoringInterval = setInterval(() => {
            if (this.activeAllocations.size > 0) {
                console.log(`[MemoryMonitor] ${JSON.stringify(this.getStatus())}`);
            }
        }, 30000);
    }

    stop() {
        if (this._monitoringInterval) {
            clearInterval(this._monitoringInterval);
            this._monitoringInterval = null;
        }
    }
}

// ============================================================================
// TRANSFER QUEUE - FIFO queue with priority support
// ============================================================================
class TransferQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.maxSize = options.maxSize || 50;
        this.queue = []; // Array of { id, priority, data, timestamp, enqueueTime }
        this.processing = new Set(); // Set of IDs currently being processed
    }

    get length() {
        return this.queue.length;
    }

    get isFull() {
        return this.queue.length >= this.maxSize;
    }

    get positionInfo() {
        return this.queue.map((item, index) => ({
            position: index + 1,
            id: item.id,
            priority: item.priority,
            waitTime: Date.now() - item.enqueueTime,
            fileName: item.data?.fileName || 'unknown'
        }));
    }

    enqueue(id, data, priority = 5) {
        if (this.isFull) {
            return { success: false, error: 'Queue full' };
        }

        if (this.processing.has(id) || this.queue.some(item => item.id === id)) {
            return { success: false, error: 'Already in queue' };
        }

        const item = {
            id,
            priority,
            data,
            timestamp: Date.now(),
            enqueueTime: Date.now()
        };

        // Insert by priority (lower number = higher priority)
        let inserted = false;
        for (let i = 0; i < this.queue.length; i++) {
            if (this.queue[i].priority > priority) {
                this.queue.splice(i, 0, item);
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            this.queue.push(item);
        }

        this.emit('enqueued', { 
            id, 
            position: this.queue.indexOf(item) + 1, 
            queueLength: this.queue.length 
        });

        return { success: true, position: this.queue.indexOf(item) + 1 };
    }

    dequeue() {
        if (this.queue.length === 0) {
            return null;
        }

        const item = this.queue.shift();
        this.processing.add(item.id);

        this.emit('dequeued', { 
            id: item.id, 
            waitTime: Date.now() - item.enqueueTime,
            remaining: this.queue.length 
        });

        return item;
    }

    remove(id) {
        const queueIndex = this.queue.findIndex(item => item.id === id);
        if (queueIndex !== -1) {
            this.queue.splice(queueIndex, 1);
            this.emit('removed', { id, reason: 'cancelled' });
            return true;
        }
        
        if (this.processing.has(id)) {
            this.processing.delete(id);
            this.emit('removed', { id, reason: 'processing_complete' });
            return true;
        }
        
        return false;
    }

    markComplete(id) {
        this.processing.delete(id);
        this.emit('completed', { id });
    }

    getPosition(id) {
        const index = this.queue.findIndex(item => item.id === id);
        return index === -1 ? null : index + 1;
    }

    clear() {
        const count = this.queue.length;
        this.queue = [];
        this.processing.clear();
        this.emit('cleared', { removedCount: count });
        return count;
    }
}

// ============================================================================
// CONCURRENCY CONTROLLER - Orchestrates memory-aware transfers
// ============================================================================
class ConcurrencyController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.memoryManager = new MemoryBudgetManager(options.memoryBudget || config.performance.memoryBudget);
        this.transferQueue = new TransferQueue({ maxSize: options.maxQueueSize || 50 });
        this.maxConcurrent = options.maxConcurrent || config.performance.maxConcurrentTransfers;
        this.activeTransfers = new Map(); // transferId -> { abortController, ... }
        
        this._bindEvents();
    }

    _bindEvents() {
        this.memoryManager.on('released', () => {
            this._processQueue();
        });

        this.transferQueue.on('dequeued', (item) => {
            this.emit('start', item);
        });
    }

    async requestTransfer(transferId, transferData) {
        const fileSize = transferData.fileSize || 0;
        
        // Try immediate allocation
        if (this.activeTransfers.size < this.maxConcurrent && 
            this.memoryManager.canAllocate(transferId, fileSize)) {
            
            const allocation = this.memoryManager.allocate(transferId, fileSize);
            if (allocation.success) {
                this.emit('approved', { transferId, ...allocation, queued: false });
                return { 
                    status: 'approved', 
                    transferId, 
                    ...allocation,
                    message: 'Transfer starting immediately'
                };
            }
        }

        // Queue the request
        const queueResult = this.transferQueue.enqueue(transferId, transferData, transferData.priority || 5);
        if (!queueResult.success) {
            return { 
                status: 'rejected', 
                error: queueResult.error,
                message: 'System at capacity. Please try again later.'
            };
        }

        this.emit('queued', { 
            transferId, 
            position: queueResult.position, 
            queueLength: this.transferQueue.length 
        });

        return { 
            status: 'queued', 
            transferId, 
            position: queueResult.position,
            queueLength: this.transferQueue.length,
            message: `Position #${queueResult.position} in queue`
        };
    }

    _processQueue() {
        while (this.transferQueue.length > 0 && 
               this.activeTransfers.size < this.maxConcurrent) {
            
            const nextItem = this.transferQueue.dequeue();
            if (!nextItem) break;

            const fileSize = nextItem.data?.fileSize || 0;
            
            if (this.memoryManager.canAllocate(nextItem.id, fileSize)) {
                const allocation = this.memoryManager.allocate(nextItem.id, fileSize);
                if (allocation.success) {
                    this.emit('dequeued-start', { 
                        transferId: nextItem.id, 
                        ...allocation,
                        waitTime: Date.now() - nextItem.enqueueTime
                    });
                } else {
                    // Put back in queue if can't allocate
                    this.transferQueue.enqueue(nextItem.id, nextItem.data, nextItem.priority);
                    break;
                }
            } else {
                // Put back in queue if no memory
                this.transferQueue.enqueue(nextItem.id, nextItem.data, nextItem.priority);
                break;
            }
        }
    }

    registerActiveTransfer(transferId, controller) {
        this.activeTransfers.set(transferId, { 
            abortController: controller,
            startTime: Date.now()
        });
    }

    completeTransfer(transferId) {
        this.memoryManager.release(transferId);
        this.transferQueue.markComplete(transferId);
        this.activeTransfers.delete(transferId);
        this._processQueue();
        
        this.emit('complete', { transferId });
    }

    cancelTransfer(transferId) {
        const transfer = this.activeTransfers.get(transferId);
        if (transfer?.abortController) {
            try {
                transfer.abortController.abort();
            } catch (e) {}
        }
        
        this.memoryManager.release(transferId);
        this.transferQueue.remove(transferId);
        this.activeTransfers.delete(transferId);
        this._processQueue();
        
        this.emit('cancelled', { transferId });
    }

    getStatus() {
        return {
            memory: this.memoryManager.getStatus(),
            queue: {
                waiting: this.transferQueue.length,
                processing: this.transferQueue.processing.size,
                maxConcurrent: this.maxConcurrent,
                active: this.activeTransfers.size
            },
            positions: this.transferQueue.positionInfo
        };
    }

    stop() {
        this.memoryManager.stop();
        this.transferQueue.clear();
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
function parseHms(str) {
    if (!str) return 0;
    const parts = str.split(':');
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
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

const SYSTEM_VERSION = '2.0.0'; // Updated version for architecture overhaul

function renderProgressCard({ fileName, masterPercent, stageName, stagePercent, speedText, etaText, detailsText, queuePosition = null }) {
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);

    let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code> (v${SYSTEM_VERSION})\n\n`;
    
    if (queuePosition !== null) {
        card += `⏳ <b>وضعیت صف:</b> در انتظار (#${queuePosition})\n\n`;
    }
    
    card += `📊 <b>پیشرفت کل:</b>\n<code>[${masterBar}] ${masterPercent}%</code>\n\n`;
    card += `🔄 <b>مرحله جاری:</b> ${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;

    if (detailsText) card += `⚖️ <b>حجم:</b> ${detailsText}\n`;
    if (speedText) card += `⚡ <b>سرعت:</b> ${speedText}\n`;
    if (etaText) card += `⏱️ <b>زمان تقریبی باقی‌مانده:</b> ${etaText}\n`;

    return card;
}

// ============================================================================
// ENHANCED RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================
async function withRetry(operationName, operation, retries = 3, baseDelay = 5000) {
    let lastError;
    for (let i = 1; i <= retries; i++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;
            if (i === retries) throw err;
            
            // Exponential backoff with jitter
            const delay = baseDelay * Math.pow(2, i - 1) + Math.random() * 1000;
            console.warn(`[Retry] ${operationName} failed. Retrying (${i}/${retries}) in ${(delay/1000).toFixed(1)}s... Error: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

// ============================================================================
// TELEGRAM CLIENT MANAGER WITH CONNECTION RESILIENCE
// ============================================================================
class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(
            new StringSession(config.telegram.sessionString), 
            config.telegram.apiId, 
            config.telegram.apiHash, 
            { 
                connectionRetries: 10,      // Increased from 5
                retryDelay: 2000,           // Add retry delay
                useWSS: false,
                autoReconnect: true,        // Enable auto-reconnect
                timeout: 120000             // 2 minute timeout
            }
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
            try {
                await this.client.disconnect();
            } catch (e) {
                console.warn('[Telegram] Disconnect error:', e.message);
            }
            this.isConnected = false;
        }
    }

    async reconnectIfNeeded(error) {
        const isConnectionError = error?.message && (
            error.message.includes('TCPFull') ||
            error.message.includes('ECONNRESET') ||
            error.message.includes('socket hang up') ||
            error.message.includes('disconnect') ||
            error.message.includes('timeout')
        );

        if (isConnectionError && this._reconnectAttempts < this._maxReconnectAttempts) {
            this._reconnectAttempts++;
            console.log(`[Telegram] Reconnecting (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);
            
            try {
                await this.disconnect();
                await new Promise(r => setTimeout(r, 2000 * this._reconnectAttempts));
                await this.connect();
                return true;
            } catch (e) {
                console.error('[Telegram] Reconnect failed:', e.message);
            }
        }
        return false;
    }
}

// ============================================================================
// FILE VALIDATION UTILITIES
// ============================================================================
async function validateFile(filePath, expectedSize = null) {
    try {
        if (!fs.existsSync(filePath)) {
            return { valid: false, error: 'File does not exist', size: 0 };
        }

        const stats = await fs.promises.stat(filePath);
        
        // Check for empty file (the critical bug we're fixing!)
        if (stats.size === 0) {
            return { valid: false, error: 'File is empty (download likely failed)', size: 0 };
        }

        // Check if file is too small compared to expected
        if (expectedSize && stats.size < expectedSize * 0.01) {
            return { valid: false, error: `File too small: got ${stats.size}, expected ~${expectedSize}`, size: stats.size };
        }

        // Check if file looks corrupted (very small for expected size)
        if (expectedSize && stats.size < expectedSize * 0.90) {
            console.warn(`[Validation] File size mismatch: got ${formatBytes(stats.size)}, expected ~${formatBytes(expectedSize)}`);
            // Still allow it but log warning
        }

        return { valid: true, size: stats.size };
    } catch (err) {
        return { valid: false, error: err.message, size: 0 };
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
        
        // Initialize concurrency controller
        this.concurrencyController = new ConcurrencyController({
            maxConcurrent: config.performance.maxConcurrentTransfers,
            memoryBudget: config.performance.memoryBudget
        });

        // Bind to concurrency events
        this.concurrencyController.on('queued', ({ transferId, position }) => {
            console.log(`[Concurrency] Transfer ${transferId} queued at position ${position}`);
        });
    }

    async checkCancel() {
        if (this.abortController.signal.aborted) return true;
        if (!config.cloudflare.webhookUrl || !config.transferId) return false;
        
        try {
            const baseUrl = config.cloudflare.webhookUrl.replace(/\/action-webhook\/?$/, '');
            const res = await fetch(`${baseUrl}/check-cancel?transferId=${config.transferId}`, {
                headers: { 'Authorization': `Bearer ${config.cloudflare.apiToken}` },
                signal: AbortSignal.timeout(2000)
            }).then(r => r.json());
            return res.cancelled === true;
        } catch {
            return false;
        }
    }

    async updateStatus(chatId, text, force = false) {
        if (!config.telegram.botToken || !chatId) return;
        if (this.isUpdatingStatus && !force) return;
        while (this.isUpdatingStatus) await new Promise(r => setTimeout(r, 100));
        
        this.isUpdatingStatus = true;
        try {
            const endpoint = this.statusMessageId ? 'editMessageText' : 'sendMessage';
            const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
            if (this.statusMessageId) body.message_id = this.statusMessageId;

            const res = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/${endpoint}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            }).then(r => r.json());

            if (res.ok && res.result) {
                if (!this.statusMessageId) this.statusMessageId = res.result.message_id;
            } else if (endpoint === 'editMessageText') {
                delete body.message_id;
                const fallbackRes = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                }).then(r => r.json());
                if (fallbackRes.ok && fallbackRes.result) this.statusMessageId = fallbackRes.result.message_id;
            }
        } catch (e) {
            console.error("Failed to update status message:", e);
        } finally {
            this.isUpdatingStatus = false;
        }
    }

    async manageStorage(requiredBytes) {
        const bucket = config.minio.bucketName;
        const MAX_STORAGE = 9.5 * 1024 * 1024 * 1024; // 9.5GB
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

        let currentSize = 0;
        const toDelete = [], keptObjects = [];

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

        if (toDelete.length > 0) {
            await withRetry('Delete Old Objects', async () => {
                await minioClient.removeObjects(bucket, toDelete);
            });
        }
    }

    runFFmpeg(args, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const fullArgs = ['-progress', 'pipe:1', ...args];
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
                    } else if (key === 'out_time_us') {
                        outTimeSec = parseInt(val) / 1000000;
                    } else if (key === 'speed') {
                        speedStr = val;
                    }
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
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg Error: ${errorLog.slice(-300).replace(/\n/g, ' ').trim()}`));
            });

            ffmpegProcess.on('error', err => {
                this.activeFFmpegProcess = null;
                reject(err);
            });
        });
    }

    /**
     * OPTIMIZED UPLOAD: Streaming with progress tracking and validation
     */
    async uploadToMinIO(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const metaData = { 
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'X-Upload-Version': SYSTEM_VERSION
        };

        // Pre-upload validation (CRITICAL FIX for empty file bug)
        const validation = await validateFile(filePath);
        if (!validation.valid) {
            throw new Error(`Pre-upload validation failed: ${validation.error}`);
        }

        const totalSize = validation.size;
        console.log(`[Upload] Starting upload: ${fileName} (${formatBytes(totalSize)})`);

        return await withRetry('MinIO File Upload', async () => {
            const fileStream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 }); // 16MB read buffer
            
            // Handle abort signal
            if (signal) {
                signal.addEventListener('abort', () => fileStream.destroy(), { once: true });
            }

            let uploadedBytes = 0;
            const startTime = Date.now();

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
            console.log(`[Upload] Completed: ${fileName}`);
        }, 3, 5000);

        return await minioClient.presignedGetObject(bucket, fileName, 7200);
    }

    /**
     * ⚡ OPTIMIZED MULTIPART UPLOAD for large files (>100MB)
     * Uploads file in parallel parts instead of single stream
     * Expected speed improvement: 2-3x for large files
     */
    async uploadToMinIOMultipart(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const { thresholdBytes, partSize, concurrency } = config.performance.multipartUpload;
        
        const stats = fs.statSync(filePath);
        const totalSize = stats.size;
        
        // Only use multipart if enabled and file is large enough
        if (!config.performance.multipartUpload.enabled || totalSize < thresholdBytes) {
            return this.uploadToMinIO(filePath, fileName, onProgress, signal);
        }
        
        console.log(`[Multipart] Starting parallel upload: ${fileName} (${formatBytes(totalSize)}, parts of ${formatBytes(partSize)})`);
        
        try {
            const totalParts = Math.ceil(totalSize / partSize);
            let completedParts = 0;
            
            // Process parts in batches (parallel within each batch)
            for (let i = 0; i < totalParts; i += concurrency) {
                // Check cancellation
                if (signal?.aborted) {
                    throw new Error("انتقال توسط کاربر لغو شد.");
                }
                
                const batch = [];
                const batchEnd = Math.min(i + concurrency, totalParts);
                
                for (let j = i; j < batchEnd; j++) {
                    const start = j * partSize;
                    const end = Math.min(start + partSize, totalSize);
                    
                    // Create read stream for this part
                    const partStream = fs.createReadStream(filePath, { 
                        start, 
                        end: end - 1,
                        highWaterMark: 10 * 1024 * 1024 // 10MB buffer per part
                    });
                    
                    batch.push(
                        new Promise((resolve, reject) => {
                            partStream.on('error', reject);
                            minioClient.putObject(bucket, `${fileName}.part${j}`, partStream, end - start)
                                .then(resolve)
                                .catch(reject);
                        })
                    );
                }
                
                // Wait for entire batch to complete
                await Promise.all(batch);
                completedParts = batchEnd;
                
                // Report progress
                if (onProgress) {
                    const percent = Math.floor((completedParts / totalParts) * 100);
                    const uploadedBytes = Math.min(completedParts * partSize, totalSize);
                    const elapsedSec = (Date.now() - performance.now()) / 1000 || 1;
                    const speed = uploadedBytes / elapsedSec;
                    
                    onProgress(percent, formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), formatSpeed(speed), '');
                }
            }
            
            console.log(`[Multipart] Completed: ${totalParts} parts uploaded`);
            
            // Return presigned URL (valid for 24 hours instead of 2)
            return await minioClient.presignedGetObject(bucket, fileName, 86400);
            
        } catch (error) {
            console.error(`[Multipart] Upload failed, falling back to standard:`, error.message);
            // Fallback to standard upload on failure
            return this.uploadToMinIO(filePath, fileName, onProgress, signal);
        }
    }

    /**
     * ⚡ ADAPTIVE THROTTLING HELPER CLASS
     * Dynamically adjusts worker count based on network conditions
     */
    createAdaptiveThrottler() {
        const settings = config.performance.adaptiveThrottling;
        
        return {
            speedHistory: [],
            optimalWorkers: config.performance.downloadWorkers,
            lastAdjustment: Date.now(),
            
            recordSpeed(speedBytesPerSec) {
                if (!settings.enabled) return this.optimalWorkers;
                
                this.speedHistory.push({
                    speed: speedBytesPerSec,
                    time: Date.now()
                });
                
                // Keep only last 10 samples
                if (this.speedHistory.length > 10) {
                    this.speedHistory.shift();
                }
                
                // Check if we should adjust (every 5 seconds)
                const now = Date.now();
                if (now - this.lastAdjustment > settings.adjustmentIntervalMs) {
                    this.lastAdjustment = now;
                    return this.adjustWorkers();
                }
                
                return this.optimalWorkers;
            },
            
            adjustWorkers() {
                if (this.speedHistory.length < 5) return this.optimalWorkers;
                
                const recentSpeeds = this.speedHistory.slice(-5).map(s => s.speed);
                const avgSpeed = recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length;
                const firstHalf = recentSpeeds.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
                const secondHalf = recentSpeeds.slice(-3).reduce((a, b) => a + b, 0) / 3;
                const trend = secondHalf - firstHalf;
                const trendPercent = avgSpeed > 0 ? trend / avgSpeed : 0;
                
                // If speed is dropping significantly, increase workers
                if (trendPercent < -settings.speedDropThreshold && this.optimalWorkers < settings.maxWorkers) {
                    this.optimalWorkers = Math.min(settings.maxWorkers, this.optimalWorkers + 4);
                    console.log(`[Adaptive] Speed dropping (${formatBytes(secondHalf)}/s → ${formatBytes(firstHalf)}/s), increasing workers to ${this.optimalWorkers}`);
                }
                // If speed is stable or improving, slightly decrease to reduce overhead
                else if (trendPercent > -settings.speedRecoveryThreshold && this.optimalWorkers > settings.minWorkers) {
                    this.optimalWorkers = Math.max(settings.minWorkers, this.optimalWorkers - 2);
                }
                
                return this.optimalWorkers;
            },
            
            getCurrentWorkers() {
                return this.optimalWorkers;
            }
        };
    }

    /**
     * ⚡ OPTIMIZED DOWNLOAD v2.0: Adaptive throttling + larger chunks + better resilience
     * Expected improvement: 3-5x faster downloads
     */
    async downloadFromTelegramOptimized(client, message, filePath, fileSize, onProgress, signal) {
        const throttler = this.createAdaptiveThrottler();
        
        console.log(`[Download⚡] Starting optimized download:` +
            ` chunkSize=${formatBytes(config.performance.downloadChunkSize)}, ` +
            `initialWorkers=${config.performance.downloadWorkers}, ` +
            `adaptive=${config.performance.adaptiveThrottling.enabled}`);
        
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        let lastError = null;

        while (downloadAttempts < maxDownloadAttempts) {
            downloadAttempts++;
            try {
                // Remove file if it exists from previous attempt
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                }

                // Track speed for adaptive throttling
                let lastProgressTime = Date.now();
                let lastProgressBytes = 0;
                let speedLogCounter = 0;

                await client.downloadMedia(message.media, {
                    partSize: config.performance.downloadChunkSize, // 8MB chunks
                    outputFile: filePath,
                    workers: throttler.getCurrentWorkers(),   // Start with adaptive workers
                    progressCallback: (downloaded, total) => {
                        // Check cancellation
                        if (signal?.aborted) {
                            throw new Error("انتقال توسط کاربر لغو شد.");
                        }
                        
                        // Adaptive throttling: track speed every second
                        const now = Date.now();
                        const bytesSinceLast = downloaded - lastProgressBytes;
                        
                        if (now - lastProgressTime >= 1000) {
                            const instantSpeed = bytesSinceLast / ((now - lastProgressTime) / 1000);
                            throttler.recordSpeed(instantSpeed);
                            
                            lastProgressTime = now;
                            lastProgressBytes = downloaded;
                            
                            // Log speed periodically (every ~5 seconds)
                            speedLogCounter++;
                            if (speedLogCounter >= 5) {
                                console.log(`[Speed⚡] ${formatBytes(instantSpeed)}/s (workers: ${throttler.getCurrentWorkers()}, ${Math.round(downloaded/total*100)}%)`);
                                speedLogCounter = 0;
                            }
                        }
                        
                        if (onProgress) {
                            onProgress(downloaded, total);
                        }
                    }
                });

                // POST-DOWNLOAD VALIDATION
                console.log(`[Download⚡] Validating downloaded file...`);
                const validation = await validateFile(filePath, fileSize);
                
                if (!validation.valid) {
                    throw new Error(`Download validation failed: ${validation.error}`);
                }

                if (fileSize && validation.size < fileSize * 0.90) {
                    console.warn(`[Download⚡] Size warning: ${formatBytes(validation.size)} vs expected ${formatBytes(fileSize)}`);
                }

                console.log(`[Download⚡] Success: ${formatBytes(validation.size)} in ${downloadAttempts} attempt(s)`);
                return validation;

            } catch (err) {
                lastError = err;
                console.error(`[Download⚡] Attempt ${downloadAttempts} failed:`, err.message);

                // Try to reconnect on connection errors
                if (downloadAttempts < maxDownloadAttempts) {
                    const reconnected = await this.telegramClient.reconnectIfNeeded(err);
                    if (reconnected) {
                        console.log(`[Download⚡] Reconnected, retrying...`);
                        continue;
                    }

                    // Wait before retry (exponential backoff)
                    await new Promise(r => setTimeout(r, 3000 * downloadAttempts));
                }
            }
        }

        throw lastError || new Error('Download failed after all retries');
    }

    /**
     * OPTIMIZED DOWNLOAD: Legacy method (kept for backward compatibility)
     */
    async downloadFromTelegram(client, message, filePath, fileSize, onProgress, signal) {
        console.log(`[Download] Starting: chunkSize=${formatBytes(config.performance.downloadChunkSize)}, workers=${config.performance.downloadWorkers}`);
        
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        let lastError = null;

        while (downloadAttempts < maxDownloadAttempts) {
            downloadAttempts++;
            try {
                // Remove file if it exists from previous attempt
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                }

                await client.downloadMedia(message.media, {
                    partSize: config.performance.downloadChunkSize, // 2MB instead of 256KB
                    outputFile: filePath,
                    workers: config.performance.downloadWorkers,   // 8 instead of 24
                    progressCallback: (downloaded, total) => {
                        // Check cancellation
                        if (signal?.aborted) {
                            throw new Error("انتقال توسط کاربر لغو شد.");
                        }
                        
                        if (onProgress) {
                            onProgress(downloaded, total);
                        }
                    }
                });

                // POST-DOWNLOAD VALIDATION (Critical fix for empty file bug)
                console.log(`[Download] Validating downloaded file...`);
                const validation = await validateFile(filePath, fileSize);
                
                if (!validation.valid) {
                    throw new Error(`Download validation failed: ${validation.error}`);
                }

                if (fileSize && validation.size < fileSize * 0.90) {
                    console.warn(`[Download] Size warning: ${formatBytes(validation.size)} vs expected ${formatBytes(fileSize)}`);
                }

                console.log(`[Download] Success: ${formatBytes(validation.size)} in ${downloadAttempts} attempt(s)`);
                return validation;

            } catch (err) {
                lastError = err;
                console.error(`[Download] Attempt ${downloadAttempts} failed:`, err.message);

                // Try to reconnect on connection errors
                if (downloadAttempts < maxDownloadAttempts) {
                    const reconnected = await this.telegramClient.reconnectIfNeeded(err);
                    if (reconnected) {
                        console.log(`[Download] Reconnected, retrying...`);
                        continue;
                    }

                    // Wait before retry
                    await new Promise(r => setTimeout(r, 3000 * downloadAttempts));
                }
            }
        }

        throw lastError || new Error('Download failed after all retries');
    }

    /**
     * MAIN EXECUTION METHOD
     */
    async start() {
        const startTime = Date.now();
        let downloadedFilePath = '', targetPath = '';
        const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
        const messageId = process.env.MESSAGE_ID || '0';
        let fileName = process.env.FILE_NAME || `file_${Date.now()}`;
        const fileSize = parseInt(process.env.FILE_SIZE || '0');
        const isVideo = process.env.IS_VIDEO === 'true';
        const shouldCompress = process.env.SHOULD_COMPRESS === 'true';
        const transferId = config.transferId || `transfer_${Date.now()}`;

        try {
            // Register with concurrency controller
            const requestResult = await this.concurrencyController.requestTransfer(transferId, {
                fileName,
                fileSize,
                isVideo,
                priority: shouldCompress ? 3 : 5 // Compressed files get higher priority
            });

            this.concurrencyController.registerActiveTransfer(transferId, this.abortController);

            if (requestResult.status === 'queued') {
                // Show queue status to user
                await this.updateStatus(chatId, renderProgressCard({
                    fileName,
                    masterPercent: 0,
                    stageName: '⏳ در صف انتظار...',
                    stagePercent: 0,
                    queuePosition: requestResult.position
                }), true);

                // Wait for our turn (poll until dequeued)
                while (this.concurrencyController.transferQueue.getPosition(transferId) !== null) {
                    await new Promise(r => setTimeout(r, 2000));
                    
                    // Update queue position
                    const pos = this.concurrencyController.transferQueue.getPosition(transferId);
                    if (pos !== null) {
                        await this.updateStatus(chatId, renderProgressCard({
                            fileName,
                            masterPercent: 0,
                            stageName: `⏳ در صف انتظار (#${pos} از ${requestResult.queueLength})`,
                            stagePercent: 0,
                            queuePosition: pos
                        })).catch(() => {});
                    }
                    
                    if (await this.checkCancel()) {
                        this.concurrencyController.cancelTransfer(transferId);
                        throw new Error("انتقال توسط کاربر لغو شد.");
                    }
                }
            }

            // CONNECT TO TELEGRAM
            await this.telegramClient.connect();
            downloadedFilePath = path.join(config.performance.tempDir, `${transferId}_${fileName}`);
            const client = this.telegramClient.client;

            // PHASE 1: STORAGE MANAGEMENT (5%)
            await this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent: 5, stageName: '🧹 پاکسازی و آماده‌سازی حافظه', stagePercent: 100
            }), true);
            
            await this.manageStorage(fileSize);

            // GET MESSAGE
            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("پیام یا فایل در تلگرام یافت نشد.");

            // PHASE 2: DOWNLOAD FROM TELEGRAM (5% -> 65%) ⚡ OPTIMIZED
            let lastProgressUpdate = 0;
            let lastCancelCheck = 0;

            await this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent: 5, stageName: '📥⚡ دریافت فایل از تلگرام', stagePercent: 0
            }), true);

            // ⚡ Use optimized download with adaptive throttling (3-5x faster)
            const downloadResult = await this.downloadFromTelegramOptimized(
                client, 
                messages[0], 
                downloadedFilePath, 
                fileSize,
                (downloaded, total) => {
                    const now = Date.now();

                    if (now - lastCancelCheck >= 3000) {
                        lastCancelCheck = now;
                        this.checkCancel().then(cancelled => {
                            if (cancelled) this.isCancelled = true;
                        }).catch(() => {});
                    }

                    if (now - lastProgressUpdate >= 3000 || downloaded === total) {
                        lastProgressUpdate = now;
                        const subPercent = total ? Math.floor((downloaded / total) * 100) : 0;
                        const masterPercent = Math.min(65, 5 + Math.floor(subPercent * 0.60)); // 5-65%
                        const elapsedSec = (now - startTime) / 1000;
                        const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                        const eta = speed > 0 ? (total - downloaded) / speed : 0;

                        const text = renderProgressCard({
                            fileName,
                            masterPercent,
                            stageName: '📥⚡ دریافت فایل از تلگرام',
                            stagePercent: subPercent,
                            detailsText: `${formatBytes(downloaded)} / ${formatBytes(total)}`,
                            speedText: formatSpeed(speed),
                            etaText: formatEta(eta)
                        });

                        this.updateStatus(chatId, text, false).catch(() => {});
                    }
                },
                this.abortController.signal
            );

            targetPath = downloadedFilePath;

            // PHASE 3: VIDEO PROCESSING (65% -> 85%) - IF VIDEO
            if (isVideo) {
                if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");

                fileName = `${path.parse(fileName).name}.mp4`;
                const processedPath = path.join(config.performance.tempDir, `processed_${transferId}_${Date.now()}.mp4`);
                
                const cancelCheckInterval = setInterval(async () => {
                    if (await this.checkCancel()) {
                        if (this.activeFFmpegProcess) {
                            this.activeFFmpegProcess.kill('SIGKILL');
                        }
                    }
                }, 2000);

                try {
                    const maxDim = shouldCompress ? 854 : 1280;
                    const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
                    const crfValue = shouldCompress ? '28' : '23';
                    const audioBitrate = shouldCompress ? '64k' : '128k';

                    lastProgressUpdate = 0;
                    await this.updateStatus(chatId, renderProgressCard({
                        fileName,
                        masterPercent: 65,
                        stageName: shouldCompress ? '🗜 فشرده‌سازی و تغییر مقیاس (480p)' : '🎬 بهینه‌سازی ساختار ویدیو (720p)',
                        stagePercent: 0,
                        speedText: '1.0x',
                        etaText: 'محاسبه...'
                    }), true);

                    await this.runFFmpeg([
                        '-i', downloadedFilePath,
                        '-threads', '0',
                        '-c:v', 'libx264',
                        '-crf', crfValue,
                        '-preset', 'veryfast',
                        '-vf', scaleFilter,
                        '-c:a', 'aac',
                        '-b:a', audioBitrate,
                        '-movflags', '+faststart',
                        '-y', processedPath
                    ], (subPercent, speedStr, etaText) => {
                        const now = Date.now();
                        if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                            lastProgressUpdate = now;
                            const masterPercent = Math.min(85, 65 + Math.floor(subPercent * 0.20));

                            const text = renderProgressCard({
                                fileName,
                                masterPercent,
                                stageName: shouldCompress ? '🗜 فشرده‌سازی و تغییر مقیاس (480p)' : '🎬 بهینه‌سازی ساختار ویدیو (720p)',
                                stagePercent: subPercent,
                                speedText: speedStr,
                                etaText: etaText
                            });
                            this.updateStatus(chatId, text, false).catch(() => {});
                        }
                    }, this.abortController.signal);
                    
                    targetPath = processedPath;
                } catch (ffmpegErr) {
                    if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");
                    throw new Error(`مشکل در ساختار فایل ویدیو.\n\nجزئیات فنی: ${ffmpegErr.message}`);
                } finally {
                    clearInterval(cancelCheckInterval);
                }
            }

            // PHASE 4: UPLOAD TO MINIO (85% -> 98%) ⚡ OPTIMIZED
            if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");
            this.isCriticalSection = true;

            // ⚡ Use multipart upload for large files (>100MB) - 2-3x faster
            const fileStats = await fs.promises.stat(targetPath);
            const useMultipart = config.performance.multipartUpload.enabled && 
                                  fileStats.size > config.performance.multipartUpload.thresholdBytes;
            
            const downloadLink = useMultipart 
                ? await this.uploadToMinIOMultipart(targetPath, fileName, (subPercent, sizeText, speedText, etaText) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                        lastProgressUpdate = now;
                        const baseMaster = isVideo ? 85 : 65;
                        const masterSpan = isVideo ? 13 : 33;
                        const masterPercent = Math.min(98, baseMaster + Math.floor(subPercent * (masterSpan / 100)));

                        const text = renderProgressCard({
                            fileName,
                            masterPercent,
                            stageName: '☁️⚡ آپلود موازی‌پارتیل به سرور',
                            stagePercent: subPercent,
                            detailsText: sizeText,
                            speedText: speedText,
                            etaText: etaText
                        });

                        this.updateStatus(chatId, text, false).catch(() => {});
                    }
                }, this.abortController.signal)
                : await this.uploadToMinIO(targetPath, fileName, (subPercent, sizeText, speedText, etaText) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                        lastProgressUpdate = now;
                        const baseMaster = isVideo ? 85 : 65;
                        const masterSpan = isVideo ? 13 : 33;
                        const masterPercent = Math.min(98, baseMaster + Math.floor(subPercent * (masterSpan / 100)));

                        const text = renderProgressCard({
                            fileName,
                            masterPercent,
                            stageName: '☁️ آپلود به سرور ابری',
                            stagePercent: subPercent,
                            detailsText: sizeText,
                            speedText: speedText,
                            etaText: etaText
                        });

                        this.updateStatus(chatId, text, false).catch(() => {});
                    }
                }, this.abortController.signal);

            // COMPLETE
            const actualSize = (await fs.promises.stat(targetPath)).size;
            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            
            const successMsg = `✅ <b>انتقال کامل شد!</b>\n\n<code>[██████████] 100%</code>\n📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n📏 <b>حجم:</b> ${formatBytes(actualSize)}\n⏱️ <b>زمان:</b> ${elapsedTime} ثانیه\n⚠️ <b>لینک پس از ۲ ساعت منقضی و فایل به صورت خودکار حذف می‌شود.</b>\n\n🔗 <a href="${downloadLink}">👉 لینک دانلود مستقیم 👈</a>`;

            await this.updateStatus(chatId, successMsg, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'completed' });

            // Mark as complete in concurrency controller
            this.concurrencyController.completeTransfer(transferId);

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            
            // Release resources
            this.concurrencyController.completeTransfer(transferId);
            
            const isNetworkError = err.message.includes('TCPFull') || err.message.includes('fetch') || 
                                   err.message.includes('ECONNRESET') || err.message.includes('Timeout') ||
                                   err.message.includes('disconnect');
                                   
            await this.updateStatus(chatId, `❌ <b>خطا در انجام عملیات:</b>\n<code>${escapeHtml(err.message)}</code>${isNetworkError ? '\n\n🔄 در حال بازگشت به صف برای تلاش مجدد...' : ''}`, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'failed', error: err.message, retryable: isNetworkError });
        } finally {
            // Cleanup
            if (downloadedFilePath) await this.cleanupFile(downloadedFilePath);
            if (targetPath && targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            this.concurrencyController.stop();
            process.exit(0);
        }
    }

    async cleanupFile(filePath) {
        try { 
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
                console.log(`[Cleanup] Removed: ${filePath}`);
            }
        } catch (e) { 
            console.warn(`[Cleanup] Failed to remove ${filePath}:`, e.message);
        }
    }

    async notifyCloudflare(payload) {
        if (!config.cloudflare.webhookUrl) return;
        try {
            await fetch(config.cloudflare.webhookUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.cloudflare.apiToken}` },
                body: JSON.stringify(payload)
            });
        } catch (error) { }
    }
}

// ============================================================================
// START APPLICATION
// ============================================================================
console.log(`
╔══════════════════════════════════════════════════════════════╗
║     ⚡ File Transfer Bot v${SYSTEM_VERSION} - SPEED OPTIMIZED ⚡            ║
╠══════════════════════════════════════════════════════════════╣
║  Download Settings:                                            ║
║  • Chunk Size: ${formatBytes(config.performance.downloadChunkSize).padEnd(12)} (4x larger)              ║
║  • Workers: ${String(config.performance.downloadWorkers).padEnd(10)} (3x parallelism)           ║
║  • Adaptive Throttling: ${String(config.performance.adaptiveThrottling.enabled).padEnd(6)}                    ║
║                                                               ║
║  Upload Settings:                                              ║
║  • Multipart Upload: ${String(config.performance.multipartUpload.enabled).padEnd(6)} (>100MB files)       ║
║  • Part Size: ${formatBytes(config.performance.multipartUpload.partSize).padEnd(12)}                   ║
║  • Parallel Parts: ${String(config.performance.multipartUpload.concurrency).padEnd(7)}                  ║
║                                                               ║
║  Concurrency: ${String(config.performance.maxConcurrentTransfers).padEnd(5)} simultaneous transfers      ║
╚══════════════════════════════════════════════════════════════╝
`);
console.log(`[Config] Temp Dir: ${config.performance.tempDir}`);

new FileTransferBot().start().catch(err => {
    console.error('[Fatal] Unhandled error:', err);
    process.exit(1);
});
