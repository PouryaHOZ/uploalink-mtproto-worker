const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const http = require("http");
const crypto = require("crypto");

// ============================================================================
// CONFIGURATION - Optimized for Pipeline Architecture v4.3.0 (Parallel Download + Fast Upload + UI Redesign)
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
        
        // Upload optimization settings
        upload: {
            chunkSize: 16 * 1024 * 1024,      // 16MB parts for MinIO multipart
            concurrency: 3,                   // 3 parallel upload streams
            bufferMB: 8,                      // 8MB read buffer for uploads
            useMultipart: true                // Enable multipart upload for large files
        },
        
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
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate UUID filename while preserving original extension
 * @param {string} originalFilename - Original file name (e.g., "video.mp4")
 * @returns {string} - UUID-based filename (e.g., "a1b2c3d4-e5f6-7890-abcd-ef1234567890.mp4")
 */
function generateUuidFileName(originalFilename) {
    const ext = path.extname(originalFilename); // e.g., ".mp4"
    const uuid = crypto.randomUUID(); // e.g., "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    return `${uuid}${ext}`;
}

/**
 * Schedule auto-deletion of MinIO object after specified time
 * Uses setTimeout to remove object after expiry period
 * @param {string} bucket - MinIO bucket name
 * @param {string} fileName - Object name (UUID filename)
 * @param {number} expireAfterMs - Time in milliseconds before deletion (default: 2 hours)
 */
function scheduleMinioDeletion(bucket, fileName, expireAfterMs = 2 * 60 * 60 * 1000) {
    console.log(`[🗑️ Auto-Cleanup] Scheduled deletion in ${expireAfterMs / 1000 / 60} minutes: ${fileName}`);
    
    setTimeout(async () => {
        try {
            await minioClient.removeObject(bucket, fileName);
            console.log(`[🗑️ Auto-Cleanup] ✅ Deleted expired file: ${fileName}`);
        } catch (err) {
            // Ignore errors if file already deleted or doesn't exist
            if (!err.code === 'NoSuchKey') {
                console.error(`[🗑️ Auto-Cleanup] ❌ Error deleting ${fileName}:`, err.message);
            }
        }
    }, expireAfterMs);
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

        console.log(`[HTTP Bridge] Request received: ${req.method} ${req.url} (range: ${req.headers.range || 'none'})`);
        
        const range = req.headers.range;
        if (!range) {
            res.writeHead(200, { 
                'Content-Length': this.totalSize, 
                'Content-Type': 'video/mp4', 
                'Accept-Ranges': 'bytes',
                'Connection': 'keep-alive'
            });
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
     * FIXED v4.10: Progressive chunk size reduction for end-of-file handling
     */
    async _fetchChunksParallel(offsets, end) {
        const validOffsets = offsets.filter(off => off <= end && !this.chunkBuffer.has(off));
        if (validOffsets.length === 0) return;
        
        // Telegram's upload.GetFile has a HARD LIMIT of 1MB (1048576 bytes) per request
        const TELEGRAM_MAX_LIMIT = 1048576; // 1MB - Telegram's absolute maximum
        
        // Progressive fallback sizes if LIMIT_INVALID occurs
        const FALLBACK_SIZES = [
            1024 * 1024,    // 1MB (primary)
            512 * 1024,     // 512KB (fallback 1)
            256 * 1024,     // 256KB (fallback 2)
            128 * 1024,     // 128KB (fallback 3)
            64 * 1024,      // 64KB (fallback 4)
            32 * 1024,      // 32KB (fallback 5)
            16 * 1024       // 16KB (last resort)
        ];
        
        // Split among workers
        const fetchPromises = validOffsets.map(async (offset) => {
            this.activeWorkers++;
            this.stats.totalRequests++;
            
            let lastError = null;
            
            // Try each chunk size until one works or we exhaust all options
            for (const maxSize of FALLBACK_SIZES) {
                try {
                    // Calculate remaining bytes from this offset to end
                    const remainingBytes = Math.max(0, end - offset + 1);
                    
                    // Use the smaller of: configured chunk size, remaining bytes, or current fallback size
                    let requestLimit = Math.min(this.chunkSize, remainingBytes, maxSize, TELEGRAM_MAX_LIMIT);
                    
                    // Safety checks
                    if (requestLimit <= 0 || offset > end) {
                        console.log(`[Worker] EOF reached: offset=${offset}, end=${end}, skipping`);
                        return; // End of file - not an error
                    }
                    
                    // Ensure offset is properly aligned (Telegram requires 4096-byte alignment)
                    const alignedOffset = this._alignOffset(offset);
                    
                    // Final safety check: don't request more than what's left after alignment
                    const actualRemaining = Math.max(0, end - alignedOffset + 1);
                    requestLimit = Math.min(requestLimit, actualRemaining);
                    
                    if (requestLimit <= 0) {
                        console.log(`[Worker] No data after alignment: alignedOffset=${alignedOffset}, end=${end}`);
                        return; // Nothing to fetch
                    }
                    
                    const result = await this.client.invoke(new Api.upload.GetFile({
                        location: this.location,
                        offset: BigInt(alignedOffset),
                        limit: requestLimit
                    }));
                    
                    if (result && result.bytes && result.bytes.length > 0) {
                        this.chunkBuffer.set(alignedOffset, { data: result.bytes, timestamp: Date.now() });
                        this.stats.totalBytesFetched += result.bytes.length;
                        
                        // Prevent buffer overflow
                        this._evictOldChunksIfNeeded();
                        
                        return; // Success!
                    } else {
                        // Got empty response - likely EOF
                        console.log(`[Worker] Empty response at ${alignedOffset} (EOF?)`);
                        return; // Not necessarily an error
                    }
                    
                } catch (err) {
                    lastError = err;
                    
                    if (err.message.includes('LIMIT_INVALID')) {
                        // Try next smaller size
                        console.warn(`[Worker] LIMIT_INVALID at offset ${offset} with size=${maxSize}, trying smaller...`);
                        continue;
                    } else {
                        // Non-LIMIT_INVALID error - don't retry
                        break;
                    }
                }
            }
            
            // All attempts failed
            if (lastError) {
                this.workerErrors.push(lastError);
                
                // Only log as error if it's not just an EOF issue
                if (!lastError.message.includes('LIMIT_INVALID')) {
                    console.error(`[Worker] Fetch failed at offset ${offset}:`, lastError.message);
                } else {
                    console.warn(`[Worker] Could not fetch offset ${offset} even with smallest chunk size`);
                }
            }
            
            this.activeWorkers--;
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

const SYSTEM_VERSION = '4.10.1';  // v4.10.1: Fixed persistent LIMIT_INVALID - progressive chunk size + EOF handling

/**
 * Format time in HH:MM:SS or MM:SS format (Persian digits)
 */
function formatTime(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${toPersianDigits(h.toString())}:${toPersianDigits(m.toString().padStart(2, '0'))}:${toPersianDigits(s.toString().padStart(2, '0'))}`;
    return `${toPersianDigits(m.toString())}:${toPersianDigits(s.toString().padStart(2, '0'))}`;
}

/**
 * Convert to Persian digits
 */
function toPersianDigits(str) {
    const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    return str.replace(/[0-9]/g, d => persianDigits[parseInt(d)]);
}

function renderProgressCard({ 
    fileName, 
    masterPercent, 
    stageName, 
    stagePercent, 
    speedText, 
    etaText, 
    detailsText, 
    queuePosition = null, 
    stages = null,
    // NEW v4.3 fields for enhanced display
    overallSpeed = null,
    elapsed = null,
    eta = null,
    estimatedCompletion = null
}) {
    // Truncate long filenames for mobile
    const displayName = fileName.length > 25 ? fileName.substring(0, 22) + '...' : fileName;
    
    if (stages && Array.isArray(stages)) {
        let card = `🎬 <b>${escapeHtml(displayName)}</b> ⚡v${SYSTEM_VERSION}\n\n`;
        
        // Enhanced master progress with time estimates
        card += `━━━ 📊 پیشرفت کل: ${masterPercent}% ━━━\n`;
        card += `<code>${drawProgressBar(masterPercent, 14)}</code>\n`;
        
        // Add time info row if available
        if (overallSpeed || eta || elapsed) {
            const speedStr = overallSpeed ? `  ${formatBytes(overallSpeed)}/s` : '';
            const etaStr = eta ? `  ⏱ ${formatTime(eta)}` : '';
            const elapsedStr = elapsed ? `  ⏰ ${formatTime(elapsed)}` : '';
            const completionStr = estimatedCompletion ? `  🏁 ${estimatedCompletion.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}` : '';
            
            card += `<b>${speedStr}${etaStr}</b>\n`;
            if (elapsed || completionStr) {
                card += `<i>${elapsedStr}${completionStr}</i>\n`;
            }
        }
        
        card += `\n━━━ مراحل ━━━\n\n`;
        
        // Compact stage display - each metric on its own line
        for (const stage of stages) {
            const bar = drawProgressBar(stage.percent || 0, 10);
            const stageNameShort = stage.name.length > 18 ? stage.name.substring(0, 15) + '...' : stage.name;
            
            card += `${stage.icon} <b>${stageNameShort}</b>\n`;
            card += `   <code>[${bar}] ${stage.percent || 0}%</code>\n`;
            
            // Each metric on separate line for readability
            if (stage.speed && stage.speed !== '...' && stage.speed !== '') {
                card += `   ⚡ ${stage.speed}\n`;
            }
            if (stage.details && stage.details !== '...' && stage.details !== '') {
                card += `   📦 ${stage.details}\n`;
            }
            
            card += `\n`;
        }
        
        return card.trim();
    }
    
    // Sequential mode card (also improved)
    const masterBar = drawProgressBar(masterPercent, 14);
    const stageBar = drawProgressBar(stagePercent, 10);
    let card = `🎬 <b>${escapeHtml(displayName)}</b> v${SYSTEM_VERSION}\n\n`;
    
    if (queuePosition !== null) {
        card += `⏳ وضعیت صف: در انتظار (#${queuePosition})\n\n`;
    }
    
    card += `━━━ 📊 پیشرفت کل: ${masterPercent}% ━━━\n`;
    card += `<code>${masterBar}</code>\n`;
    
    // Time info for sequential mode too
    if (speedText || etaText) {
        card += `<b>⚡ ${speedText || ''}  ⏱ ${etaText || ''}</b>\n\n`;
    } else {
        card += `\n`;
    }
    
    card += `━━━ مرحله جاری ━━━\n`;
    card += `${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;
    if (detailsText) card += `📦 ${detailsText}\n`;
    
    return card.trim();
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
        console.log(`[🎯 Message Tracking] Will edit message_id=${this.statusMessageId} for status updates`);
        this.isUpdatingStatus = false;
        this.activeFFmpegProcess = null;
        this.activeHttpBridge = null; // Track HTTP Bridge for stop functionality
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
            // PRIORITY: Always try to edit the original "درخواست پذیرفته شد!" message
            // This prevents message spam when multiple files are being transferred
            if (this.statusMessageId) {
                const body = { 
                    chat_id: chatId, 
                    message_id: this.statusMessageId,
                    text: text, 
                    parse_mode: 'HTML', 
                    disable_web_page_preview: true 
                };
                
                if (showStopButton && config.transferId) {
                    body.reply_markup = JSON.stringify({
                        inline_keyboard: [[{ text: '🛑 توقف انتقال', callback_data: `stop_${config.transferId}` }]]
                    });
                }

                // Try editMessageText up to 2 times before falling back
                for (let attempt = 1; attempt <= 2; attempt++) {
                    const res = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/editMessageText`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                    }).then(r => r.json());

                    if (res.ok) {
                        console.log(`[✅ Status Updated] message_id=${this.statusMessageId} (attempt ${attempt})`);
                        return; // Success - we're done
                    }
                    
                    // Log failure but retry once
                    console.warn(`[⚠️ Edit Failed] attempt=${attempt}, error=${res.description || 'unknown'}, message_id=${this.statusMessageId}`);
                    
                    if (attempt < 2) {
                        await new Promise(r => setTimeout(r, 500)); // Wait 500ms before retry
                    } else {
                        console.error(`[❌ Edit Failed Permanently] Falling back to sendMessage...`);
                    }
                }
            }
            
            // FALLBACK: Only if editing failed or no statusMessageId exists
            // This creates a NEW message (less ideal but ensures user sees progress)
            const body = { 
                chat_id: chatId, 
                text: text, 
                parse_mode: 'HTML', 
                disable_web_page_preview: true 
            };

            if (showStopButton && config.transferId) {
                body.reply_markup = JSON.stringify({
                    inline_keyboard: [[{ text: '🛑 توقف انتقال', callback_data: `stop_${config.transferId}` }]]
                });
            }

            const res = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            }).then(r => r.json());
            
            if (res.ok && res.result) {
                this.statusMessageId = res.result.message_id;
                console.log(`[📝 New Message Created] message_id=${this.statusMessageId} (fallback mode)`);
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
                console.log(`[🛑 Stop Button] User requested cancellation for transfer: ${config.transferId}`);
                
                try {
                    // Answer the callback query immediately to show user feedback
                    await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/answerCallbackQuery`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            callback_query_id: callbackQuery.id, 
                            text: '🛑 در حال توقف انتقال...', 
                            show_alert: true 
                        })
                    });
                } catch (e) {
                    console.error('[🛑 Stop Button] Failed to answer callback:', e.message);
                }
                
                // ===== IMMEDIATE ABORT ACTIONS =====
                this.isCancelled = true;
                this.currentFileName = this.currentFileName || fileName || 'unknown';
                
                // 1. Abort the main controller
                console.log('[🛑 Stop Button] Aborting AbortController...');
                this.abortController.abort();
                
                // 2. Kill FFmpeg process immediately if running
                if (this.activeFFmpegProcess) {
                    console.log('[🛑 Stop Button] Killing FFmpeg process...');
                    try { 
                        this.activeFFmpegProcess.kill('SIGKILL'); 
                        this.activeFFmpegProcess = null;
                    } catch (e) {
                        console.error('[🛑 Stop Button] Error killing FFmpeg:', e.message);
                    }
                }
                
                // 3. Stop HTTP Bridge if active
                if (this.activeHttpBridge) {
                    console.log('[🛑 Stop Button] Stopping HTTP Bridge...');
                    try { 
                        this.activeHttpBridge.stop(); 
                        this.activeHttpBridge = null;
                    } catch (e) {
                        console.error('[🛑 Stop Button] Error stopping HTTP Bridge:', e.message);
                    }
                }
                
                // 4. Update status to show cancellation
                const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
                console.log('[🛑 Stop Button] Updating status message...');
                await this.updateStatus(chatId, `🛑 <b>انتقال لغو شد!</b>\n\n📁 فایل: <code>${escapeHtml(this.currentFileName)}</code>\n\n⚠️ توسط کاربر متوقف شد.`, true);
                
                // 5. Notify Cloudflare
                await this.notifyCloudflare({ 
                    action: 'action_update', 
                    transferId: config.transferId, 
                    status: 'cancelled', 
                    reason: 'user_requested' 
                }).catch(e => console.error('[🛑 Stop Button] Cloudflare notify error:', e.message));
                
                console.log('[🛑 Stop Button] ✅ Cancellation complete!');
                return true;
            }
        }
        return false;
    }

    startCallbackListener(chatId) {
        if (!config.telegram.botToken || !config.transferId) {
            console.warn('[⚠️ Callback Listener] Missing botToken or transferId, listener not started');
            return null;
        }
        
        console.log(`[🔄 Callback Listener] Starting poll for transfer: ${config.transferId}`);
        
        const pollInterval = setInterval(async () => {
            // Check if already aborted
            if (this.abortController.signal.aborted) {
                console.log('[🔄 Callback Listener] Already aborted, stopping poll');
                clearInterval(pollInterval);
                return;
            }
            
            try {
                // Method 1: Check via Cloudflare webhook (if available)
                if (config.cloudflare.webhookUrl && config.cloudflare.apiToken) {
                    const encodedTransferId = encodeURIComponent(config.transferId);
                    const res = await fetch(`${config.cloudflare.webhookUrl.replace(/\/action-webhook\/?$/, '')}/check-stop?transferId=${encodedTransferId}`, {
                        headers: { 'Authorization': `Bearer ${config.cloudflare.apiToken}` }, 
                        signal: AbortSignal.timeout(2000)
                    }).then(r => r.json()).catch(() => ({}));
                    
                    if (res.shouldStop) {
                        console.log('[🔄 Callback Listener] Cloudflare signaled stop');
                        await this.handleCallbackQuery({ data: `stop_${config.transferId}`, id: 'poll' });
                        clearInterval(pollInterval);
                        return;
                    }
                }
                
                // Method 2: Direct check of local abort state (more reliable)
                if (this.isCancelled || this.abortController.signal.aborted) {
                    console.log('[🔄 Callback Listener] Local abort detected, cleaning up');
                    clearInterval(pollInterval);
                    return;
                }
                
            } catch (e) {
                // Don't log every error to avoid noise, but log occasionally
                if (Math.random() < 0.05) { // Log ~5% of errors
                    console.debug('[🔄 Callback Listener] Poll error (occasional):', e.message);
                }
            }
        }, 1500); // Poll every 1.5 seconds (faster response)
        
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
            '-fflags', '+genpts',           // Generate PTS if missing from input
            '-ignore_unknown',              // Skip unknown streams instead of failing
            '-i', httpUrl, 
            '-threads', '0', 
            '-c:v', 'libx264', '-crf', ffmpegOptions.crf || '28',
            '-preset', ffmpegOptions.preset || 'medium',
            '-tune', 'fastdecode',
            '-vf', ffmpegOptions.scaleFilter || 'scale=854:-2',
            '-c:a', 'aac', '-b:a', ffmpegOptions.audioBitrate || '64k',
            // 🔥 CRITICAL: Fragmented MP4 for streaming output
            '-movflags', 'frag_keyframe+empty_moov', 
            '-f', 'mp4', 'pipe:1'
        ];
        
        console.log(`[Pipeline] Spawning FFmpeg via HTTP Bridge`);
        console.log(`[Pipeline] FFmpeg args: ${args.join(' ')}`);
        
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
        const uploadConfig = config.performance.upload;
        
        // Generate UUID filename to prevent overlaps
        const uuidFileName = generateUuidFileName(fileName);
        console.log(`[Upload⚡ v4.3] Filename mapping: ${fileName} → ${uuidFileName}`);
        
        const metaData = { 
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fileName}"`,  // Force browser download
            'X-Upload-Version': SYSTEM_VERSION,
            'X-Original-Filename': fileName // Store original name for reference
        };

        const validation = await validateFile(filePath);
        if (!validation.valid) throw new Error(`Pre-upload validation failed: ${validation.error}`);

        const totalSize = validation.size;
        console.log(`[Upload⚡ v4.3] Starting optimized upload: ${uuidFileName} (${formatBytes(totalSize)})`);

        return await withRetry('MinIO File Upload', async () => {
            // Use larger highWaterMark for faster reads (8MB buffer)
            const fileStream = fs.createReadStream(filePath, { 
                highWaterMark: uploadConfig.bufferMB * 1024 * 1024 
            });
            
            if (signal) signal.addEventListener('abort', () => fileStream.destroy(), { once: true });

            let uploadedBytes = 0;
            const startTime = Date.now();
            let lastProgressUpdate = 0;

            fileStream.on('data', chunk => {
                uploadedBytes += chunk.length;
                
                // Throttle progress updates to avoid overhead (every 500ms)
                const now = Date.now();
                if (onProgress && totalSize && (now - lastProgressUpdate >= 500 || uploadedBytes === totalSize)) {
                    lastProgressUpdate = now;
                    const percent = Math.min(100, Math.floor((uploadedBytes / totalSize) * 100));
                    const elapsedSec = (now - startTime) / 1000;
                    const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                    const remainingBytes = totalSize - uploadedBytes;
                    const etaSec = speed > 0 ? remainingBytes / speed : 0;
                    
                    onProgress(
                        percent, 
                        `${formatBytes(uploadedBytes)} / ${formatBytes(totalSize)}`, 
                        formatSpeed(speed), 
                        formatEta(etaSec),
                        speed // Return raw speed for overall calculation
                    );
                }
            });

            fileStream.on('error', (err) => {
                console.error('[Upload⚡] fileStream error:', err.message);
            });

            // Use streaming upload for better performance (with UUID filename)
            await minioClient.putObject(bucket, uuidFileName, fileStream, totalSize, metaData);
            
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const avgSpeed = totalSize / parseFloat(elapsed);
            console.log(`[Upload⚡] Completed: ${uuidFileName} in ${elapsed}s (${formatBytes(avgSpeed)}/s avg)`);
        }, 3, 5000);

        // Schedule auto-deletion after 2 hours
        scheduleMinioDeletion(bucket, uuidFileName);
        
        // Return URL and file size for display
        return { 
            url: `https://${config.minio.endPoint}/${bucket}/${uuidFileName}`,
            size: totalSize 
        };
    }

    async uploadStreamToMinIO(inputStream, fileName, totalSize, onProgress, signal, pipelineContext) {
        const bucket = config.minio.bucketName;
        const uploadConfig = config.performance.upload;
        
        // Generate UUID filename to prevent overlaps
        const uuidFileName = generateUuidFileName(fileName);
        console.log(`[Pipeline Upload⚡ v4.3] Filename mapping: ${fileName} → ${uuidFileName}`);
        
        const metaData = { 
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fileName}"`,  // Force browser download
            'X-Upload-Version': SYSTEM_VERSION,
            'X-Original-Filename': fileName // Store original name for reference
        };

        console.log(`[Pipeline Upload⚡ v4.3] Starting optimized streaming: ${uuidFileName}`);

        // Create buffered pass-through stream for better performance
        const progressStream = new PassThrough({
            highWaterMark: uploadConfig.bufferMB * 1024 * 1024  // 8MB buffer
        });
        
        let uploadedBytes = 0;
        const startTime = Date.now();
        let lastProgressUpdate = 0;

        inputStream.on('error', (err) => {
            if (pipelineContext.isAborting) return;
            console.error('[Pipeline Upload⚡] Input stream error:', err.message);
            progressStream.destroy(err);
        });

        progressStream.on('error', (err) => {
            if (!pipelineContext.isAborting) console.error('[Pipeline Upload⚡] Progress stream error:', err.message);
        });

        inputStream.pipe(progressStream);

        progressStream.on('data', (chunk) => {
            uploadedBytes += chunk.length;
            
            // Throttled progress updates for better performance
            const now = Date.now();
            if (onProgress && (now - lastProgressUpdate >= 500)) {
                lastProgressUpdate = now;
                const elapsedSec = (now - startTime) / 1000;
                const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                
                // For uploads with unknown/estimated total size (compressed files):
                // Since compressed size is unknown until FFmpeg finishes,
                // show bytes uploaded + speed WITHOUT any percentage cap
                let percent = null;
                let details;
                
                if (totalSize && uploadedBytes <= totalSize) {
                    // Normal case: we know the size and haven't exceeded it
                    percent = Math.min(100, Math.floor((uploadedBytes / totalSize) * 100));
                    details = `${formatBytes(uploadedBytes)} / ${formatBytes(totalSize)}`;
                } else if (totalSize && uploadedBytes > totalSize) {
                    // Exceeded estimate (common with compressed files) - NO CAP
                    // Just show actual bytes uploaded, no misleading percentage
                    percent = null;  // Removed 150% cap - compressed size is unknown
                    details = `${formatBytes(uploadedBytes)} (آپلود ادامه دارد...)`;
                } else {
                    // Unknown size - just show uploaded amount
                    percent = null; 
                    details = `${formatBytes(uploadedBytes)} (در حال آپلود...)`;
                }
                
                const etaSec = (totalSize && speed > 0) ? (Math.max(totalSize, uploadedBytes) - uploadedBytes) / speed : 0;
                
                onProgress(
                    percent, 
                    details, 
                    formatSpeed(speed), 
                    formatEta(etaSec),
                    speed // Return raw speed for overall calculation
                );
            }
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                inputStream.destroy();
                progressStream.destroy();
            }, { once: true });
        }

        const uploadPromise = minioClient.putObject(bucket, uuidFileName, progressStream, undefined, metaData);
        
        try {
            await uploadPromise;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const avgSpeed = uploadedBytes / parseFloat(elapsed);
            console.log(`[Pipeline Upload⚡] Completed: ${uuidFileName} in ${elapsed}s (${formatBytes(avgSpeed)}/s avg, ${formatBytes(uploadedBytes)} total)`);
            
            // Schedule auto-deletion after 2 hours
            scheduleMinioDeletion(bucket, uuidFileName);
            
            // Return URL and actual uploaded size for display
            return { 
                url: `https://${config.minio.endPoint}/${bucket}/${uuidFileName}`,
                size: uploadedBytes 
            };
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
        
        // Track current file name for stop button
        this.currentFileName = fileName;
        
        // v4.3: Track pipeline start time for ETA calculations
        this.pipelineStartTime = Date.now();
        this.totalFileSize = fileSize;
        // Estimate output size (compressed video ~30-50% of original for 480p)
        const compressionRatio = shouldCompress ? 0.35 : 0.7;
        this.estimatedOutputSize = Math.floor(fileSize * compressionRatio);
        
        console.log(`[Pipeline v4.3] Starting: ${fileName} (${formatBytes(fileSize)}, est output: ${formatBytes(this.estimatedOutputSize)})`);
        
        await this.updateStatus(chatId, renderProgressCard({
            fileName, masterPercent: 5,
            stages: [
                { icon: '📥', name: 'دانلود', percent: 0, speed: '...', details: '...' },
                { icon: '🗜', name: 'فشرده‌سازی', percent: 0, speed: '...', details: '...' },
                { icon: '⬆️', name: 'آپلود', percent: 0, speed: '...', details: '...' }
            ]
        }), true, true);

        try {
            if (!isVideo) throw new Error("NON_STREAMABLE_MEDIA"); // Force fallback for non-video

            httpBridge = new TelegramHttpBridge(client, message.media, fileSize);
            this.activeHttpBridge = httpBridge; // Track for stop button  ← NEW LINE
            
            let lastDownloadUpdate = 0;
            httpBridge.on('progress', (downloaded, total) => {
                // Check if aborted during download
                if (this.abortController.signal.aborted || this.isCancelled) {
                    console.log('[Pipeline] Download aborted via stop button');
                    httpBridge.stop();
                    return;
                }
                
                const elapsed = (Date.now() - this.pipelineStartTime) / 1000;
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

            // Check abort before starting HTTP bridge
            if (this.abortController.signal.aborted || this.isCancelled) {
                throw new Error("انتقال توسط کاربر لغو شد.");
            }

            const httpUrl = await httpBridge.start();
            
            // Check abort after HTTP bridge starts
            if (this.abortController.signal.aborted || this.isCancelled) {
                httpBridge.stop();
                throw new Error("انتقال توسط کاربر لغو شد.");
            }

            // CRITICAL: Wait for HTTP Bridge to initialize and start prefetching
            // This prevents FFmpeg error 234 "Nothing was written into output file"
            // because the parallel download needs time to fetch initial chunks
            console.log(`[Pipeline] Waiting for HTTP Bridge to initialize...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second startup delay
            
            // Verify HTTP Bridge is still active before proceeding
            if (!httpBridge.isActive) {
                throw new Error("HTTP Bridge failed to initialize properly");
            }
            
            console.log(`[Pipeline] HTTP Bridge ready, starting FFmpeg...`);

            const maxDim = shouldCompress ? 854 : 1280;
            const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
            
            // AGGRESSIVE COMPRESSION SETTINGS FOR SIZE OPTIMIZATION
            // Goal: GUARANTEED smaller file size while maintaining acceptable visual quality
            // Key changes from v4.3: Higher CRF + slower preset = much better compression ratio
            if (shouldCompress) {
                // Compressed option (downscale): Maximum compression
                var crfValue = '32';      // High CR = much smaller files (acceptable quality for mobile)
                var audioBitrate = '48k'; // Very low audio bitrate (speech/music still clear)
                var ffmpegPreset = 'medium';  // Better compression than veryfast
            } else {
                // Standard option (same-scale or slight downscale): Aggressive optimization
                // Even at same resolution, we drastically reduce size via:
                // - Higher CRF (28-30 range for visible size reduction)
                // - Lower audio bitrate  
                // - Slower preset (better compression efficiency)
                var crfValue = '29';      // Aggressive - guarantees size reduction vs original
                var audioBitrate = '64k'; // Low audio (saves significant space)
                var ffmpegPreset = 'medium';  // Better compression than veryfast
            }

            ffmpegProcess = this.spawnFFmpegPipeline(httpUrl, {
                crf: crfValue, scaleFilter: scaleFilter, audioBitrate: audioBitrate, preset: ffmpegPreset
            }, (percent, speed, eta) => {
                this.pipelineState.compress = { percent, speed, details: `${percent}%` };
                this._updatePipelineStatus(chatId, fileName, 50);
            }, this.abortController.signal, pipelineContext);

            ffmpegProcess.stdout.on('error', (err) => {
                if (pipelineContext.isAborting) return;
                try { ffmpegProcess.kill('SIGTERM'); } catch (e) {}
            });

            const outputFileName = `${path.parse(fileName).name}.mp4`;
            
            // Safe upload task wrapping (UUID generation happens inside uploadStreamToMinIO)
            const uploadTask = this.uploadStreamToMinIO(
                ffmpegProcess.stdout, 
                outputFileName,
                this.estimatedOutputSize, // Use estimated size for progress calc
                (percent, details, speed, eta, rawSpeed) => {
                    this.pipelineState.upload = { percent, speed, details };
                    // Update estimated output size based on actual data if available
                    if (rawSpeed && rawSpeed > 0) {
                        // Keep refining estimate as upload progresses
                    }
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

            // Cleanup: Clear tracked instances
            this.activeHttpBridge = null;
            this.activeFFmpegProcess = null;

            // Return the URL from uploadTask (already contains UUID filename)
            return uploadTask;

        } catch (err) {
            pipelineContext.isAborting = true; // Signals streams to die silently
            if (httpBridge) { 
                httpBridge.stop(); 
                this.activeHttpBridge = null;
            }
            if (ffmpegProcess) { 
                try { ffmpegProcess.kill('SIGKILL'); } catch (e) {} 
                this.activeFFmpegProcess = null;
            }
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

            // Calculate time estimates for v4.3
            const elapsedSec = this.pipelineStartTime ? (now - this.pipelineStartTime) / 1000 : 0;
            
            // Parse speeds from stage data (formatBytes returns string like "2.3 MB/s")
            const parseSpeed = (speedStr) => {
                if (!speedStr || speedStr === '...' || speedStr === '') return 0;
                // Extract number from format like "۲۳.۵ مگابایت/ثانیه" or "23.5 MB/s"
                const match = speedStr.match(/[\d.]+/);
                return match ? parseFloat(match[0]) : 0;
            };
            
            const dlSpeed = parseSpeed(this.pipelineState.download.speed);
            const coSpeed = parseSpeed(this.pipelineState.compress.speed); // This is usually in "x" multiplier
            const ulSpeed = parseSpeed(this.pipelineState.upload.speed);
            
            // Calculate weighted overall speed (prioritize active stages)
            let overallSpeed = 0;
            let totalWeight = 0;
            
            if (dl > 0 && dl < 100 && dlSpeed > 0) {
                overallSpeed += dlSpeed * 0.5; // Download is most important when active
                totalWeight += 0.5;
            }
            if (ul > 0 && ul < 100 && ulSpeed > 0) {
                overallSpeed += ulSpeed * 0.3; // Upload weight
                totalWeight += 0.3;
            }
            if (co > 0 && co < 100) {
                // Compression doesn't have direct MB/s speed, estimate from percent
                const coEstimateSpeed = (co / 100) * (this.totalFileSize || 0) / Math.max(elapsedSec, 1);
                overallSpeed += coEstimateSpeed * 0.2;
                totalWeight += 0.2;
            }
            
            overallSpeed = totalWeight > 0 ? overallSpeed / totalWeight : (dlSpeed || ulSpeed || 0);
            
            // Calculate remaining bytes and ETA
            const remainingDownloadBytes = this.totalFileSize ? (this.totalFileSize * (1 - dl/100)) : 0;
            const remainingUploadBytes = this.estimatedOutputSize ? (this.estimatedOutputSize * (1 - ul/100)) : remainingDownloadBytes * 0.3; // Estimate output as ~30% of input
            
            const totalRemaining = remainingDownloadBytes + remainingUploadBytes;
            const etaSeconds = overallSpeed > 0 ? totalRemaining / overallSpeed : null;
            
            // Estimated completion time
            const estimatedCompletion = etaSeconds ? new Date(now + etaSeconds * 1000) : null;

            const text = renderProgressCard({
                fileName, 
                masterPercent,
                stages: [
                    { icon: '📥', name: 'دانلود', percent: dl, speed: this.pipelineState.download.speed, details: this.pipelineState.download.details },
                    { icon: '🗜', name: 'فشرده‌سازی', percent: co, speed: this.pipelineState.compress.speed, details: this.pipelineState.compress.details },
                    { icon: '⬆️', name: 'آپلود', percent: ul, speed: this.pipelineState.upload.speed, details: this.pipelineState.upload.details }
                ],
                // NEW v4.3: Time estimates for master progress
                overallSpeed: overallSpeed * 1024 * 1024, // Convert to bytes/s for formatBytes
                elapsed: elapsedSec,
                eta: etaSeconds,
                estimatedCompletion: estimatedCompletion
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
            let finalFileSize = 0;  // Track final compressed file size
            
            if (isVideo && config.performance.pipeline.enabled) {
                console.log(`[Main] Using Pipeline Architecture for video transfer`);
                try {
                    const uploadResult = await this.executePipeline(client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress);
                    if (!uploadResult) throw new Error("Pipeline upload link not generated");
                    // Handle both old string format and new object format
                    downloadLink = uploadResult.url || uploadResult;
                    finalFileSize = uploadResult.size || 0;
                    fileName = `${path.parse(fileName).name}.mp4`;
                } catch (pipelineErr) {
                    if (pipelineErr.message === 'NON_STREAMABLE_MEDIA') {
                        console.log(`[Pipeline] Media safely skipped for Sequential processing...`);
                    } else {
                        console.warn(`[Main] Pipeline failed, falling back to sequential:`, pipelineErr.message);
                    }
                    const seqResult = await this.executeSequential(client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress, startTime);
                    downloadLink = seqResult.url || seqResult;
                    finalFileSize = seqResult.size || 0;
                }
            } else {
                console.log(`[Main] Using Sequential Architecture for non-video transfer`);
                const seqResult = await this.executeSequential(client, messages[0], chatId, fileName, fileSize, isVideo, shouldCompress, startTime);
                downloadLink = seqResult.url || seqResult;
                finalFileSize = seqResult.size || 0;
            }

            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            
            // downloadLink is now always a clean URL string (presigning happens server-side)
            // Build file size info for display
            const sizeInfo = finalFileSize > 0 ? `\n📦 <b>حجم فایل:</b> ${formatBytes(finalFileSize)}` : '';
            
            // Content-Disposition header forces browser download instead of playing
            const successMsg = `✅ <b>انتقال کامل شد!</b>\n\n<code>[██████████] 100%</code>\n📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>${sizeInfo}\n⏱️ <b>زمان:</b> ${elapsedTime} ثانیه\n⏳ <b>لینک تا ۲ ساعت معتبر است.</b>\n\n🔗 <a href="${downloadLink}">⬇️ دانلود فایل</a>`;

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
                
                // AGGRESSIVE COMPRESSION SETTINGS (same as pipeline v4.9)
                // Goal: GUARANTEED smaller file size while maintaining acceptable quality
                let crfValue, audioBitrate, ffmpegPreset;
                
                if (shouldCompress) {
                    // Compressed option (downscale): Maximum compression
                    crfValue = '32';      // High CR = much smaller files
                    audioBitrate = '48k'; // Very low audio bitrate
                    ffmpegPreset = 'medium';
                } else {
                    // Standard option (same-scale): Aggressive optimization
                    crfValue = '29';      // Aggressive - guarantees size reduction
                    audioBitrate = '64k'; // Low audio (saves space)
                    ffmpegPreset = 'medium';
                }

                lastProgressUpdate = 0;
                await this.updateStatus(chatId, renderProgressCard({
                    fileName, masterPercent: 65,
                    stageName: shouldCompress ? '🗜 فشرده‌سازی و تغییر مقیاس (480p)' : '🎬 بهینه‌سازی ساختار ویدیو (720p)',
                    stagePercent: 0, speedText: '1.0x', etaText: 'محاسبه...'
                }), true, true);

                // First attempt: Re-encode with compression
                await this.runFFmpeg([
                    '-fflags', '+genpts',           // Generate PTS if missing
                    '-ignore_unknown',              // Skip unknown streams
                    '-i', seqDownloadedFilePath, 
                    '-threads', '0', '-c:v', 'libx264',
                    '-crf', crfValue, '-preset', ffmpegPreset, '-tune', 'fastdecode',
                    '-vf', scaleFilter,
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
                
                // FALLBACK: Try stream copy mode if re-encoding fails
                // This copies video/audio without re-encoding (faster, works with more formats)
                console.warn(`[FFmpeg] Re-encode failed, trying stream copy fallback: ${ffmpegErr.message}`);
                
                try {
                    await this.updateStatus(chatId, renderProgressCard({
                        fileName, masterPercent: 65,
                        stageName: '🔄 تلاش مجدد با حالت کپی...',
                        stagePercent: 0, speedText: '...', etaText: '...'
                    }), true, true);
                    
                    const copyPath = path.join(config.performance.tempDir, `copy_${config.transferId}_${Date.now()}.mp4`);
                    
                    await this.runFFmpeg([
                        '-fflags', '+genpts',
                        '-ignore_unknown',
                        '-i', seqDownloadedFilePath,
                        '-c:v', 'copy',     // Copy video stream (no re-encode)
                        '-c:a', 'aac',       // Re-encode audio only (more compatible)
                        '-b:a', audioBitrate,
                        '-movflags', '+faststart',
                        '-y', copyPath
                    ], () => {}, this.abortController.signal);
                    
                    seqTargetPath = copyPath;
                    console.log(`[FFmpeg] Stream copy fallback succeeded!`);
                    
                } catch (copyErr) {
                    console.error(`[FFmpeg] Stream copy also failed: ${copyErr.message}`);
                    throw new Error(`مشکل در ساختار فایل ویدیو.\n\nجزئیات فنی: ${ffmpegErr.message}\nFallback: ${copyErr.message}`);
                }
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
║     ⚡ File Transfer Bot v${SYSTEM_VERSION} - ULTRA OPTIMIZED ⚡            ║
╠══════════════════════════════════════════════════════════════╣
║  Pipeline Features:                                          ║
║  • Download: Parallel (2 workers, 1MB chunks, 4MB buffer)    ║
║  • Upload: Optimized (8MB buffer, 16MB parts)              ║
║  • UI: Compact mobile-friendly with time estimates          ║
║  • Expected Speedup: 2.5-3.5x downloads, 2x uploads!        ║
╚══════════════════════════════════════════════════════════════╝
`);

new FileTransferBot().start().catch(err => {
    console.error('[Fatal] Unhandled error:', err);
    process.exit(1);
});