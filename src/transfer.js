const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");

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
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '8'),
        tempDir: TEMP_DIR
    },
    cloudflare: {
        webhookUrl: process.env.CLOUDFLARE_WEBHOOK_URL || '',
        apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
    },
    transferId: process.env.TRANSFER_ID || ''
};

if (!fs.existsSync(config.performance.tempDir)) fs.mkdirSync(config.performance.tempDir, { recursive: true });

const minioClient = new Minio.Client({
    endPoint: config.minio.endPoint, port: config.minio.port, useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey, secretKey: config.minio.secretKey, region: config.minio.region
});

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

function renderProgressCard({ fileName, masterPercent, stageName, stagePercent, speedText, etaText, detailsText }) {
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);

    let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code>\n\n`;
    card += `📊 <b>پیشرفت کل:</b>\n<code>[${masterBar}] ${masterPercent}%</code>\n\n`;
    card += `🔄 <b>مرحله جاری:</b> ${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;

    if (detailsText) card += `⚖️ <b>حجم:</b> ${detailsText}\n`;
    if (speedText) card += `⚡ <b>سرعت:</b> ${speedText}\n`;
    if (etaText) card += `⏱️ <b>زمان تقریبی باقی‌مانده:</b> ${etaText}\n`;

    return card;
}

// 🔄 INTERNAL RETRY WRAPPER FOR NETWORK RESILIENCY
async function withRetry(operationName, operation, retries = 3, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
        try {
            return await operation();
        } catch (err) {
            if (i === retries) throw err;
            console.warn(`[Retry] ${operationName} failed. Retrying (${i}/${retries}) in ${delay/1000}s... Error: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(new StringSession(config.telegram.sessionString), config.telegram.apiId, config.telegram.apiHash, { connectionRetries: 5, useWSS: false });
        this.isConnected = false;
    }
    async connect() { if (!this.isConnected) { await this.client.connect(); this.isConnected = true; } }
    async disconnect() { if (this.isConnected) { await this.client.disconnect(); this.isConnected = false; } }
}

class FileTransferBot {
    constructor() {
        this.telegramClient = new TelegramClientManager();
        this.statusMessageId = null;
        this.isUpdatingStatus = false;
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

    runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            let errorLog = '';
            ffmpeg.stderr.on('data', data => errorLog += data.toString());
            ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg Error: ${errorLog.slice(-300).replace(/\n/g, ' ').trim()}`)));
            ffmpeg.on('error', err => reject(err));
        });
    }

    async uploadToMinIO(filePath, fileName) {
        const bucket = config.minio.bucketName;
        const metaData = { 'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream' };
        
        // Wrap MinIO upload in fault-tolerant retry loop
        await withRetry('MinIO File Upload', async () => {
            await minioClient.fPutObject(bucket, fileName, filePath, metaData);
        }, 3, 5000); // 3 Retries, 5 seconds apart

        return await minioClient.presignedGetObject(bucket, fileName, 7200); // 2 hour expiry limit
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

        try {
            await this.telegramClient.connect();
            downloadedFilePath = path.join(config.performance.tempDir, fileName);
            const client = this.telegramClient.client;

            await this.updateStatus(chatId, `🚀 <b>عملیات آغاز شد</b>\n\n<code>[████░░░░░░] 40%</code>\n🔄 <b>سرور پردازش ابری متصل شد. در حال آزادسازی فضا...</b>`, true);
            await this.manageStorage(fileSize);

            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("پیام یا فایل در تلگرام یافت نشد.");

            const writeStream = fs.createWriteStream(downloadedFilePath, { highWaterMark: 4 * 1024 * 1024 });
            let lastProgressUpdate = 0;

            await client.downloadMedia(messages[0].media, {
                outputFile: writeStream,
                workers: config.performance.downloadWorkers,
                progressCallback: (downloaded, total) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 4000 || downloaded === total) {
                        lastProgressUpdate = now;
                        const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                        this.updateStatus(chatId, `📥 <b>در حال دانلود از تلگرام...</b>\n\n<code>[██████░░░░] 60%</code>\n${drawProgressBar(percent)} <b>${percent}%</b>\n📊 <b>حجم:</b> ${formatBytes(downloaded)} / ${formatBytes(total)}`, false).catch(() => {});
                    }
                }
            });

            targetPath = downloadedFilePath;

            if (isVideo) {
                await this.updateStatus(chatId, `⚙️ <b>در حال پردازش و بهینه‌سازی ویدیو...</b>\n\n<code>[████████░░] 80%</code>\n(این مرحله بسته به حجم ویدیو ممکن است طول بکشد)`, true);
                
                fileName = `${path.parse(fileName).name}.mp4`;
                const processedPath = path.join(config.performance.tempDir, `processed_${Date.now()}.mp4`);
                
                try {
                    // DYNAMIC SCALING ENGINE
                    // 1280px bounds = 720p Max (Standard)
                    // 854px bounds  = 480p Max (Lightweight)
                    const maxDim = shouldCompress ? 854 : 1280;
                    
                    // Decrease Aspect Ratio ensures it ONLY scales down, NEVER upscales.
                    // Pad ensures coordinates are even numbers to prevent x264 codec errors.
                    const scaleFilter = `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
                    
                    // CRF 23 = Standard acceptable compression (visually lossless).
                    // CRF 28 = High compression (Lightweight mode).
                    const crfValue = shouldCompress ? '28' : '23';
                    const audioBitrate = shouldCompress ? '64k' : '128k';

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
                    ]);
                    targetPath = processedPath;
                } catch (ffmpegErr) {
                    throw new Error(`مشکل در ساختار فایل ویدیو.\n\nجزئیات فنی: ${ffmpegErr.message}`);
                }
            }

            const actualSize = (await fs.promises.stat(targetPath)).size;
            
            await this.updateStatus(chatId, `☁️ <b>در حال ذخیره در فضای ابری...</b>\n\n<code>[█████████░] 90%</code>\n📤 <b>آپلود به زودی به پایان می‌رسد.</b>`, true);
            const downloadLink = await this.uploadToMinIO(targetPath, fileName);

            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            
            const successMsg = `✅ <b>انتقال کامل شد!</b>\n\n<code>[██████████] 100%</code>\n📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n📏 <b>حجم:</b> ${formatBytes(actualSize)}\n⏱️ <b>زمان:</b> ${elapsedTime} ثانیه\n⚠️ <b>لینک پس از ۲ ساعت منقضی و فایل به صورت خودکار حذف می‌شود.</b>\n\n🔗 <a href="${downloadLink}">👉 لینک دانلود مستقیم 👈</a>`;

            await this.updateStatus(chatId, successMsg, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'completed' });

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            const isNetworkError = err.message.includes('TCPFull') || err.message.includes('fetch') || err.message.includes('ECONNRESET') || err.message.includes('Timeout');
            await this.updateStatus(chatId, `❌ <b>خطا در انجام عملیات:</b>\n<code>${escapeHtml(err.message)}</code>${isNetworkError ? '\n\n🔄 در حال بازگشت به صف برای تلاش مجدد...' : ''}`, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'failed', error: err.message, retryable: isNetworkError });
        } finally {
            if (downloadedFilePath) await this.cleanupFile(downloadedFilePath);
            if (targetPath && targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            process.exit(0);
        }
    }

    async cleanupFile(filePath) {
        try { if (fs.existsSync(filePath)) await fs.promises.unlink(filePath); } catch (e) { }
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

new FileTransferBot().start();