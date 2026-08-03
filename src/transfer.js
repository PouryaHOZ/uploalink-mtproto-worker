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

if (!fs.existsSync(config.performance.tempDir)) {
    fs.mkdirSync(config.performance.tempDir, { recursive: true });
}

const minioClient = new Minio.Client({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    region: config.minio.region
});

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "۰ بایت";
    const k = 1024;
    const sizes = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        const MAX_STORAGE = 9.5 * 1024 * 1024 * 1024; // 9.5 GB
        const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
        const now = Date.now();

        const exists = await minioClient.bucketExists(bucket).catch(() => false);
        if (!exists) {
            await minioClient.makeBucket(bucket, config.minio.region);
            return;
        }

        const objects = await new Promise((resolve, reject) => {
            const objs = [];
            const stream = minioClient.listObjectsV2(bucket, '', true);
            stream.on('data', obj => objs.push(obj));
            stream.on('error', reject);
            stream.on('end', () => resolve(objs));
        });

        let currentSize = 0;
        const toDelete = [];
        const keptObjects = [];

        // 1. Mandatory Expiry: Delete anything older than 2 hours
        for (const obj of objects) {
            const ageMs = now - new Date(obj.lastModified).getTime();
            if (ageMs > TWO_HOURS_MS) {
                toDelete.push(obj.name);
            } else {
                currentSize += obj.size;
                keptObjects.push(obj);
            }
        }

        // 2. Capacity Constraints: Delete oldest if exceeding 9.5GB limit
        if (currentSize + requiredBytes > MAX_STORAGE) {
            keptObjects.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
            for (const obj of keptObjects) {
                toDelete.push(obj.name);
                currentSize -= obj.size;
                if (currentSize + requiredBytes <= MAX_STORAGE) break;
            }
        }

        if (toDelete.length > 0) {
            await minioClient.removeObjects(bucket, toDelete);
            console.log(`Storage Manager: Swept ${toDelete.length} objects to free space.`);
        }
    }

    runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            let errorLog = '';
            ffmpeg.stderr.on('data', data => errorLog += data.toString());
            ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg Exit ${code}: ${errorLog.slice(-300).replace(/\n/g, ' ').trim()}`)));
            ffmpeg.on('error', err => reject(err));
        });
    }

    async uploadToMinIO(filePath, fileName) {
        const bucket = config.minio.bucketName;
        const metaData = { 'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream' };
        await minioClient.fPutObject(bucket, fileName, filePath, metaData);
        // Expiry strictly set to 2 hours (7200 seconds)
        return await minioClient.presignedGetObject(bucket, fileName, 7200);
    }

    async start() {
        const startTime = Date.now();
        let downloadedFilePath = '';
        let targetPath = '';
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

            await this.updateStatus(chatId, `🚀 <b>انتقال آغاز شد!</b>\n\n🧹 <b>در حال پاکسازی حافظه و آزادسازی فضا...</b>`, true);
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
                        this.updateStatus(chatId, `📥 <b>در حال دریافت:</b>\n${drawProgressBar(percent)} <b>${percent}%</b>\n📊 <b>حجم:</b> ${formatBytes(downloaded)} / ${formatBytes(total)}`, false).catch(() => {});
                    }
                }
            });

            targetPath = downloadedFilePath;

            if (isVideo) {
                fileName = `${path.parse(fileName).name}.mp4`;
                const processedPath = path.join(config.performance.tempDir, `processed_${Date.now()}.mp4`);
                try {
                    await this.updateStatus(chatId, `⚙️ <b>در حال ${shouldCompress ? 'فشرده‌سازی ویدیو' : 'همگام‌سازی فرمت'}...</b>`, true);
                    const ffmpegArgs = shouldCompress 
                        ? ['-i', downloadedFilePath, '-threads', '0', '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-vf', 'scale=-2:480', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', processedPath]
                        : ['-i', downloadedFilePath, '-c', 'copy', '-movflags', '+faststart', '-y', processedPath];
                    await this.runFFmpeg(ffmpegArgs);
                    targetPath = processedPath;
                } catch (ffmpegErr) {
                    throw new Error(`فرمت این ویدیو پشتیبانی نمی‌شود.\n\nجزئیات فنی: ${ffmpegErr.message}`);
                }
            }

            const actualSize = (await fs.promises.stat(targetPath)).size;
            await this.updateStatus(chatId, `☁️ <b>در حال آپلود در هاست ابری (اعتبار لینک: ۲ ساعت)...</b>`, true);
            const downloadLink = await this.uploadToMinIO(targetPath, fileName);

            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            const successMsg = `✅ <b>انتقال کامل شد!</b>\n\n📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n📏 <b>حجم:</b> ${formatBytes(actualSize)}\n⏱️ <b>زمان:</b> ${elapsedTime} ثانیه\n⚠️ <b>لینک پس از ۲ ساعت به صورت خودکار منقضی و حذف می‌شود.</b>\n\n🔗 <a href="${downloadLink}">👉 لینک دانلود مستقیم 👈</a>`;

            await this.updateStatus(chatId, successMsg, true);
            await this.notifyCloudflare({ action: 'action_update', transferId: config.transferId, status: 'completed' });

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            
            // Check if error is transient/network related to decide if it goes back in the queue
            const isNetworkError = err.message.includes('TCPFull') || err.message.includes('fetch') || err.message.includes('ECONNRESET');
            
            await this.updateStatus(chatId, `❌ <b>خطا در انجام انتقال:</b>\n<code>${escapeHtml(err.message)}</code>${isNetworkError ? '\n\n🔄 در حال تلاش مجدد و بازگشت به صف...' : ''}`, true);
            
            await this.notifyCloudflare({ 
                action: 'action_update', 
                transferId: config.transferId, 
                status: 'failed', 
                error: err.message, 
                retryable: isNetworkError 
            });

        } finally {
            if (downloadedFilePath) await this.cleanupFile(downloadedFilePath);
            if (targetPath && targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            process.exit(0); // Exit 0 so GitHub action doesn't mark as failed. The webhook handles logic.
        }
    }

    async cleanupFile(filePath) {
        try { if (fs.existsSync(filePath)) await fs.promises.unlink(filePath); } catch (e) { }
    }

    async notifyCloudflare(payload) {
        if (!config.cloudflare.webhookUrl) return;
        try {
            await fetch(config.cloudflare.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.cloudflare.apiToken}` },
                body: JSON.stringify(payload)
            });
        } catch (error) {
            console.error("Failed to hit Cloudflare Webhook:", error);
        }
    }
}

new FileTransferBot().start();