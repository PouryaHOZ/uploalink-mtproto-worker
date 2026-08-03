const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Minio = require("minio");

const TEMP_DIR = fs.existsSync("/dev/shm") ? "/dev/shm/temp_transfers" : "./temp_transfers";

// Clean endpoint formatting in case https:// was pasted
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
    }
};

if (!fs.existsSync(config.performance.tempDir)) {
    fs.mkdirSync(config.performance.tempDir, { recursive: true });
}

// Initialize MinIO Client
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

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return "۰ بایت/ثانیه";
    const k = 1024;
    const sizes = ["بایت/ثانیه", "کیلوبایت/ثانیه", "مگابایت/ثانیه", "گیگابایت/ثانیه"];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function drawProgressBar(percent, length = 12) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(
            new StringSession(config.telegram.sessionString),
            config.telegram.apiId,
            config.telegram.apiHash,
            {
                connectionRetries: 5,
                useWSS: false
            }
        );
        this.isConnected = false;
    }

    async connect() {
        if (!this.isConnected) {
            await this.client.connect();
            this.isConnected = true;
        }
    }

    async disconnect() {
        if (this.isConnected) {
            await this.client.disconnect();
            this.isConnected = false;
        }
    }
}

class FileTransferBot {
    constructor() {
        this.telegramClient = new TelegramClientManager();
        this.statusMessageId = null;
        this.isUpdatingStatus = false;
    }

    async updateStatus(chatId, text, force = false) {
        if (!config.telegram.botToken || !chatId) return;

        // Skip non-critical updates if busy
        if (this.isUpdatingStatus && !force) return;

        // For critical updates (e.g. final link), wait for active lock to release
        while (this.isUpdatingStatus) {
            await new Promise(r => setTimeout(r, 100));
        }

        this.isUpdatingStatus = true;

        try {
            const endpoint = this.statusMessageId ? 'editMessageText' : 'sendMessage';
            const body = {
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            };

            if (this.statusMessageId) {
                body.message_id = this.statusMessageId;
            }

            const res = await fetch(`${config.telegram.baseUrl}/bot${config.telegram.botToken}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(r => r.json());

            if (res.ok && res.result) {
                if (!this.statusMessageId) {
                    this.statusMessageId = res.result.message_id;
                }
            } else {
                console.error(`Telegram API error on ${endpoint}:`, res);
                // Fallback to sending a new message if editing failed
                if (endpoint === 'editMessageText') {
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
            }
        } catch (e) {
            console.error("Failed to update status message:", e);
        } finally {
            this.isUpdatingStatus = false;
        }
    }

    runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            let errorLog = '';

            ffmpeg.stderr.on('data', data => {
                errorLog += data.toString();
            });

            ffmpeg.on('close', code => {
                if (code === 0) {
                    resolve();
                } else {
                    const cleanLog = errorLog.slice(-300).replace(/\n/g, ' ').trim();
                    reject(new Error(`کد ${code}: ${cleanLog}`));
                }
            });

            ffmpeg.on('error', err => reject(err));
        });
    }

    async uploadToMinIO(filePath, fileName) {
        const bucket = config.minio.bucketName;

        const exists = await minioClient.bucketExists(bucket).catch(() => false);
        if (!exists) {
            await minioClient.makeBucket(bucket, config.minio.region);
        }

        const metaData = {
            'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream'
        };

        await minioClient.fPutObject(bucket, fileName, filePath, metaData);

        const expirySeconds = 7 * 24 * 60 * 60;
        const presignedUrl = await minioClient.presignedGetObject(bucket, fileName, expirySeconds);

        return presignedUrl;
    }

    async start() {
        const startTime = Date.now();
        let downloadedFilePath = '';
        let targetPath = '';
        const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';

        try {
            await this.telegramClient.connect();

            const messageId = process.env.MESSAGE_ID || '0';
            let fileName = process.env.FILE_NAME || `file_${Date.now()}`;
            const fileSize = parseInt(process.env.FILE_SIZE || '0');
            const isVideo = process.env.IS_VIDEO === 'true';
            const shouldCompress = process.env.SHOULD_COMPRESS === 'true';

            downloadedFilePath = path.join(config.performance.tempDir, fileName);
            const client = this.telegramClient.client;

            await this.updateStatus(chatId, `🚀 <b>انتقال آغاز شد!</b>\n\n📥 <b>در حال برقراری ارتباط با سرور...</b>`, true);

            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) {
                throw new Error("پیام یا فایل در تلگرام یافت نشد.");
            }

            console.log(`[Start] Downloading message ${messageId} (${fileName})...`);
            
            const writeStream = fs.createWriteStream(downloadedFilePath, {
                highWaterMark: 4 * 1024 * 1024 
            });

            let lastProgressUpdate = 0;

            await client.downloadMedia(messages[0].media, {
                outputFile: writeStream,
                workers: config.performance.downloadWorkers,
                progressCallback: (downloaded, total) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 4000 || downloaded === total) {
                        lastProgressUpdate = now;
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? downloaded / elapsed : 0;
                        const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                        const bar = drawProgressBar(percent);

                        const progressMsg = `📥 <b>در حال دریافت از تلگرام:</b>\n` +
                                            `${bar} <b>${percent}%</b>\n` +
                                            `📊 <b>حجم:</b> ${formatBytes(downloaded)} / ${formatBytes(total)}\n` +
                                            `⚡ <b>سرعت:</b> ${formatSpeed(speed)}`;

                        this.updateStatus(chatId, progressMsg, false).catch(() => {});
                    }
                }
            });

            targetPath = downloadedFilePath;

            if (isVideo) {
                const parsedPath = path.parse(fileName);
                fileName = `${parsedPath.name}.mp4`;
                const processedPath = path.join(config.performance.tempDir, `processed_${Date.now()}.mp4`);

                try {
                    if (shouldCompress) {
                        await this.updateStatus(chatId, `⚙️ <b>در حال فشرده‌سازی ویدیو به کیفیت 480p...</b>`, true);
                        await this.runFFmpeg([
                            '-i', downloadedFilePath,
                            '-threads', '0',
                            '-c:v', 'libx264',
                            '-crf', '28',
                            '-preset', 'ultrafast',
                            '-vf', 'scale=-2:480',
                            '-c:a', 'aac',
                            '-b:a', '128k',
                            '-movflags', '+faststart',
                            '-y', processedPath
                        ]);
                    } else {
                        await this.updateStatus(chatId, `⚙️ <b>در حال همگام‌سازی فرمت ویدیو برای پخش مستقیم...</b>`, true);
                        await this.runFFmpeg([
                            '-i', downloadedFilePath,
                            '-c', 'copy',
                            '-movflags', '+faststart',
                            '-y', processedPath
                        ]);
                    }
                    targetPath = processedPath;
                } catch (ffmpegErr) {
                    throw new Error(`فرمت این ویدیو پشتیبانی نمی‌شود یا فایل آسیب دیده است.\n\nجزئیات فنی: ${ffmpegErr.message}`);
                }
            }

            const stats = await fs.promises.stat(targetPath);
            const actualSize = stats.size;

            await this.updateStatus(chatId, `☁️ <b>در حال آپلود فایل در هاست MinIO...</b>`, true);
            const downloadLink = await this.uploadToMinIO(targetPath, fileName);

            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            const successMsg = `✅ <b>انتقال با موفقیت کامل شد!</b>\n\n` +
                               `📁 <b>نام فایل:</b> <code>${escapeHtml(fileName)}</code>\n` +
                               `📏 <b>حجم نهایی:</b> ${formatBytes(actualSize)}\n` +
                               `⏱️ <b>زمان کل:</b> ${elapsedTime} ثانیه\n\n` +
                               `🔗 <b>لینک دانلود مستقیم (اعتبار ۷ روز):</b>\n<a href="${downloadLink}">👉 برای دانلود فایل اینجا کلیک کنید 👈</a>`;

            await this.updateStatus(chatId, successMsg, true);

            await this.notifyCloudflare({
                event: 'transfer_completed',
                fileId: messageId,
                downloadLink,
                originalSize: fileSize || actualSize,
                compressed: shouldCompress,
                elapsedTime
            });

            await this.cleanupFile(downloadedFilePath);
            if (targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            process.exit(0);

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            await this.updateStatus(chatId, `❌ <b>خطا در انجام انتقال:</b>\n<code>${escapeHtml(err.message || String(err))}</code>`, true);

            await this.notifyCloudflare({
                event: 'transfer_error',
                error: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString()
            });

            if (downloadedFilePath) await this.cleanupFile(downloadedFilePath);
            if (targetPath && targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            process.exit(1);
        }
    }

    async cleanupFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
        } catch (e) { console.error(`Error deleting ${filePath}:`, e); }
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
        } catch (error) {
            console.error("Error posting status webhook to Cloudflare:", error);
        }
    }
}

new FileTransferBot().start();