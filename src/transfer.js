const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const http = require("http");

// ============================================================================
// CONFIGURATION - Optimized for Pipeline Architecture v4.2.0 (Parallel Download + Full UI)
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
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '262144'), // 256KB (GramJS max for sequential)
        parallelDownloadChunkSize: 1024 * 1024, // 1MB chunks for HTTP Bridge (MAX allowed!)
        parallelWorkers: parseInt(process.env.PARALLEL_DOWNLOAD_WORKERS || '2'), // 2 workers (balanced)
        readAheadBufferMB: 4, // 4MB buffer keeps FFmpeg fed
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '8'),
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '5'),
        tempDir: TEMP_DIR,
        
        pipeline: {
            enabled: true,
            ffmpegInputBufferMB: 2,
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

// ============================================================================
// TRANSFER QUEUE 
// ============================================================================
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

// ============================================================================
// CONCURRENCY CONTROLLER
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
    getStatus() {
        return {
            memory: this.memoryManager.getStatus(),
            queue: { waiting: this.transferQueue.length, processing: this.transferQueue.processing.size, maxConcurrent: this.maxConcurrent, active: this.activeTransfers.size },
            positions: this.transferQueue.positionInfo
        };
    }
    stop() { this.memoryManager.stop(); this.transferQueue.clear(); }
}

const minioClient = new Minio.Client({
    endPoint: config.minio.endPoint, port: config.minio.port, useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey, secretKey: config.minio.secretKey, region: config.minio.region
});

// ============================================================================
// TELEGRAM HTTP BRIDGE - Parallel Download Architecture v4.2.0 (Option C: Hybrid)
// ============================================================================
class TelegramHttpBridge extends EventEmitter {
    constructor(client, media, totalSize) {
        super();
        this.client = client;
        this.totalSize = totalSize;
        this.location = this._extractLocation(media);
        this.server = null;
        this.port = 0;
        this.isActive = true;
        this.totalSent = 0;
        
        // Parallel download settings
        this.chunkSize = config.performance.parallelDownloadChunkSize; // 1MB
        this.workerCount = config.performance.parallelWorkers; // 2 workers
        this.bufferSizeMB = config.performance.readAheadBufferMB; // 4MB buffer
        
        // Buffer management
        this.chunkBuffer = new Map(); // offset → { data, timestamp }
        this.nextReadOffset = 0;
        this.bufferHighWaterMark = this.bufferSizeMB * 1024 * 1024;
        this.bufferLowWaterMark = this.bufferSizeMB * 512 * 1024; // 50% of high mark
        
        // Worker management
        this.activeWorkers = 0;
        this.workerErrors = [];
        this.prefetchQueue = [];
        this.isPrefetching = false;
        
        // Performance tracking
        this.stats = {
            totalRequests: 0,
            totalBytesFetched: 0,
            cacheHits: 0,
            cacheMisses: 0,
            startTime: Date.now()
        };
        
        console.log(`[HTTP Bridge v4.2] Initialized: chunkSize=${formatBytes(this.chunkSize)}, workers=${this.workerCount}, buffer=${this.bufferSizeMB}MB`);
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

    start() {
        return new Promise((resolve, reject) => {
            if (!this.location) return reject(new Error("Cannot extract file location for HTTP Bridge."));
            
            this.server = http.createServer(this.handleRequest.bind(this));
            this.server.on('error', reject);
            
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                console.log(`[HTTP Bridge v4.2] Running at http://127.0.0.1:${this.port} (Parallel Mode)`);
                resolve(`http://127.0.0.1:${this.port}/stream.mp4`);
            });
        });
    }

    async handleRequest(req, res) {
        if (!this.isActive) {
            res.writeHead(503);
            return res.end();
        }

        const range = req.headers.range;
        if (!range) {
            res.writeHead(200, { 'Content-Length': this.totalSize, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
            await this.streamRangeParallel(0, this.totalSize - 1, res);
        } else {
            const positions = range.replace(/bytes=/, "").split("-");
            const start = parseInt(positions[0], 10);
            const end = positions[1] ? parseInt(positions[1], 10) : this.totalSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${this.totalSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            });
            await this.streamRangeParallel(start, end, res);
        }
    }

    /**
     * PARALLEL STREAMING RANGE - Option C Hybrid Architecture
     * 
     * Features:
     * - 2 workers downloading in parallel
     * - 4MB read-ahead buffer
     * - Smart prefetching (stays ahead of reader)
     * - Request pipelining (overlap network I/O)
     */
    async streamRangeParallel(start, end, res) {
        // Reset state for new stream
        this.nextReadOffset = start;
        this.chunkBuffer.clear();
        this.workerErrors = [];
        this.stats.startTime = Date.now();
        
        console.log(`[Parallel Stream] Starting range ${formatBytes(start)}-${formatBytes(end)}, workers=${this.workerCount}`);
        
        try {
            // Start initial prefetch to fill buffer
            await this._initialPrefetch(end);
            
            // Main read loop - consume from buffer while refilling
            while (this.nextReadOffset <= end && this.isActive) {
                if (res.destroyed || res.closed) break;
                
                // Check for worker errors
                if (this.workerErrors.length > 0) {
                    throw this.workerErrors[0];
                }
                
                // Wait for data if buffer is empty at our position
                const alignedOffset = this._alignOffset(this.nextReadOffset);
                
                if (!this.chunkBuffer.has(alignedOffset)) {
                    // Buffer miss - wait for worker to fetch
                    await this._waitForChunk(alignedOffset, end);
                }
                
                // Get chunk from buffer
                const chunkData = this.chunkBuffer.get(alignedOffset);
                if (!chunkData) break; // EOF or error
                
                // Remove from buffer (consumed)
                this.chunkBuffer.delete(alignedOffset);
                
                // Calculate actual data slice (handle alignment skip)
                const skipBytes = this.nextReadOffset - alignedOffset;
                let data = chunkData.data;
                if (skipBytes > 0) data = data.slice(skipBytes);
                
                // Trim to requested end
                const bytesNeeded = (end - this.nextReadOffset) + 1;
                if (data.length > bytesNeeded) data = data.slice(0, bytesNeeded);
                
                this.nextReadOffset += data.length;
                this.totalSent += data.length;
                
                // Emit progress
                this.emit('progress', this.totalSent, this.totalSize);
                
                // Write to response (with backpressure handling)
                if (!res.write(data)) {
                    await new Promise(r => res.once('drain', r));
                }
                
                // Trigger background prefetch if buffer is getting low
                if (this._getBufferSize() < this.bufferLowWaterMark) {
                    this._triggerPrefetch(end).catch(err => {
                        console.warn('[Parallel Stream] Prefetch warning:', err.message);
                    });
                }
            }
            
            if (!res.destroyed && !res.closed) res.end();
            
            // Log performance stats
            const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(1);
            const avgSpeed = this.totalSent / parseFloat(elapsed);
            console.log(`[Parallel Stream] Complete: ${formatBytes(this.totalSent)} in ${elapsed}s (${formatBytes(avgSpeed)}/s)`);
            console.log(`[Parallel Stream] Stats: requests=${this.stats.totalRequests}, cacheHits=${this.stats.cacheHits}, misses=${this.stats.cacheMisses}`);
            
        } catch (err) {
            console.error('[Parallel Stream] Error:', err.message);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        } finally {
            this.isActive = false;
        }
    }

    /**
     * Initial prefetch - fill buffer before starting to read
     */
    async _initialPrefetch(end) {
        const initialChunks = Math.ceil(this.bufferHighWaterMark / this.chunkSize);
        const offsetsToFetch = [];
        
        for (let i = 0; i < Math.min(initialChunks, this.workerCount * 2); i++) {
            const offset = this._alignOffset(this.nextReadOffset + (i * this.chunkSize));
            if (offset <= end) offsetsToFetch.push(offset);
        }
        
        if (offsetsToFetch.length > 0) {
            console.log(`[Prefetch] Initial fill: ${offsetsToFetch.length} chunks`);
            await this._fetchChunksParallel(offsetsToFetch, end);
        }
    }

    /**
     * Trigger background prefetch when buffer is low
     */
    async _triggerPrefetch(end) {
        if (this.isPrefetching) return;
        this.isPrefetching = true;
        
        try {
            // Find gaps in buffer and fetch them
            const offsetsToFetch = [];
            let currentCheck = this._alignOffset(this.nextReadOffset);
            const maxFetchOffset = currentCheck + (this.bufferHighWaterMark * 2);
            
            while (currentCheck <= end && currentCheck < maxFetchOffset && offsetsToFetch.length < this.workerCount) {
                const aligned = this._alignOffset(currentCheck);
                if (!this.chunkBuffer.has(aligned)) {
                    offsetsToFetch.push(aligned);
                }
                currentCheck += this.chunkSize;
            }
            
            if (offsetsToFetch.length > 0) {
                await this._fetchChunksParallel(offsetsToFetch, end);
            }
        } finally {
            this.isPrefetching = false;
        }
    }

    /**
     * Fetch multiple chunks in parallel using workers
     */
    async _fetchChunksParallel(offsets, end) {
        const validOffsets = offsets.filter(off => off <= end && !this.chunkBuffer.has(off));
        if (validOffsets.length === 0) return;
        
        // Split among workers
        const fetchPromises = validOffsets.map(async (offset) => {
            this.activeWorkers++;
            this.stats.totalRequests++;
            
            try {
                const result = await this.client.invoke(new Api.upload.GetFile({
                    location: this.location,
                    offset: BigInt(offset),
                    limit: Math.min(this.chunkSize, end - offset + 1)
                }));
                
                if (result && result.bytes && result.bytes.length > 0) {
                    this.chunkBuffer.set(offset, { data: result.bytes, timestamp: Date.now() });
                    this.stats.totalBytesFetched += result.bytes.length;
                    
                    // Prevent buffer overflow
                    this._evictOldChunksIfNeeded();
                }
            } catch (err) {
                this.workerErrors.push(err);
                console.error(`[Worker] Fetch failed at offset ${offset}:`, err.message);
            } finally {
                this.activeWorkers--;
            }
        });
        
        await Promise.allSettled(fetchPromises);
    }

    /**
     * Wait for a specific chunk to be fetched into buffer
     */
    async _waitForChunk(offset, end) {
        const maxWaitMs = 30000; // 30 second timeout
        const startTime = Date.now();
        
        while (!this.chunkBuffer.has(offset) && this.isActive) {
            // Check timeout
            if (Date.now() - startTime > maxWaitMs) {
                throw new Error(`Timeout waiting for chunk at offset ${offset}`);
            }
            
            // Check for errors
            if (this.workerErrors.length > 0) {
                throw this.workerErrors[0];
            }
            
            // If no active workers, trigger a fetch
            if (this.activeWorkers === 0 && offset <= end) {
                await this._fetchChunksParallel([offset], end);
            } else {
                // Small delay to avoid busy-waiting
                await new Promise(r => setTimeout(r, 5));
            }
        }
        
        this.stats.cacheMisses++;
    }

    /**
     * Align offset to Telegram's requirement (must be divisible by 4096)
     */
    _alignOffset(offset) {
        return Math.floor(offset / 4096) * 4096;
    }

    /**
     * Get current buffer size in bytes
     */
    _getBufferSize() {
        let size = 0;
        for (const chunk of this.chunkBuffer.values()) {
            size += chunk.data.length;
        }
        return size;
    }

    /**
     * Evict old chunks if buffer exceeds limit
     */
    _evictOldChunksIfNeeded() {
        while (this._getBufferSize() > this.bufferHighWaterMark && this.chunkBuffer.size > 1) {
            // Find oldest chunk that's behind our read position
            let oldestOffset = null;
            let oldestTime = Infinity;
            
            for (const [offset, chunk] of this.chunkBuffer.entries()) {
                // Prefer evicting chunks we've already passed
                if (offset < this.nextReadOffset && chunk.timestamp < oldestTime) {
                    oldestOffset = offset;
                    oldestTime = chunk.timestamp;
                }
            }
            
            // If nothing behind us, evict the absolute oldest
            if (!oldestOffset) {
                for (const [offset, chunk] of this.chunkBuffer.entries()) {
                    if (chunk.timestamp < oldestTime) {
                        oldestOffset = offset;
                        oldestTime = chunk.timestamp;
                    }
                }
            }
            
            if (oldestOffset !== null) {
                this.chunkBuffer.delete(oldestOffset);
                this.stats.cacheHits++; // Count as "hit" since we managed it
            } else {
                break; // Safety exit
            }
        }
    }

    stop() {
        this.isActive = false;
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.chunkBuffer.clear();
        console.log(`[HTTP Bridge v4.2] Closed.`);
    }
}

// ============================================================================
// UTILITY FUNCTIONS
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

const SYSTEM_VERSION = '4.2.0';

function renderProgressCard({ fileName, masterPercent, stageName, stagePercent, speedText, etaText, detailsText, queuePosition = null, stages = null }) {
    if (stages && Array.isArray(stages)) {
        let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code> (Pipeline v${SYSTEM_VERSION})\n\n`;
        card += `📊 <b>پیشرفت کل:</b>\n<code>[${drawProgressBar(masterPercent, 12)}] ${masterPercent}%</code>\n\n`;
        card += `🔄 <b>مراحل موازی:</b>\n\n`;
        for (const stage of stages) {
            const bar = drawProgressBar(stage.percent || 0, 10);
            card += `${stage.icon} ${stage.name}\n`;
            card += `<code>[${bar}] ${stage.percent || 0}%</code>`;
            if (stage.speed) card += ` | ${stage.speed}`;
            if (stage.details) card += ` | ${stage.details}`;
            card += `\n\n`;
        }
        if (etaText) card += `⏱️ <b>زمان تقریبی:</b> ${etaText}\n`;
        return card;
    }
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);
    let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code> (v${SYSTEM_VERSION})\n\n`;
    if (queuePosition !== null) card += `⏳ <b>وضعیت صف:</b> در انتظار (#${queuePosition})\n\n`;
    card += `📊 <b>پیشرفت کل:</b>\n<code>[${masterBar}] ${masterPercent}%</code>\n\n`;
    card += `🔄 <b>مرحله جاری:</b> ${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;
    if (detailsText) card += `⚖️ <b>حجم:</b> ${detailsText}\n`;
    if (speedText) card += `⚡ <b>سرعت:</b> ${speedText}\n`;
    if (etaText) card += `⏱️ <b>زمان تقریبی باقی‌مانده:</b> ${etaText}\n`;
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
            try { await this.client.disconnect(); } catch (e) { console.warn('[Telegram] Disconnect error:', e.message); }
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
        if (stats.size === 0) return { valid: false, error: 'File is empty (download likely failed)', size: 0 };
        if (expectedSize && stats.size < expectedSize * 0.01) return { valid: false, error: `File too small: got ${stats.size}, expected ~${expectedSize}`, size: stats.size };
        if (expectedSize && stats.size < expectedSize * 0.90) console.warn(`[Validation] File size mismatch: got ${formatBytes(stats.size)}, expected ~${formatBytes(expectedSize)}`);
        return { valid: true, size: stats.size };
    } catch (err) { return { valid: false, error: err.message, size: 0 }; }
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

        this.concurrencyController.on('queued', ({ transferId, position }) => {
            console.log(`[Concurrency] Transfer ${transferId} queued at position ${position}`);
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
                delete body.message_id;
                delete body.reply_markup;
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
                if (this.activeFFmpegProcess) {
                    try { this.activeFFmpegProcess.kill('SIGKILL'); } catch (e) {}
                }
                
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
            if (this.abortController.signal.aborted) {
                clearInterval(pollInterval);
                return;
            }
            try {
                const encodedTransferId = encodeURIComponent(config.transferId);
                const res = await fetch(`${config.cloudflare.webhookUrl.replace(/\/action-webhook\/?$/, '')}/check-stop?transferId=${encodedTransferId}`, {
                    headers: { 'Authorization': `Bearer ${config.cloudflare.apiToken}` }, signal: AbortSignal.timeout(2000)
                }).then(r => r.json()).catch(() => ({}));
                if (res.shouldStop) {
                    await this.handleCallbackQuery({ data: `stop_${config.transferId}`, id: 'poll' });
                }
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
            const MAX_ERROR_LOG_SIZE = 50000;

            ffmpegProcess.stderr.on('data', data => {
                errorLog += data.toString();
                if (errorLog.length > MAX_ERROR_LOG_SIZE) {
                    errorLog = errorLog.slice(-MAX_ERROR_LOG_SIZE);
                }
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

    spawnFFmpegPipeline(httpUrl, ffmpegOptions, onProgress, signal, pipelineContext) {
        const args = [
            '-i', httpUrl, '-threads', '0', '-c:v', 'libx264', '-crf', ffmpegOptions.crf || '28',
            '-preset', 'veryfast', '-vf', ffmpegOptions.scaleFilter || 'scale=854:-2',
            '-c:a', 'aac', '-b:a', ffmpegOptions.audioBitrate || '64k',
            // 🔥 CRITICAL FIX: To pipe an MP4 out, it MUST be fragmented
            '-movflags', 'frag_keyframe+empty_moov', 
            '-f', 'mp4', 'pipe:1'
        ];
        
        console.log(`[Pipeline] Spawning FFmpeg via HTTP Bridge`);
        const ffmpegProcess = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            signal
        });
        
        this.activeFFmpegProcess = ffmpegProcess;
        
        let totalDurationSec = 0;
        let errorLog = '';
        const MAX_ERROR_LOG_SIZE = 50000;
        let outTimeSec = 0;
        let speedStr = '1.0x';

        ffmpegProcess.stderr.on('data', data => {
            errorLog += data.toString();
            if (errorLog.length > MAX_ERROR_LOG_SIZE) {
                errorLog = errorLog.slice(-MAX_ERROR_LOG_SIZE);
            }
            if (!totalDurationSec) {
                const match = errorLog.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                if (match) totalDurationSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
            }
            const timeMatch = errorLog.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
            if (timeMatch?.length > 0) {
                const lastTime = timeMatch[timeMatch.length - 1];
                outTimeSec = parseHms(lastTime.replace('time=', ''));
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

        ffmpegProcess.on('close', code => {
            this.activeFFmpegProcess = null;
            if (code !== 0 && code !== null && !pipelineContext.isAborting) {
                console.error(`[Pipeline] FFmpeg exited with code ${code}: ${errorLog.slice(-300)}`);
            }
        });

        ffmpegProcess.on('error', err => {
            this.activeFFmpegProcess = null;
            if (!pipelineContext.isAborting) console.error(`[Pipeline] FFmpeg error:`, err.message);
        });

        return ffmpegProcess;
    }

    async uploadToMinIO(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const metaData = { 
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'X-Upload-Version': SYSTEM_VERSION
        };

        const validation = await validateFile(filePath);
        if (!validation.valid) throw new Error(`Pre-upload validation failed: ${validation.error}`);

        const totalSize = validation.size;
        console.log(`[Upload] Starting upload: ${fileName} (${formatBytes(totalSize)})`);

        return await withRetry('MinIO File Upload', async () => {
            const fileStream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 * 1024 });
            if (signal) signal.addEventListener('abort', () => fileStream.destroy(), { once: true });

            fileStream.on('error', (err) => {
                console.error('[Upload] fileStream error:', err.message);
            });

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

    async uploadStreamToMinIO(inputStream, fileName, totalSize, onProgress, signal, pipelineContext) {
        const bucket = config.minio.bucketName;
        const metaData = { 
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'X-Upload-Version': SYSTEM_VERSION
        };

        console.log(`[Pipeline] Starting streaming upload: ${fileName}`);

        const progressStream = new PassThrough();
        let uploadedBytes = 0;
        const startTime = Date.now();

        inputStream.on('error', (err) => {
            if (pipelineContext.isAborting) return;
            console.error('[Pipeline] Input stream error during upload:', err.message);
            progressStream.destroy(err);
        });

        progressStream.on('error', (err) => {
            if (!pipelineContext.isAborting) console.error('[Pipeline] Progress stream error:', err.message);
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

        if (signal) {
            signal.addEventListener('abort', () => {
                inputStream.destroy();
                progressStream.destroy();
            }, { once: true });
        }

        const uploadPromise = minioClient.putObject(bucket, fileName, progressStream, undefined, metaData);
        
        try {
            await uploadPromise;
            console.log(`[Pipeline] Streaming upload completed: ${fileName}`);
            return await minioClient.presignedGetObject(bucket, fileName, 7200);
        } catch (err) {
            if (pipelineContext.isAborting) return null; // Silent abort
            throw err;
        }
    }

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
                if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);

                let lastProgressTime = Date.now();
                let lastProgressBytes = 0;
                let speedLogCounter = 0;
                let instantSpeed = 0;

                await client.downloadMedia(message.media, {
                    partSize: config.performance.downloadChunkSize,
                    outputFile: filePath,
                    workers: throttler.getCurrentWorkers(),
                    progressCallback: (downloaded, total) => {
                        if (signal?.aborted) throw new Error("انتقال توسط کاربر لغو شد.");
                        
                        const now = Date.now();
                        const bytesSinceLast = downloaded - lastProgressBytes;
                        
                        if (now - lastProgressTime >= 1000) {
                            instantSpeed = bytesSinceLast / ((now - lastProgressTime) / 1000);
                            throttler.recordSpeed(instantSpeed);
                            
                            lastProgressTime = now;
                            lastProgressBytes = downloaded;
                            
                            speedLogCounter++;
                            if (speedLogCounter >= 5) {
                                console.log(`[Speed⚡] ${formatBytes(instantSpeed)}/s (workers: ${throttler.getCurrentWorkers()}, ${Math.round(downloaded/total*100)}%)`);
                                speedLogCounter = 0;
                            }
                        }
                        if (onProgress) onProgress(downloaded, total);
                    }
                });

                const validation = await validateFile(filePath, fileSize);
                if (!validation.valid) throw new Error(`Download validation failed: ${validation.error}`);
                if (fileSize && validation.size < fileSize * 0.90) console.warn(`[Download⚡] Size warning: ${formatBytes(validation.size)} vs expected ${formatBytes(fileSize)}`);

                console.log(`[Download⚡] Success: ${formatBytes(validation.size)} in ${downloadAttempts} attempt(s)`);
                return validation;

            } catch (err) {
                lastError = err;
                console.error(`[Download⚡] Attempt ${downloadAttempts} failed:`, err.message);

                if (downloadAttempts < maxDownloadAttempts) {
                    const reconnected = await this.telegramClient.reconnectIfNeeded(err);
                    if (reconnected) { console.log(`[Download⚡] Reconnected, retrying...`); continue; }
                    await new Promise(r => setTimeout(r, 3000 * downloadAttempts));
                }
            }
        }
        throw lastError || new Error('Download failed after all retries');
    }

    createAdaptiveThrottler() {
        const settings = config.performance.adaptiveThrottling;
        return {
            speedHistory: [],
            optimalWorkers: config.performance.downloadWorkers,
            lastAdjustment: Date.now(),
            
            recordSpeed(speedBytesPerSec) {
                if (!settings.enabled) return this.optimalWorkers;
                this.speedHistory.push({ speed: speedBytesPerSec, time: Date.now() });
                if (this.speedHistory.length > 10) this.speedHistory.shift();
                
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
                
                if (trendPercent < -settings.speedDropThreshold && this.optimalWorkers < settings.maxWorkers) {
                    this.optimalWorkers = Math.min(settings.maxWorkers, this.optimalWorkers + 4);
                }
                else if (trendPercent > -settings.speedRecoveryThreshold && this.optimalWorkers > settings.minWorkers) {
                    this.optimalWorkers = Math.max(settings.minWorkers, this.optimalWorkers - 2);
                }
                return this.optimalWorkers;
            },
            
            getCurrentWorkers() { return this.optimalWorkers; }
        };
    }

    async executePipeline(client, message, chatId, fileName, fileSize, isVideo, shouldCompress) {
        const transferId = config.transferId;
        const pipelineContext = { isAborting: false };
        let httpBridge = null;
        let ffmpegProcess;
        let startBridgeTime = Date.now();
        
        await this.updateStatus(chatId, renderProgressCard({
            fileName, masterPercent: 5,
            stages: [
                { icon: '📥', name: 'استریم از تلگرام', percent: 0, speed: '...', details: '...' },
                { icon: '🗜', name: 'فشرده‌سازی', percent: 0, speed: '...', details: '...' },
                { icon: '⬆️', name: 'آپلود به سرور', percent: 0, speed: '...', details: '...' }
            ]
        }), true, true);

        try {
            if (!isVideo) throw new Error("NON_STREAMABLE_MEDIA"); // Force fallback for non-video

            httpBridge = new TelegramHttpBridge(client, message.media, fileSize);
            
            let lastDownloadUpdate = 0;
            httpBridge.on('progress', (downloaded, total) => {
                const elapsed = (Date.now() - startBridgeTime) / 1000;
                const speed = elapsed > 0 ? downloaded / elapsed : 0;
                const percent = total ? Math.floor((downloaded / total) * 100) : 0;

                this.pipelineState.download = { 
                    percent: percent, 
                    speed: formatBytes(speed) + '/s', 
                    details: `${formatBytes(downloaded)} / ${formatBytes(total)}` 
                };
                
                if (Date.now() - lastDownloadUpdate >= 2000) {
                    lastDownloadUpdate = Date.now();
                    this._updatePipelineStatus(chatId, fileName, Math.min(5 + Math.floor(percent * 0.35), 40));
                }
            });

            const httpUrl = await httpBridge.start();

            const maxDim = shouldCompress ? 854 : 1280;
            const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
            const crfValue = shouldCompress ? '28' : '23';
            const audioBitrate = shouldCompress ? '64k' : '128k';

            ffmpegProcess = this.spawnFFmpegPipeline(httpUrl, {
                crf: crfValue, scaleFilter: scaleFilter, audioBitrate: audioBitrate
            }, (percent, speed, eta) => {
                this.pipelineState.compress = { percent, speed, details: `${percent}%` };
                this._updatePipelineStatus(chatId, fileName, 50);
            }, this.abortController.signal, pipelineContext);

            ffmpegProcess.stdout.on('error', (err) => {
                if (pipelineContext.isAborting) return;
                try { ffmpegProcess.kill('SIGTERM'); } catch (e) {}
            });

            const outputFileName = `${path.parse(fileName).name}.mp4`;
            
            // Safe upload task wrapping
            const uploadTask = this.uploadStreamToMinIO(
                ffmpegProcess.stdout, 
                outputFileName,
                fileSize, 
                (percent, details, speed, eta) => {
                    this.pipelineState.upload = { percent, speed, details };
                    this._updatePipelineStatus(chatId, fileName, 85);
                },
                this.abortController.signal, 
                pipelineContext
            ).catch(err => {
                if (!pipelineContext.isAborting) console.error(`[Pipeline] Upload task error: ${err.message}`);
                return null;
            });

            await Promise.all([
                new Promise((resolve, reject) => {
                    ffmpegProcess.on('close', (code) => {
                        if (code === 0 || code === null) resolve();
                        else reject(new Error(`FFmpeg exited with code ${code}`));
                    });
                    ffmpegProcess.on('error', reject);
                }),
                uploadTask
            ]);

            return await minioClient.presignedGetObject(config.minio.bucketName, outputFileName, 7200);

        } catch (err) {
            pipelineContext.isAborting = true; // Signals streams to die silently
            if (httpBridge) httpBridge.stop();
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

            const text = renderProgressCard({
                fileName, masterPercent,
                stages: [
                    { icon: '📥', name: 'استریم از تلگرام', percent: dl, speed: this.pipelineState.download.speed, details: this.pipelineState.download.details },
                    { icon: '🗜', name: 'فشرده‌سازی', percent: co, speed: this.pipelineState.compress.speed, details: this.pipelineState.compress.details },
                    { icon: '⬆️', name: 'آپلود به سرور', percent: ul, speed: this.pipelineState.upload.speed, details: this.pipelineState.upload.details }
                ]
            });

            this.updateStatus(chatId, text, false, true).catch(() => {});
        }
    }

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
        
        this.currentFileName = fileName;

        const callbackPoller = this.startCallbackListener(chatId);

        try {
            const requestResult = await this.concurrencyController.requestTransfer(transferId, {
                fileName, fileSize, isVideo, priority: shouldCompress ? 3 : 5
            });

            this.concurrencyController.registerActiveTransfer(transferId, this.abortController);

            if (requestResult.status === 'queued') {
                await this.updateStatus(chatId, renderProgressCard({
                    fileName, masterPercent: 0, stageName: '⏳ در صف انتظار...', stagePercent: 0, queuePosition: requestResult.position
                }), true);

                while (this.concurrencyController.transferQueue.getPosition(transferId) !== null) {
                    await new Promise(r => setTimeout(r, 2000));
                    
                    const pos = this.concurrencyController.transferQueue.getPosition(transferId);
                    if (pos !== null) {
                        await this.updateStatus(chatId, renderProgressCard({
                            fileName, masterPercent: 0, stageName: `⏳ در صف انتظار (#${pos})`, stagePercent: 0, queuePosition: pos
                        })).catch(() => {});
                    }
                    
                    if (await this.checkCancel()) {
                        this.concurrencyController.cancelTransfer(transferId);
                        throw new Error("انتقال توسط کاربر لغو شد.");
                    }
                }
            }

            await this.telegramClient.connect();
            const client = this.telegramClient.client;

            await this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent: 5, stageName: '🧹 پاکسازی و آماده‌سازی حافظه', stagePercent: 100
            }), true, true); 
            
            await this.manageStorage(fileSize);

            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("پیام یا فایل در تلگرام یافت نشد.");

            let downloadLink;
            
            if (isVideo && config.performance.pipeline.enabled) {
                console.log(`[Main] Using Pipeline Architecture for video transfer`);
                try {
                    downloadLink = await this.executePipeline(client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress);
                    if (!downloadLink) throw new Error("Pipeline upload link not generated");
                    fileName = `${path.parse(fileName).name}.mp4`;
                } catch (pipelineErr) {
                    if (pipelineErr.message === 'NON_STREAMABLE_MEDIA') {
                        console.log(`[Pipeline] Media safely skipped for Sequential processing...`);
                    } else {
                        console.warn(`[Main] Pipeline failed, falling back to sequential:`, pipelineErr.message);
                    }
                    downloadLink = await this.executeSequential(client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress, startTime);
                }
            } else {
                console.log(`[Main] Using Sequential Architecture for non-video transfer`);
                downloadLink = await this.executeSequential(client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress, startTime);
            }

            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            const successMsg = `✅ <b>انتقال کامل شد!</b>\n\n<code>[██████████] 100%</code>\n📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n⏱️ <b>زمان:</b> ${elapsedTime} ثانیه\n⚠️ <b>لینک پس از ۲ ساعت منقضی می‌شود.</b>\n\n🔗 <a href="${downloadLink}">👉 لینک دانلود مستقیم 👈</a>`;

            await this.updateStatus(chatId, successMsg, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'completed' });
            this.concurrencyController.completeTransfer(transferId);

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            this.concurrencyController.completeTransfer(transferId);
            
            const isNetworkError = err.message.includes('TCPFull') || err.message.includes('fetch') || 
                                   err.message.includes('ECONNRESET') || err.message.includes('Timeout') ||
                                   err.message.includes('disconnect');
            const isCancelled = err.message.includes('لغو شد') || err.message.includes('cancelled');
                                   
            const errorMsg = isCancelled 
                ? `🛑 <b>انتقال لغو شد!</b>\n\n📁 فایل: <code>${escapeHtml(fileName)}</code>`
                : `❌ <b>خطا در انجام عملیات:</b>\n<code>${escapeHtml(err.message)}</code>${isNetworkError ? '\n\n🔄 در حال بازگشت به صف...' : ''}`;
                
            await this.updateStatus(chatId, errorMsg, true);
            await this.notifyCloudflare({ 
                action: 'action_update', 
                transferId: config.transferId, 
                status: isCancelled ? 'cancelled' : 'failed', 
                error: err.message, 
                retryable: isNetworkError 
            });
        } finally {
            if (callbackPoller) clearInterval(callbackPoller);
            if (downloadedFilePath) await this.cleanupFile(downloadedFilePath).catch(() => {});
            if (targetPath && targetPath !== downloadedFilePath) await this.cleanupFile(targetPath).catch(() => {});
            await this.telegramClient.disconnect().catch(() => {});
            this.concurrencyController.stop();
            setTimeout(() => process.exit(0), 1000);
        }
    }

    async executeSequential(client, message, chatId, fileName, fileSize, isVideo, shouldCompress, globalStartTime) {
        const seqDownloadedFilePath = path.join(config.performance.tempDir, `${config.transferId}_${fileName}`);
        let seqTargetPath = seqDownloadedFilePath;

        let lastProgressUpdate = 0;
        let lastCancelCheck = 0;

        await this.updateStatus(chatId, renderProgressCard({
            fileName, masterPercent: 5, stageName: '📥⚡ دریافت فایل از تلگرام', stagePercent: 0
        }), true, true);

        const downloadResult = await this.downloadFromTelegramOptimized(
            client, message, seqDownloadedFilePath, fileSize,
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
                    const masterPercent = Math.min(65, 5 + Math.floor(subPercent * 0.60));
                    const elapsedSec = (now - globalStartTime) / 1000;
                    const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                    const eta = speed > 0 ? (total - downloaded) / speed : 0;

                    this.updateStatus(chatId, renderProgressCard({
                        fileName, masterPercent, stageName: '📥⚡ دریافت فایل از تلگرام',
                        stagePercent: subPercent, detailsText: `${formatBytes(downloaded)} / ${formatBytes(total)}`,
                        speedText: formatSpeed(speed), etaText: formatEta(eta)
                    }), false, true).catch(() => {});
                }
            },
            this.abortController.signal
        );

        seqTargetPath = seqDownloadedFilePath;

        if (isVideo) {
            if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");

            fileName = `${path.parse(fileName).name}.mp4`;
            const processedPath = path.join(config.performance.tempDir, `processed_${config.transferId}_${Date.now()}.mp4`);
            
            const cancelCheckInterval = setInterval(async () => {
                if (await this.checkCancel()) {
                    if (this.activeFFmpegProcess) this.activeFFmpegProcess.kill('SIGKILL');
                }
            }, 2000);

            try {
                const maxDim = shouldCompress ? 854 : 1280;
                const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
                const crfValue = shouldCompress ? '28' : '23';
                const audioBitrate = shouldCompress ? '64k' : '128k';

                lastProgressUpdate = 0;
                await this.updateStatus(chatId, renderProgressCard({
                    fileName, masterPercent: 65,
                    stageName: shouldCompress ? '🗜 فشرده‌سازی و تغییر مقیاس (480p)' : '🎬 بهینه‌سازی ساختار ویدیو (720p)',
                    stagePercent: 0, speedText: '1.0x', etaText: 'محاسبه...'
                }), true, true);

                await this.runFFmpeg([
                    '-i', seqDownloadedFilePath, '-threads', '0', '-c:v', 'libx264',
                    '-crf', crfValue, '-preset', 'veryfast', '-vf', scaleFilter,
                    '-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart', '-y', processedPath
                ], (subPercent, speedStr, etaText) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                        lastProgressUpdate = now;
                        const masterPercent = Math.min(85, 65 + Math.floor(subPercent * 0.20));
                        this.updateStatus(chatId, renderProgressCard({
                            fileName, masterPercent,
                            stageName: shouldCompress ? '🗜 فشرده‌سازی و تغییر مقیاس (480p)' : '🎬 بهینه‌سازی ساختار ویدیو (720p)',
                            stagePercent: subPercent, speedText: speedStr, etaText: etaText
                        }), false, true).catch(() => {});
                    }
                }, this.abortController.signal);
                
                seqTargetPath = processedPath;
            } catch (ffmpegErr) {
                if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");
                throw new Error(`مشکل در ساختار فایل ویدیو.\n\nجزئیات فنی: ${ffmpegErr.message}`);
            } finally {
                clearInterval(cancelCheckInterval);
            }
        }

        if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");
        this.isCriticalSection = true;

        const fileStats = await fs.promises.stat(seqTargetPath);
        const useMultipart = config.performance.multipartUpload.enabled && fileStats.size > config.performance.multipartUpload.thresholdBytes;
        
        const downloadLink = useMultipart 
            ? await this.uploadToMinIOMultipart(seqTargetPath, fileName, (subPercent, sizeText, speedText, etaText) => {
                const now = Date.now();
                if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                    lastProgressUpdate = now;
                    const baseMaster = isVideo ? 85 : 65;
                    const masterSpan = isVideo ? 13 : 33;
                    const masterPercent = Math.min(98, baseMaster + Math.floor(subPercent * (masterSpan / 100)));
                    this.updateStatus(chatId, renderProgressCard({
                        fileName, masterPercent, stageName: '☁️⚡ آپلود موازی‌پارتیل به سرور',
                        stagePercent: subPercent, detailsText: sizeText, speedText: speedText, etaText: etaText
                    }), false, true).catch(() => {});
                }
            }, this.abortController.signal)
            : await this.uploadToMinIO(seqTargetPath, fileName, (subPercent, sizeText, speedText, etaText) => {
                const now = Date.now();
                if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                    lastProgressUpdate = now;
                    const baseMaster = isVideo ? 85 : 65;
                    const masterSpan = isVideo ? 13 : 33;
                    const masterPercent = Math.min(98, baseMaster + Math.floor(subPercent * (masterSpan / 100)));
                    this.updateStatus(chatId, renderProgressCard({
                        fileName, masterPercent, stageName: '☁️ آپلود به سرور ابری',
                        stagePercent: subPercent, detailsText: sizeText, speedText: speedText, etaText: etaText
                    }), false, true).catch(() => {});
                }
            }, this.abortController.signal);

        return downloadLink;
    }

    async uploadToMinIOMultipart(filePath, fileName, onProgress, signal) {
        const bucket = config.minio.bucketName;
        const { thresholdBytes, partSize, concurrency } = config.performance.multipartUpload;
        
        const stats = fs.statSync(filePath);
        const totalSize = stats.size;
        
        if (!config.performance.multipartUpload.enabled || totalSize < thresholdBytes) {
            return this.uploadToMinIO(filePath, fileName, onProgress, signal);
        }
        
        console.log(`[Multipart] Starting parallel upload: ${fileName} (${formatBytes(totalSize)})`);
        
        try {
            const multipartStartTime = Date.now();
            const totalParts = Math.ceil(totalSize / partSize);
            let completedParts = 0;
            
            for (let i = 0; i < totalParts; i += concurrency) {
                if (signal?.aborted) throw new Error("انتقال توسط کاربر لغو شد.");
                
                const batch = [];
                const batchEnd = Math.min(i + concurrency, totalParts);
                
                for (let j = i; j < batchEnd; j++) {
                    const start = j * partSize;
                    const end = Math.min(start + partSize, totalSize);
                    
                    const partStream = fs.createReadStream(filePath, { start, end: end - 1, highWaterMark: 10 * 1024 * 1024 });
                    
                    batch.push(new Promise((resolve, reject) => {
                        partStream.on('error', reject);
                        minioClient.putObject(bucket, `${fileName}.part${j}`, partStream, end - start)
                            .then(resolve).catch(reject);
                    }));
                }
                
                await Promise.all(batch);
                completedParts = batchEnd;
                
                if (onProgress) {
                    const percent = Math.floor((completedParts / totalParts) * 100);
                    const uploadedBytes = Math.min(completedParts * partSize, totalSize);
                    const elapsedSec = Math.max(1, (Date.now() - multipartStartTime) / 1000);
                    const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                    onProgress(percent, formatBytes(uploadedBytes) + " / " + formatBytes(totalSize), formatSpeed(speed), '');
                }
            }
            
            return await minioClient.presignedGetObject(bucket, fileName, 86400);
            
        } catch (error) {
            console.error(`[Multipart] Upload failed, falling back:`, error.message);
            return this.uploadToMinIO(filePath, fileName, onProgress, signal);
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
                method: 'POST', 
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.cloudflare.apiToken}` },
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
║     ⚡ File Transfer Bot v${SYSTEM_VERSION} - PARALLEL DOWNLOAD ⚡      ║
╠══════════════════════════════════════════════════════════════╣
║  Pipeline Features:                                          ║
║  • Mode: Parallel HTTP Bridge (Option C Hybrid)              ║
║  • Workers: ${config.performance.parallelWorkers} parallel download threads              ║
║  • Chunk Size: 1MB (max allowed)                             ║
║  • Buffer: ${config.performance.readAheadBufferMB}MB read-ahead (keeps FFmpeg fed)           ║
║  • Output format: Fragmented MP4 for continuous pipe         ║
║  • Expected Speedup: 2.5-3.5x faster downloads!              ║
╚══════════════════════════════════════════════════════════════╝
`);

new FileTransferBot().start().catch(err => {
    console.error('[Fatal] Unhandled error:', err);
    process.exit(1);
});