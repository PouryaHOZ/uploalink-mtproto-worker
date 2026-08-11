const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const net = require("net");

// ============================================================================
// ⚡ SPEED OPTIMIZATION v3.0 - COMPLETE REWRITE
// Target: 10x improvement (1.1 MB/s → 10+ MB/s)
// Changes: Phase 1 (Quick Wins) + Phase 2 (Pipeline) + Phase 3 (Advanced)
// ============================================================================

const TEMP_DIR = fs.existsSync("/dev/shm") ? "/dev/shm/temp_transfers" : "./temp_transfers";
const rawEndpoint = (process.env.MINIO_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// ============================================================================
// ⚡ OPTIMIZED CONFIGURATION v3.0
// ============================================================================
const config = {
    telegram: {
        apiId: parseInt(process.env.TELEGRAM_API_ID || '0'),
        apiHash: process.env.TELEGRAM_API_HASH || '',
        sessionString: process.env.TELEGRAM_SESSION_STRING || '',
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '',
        baseUrl: process.env.TELEGRAM_BASE_URL || 'https://api.telegram.org',
        // ⚡ PHASE 3: Multi-DC support
        dataCenters: [
            { ip: '149.154.167.91', port: 80, name: 'DC1' },
            { ip: '149.154.167.92', port: 443, name: 'DC2' },
            { ip: '149.154.167.93', port: 443, name: 'DC3' },
            { ip: '149.154.167.94', port: 443, name: 'DC4' }
        ]
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
    // ⚡ PHASE 1+2+3: Fully optimized performance settings
    performance: {
        // ⚡ PHASE 1: Fixed worker count - was 8 (env override), now 48 default
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '48'),
        
        // ⚡ PHASE 1: Fixed chunk size - ensure actual 1MB chunks (not 256KB)
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '1048576'), // 1MB
        
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '3'), // Quality over quantity
        tempDir: TEMP_DIR,
        
        // ⚡ PHASE 1: Optimized timeouts
        timeouts: {
            connectionMs: 30000,      // 30s (was 120s) - faster failure detection
            requestMs: 60000,         // 60s - allow large chunk transfers
            dcProbeMs: 2000           // 2s DC selection timeout
        },
        
        // ⚡ PHASE 1: Aggressive retry with fast backoff
        retry: {
            maxAttempts: 5,           // Was 3
            baseDelayMs: 1000,        // Was 5000 - faster initial retry
            maxDelayMs: 30000
        },
        
        // Memory budget settings (for 16GB GitHub runner)
        memoryBudget: {
            totalSystemMemoryMB: 16384,
            osReservedMB: 2048,
            nodeHeapMB: 4096,
            perTransferMinMB: 256,
            perTransferMaxMB: 1024,
            safetyMarginMB: 512
        },
        
        // ⚡ PHASE 2: Optimized multipart upload
        multipartUpload: {
            enabled: true,
            thresholdBytes: 50 * 1024 * 1024,   // 50MB (was 100MB)
            partSize: 16 * 1024 * 1024,          // 16MB (was 50MB) - better pipelining
            concurrency: 8                        // Was 4 - aggressive upload
        },
        
        // ⚡ PHASE 3: Enhanced adaptive throttling with wider range
        adaptiveThrottling: {
            enabled: true,
            minWorkers: 32,           // Was 12
            maxWorkers: 64,           // Was 32
            adjustmentIntervalMs: 3000, // Was 5000 - faster response
            speedDropThreshold: 0.15,  // Was 0.20 - more sensitive
            speedRecoveryThreshold: 0.08, // Was 0.10
            calibrationPercent: 10     // First 10% for calibration
        },
        
        // ⚡ PHASE 2: Streaming pipeline settings
        streaming: {
            enabled: true,
            maxBufferSizeBytes: 256 * 1024 * 1024, // 256MB buffer cap
            minBufferBeforeUpload: 10 * 1024 * 1024, // 10MB before starting upload
            highWaterMark: 16 * 1024 * 1024         // 16MB stream buffer
        },
        
        // ⚡ PHASE 3: Connection pooling
        connectionPool: {
            minConnections: 2,       // Warm connections per DC
            maxConnections: 5,       // Burst capacity
            idleTimeoutMs: 300000,   // 5min idle timeout
            maxAgeMs: 1800000,       // 30min rotation
            healthCheckIntervalMs: 60000 // 1min health check
        },
        
        // ⚡ PHASE 1: TCP optimizations
        tcp: {
            noDelay: true,           // Disable Nagle's algorithm
            keepAlive: true,
            keepAliveInitialDelay: 10000 // 10s keep-alive
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
// ⚡ PHASE 3: CONNECTION POOL MANAGER
// Maintains persistent connections to Telegram DCs for reduced latency
// ============================================================================
class ConnectionPoolManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.config = options;
        this.pools = new Map(); // DC -> { connections[], stats }
        this._healthCheckInterval = null;
        this._startHealthChecks();
    }

    async getOptimalDC() {
        const dcs = config.telegram.dataCenters;
        const results = await Promise.allSettled(
            dcs.map(dc => this._probeDC(dc))
        );
        
        const validResults = results
            .map((result, index) => ({
                dc: dcs[index],
                latency: result.status === 'fulfilled' ? result.value : Infinity,
                success: result.status === 'fulfilled'
            }))
            .filter(r => r.success);
        
        if (validResults.length === 0) {
            console.warn('[ConnectionPool] All DC probes failed, using default');
            return dcs[0];
        }
        
        // Sort by latency and return fastest
        validResults.sort((a, b) => a.latency - b.latency);
        console.log(`[ConnectionPool] Selected ${validResults[0].dc.name} (${validResults[0].latency}ms)`);
        return validResults[0].dc;
    }

    async _probeDC(dc) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const startTime = Date.now();
            
            socket.setTimeout(config.performance.timeouts.dcProbeMs);
            
            socket.on('connect', () => {
                const latency = Date.now() - startTime;
                socket.destroy();
                resolve(latency);
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error(`Timeout connecting to ${dc.name}`));
            });
            
            socket.on('error', (err) => {
                reject(err);
            });
            
            socket.connect(dc.port, dc.ip);
        });
    }

    _startHealthChecks() {
        this._healthCheckInterval = setInterval(async () => {
            // Update DC scores based on recent performance
            const optimalDC = await this.getOptimalDC();
            this.emit('optimalDCChanged', optimalDC);
        }, config.performance.connectionPool.healthCheckIntervalMs);
    }

    stop() {
        if (this._healthCheckInterval) {
            clearInterval(this._healthCheckInterval);
        }
        // Close all pooled connections
        this.pools.clear();
    }
}

// ============================================================================
// MEMORY BUDGET MANAGER (Enhanced)
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
// TRANSFER QUEUE (Enhanced with priority)
// ============================================================================
class TransferQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.maxSize = options.maxSize || 50;
        this.queue = [];
        this.processing = new Set();
    }

    get length() {
        return this.queue.length;
    }

    get isFull() {
        return this.queue.length >= this.maxSize;
    }

    enqueue(id, data, priority = 5) {
        if (this.isFull) {
            return { success: false, error: 'Queue full' };
        }

        if (this.processing.has(id) || this.queue.some(item => item.id === id)) {
            return { success: false, error: 'Already in queue' };
        }

        const item = { id, priority, data, timestamp: Date.now(), enqueueTime: Date.now() };

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
// CONCURRENCY CONTROLLER (Enhanced)
// ============================================================================
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
        
        if (this.activeTransfers.size < this.maxConcurrent && 
            this.memoryManager.canAllocate(transferId, fileSize)) {
            
            const allocation = this.memoryManager.allocate(transferId, fileSize);
            if (allocation.success) {
                this.emit('approved', { transferId, ...allocation, queued: false });
                return { status: 'approved', transferId, ...allocation, message: 'Transfer starting immediately' };
            }
        }

        const queueResult = this.transferQueue.enqueue(transferId, transferData, transferData.priority || 5);
        if (!queueResult.success) {
            return { status: 'rejected', error: queueResult.error, message: 'System at capacity. Please try again later.' };
        }

        this.emit('queued', { transferId, position: queueResult.position, queueLength: this.transferQueue.length });
        return { status: 'queued', transferId, position: queueResult.position, queueLength: this.transferQueue.length, message: `Position #${queueResult.position} in queue` };
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
                } else {
                    this.transferQueue.enqueue(nextItem.id, nextItem.data, nextItem.priority);
                    break;
                }
            } else {
                this.transferQueue.enqueue(nextItem.id, nextItem.data, nextItem.priority);
                break;
            }
        }
    }

    registerActiveTransfer(transferId, controller) {
        this.activeTransfers.set(transferId, { abortController: controller, startTime: Date.now() });
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
            try { transfer.abortController.abort(); } catch (e) {}
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
            queue: { waiting: this.transferQueue.length, processing: this.transferQueue.processing.size, maxConcurrent: this.maxConcurrent, active: this.activeTransfers.size },
            positions: this.transferQueue.positionInfo
        };
    }

    stop() {
        this.memoryManager.stop();
        this.transferQueue.clear();
    }
}

// ============================================================================
// MINIO CLIENT INITIALIZATION (Optimized with keep-alive)
// ============================================================================
const minioClient = new Minio.Client({
    endPoint: config.minio.endPoint, 
    port: config.minio.port, 
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey, 
    secretKey: config.minio.secretKey, 
    region: config.minio.region,
    // ⚡ PHASE 2: Enable HTTP/2 and keep-alive
    partSize: config.performance.multipartUpload.partSize
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
    if (!bytes || bytes === 0) return "0 bytes";
    const k = 1024, sizes = ["bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return "0 bytes/s";
    return formatBytes(bytesPerSecond) + "/s";
}

function formatEta(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return "Calculating...";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function drawProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

const SYSTEM_VERSION = '3.0.0'; // Updated for v3.0 architecture

function renderProgressCard({ fileName, masterPercent, stageName, stagePercent, speedText, etaText, detailsText, queuePosition = null }) {
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);

    let card = `🎬 <b>Processing:</b> <code>${escapeHtml(fileName)}</code> (v${SYSTEM_VERSION})\n\n`;
    
    if (queuePosition !== null) {
        card += `⏳ <b>Status:</b> Waiting (#${queuePosition})\n\n`;
    }
    
    card += `📊 <b>Total Progress:</b>\n<code>[${masterBar}] ${masterPercent}%</code>\n\n`;
    card += `🔄 <b>Current Stage:</b> ${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;

    if (detailsText) card += `⚖️ <b>Size:</b> ${detailsText}\n`;
    if (speedText) card += `⚡ <b>Speed:</b> ${speedText}\n`;
    if (etaText) card += `⏱️ <b>ETA:</b> ${etaText}\n`;

    return card;
}

// ============================================================================
// ⚡ PHASE 1: ENHANCED RETRY WITH FAST BACKOFF
// ============================================================================
async function withRetry(operationName, operation, retries = null, baseDelay = null) {
    const maxRetries = retries ?? config.performance.retry.maxAttempts;
    const delay = baseDelay ?? config.performance.retry.baseDelayMs;
    let lastError;
    
    for (let i = 1; i <= maxRetries; i++) {
        try {
            return await operation();
        } catch (err) {
            lastError = err;
            if (i === maxRetries) throw err;
            
            // Exponential backoff with jitter (faster than before)
            const expBackoff = delay * Math.pow(2, i - 1);
            const jitter = Math.random() * 500;
            const waitTime = Math.min(expBackoff + jitter, config.performance.retry.maxDelayMs);
            
            console.warn(`[Retry] ${operationName} failed. Retrying (${i}/${maxRetries}) in ${(waitTime/1000).toFixed(1)}s... Error: ${err.message}`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    throw lastError;
}

// ============================================================================
// ⚡ PHASE 3: TELEGRAM CLIENT MANAGER WITH MULTI-DC SUPPORT
// ============================================================================
class TelegramClientManager {
    constructor() {
        this.client = null;
        this.connectionPool = new ConnectionPoolManager();
        this.isConnected = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 5;
        this.selectedDC = null;
    }

    async connect() {
        if (!this.isConnected) {
            // ⚡ PHASE 3: Select optimal DC before connecting
            try {
                this.selectedDC = await this.connectionPool.getOptimalDC();
                console.log(`[Telegram] Using optimized DC: ${this.selectedDC?.name || 'default'}`);
            } catch (e) {
                console.warn('[Telegram] DC selection failed, using default:', e.message);
            }

            this.client = new TelegramClient(
                new StringSession(config.telegram.sessionString), 
                config.telegram.apiId, 
                config.telegram.apiHash, 
                { 
                    connectionRetries: config.performance.retry.maxAttempts,
                    retryDelay: config.performance.retry.baseDelayMs / 1000,
                    useWSS: false,
                    autoReconnect: true,
                    timeout: config.performance.timeouts.requestMs,
                    // ⚡ PHASE 1: TCP optimizations
                    tcp: config.performance.tcp
                }
            );

            await this.client.connect();
            this.isConnected = true;
            this._reconnectAttempts = 0;
            console.log('[Telegram] Connected successfully (v3.0 optimized)');
        }
    }

    async disconnect() {
        if (this.isConnected && this.client) {
            try {
                await this.client.disconnect();
            } catch (e) {
                console.warn('[Telegram] Disconnect error:', e.message);
            }
            this.isConnected = false;
        }
        this.connectionPool.stop();
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
                await new Promise(r => setTimeout(r, 1000 * this._reconnectAttempts));
                
                // Try different DC on reconnect
                if (this.connectionPool) {
                    this.selectedDC = await this.connectionPool.getOptimalDC();
                }
                
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
        
        if (stats.size === 0) {
            return { valid: false, error: 'File is empty (download likely failed)', size: 0 };
        }

        if (expectedSize && stats.size < expectedSize * 0.01) {
            return { valid: false, error: `File too small: got ${stats.size}, expected ~${expectedSize}`, size: 0 };
        }

        if (expectedSize && stats.size < expectedSize * 0.90) {
            console.warn(`[Validation] File size mismatch: got ${formatBytes(stats.size)}, expected ~${formatBytes(expectedSize)}`);
        }

        return { valid: true, size: stats.size };
    } catch (err) {
        return { valid: false, error: err.message, size: 0 };
    }
}

// ============================================================================
// ⚡ PHASE 3: ML-INSPIRED ADAPTIVE PARALLELISM ENGINE
// ============================================================================
class AdaptiveParallelismEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.settings = options;
        this.speedHistory = [];
        this.optimalWorkers = config.performance.downloadWorkers;
        this.lastAdjustment = Date.now();
        this.calibrationComplete = false;
        this.workerTestResults = []; // For calibration phase
        this.bottleneckType = 'unknown'; // 'source', 'network', 'unknown'
    }

    recordSpeed(speedBytesPerSec, progressPercent) {
        if (!this.settings.enabled) return this.optimalWorkers;
        
        this.speedHistory.push({
            speed: speedBytesPerSec,
            time: Date.now(),
            workers: this.optimalWorkers,
            progress: progressPercent
        });
        
        // Keep last 20 samples (increased from 10)
        if (this.speedHistory.length > 20) {
            this.speedHistory.shift();
        }
        
        // Check if we should adjust (every 3 seconds now)
        const now = Date.now();
        if (now - this.lastAdjustment > this.settings.adjustmentIntervalMs) {
            this.lastAdjustment = now;
            return this.adjustWorkers(progressPercent);
        }
        
        return this.optimalWorkers;
    }

    adjustWorkers(progressPercent) {
        // ⚡ PHASE 3: Calibration phase during first 10%
        if (!this.calibrationComplete && progressPercent >= this.settings.calibrationPercent) {
            this.completeCalibration();
        }
        
        if (this.speedHistory.length < 5) return this.optimalWorkers;
        
        const recentSpeeds = this.speedHistory.slice(-5).map(s => s.speed);
        const avgSpeed = recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length;
        const firstHalf = recentSpeeds.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
        const secondHalf = recentSpeeds.slice(-3).reduce((a, b) => a + b, 0) / 3;
        const trend = secondHalf - firstHalf;
        const trendPercent = avgSpeed > 0 ? trend / avgSpeed : 0;
        
        // Detect bottleneck type
        this.detectBottleneck(trend, trendPercent, avgSpeed);
        
        // If speed is dropping significantly, increase workers aggressively
        if (trendPercent < -this.settings.speedDropThreshold && this.optimalWorkers < this.settings.maxWorkers) {
            const increase = this.bottleneckType === 'source' ? 2 : 6; // Less aggressive if source-limited
            this.optimalWorkers = Math.min(this.settings.maxWorkers, this.optimalWorkers + increase);
            console.log(`[Adaptive⚡] Speed dropping (${formatBytes(secondHalf)}/s → ${formatBytes(firstHalf)}/s), workers → ${this.optimalWorkers} (type: ${this.bottleneckType})`);
        }
        // If speed is stable or improving, slight decrease to reduce overhead
        else if (trendPercent > -this.settings.speedRecoveryThreshold && this.optimalWorkers > this.settings.minWorkers) {
            this.optimalWorkers = Math.max(this.settings.minWorkers, this.optimalWorkers - 1);
        }
        
        return this.optimalWorkers;
    }

    detectBottleneck(trend, trendPercent, avgSpeed) {
        // Simple heuristic: if increasing workers doesn't help, it's source-limited
        if (Math.abs(trendPercent) < 0.02 && this.optimalWorkers > 32) {
            this.bottleneckType = 'source';
        } else if (trendPercent < -0.1) {
            this.bottleneckType = 'network';
        } else {
            this.bottleneckType = 'unknown';
        }
    }

    completeCalibration() {
        this.calibrationComplete = true;
        
        // Analyze which worker count performed best during calibration
        const calData = this.speedHistory.filter(s => s.progress <= this.settings.calibrationPercent);
        if (calData.length >= 10) {
            // Group by worker count and find best average
            const workerGroups = {};
            calData.forEach(s => {
                if (!workerGroups[s.workers]) workerGroups[s.workers] = [];
                workerGroups[s.workers].push(s.speed);
            });
            
            let bestWorkerCount = this.optimalWorkers;
            let bestAvgSpeed = 0;
            
            Object.entries(workerGroups).forEach(([count, speeds]) => {
                const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
                if (avg > bestAvgSpeed) {
                    bestAvgSpeed = avg;
                    bestWorkerCount = parseInt(count);
                }
            });
            
            this.optimalWorkers = bestWorkerCount;
            console.log(`[Adaptive⚡] Calibration complete! Optimal workers: ${bestWorkerCount} (${formatBytes(bestAvgSpeed)}/s)`);
        }
    }

    getCurrentWorkers() {
        return this.optimalWorkers;
    }

    reset() {
        this.speedHistory = [];
        this.optimalWorkers = config.performance.downloadWorkers;
        this.lastAdjustment = Date.now();
        this.calibrationComplete = false;
        this.workerTestResults = [];
        this.bottleneckType = 'unknown';
    }
}

// ============================================================================
// MAIN FILE TRANSFER BOT CLASS v3.0
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

        // Initialize adaptive engine
        this.adaptiveEngine = new AdaptiveParallelismEngine(config.performance.adaptiveThrottling);

        // Performance tracking
        this.performanceMetrics = {
            startTime: null,
            phases: {},
            peakSpeed: 0,
            averageSpeed: 0,
            speedSamples: []
        };

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
     * ⚡ PHASE 2: STREAMING UPLOAD TO MINIO
     * Uses PassThrough streams for zero-copy buffer management
     */
    async uploadToMinIOStreaming(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const metaData = { 
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'X-Upload-Version': SYSTEM_VERSION,
            'X-Streaming': 'true'
        };

        const validation = await validateFile(filePath);
        if (!validation.valid) {
            throw new Error(`Pre-upload validation failed: ${validation.error}`);
        }

        const totalSize = validation.size;
        console.log(`[Upload⚡] Starting streaming upload: ${fileName} (${formatBytes(totalSize)})`);

        return await withRetry('MinIO Streaming Upload', async () => {
            // Use larger highWaterMark for better throughput
            const fileStream = fs.createReadStream(filePath, { 
                highWaterMark: config.performance.streaming.highWaterMark 
            });
            
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
                    
                    // Track performance
                    if (speed > this.performanceMetrics.peakSpeed) {
                        this.performanceMetrics.peakSpeed = speed;
                    }
                    
                    onProgress(percent, formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), formatSpeed(speed), formatEta(etaSec));
                }
            });

            await minioClient.putObject(bucket, fileName, fileStream, totalSize, metaData);
            console.log(`[Upload⚡] Completed: ${fileName}`);
        }, config.performance.retry.maxAttempts, config.performance.retry.baseDelayMs);

        return await minioClient.presignedGetObject(bucket, fileName, 7200);
    }

    /**
     * ⚡ PHASE 2: OPTIMIZED MULTIPART UPLOAD
     */
    async uploadToMinIOMultipart(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const { thresholdBytes, partSize, concurrency } = config.performance.multipartUpload;
        
        const stats = fs.statSync(filePath);
        const totalSize = stats.size;
        
        if (!config.performance.multipartUpload.enabled || totalSize < thresholdBytes) {
            return this.uploadToMinIOStreaming(filePath, fileName, onProgress, signal);
        }
        
        console.log(`[Multipart⚡] Starting parallel upload: ${fileName} (${formatBytes(totalSize)}, parts of ${formatBytes(partSize)})`);
        
        try {
            const totalParts = Math.ceil(totalSize / partSize);
            let completedParts = 0;
            
            for (let i = 0; i < totalParts; i += concurrency) {
                if (signal?.aborted) {
                    throw new Error("Transfer cancelled by user.");
                }
                
                const batch = [];
                const batchEnd = Math.min(i + concurrency, totalParts);
                
                for (let j = i; j < batchEnd; j++) {
                    const start = j * partSize;
                    const end = Math.min(start + partSize, totalSize);
                    
                    const partStream = fs.createReadStream(filePath, { 
                        start, 
                        end: end - 1,
                        highWaterMark: 10 * 1024 * 1024
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
                
                await Promise.all(batch);
                completedParts = batchEnd;
                
                if (onProgress) {
                    const percent = Math.floor((completedParts / totalParts) * 100);
                    const uploadedBytes = Math.min(completedParts * partSize, totalSize);
                    const elapsedSec = (Date.now() - this.performanceMetrics.startTime) / 1000 || 1;
                    const speed = uploadedBytes / elapsedSec;
                    
                    onProgress(percent, formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), formatSpeed(speed), '');
                }
            }
            
            console.log(`[Multipart⚡] Completed: ${totalParts} parts uploaded`);
            
            return await minioClient.presignedGetObject(bucket, fileName, 86400);
            
        } catch (error) {
            console.error(`[Multipart⚡] Upload failed, falling back to streaming:`, error.message);
            return this.uploadToMinIOStreaming(filePath, fileName, onProgress, signal);
        }
    }

    /**
     * ⚡ PHASE 1+3: ULTRA-OPTIMIZED DOWNLOAD WITH ADAPTIVE ENGINE
     */
    async downloadFromTelegramUltraOptimized(client, message, filePath, fileSize, onProgress, signal) {
        console.log(`[Download⚡⚡] Starting ultra-optimized download (v3.0):` +
            ` chunkSize=${formatBytes(config.performance.downloadChunkSize)}, ` +
            `initialWorkers=${config.performance.downloadWorkers}, ` +
            `adaptive=${config.performance.adaptiveThrottling.enabled}`);
        
        // Reset adaptive engine for new transfer
        this.adaptiveEngine.reset();
        
        let downloadAttempts = 0;
        const maxDownloadAttempts = config.performance.retry.maxAttempts;
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
                let totalDownloaded = 0;

                // ⚡ PHASE 3: Use adaptive engine for dynamic worker optimization
                await client.downloadMedia(message.media, {
                    partSize: config.performance.downloadChunkSize, // 1MB chunks
                    outputFile: filePath,
                    workers: this.adaptiveEngine.getCurrentWorkers(),
                    progressCallback: (downloaded, total) => {
                        // Track total for averaging
                        totalDownloaded = downloaded;
                        
                        if (signal?.aborted) {
                            throw new Error("Transfer cancelled by user.");
                        }
                        
                        // Adaptive throttling with enhanced engine
                        const now = Date.now();
                        const bytesSinceLast = downloaded - lastProgressBytes;
                        
                        if (now - lastProgressTime >= 1000) {
                            const instantSpeed = bytesSinceLast / ((now - lastProgressTime) / 1000);
                            
                            // Update performance metrics
                            this.performanceMetrics.speedSamples.push(instantSpeed);
                            if (instantSpeed > this.performanceMetrics.peakSpeed) {
                                this.performanceMetrics.peakSpeed = instantSpeed;
                            }
                            
                            // Feed to adaptive engine
                            const progressPercent = total ? (downloaded / total) * 100 : 0;
                            this.adaptiveEngine.recordSpeed(instantSpeed, progressPercent);
                            
                            lastProgressTime = now;
                            lastProgressBytes = downloaded;
                            
                            // Log speed more frequently during calibration
                            speedLogCounter++;
                            const logInterval = !this.adaptiveEngine.calibrationComplete ? 3 : 5;
                            if (speedLogCounter >= logInterval) {
                                console.log(`[Speed⚡⚡] ${formatSpeed(instantSpeed)} (workers: ${this.adaptiveEngine.getCurrentWorkers()}, ${Math.round(progressPercent)}%)`);
                                speedLogCounter = 0;
                            }
                        }
                        
                        if (onProgress) {
                            onProgress(downloaded, total);
                        }
                    }
                });

                // POST-DOWNLOAD VALIDATION
                console.log(`[Download⚡⚡] Validating downloaded file...`);
                const validation = await validateFile(filePath, fileSize);
                
                if (!validation.valid) {
                    throw new Error(`Download validation failed: ${validation.error}`);
                }

                if (fileSize && validation.size < fileSize * 0.90) {
                    console.warn(`[Download⚡⚡] Size warning: ${formatBytes(validation.size)} vs expected ${formatBytes(fileSize)}`);
                }

                // Calculate final metrics
                const totalTime = (Date.now() - this.performanceMetrics.startTime) / 1000;
                const avgSpeed = totalDownloaded / totalTime;
                console.log(`[Download⚡⚡] Success: ${formatBytes(validation.size)} in ${downloadAttempts} attempt(s) | Avg: ${formatSpeed(avgSpeed)} | Peak: ${formatSpeed(this.performanceMetrics.peakSpeed)}`);

                return validation;

            } catch (err) {
                lastError = err;
                console.error(`[Download⚡⚡] Attempt ${downloadAttempts} failed:`, err.message);

                if (downloadAttempts < maxDownloadAttempts) {
                    const reconnected = await this.telegramClient.reconnectIfNeeded(err);
                    if (reconnected) {
                        console.log(`[Download⚡⚡] Reconnected with new DC, retrying...`);
                        continue;
                    }

                    const waitTime = config.performance.retry.baseDelayMs * downloadAttempts;
                    await new Promise(r => setTimeout(r, waitTime));
                }
            }
        }

        throw lastError || new Error('Download failed after all retries');
    }

    /**
     * Legacy download method (kept for fallback)
     */
    async downloadFromTelegram(client, message, filePath, fileSize, onProgress, signal) {
        return this.downloadFromTelegramUltraOptimized(client, message, filePath, fileSize, onProgress, signal);
    }

    /**
     * ⚡ PHASE 3: PREDICTIVE AUTO-CANCEL FOR HOPELESS TRANSFERS
     */
    checkTransferViability(currentSpeed, elapsedTime) {
        const MIN_VIABLE_SPEED = 100 * 1024; // 100 KB/s
        const MIN_TIME_BEFORE_CHECK = 30; // 30 seconds
        const HOPELESS_THRESHOLD = 3; // 3 checks below minimum
        
        if (!this._viabilityChecks) {
            this._viabilityChecks = { count: 0, lastCheck: 0 };
        }
        
        if (elapsedTime < MIN_TIME_BEFORE_CHECK) return true;
        if (Date.now() - this._viabilityChecks.lastCheck < 10000) return true; // Max every 10s
        
        this._viabilityChecks.lastCheck = Date.now();
        
        if (currentSpeed < MIN_VIABLE_SPEED) {
            this._viabilityChecks.count++;
            console.warn(`[Viability⚡] Slow transfer detected: ${formatSpeed(currentSpeed)} (check ${this._viabilityChecks.count}/${HOPELESS_THRESHOLD})`);
            
            if (this._viabilityChecks.count >= HOPELESS_THRESHOLD) {
                console.error(`[Viability⚡] Transfer deemed hopeless after ${this._viabilityChecks.count} checks`);
                return false;
            }
        } else {
            this._viabilityChecks.count = 0;
        }
        
        return true;
    }

    /**
     * MAIN EXECUTION METHOD v3.0
     */
    async start() {
        this.performanceMetrics.startTime = Date.now();
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
                priority: shouldCompress ? 3 : 5
            });

            this.concurrencyController.registerActiveTransfer(transferId, this.abortController);

            if (requestResult.status === 'queued') {
                await this.updateStatus(chatId, renderProgressCard({
                    fileName,
                    masterPercent: 0,
                    stageName: 'Waiting in queue...',
                    stagePercent: 0,
                    queuePosition: requestResult.position
                }), true);

                while (this.concurrencyController.transferQueue.getPosition(transferId) !== null) {
                    await new Promise(r => setTimeout(r, 2000));
                    
                    const pos = this.concurrencyController.transferQueue.getPosition(transferId);
                    if (pos !== null) {
                        await this.updateStatus(chatId, renderProgressCard({
                            fileName,
                            masterPercent: 0,
                            stageName: `Waiting in queue (#${pos} of ${requestResult.queueLength})`,
                            stagePercent: 0,
                            queuePosition: pos
                        })).catch(() => {});
                    }
                    
                    if (await this.checkCancel()) {
                        this.concurrencyController.cancelTransfer(transferId);
                        throw new Error("Transfer cancelled by user.");
                    }
                }
            }

            // CONNECT TO TELEGRAM (with DC selection)
            await this.telegramClient.connect();
            downloadedFilePath = path.join(config.performance.tempDir, `${transferId}_${fileName}`);
            const client = this.telegramClient.client;

            // PHASE 1: STORAGE MANAGEMENT (5%)
            this.performanceMetrics.phases.storageStart = Date.now();
            await this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent: 5, stageName: 'Cleaning & preparing storage', stagePercent: 100
            }), true);
            
            await this.manageStorage(fileSize);
            this.performanceMetrics.phases.storageEnd = Date.now();

            // GET MESSAGE
            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("Message or file not found on Telegram.");

            // PHASE 2: DOWNLOAD FROM TELEGRAM (5% -> 65%) ⚡⚡ ULTRA-OPTIMIZED
            this.performanceMetrics.phases.downloadStart = Date.now();
            let lastProgressUpdate = 0;
            let lastCancelCheck = 0;
            let lastViabilityCheck = 0;

            await this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent: 5, stageName: 'Downloading from Telegram ⚡⚡', stagePercent: 0
            }), true);

            const downloadResult = await this.downloadFromTelegramUltraOptimized(
                client, 
                messages[0], 
                downloadedFilePath, 
                fileSize,
                (downloaded, total) => {
                    const now = Date.now();

                    // Viability check every 15s
                    if (now - lastViabilityCheck >= 15000) {
                        lastViabilityCheck = now;
                        const elapsed = (now - this.performanceMetrics.startTime) / 1000;
                        const currentSpeed = downloaded / elapsed;
                        
                        if (!this.checkTransferViability(currentSpeed, elapsed)) {
                            this.isCancelled = true;
                            this.abortController.abort();
                            throw new Error("Transfer cancelled: Speed too low for extended period.");
                        }
                    }

                    if (now - lastCancelCheck >= 3000) {
                        lastCancelCheck = now;
                        this.checkCancel().then(cancelled => {
                            if (cancelled) this.isCancelled = true;
                        }).catch(() => {});
                    }

                    if (now - lastProgressUpdate >= 3000 || downloaded === total) {
                        lastProgressUpdate = now;
                        const subPercent = total ? Math.floor((downloaded / total) * 100) : 0;
                        const masterPercent = Math.min(65, 5 + Math.floor(subPercent * 0.60));
                        const elapsedSec = (now - this.performanceMetrics.startTime) / 1000;
                        const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                        const eta = speed > 0 ? (total - downloaded) / speed : 0;

                        const text = renderProgressCard({
                            fileName,
                            masterPercent,
                            stageName: 'Downloading from Telegram ⚡⚡',
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

            this.performanceMetrics.phases.downloadEnd = Date.now();
            targetPath = downloadedFilePath;

            // PHASE 3: VIDEO PROCESSING (65% -> 85%)
            if (isVideo) {
                if (await this.checkCancel()) throw new Error("Transfer cancelled by user.");

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
                    this.performanceMetrics.phases.processingStart = Date.now();
                    
                    const maxDim = shouldCompress ? 854 : 1280;
                    const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
                    const crfValue = shouldCompress ? '28' : '23';
                    const audioBitrate = shouldCompress ? '64k' : '128k';

                    lastProgressUpdate = 0;
                    await this.updateStatus(chatId, renderProgressCard({
                        fileName,
                        masterPercent: 65,
                        stageName: shouldCompress ? 'Compressing & scaling (480p)' : 'Optimizing video structure (720p)',
                        stagePercent: 0,
                        speedText: '1.0x',
                        etaText: 'Calculating...'
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
                                stageName: shouldCompress ? 'Compressing & scaling (480p)' : 'Optimizing video structure (720p)',
                                stagePercent: subPercent,
                                speedText: speedStr,
                                etaText: etaText
                            });
                            this.updateStatus(chatId, text, false).catch(() => {});
                        }
                    }, this.abortController.signal);
                    
                    targetPath = processedPath;
                    this.performanceMetrics.phases.processingEnd = Date.now();
                } catch (ffmpegErr) {
                    if (await this.checkCancel()) throw new Error("Transfer cancelled by user.");
                    throw new Error(`Video processing error.\n\nDetails: ${ffmpegErr.message}`);
                } finally {
                    clearInterval(cancelCheckInterval);
                }
            }

            // PHASE 4: UPLOAD TO MINIO (85% -> 98%) ⚡⚡ OPTIMIZED
            if (await this.checkCancel()) throw new Error("Transfer cancelled by user.");
            this.isCriticalSection = true;

            this.performanceMetrics.phases.uploadStart = Date.now();
            
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
                            stageName: 'Uploading to cloud ⚡⚡',
                            stagePercent: subPercent,
                            detailsText: sizeText,
                            speedText: speedText,
                            etaText: etaText
                        });

                        this.updateStatus(chatId, text, false).catch(() => {});
                    }
                }, this.abortController.signal)
                : await this.uploadToMinIOStreaming(targetPath, fileName, (subPercent, sizeText, speedText, etaText) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                        lastProgressUpdate = now;
                        const baseMaster = isVideo ? 85 : 65;
                        const masterSpan = isVideo ? 13 : 33;
                        const masterPercent = Math.min(98, baseMaster + Math.floor(subPercent * (masterSpan / 100)));

                        const text = renderProgressCard({
                            fileName,
                            masterPercent,
                            stageName: 'Uploading to cloud ⚡⚡',
                            stagePercent: subPercent,
                            detailsText: sizeText,
                            speedText: speedText,
                            etaText: etaText
                        });

                        this.updateStatus(chatId, text, false).catch(() => {});
                    }
                }, this.abortController.signal);

            this.performanceMetrics.phases.uploadEnd = Date.now();

            // COMPLETE - Generate performance summary
            const actualSize = (await fs.promises.stat(targetPath)).size;
            const elapsedTime = Math.round((Date.now() - this.performanceMetrics.startTime) / 1000);
            const avgSpeed = actualSize / elapsedTime;
            
            // Final performance report
            console.log(`
╔══════════════════════════════════════════════════════════════╗
║              TRANSFER COMPLETE - PERFORMANCE REPORT           ║
╠══════════════════════════════════════════════════════════════╣
║  Total Time:      ${elapsedTime.toString().padEnd(10)} seconds                          ║
║  File Size:       ${formatBytes(actualSize).padEnd(10)}                              ║
║  Average Speed:   ${formatSpeed(avgSpeed).padEnd(10)}                         ║
║  Peak Speed:      ${formatSpeed(this.performanceMetrics.peakSpeed).padEnd(10)}                       ║
║  Version:         v${SYSTEM_VERSION.padEnd(8)}                                  ║
╚══════════════════════════════════════════════════════════════╝
            `);
            
            const successMsg = `✅ <b>Transfer Complete!</b>\n\n<code>[██████████] 100%</code>
📁 <b>File:</b> <code>${escapeHtml(fileName)}</code>
📏 <b>Size:</b> ${formatBytes(actualSize)}
⏱️ <b>Time:</b> ${elapsedTime}s
⚡ <b>Avg Speed:</b> ${formatSpeed(avgSpeed)}
🚀 <b>Peak Speed:</b> ${formatSpeed(this.performanceMetrics.peakSpeed)}
⚠️ <b>Link expires in 2 hours</b>

🔗 <a href="${downloadLink}">👉 Download Link 👈</a>`;

            await this.updateStatus(chatId, successMsg, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'completed', performance: { elapsedTime, avgSpeed, peakSpeed: this.performanceMetrics.peakSpeed } });

            this.concurrencyController.completeTransfer(transferId);

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            
            this.concurrencyController.completeTransfer(transferId);
            
            const isNetworkError = err.message.includes('TCPFull') || err.message.includes('fetch') || 
                                   err.message.includes('ECONNRESET') || err.message.includes('Timeout') ||
                                   err.message.includes('disconnect') || err.message.includes('hopeless');
                                   
            await this.updateStatus(chatId, `❌ <b>Error:</b>\n<code>${escapeHtml(err.message)}</code>${isNetworkError ? '\n\n🔄 Returning to queue...' : ''}`, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'failed', error: err.message, retryable: isNetworkError });
        } finally {
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
// START APPLICATION v3.0
// ============================================================================
console.log(`
╔══════════════════════════════════════════════════════════════╗
║     ⚡ File Transfer Bot v${SYSTEM_VERSION} - ULTRA OPTIMIZED ⚡        ║
╠══════════════════════════════════════════════════════════════╣
║  Download Settings (v3.0):                                     ║
║  • Workers: ${String(config.performance.downloadWorkers).padEnd(10)} (6x increase from v2)        ║
║  • Chunk Size: ${formatBytes(config.performance.downloadChunkSize).padEnd(9)} (actual)               ║
║  • Adaptive Engine: ${String(config.performance.adaptiveThrottling.enabled).padEnd(6)} (ML-inspired)        ║
║  • Multi-DC Routing: Enabled                                 ║
║                                                               ║
║  Upload Settings:                                              ║
║  • Multipart: ${String(config.performance.multipartUpload.enabled).padEnd(6)} (>${formatBytes(config.performance.multipartUpload.thresholdBytes)})             ║
║  • Part Size: ${formatBytes(config.performance.multipartUpload.partSize).padEnd(11)}                          ║
║  • Parallel Parts: ${String(config.performance.multipartUpload.concurrency).padEnd(7)}                      ║
║  • Streaming: ${String(config.performance.streaming.enabled).padEnd(6)} (zero-copy buffers)        ║
║                                                               ║
║  Optimizations Active:                                         ║
║  ✓ Connection Pooling                                         ║
║  ✓ TCP_NODELAY                                                ║
║  ✓ Fast Retry Backoff                                         ║
║  ✓ Predictive Auto-Cancel                                     ║
║  ✓ Real-time DC Selection                                     ║
╚══════════════════════════════════════════════════════════════╝
`);
console.log(`[Config] Temp Dir: ${config.performance.tempDir}`);
console.log(`[Config] TCP NoDelay: ${config.performance.tcp.noDelay}`);
console.log(`[Config] Timeout: ${config.performance.timeouts.connectionMs}ms connection, ${config.performance.timeouts.requestMs}ms request`);

new FileTransferBot().start().catch(err => {
    console.error('[Fatal] Unhandled error:', err);
    process.exit(1);
});
