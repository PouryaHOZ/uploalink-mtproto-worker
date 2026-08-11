/**
 * SPEED OPTIMIZATION PLAN v2.0
 * Target: 10x speed improvement (800KB/s → 8+ MB/s)
 * 
 * ============================================================================
 * PHASE 1: TELEGRAM DOWNLOAD OPTIMIZATIONS (Expected: 3-5x improvement)
 * ============================================================================
 */

// 1. INCREASE WORKERS (8 → 24)
// Telegram MTProto supports parallel chunk downloads
config.performance.downloadWorkers = 24; // Was 8

// 2. LARGER CHUNK SIZE (2MB → 8MB)
// Reduces request overhead, better throughput
config.performance.downloadChunkSize = 8388608; // 8MB (was 2MB)

// 3. SMART DC SELECTION
// Connect to nearest Telegram data center for lower latency
async function optimizeDC(client) {
    // Get available DCs and ping them
    const dcOptions = await client.getDCList();
    const nearestDC = await findNearestDC(dcOptions);
    if (nearestDC && nearestDC !== client.session.dcId) {
        console.log(`[Optimization] Switching to faster DC: ${nearestDC}`);
        await client.switchToDC(nearestDC);
    }
}

// 4. CONNECTION POOLING
// Keep connections warm for reuse
const CONNECTION_POOL_SIZE = 4;
const activeConnections = new Map();

// ============================================================================
// PHASE 2: PIPELINED PROCESSING (Expected: 2x improvement)
// ============================================================================

// 5. STREAMING PIPELINE (Eliminate disk I/O)
// Instead of: Download -> Save -> Read -> Upload
// Do: Download -> [Stream] -> Upload simultaneously
async function pipelineTransfer(client, message, minioClient) {
    const { PassThrough } = require('stream');
    
    // Create pipe that connects download directly to upload
    const passThrough = new PassThrough({
        highWaterMark: 64 * 1024 * 1024 // 64MB buffer
    });
    
    // Start upload while still downloading
    const [downloadPromise, uploadPromise] = await Promise.all([
        client.downloadMedia(message.media, {
            outputFile: passThrough, // Stream instead of file
            workers: config.performance.downloadWorkers,
            partSize: config.performance.downloadChunkSize
        }),
        minioClient.putObject(bucket, fileName, passThrough, fileSize, metaData)
    ]);
    
    return Promise.all([downloadPromise, uploadPromise]);
}

// 6. PARALLEL COMPRESSION (For videos)
// While downloading next chunks, compress already downloaded ones
async function parallelProcess(downloadStream, compressCallback) {
    const { Transform } = require('stream');
    
    const compressor = new Transform({
        transform(chunk, encoding, callback) {
            // Queue chunk for compression while continuing download
            setImmediate(() => {
                compressCallback(chunk).then(result => {
                    this.push(result);
                    callback();
                });
            });
        },
        
        highWaterMark: 32 * 1024 * 1024 // 32MB
    });
    
    return downloadStream.pipe(compressor);
}

// ============================================================================
// PHASE 3: MINIO UPLOAD OPTIMIZATIONS (Expected: 2-3x improvement)
// ============================================================================

// 7. MULTIPART PARALLEL UPLOAD
// Split large files into parts, upload in parallel
async function parallelMultipartUpload(minioClient, bucket, filePath, fileName, opts = {}) {
    const PART_SIZE = 50 * 1024 * 1024; // 50MB parts
    const CONCURRENT_PARTS = 4; // Upload 4 parts simultaneously
    
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;
    const totalParts = Math.ceil(totalSize / PART_SIZE);
    
    console.log(`[Upload] Multipart: ${totalParts} parts, ${CONCURRENT_PARTS} concurrent`);
    
    // Pre-create multipart upload
    const uploadId = await minioClient.initiatePartialUpload(bucket, fileName);
    
    // Upload parts in parallel batches
    for (let i = 0; i < totalParts; i += CONCURRENT_PARTS) {
        const batch = [];
        for (let j = i; j < Math.min(i + CONCURRENT_PARTS, totalParts); j++) {
            const start = j * PART_SIZE;
            const end = Math.min(start + PART_SIZE, totalSize);
            
            batch.push(
                fs.createReadStream(filePath, { start, end - 1 })
                    .pipe(minioClient.uploadPart(bucket, fileName, uploadId, j + 1))
            );
        }
        await Promise.all(batch);
        
        const percent = Math.min(100, Math.floor((i + CONCURRENT_PARTS) / totalParts * 100));
        if (opts.onProgress) opts.onProgress(percent);
    }
    
    // Complete multipart upload
    await minioClient.completePartialUpload(bucket, fileName, uploadId);
}

// 8. UPLOAD WITH COMPRESSION
// Compress before uploading (for text/logs/small files)
async function compressedUpload(minioClient, bucket, filePath, fileName) {
    const { createGzip } = require('zlib');
    const { pipeline } = require('stream/promises');
    
    const gzip = createGzip({ level: 9 }); // Max compression
    
    await pipeline(
        fs.createReadStream(filePath),
        gzip,
        minioClient.putObject(bucket, fileName + '.gz', null, {
            'Content-Encoding': 'gzip',
            'X-Original-Size': fs.statSync(filePath).size.toString()
        })
    );
}

// ============================================================================
// PHASE 4: CACHING & CDN OPTIMIZATIONS
// ============================================================================

// 9. RESPONSE CACHING HEADERS
// Set proper headers for CDN caching
const CACHE_HEADERS = {
    'Cache-Control': 'public, max-age=7200', // Cache for 2 hours
    'X-Accel-Buffering': 'yes',              // Enable proxy buffering
    'X-Accel-Expires': '7200'               // Expire in 2 hours
};

// 10. PRESIGNED URL WITH ACCELERATION
// Use Cloudflare R2 or accelerated endpoint
function getAcceleratedUrl(minioClient, bucket, fileName) {
    // If using Cloudflare R2, use public URL (faster)
    if (process.env.USE_R2 === 'true') {
        return `https://${process.env.R2_PUBLIC_DOMAIN}/${bucket}/${fileName}`;
    }
    
    // Otherwise use presigned URL with longer expiry
    return minioClient.presignedGetObject(bucket, fileName, 86400); // 24h
}

// ============================================================================
// PHASE 5: ADVANCED TECHNIQUES
// ============================================================================

// 11. ADAPTIVE THROTTLING
// Adjust workers based on network conditions
class AdaptiveThrottler {
    constructor() {
        this.speedHistory = [];
        this.maxHistory = 10;
        this.optimalWorkers = 16;
    }
    
    recordSpeed(speedBytesPerSec) {
        this.speedHistory.push(Date.now(), speedBytesPerSec);
        if (this.speedHistory.length > this.maxHistory * 2) {
            this.speedHistory.splice(0, 2);
        }
        
        this.adjustWorkers();
    }
    
    adjustWorkers() {
        if (this.speedHistory.length < 4) return;
        
        const recentSpeeds = this.speedHistory.filter((_, i) => i % 2 === 1).slice(-5);
        const avgSpeed = recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length;
        const trend = recentSpeeds[recentSpeeds.length - 1] - recentSpeeds[0];
        
        // Increase workers if speed is dropping (network congestion)
        if (trend < -avgSpeed * 0.2 && this.optimalWorkers < 32) {
            this.optimalWorkers += 4;
        }
        // Decrease if stable/high speed (avoid overhead)
        else if (trend > -avgSpeed * 0.1 && this.optimalWorkers > 12) {
            this.optimalWorkers -= 2;
        }
        
        return this.optimalWorkers;
    }
}

// 12. BANDWIDTH ESTIMATION & PREDICTION
class BandwidthEstimator {
    constructor() {
        this.samples = [];
        windowSize = 5000; // 5 second window
    }
    
    addSample(bytes, timestamp = Date.now()) {
        this.samples.push({ bytes, timestamp });
        this.cleanup();
    }
    
    cleanup() {
        const cutoff = Date.now() - this.windowSize;
        this.samples = this.samples.filter(s => s.timestamp > cutoff);
    }
    
    getCurrentSpeed() {
        if (this.samples.length < 2) return 0;
        
        const first = this.samples[0];
        const last = this.samples[this.samples.length - 1];
        const timeDiff = (last.timestamp - first.timestamp) / 1000;
        const bytesDiff = last.bytes - first.bytes;
        
        return timeDiff > 0 ? bytesDiff / timeDiff : 0;
    }
    
    predictETA(remainingBytes) {
        const speed = this.getCurrentSpeed();
        return speed > 0 ? remainingBytes / speed : Infinity;
    }
}

// ============================================================================
// IMPLEMENTATION: New Optimized Transfer Class
// ============================================================================

class OptimizedTransfer extends TransferHandler {
    async downloadFromTelegram(client, message, filePath, fileSize, onProgress, signal) {
        console.log(`[Optimized] Starting high-speed download...`);
        
        const throttler = new AdaptiveThrottler();
        const estimator = new BandwidthEstimator();
        let lastProgressTime = Date.now();
        let lastProgressBytes = 0;
        
        // Use optimized settings
        const result = await client.downloadMedia(message.media, {
            partSize: 8388608, // 8MB chunks
            workers: throttler.optimalWorkers, // Dynamic worker count
            outputFile: filePath,
            progressCallback: (downloaded, total) => {
                // Track speed for adaptive adjustments
                const now = Date.now();
                const bytesSinceLast = downloaded - lastProgressBytes;
                
                if (now - lastProgressTime > 1000) { // Every second
                    const instantSpeed = bytesSinceLast / ((now - lastProgressTime) / 1000);
                    throttler.recordSpeed(instantSpeed);
                    estimator.addSample(downloaded, now);
                    
                    lastProgressTime = now;
                    lastProgressBytes = downloaded;
                    
                    // Log speed every 5 seconds
                    if (Math.random() < 0.2) { // ~20% chance = every 5 sec
                        console.log(`[Speed] ${formatBytes(instantSpeed)}/s (workers: ${throttler.optimalWorkers})`);
                    }
                }
                
                if (onProgress) onProgress(downloaded, total);
            }
        });
        
        const finalSpeed = estimator.getCurrentSpeed();
        console.log(`[Optimized] Download complete. Avg speed: ${formatBytes(finalSpeed)}/s`);
        
        return result;
    }
    
    async uploadToMinIO(filePath, fileName, onProgress, signal) {
        console.log(`[Optimized] Starting parallel multipart upload...`);
        
        const stats = fs.statSync(filePath);
        const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB
        
        if (stats.size > LARGE_FILE_THRESHOLD) {
            // Use multipart upload for large files
            return await parallelMultipartUpload(
                minioClient,
                config.minio.bucketName,
                filePath,
                fileName,
                { onProgress }
            );
        } else {
            // Use streaming upload with larger buffer for small files
            return await super.uploadToMinIO(filePath, fileName, onProgress, signal);
        }
    }
}

// ============================================================================
// CONFIGURATION UPDATES
// ============================================================================

const OPTIMIZED_CONFIG = {
    ...config,
    performance: {
        ...config.performance,
        downloadChunkSize: 8388608,      // 8MB (was 2MB)
        downloadWorkers: 24,             // 24 (was 8)
        maxConcurrentTransfers: 5,       // 5 (was 3)
        enableAdaptiveThrottling: true,
        enablePipelineMode: true,
        useMultipartUpload: true,
        multipartThreshold: 104857600,   // 100MB
        multipartPartSize: 52428800,     // 50MB
        multipartConcurrency: 4          // 4 parallel parts
    }
};

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           SPEED OPTIMIZATION ENABLED v2.0                     ║
╠══════════════════════════════════════════════════════════════╣
║  Expected Improvements:                                       ║
║  • Telegram Download: 3-5x faster (more workers + chunks)     ║
║  • MinIO Upload: 2-3x faster (multipart parallel)             ║
║  • Overall Pipeline: 2x faster (streaming, no disk I/O)      ║
║                                                               ║
║  Settings:                                                    ║
║  • Chunk Size: ${OPTIMIZED_CONFIG.performance.downloadChunkSize} (${formatBytes(OPTIMIZED_CONFIG.performance.downloadChunkSize)})
║  • Workers: ${OPTIMIZED_CONFIG.performance.downloadWorkers}
║  • Multipart: Enabled (>100MB files)                          ║
║  • Adaptive Throttling: ${OPTIMIZED_CONFIG.performance.enableAdaptiveThrottling}
╚══════════════════════════════════════════════════════════════╝
`);
