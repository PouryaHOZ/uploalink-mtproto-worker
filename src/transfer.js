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
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '16'),
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

const SYSTEM_VERSION = '0.5.7';

function renderProgressCard({ fileName, masterPercent, stageName, stagePercent, speedText, etaText, detailsText }) {
    const masterBar = drawProgressBar(masterPercent, 12);
    const stageBar = drawProgressBar(stagePercent, 10);

    let card = `🎬 <b>پردازش فایل:</b> <code>${escapeHtml(fileName)}</code> (v${SYSTEM_VERSION})\n\n`;
    card += `📊 <b>پیشرفت کل:</b>\n<code>[${masterBar}] ${masterPercent}%</code>\n\n`;
    card += `🔄 <b>مرحله جاری:</b> ${stageName}\n`;
    card += `<code>[${stageBar}] ${stagePercent}%</code>\n`;

    if (detailsText) card += `⚖️ <b>حجم:</b> ${detailsText}\n`;
    if (speedText) card += `⚡ <b>سرعت:</b> ${speedText}\n`;
    if (etaText) card += `⏱️ <b>زمان تقریبی باقی‌مانده:</b> ${etaText}\n`;

    return card;
}

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
        this.activeFFmpegProcess = null;
        this.isCriticalSection = false;
    }

    async checkCancel() {
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

    runFFmpeg(args, onProgress) {
        return new Promise((resolve, reject) => {
            const fullArgs = ['-progress', 'pipe:1', ...args];
            this.activeFFmpegProcess = spawn('ffmpeg', fullArgs);
            
            let totalDurationSec = 0;
            let errorLog = '';

            this.activeFFmpegProcess.stderr.on('data', data => {
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

            this.activeFFmpegProcess.stdout.on('data', data => {
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

            this.activeFFmpegProcess.on('close', code => {
                this.activeFFmpegProcess = null;
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg Error: ${errorLog.slice(-300).replace(/\n/g, ' ').trim()}`));
            });

            this.activeFFmpegProcess.on('error', err => {
                this.activeFFmpegProcess = null;
                reject(err);
            });
        });
    }

    async uploadToMinIO(filePath, fileName, onProgress) {
        const bucket = config.minio.bucketName;
        const metaData = { 'Content-Type': fileName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream' };
        const stats = await fs.promises.stat(filePath);
        const totalSize = stats.size;

        await withRetry('MinIO File Upload', async () => {
            const fileStream = fs.createReadStream(filePath);
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
        }, 3, 5000);

        return await minioClient.presignedGetObject(bucket, fileName, 7200);
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

            await this.updateStatus(chatId, renderProgressCard({
                fileName, masterPercent: 40, stageName: '🧹 پاکسازی و آماده‌سازی حافظه', stagePercent: 100
            }), true);
            
            await this.manageStorage(fileSize);

            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("پیام یا فایل در تلگرام یافت نشد.");

            const writeStream = fs.createWriteStream(downloadedFilePath, { highWaterMark: 16 * 1024 * 1024 });
            let lastProgressUpdate = 0;
            let lastCancelCheck = 0;

            const adaptiveWorkers = fileSize > 50 * 1024 * 1024 ? Math.min(config.performance.downloadWorkers, 20) : 6;

            await client.downloadMedia(messages[0].media, {
                partSize: 512 * 1024,
                outputFile: writeStream,
                workers: adaptiveWorkers,
                progressCallback: (downloaded, total) => {
                    const now = Date.now();

                    if (now - lastCancelCheck >= 3000) {
                        lastCancelCheck = now;
                        this.checkCancel().then(cancelled => {
                            if (cancelled) {
                                writeStream.destroy();
                            }
                        }).catch(() => {});
                    }

                    if (now - lastProgressUpdate >= 3000 || downloaded === total) {
                        lastProgressUpdate = now;
                        const subPercent = total ? Math.floor((downloaded / total) * 100) : 0;
                        const masterPercent = Math.min(65, 40 + Math.floor(subPercent * 0.25));
                        const elapsedSec = (now - startTime) / 1000;
                        const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                        const eta = speed > 0 ? (total - downloaded) / speed : 0;

                        const text = renderProgressCard({
                            fileName,
                            masterPercent,
                            stageName: '📥 دریافت فایل از تلگرام',
                            stagePercent: subPercent,
                            detailsText: `${formatBytes(downloaded)} / ${formatBytes(total)}`,
                            speedText: formatSpeed(speed),
                            etaText: formatEta(eta)
                        });

                        this.updateStatus(chatId, text, false).catch(() => {});
                    }
                }
            });

            targetPath = downloadedFilePath;

            if (isVideo) {
                if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");

                fileName = `${path.parse(fileName).name}.mp4`;
                const processedPath = path.join(config.performance.tempDir, `processed_${Date.now()}.mp4`);
                
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
                    });
                    targetPath = processedPath;
                } catch (ffmpegErr) {
                    if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");
                    throw new Error(`مشکل در ساختار فایل ویدیو.\n\nجزئیات فنی: ${ffmpegErr.message}`);
                } finally {
                    clearInterval(cancelCheckInterval);
                }
            }

            if (await this.checkCancel()) throw new Error("انتقال توسط کاربر لغو شد.");
            this.isCriticalSection = true;

            const downloadLink = await this.uploadToMinIO(targetPath, fileName, (subPercent, sizeText, speedText, etaText) => {
                const now = Date.now();
                if (now - lastProgressUpdate >= 3500 || subPercent === 100) {
                    lastProgressUpdate = now;
                    const baseMaster = isVideo ? 85 : 65;
                    const masterSpan = isVideo ? 13 : 33;
                    const masterPercent = Math.min(98, baseMaster + Math.floor(subPercent * (masterSpan / 100)));

                    const text = renderProgressCard({
                        fileName,
                        masterPercent,
                        stageName: '☁️ آپلود به سرور ابری (غیرقابل لغو)',
                        stagePercent: subPercent,
                        detailsText: sizeText,
                        speedText: speedText,
                        etaText: etaText
                    });

                    this.updateStatus(chatId, text, false, false).catch(() => {});
                }
            });

            const actualSize = (await fs.promises.stat(targetPath)).size;
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
