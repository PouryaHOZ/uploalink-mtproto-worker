const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const FormData = require("form-data");

const TEMP_DIR = fs.existsSync("/dev/shm") ? "/dev/shm/temp_transfers" : "./temp_transfers";

const config = {
    telegram: {
        apiId: parseInt(process.env.TELEGRAM_API_ID || '0'),
        apiHash: process.env.TELEGRAM_API_HASH || '',
        sessionString: process.env.TELEGRAM_SESSION_STRING || '',
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '',
        baseUrl: process.env.TELEGRAM_BASE_URL || 'https://api.telegram.org'
    },
    bale: process.env.BALE_BOT_TOKEN && process.env.BALE_CHAT_ID ? {
        botToken: process.env.BALE_BOT_TOKEN,
        chatId: process.env.BALE_CHAT_ID,
        baseUrl: process.env.BALE_BASE_URL || 'https://tapi.bale.ai'
    } : null,
    rubika: process.env.RUBIKA_BOT_TOKEN && process.env.RUBIKA_CHAT_ID ? {
        botToken: process.env.RUBIKA_BOT_TOKEN,
        chatId: process.env.RUBIKA_CHAT_ID,
        baseUrl: process.env.RUBIKA_BASE_URL || "https://botapi.rubika.ir/v3/"
    } : null,
    performance: {
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '14'),
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '67108864'),
        uploadChunkSize: parseInt(process.env.UPLOAD_CHUNK_SIZE || '16777216'),
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

function drawProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

// Live Chat Status Updater via Telegram Bot API
async function updateTelegramStatus(chatId, text) {
    if (!config.telegram.botToken || !chatId) return;
    try {
        const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        });
    } catch (e) {
        console.error("Failed to update status message:", e);
    }
}

class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(
            new StringSession(config.telegram.sessionString),
            config.telegram.apiId,
            config.telegram.apiHash,
            {
                connectionRetries: 5,
                downloadWorkers: config.performance.downloadWorkers,
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
    }

    async start() {
        const startTime = Date.now();
        let downloadedFilePath = '';
        let targetPath = '';

        try {
            await this.telegramClient.connect();

            const messageId = process.env.MESSAGE_ID || '0';
            const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
            const fileName = process.env.FILE_NAME || `file_${Date.now()}`;
            const fileSize = parseInt(process.env.FILE_SIZE || '0');
            const isVideo = process.env.IS_VIDEO === 'true';
            const rawDestinations = process.env.DESTINATIONS || '';
            const destinations = rawDestinations ? rawDestinations.split(',') : ['bale', 'rubika'];
            const shouldCompress = process.env.SHOULD_COMPRESS === 'true';

            downloadedFilePath = path.join(config.performance.tempDir, fileName);
            const client = this.telegramClient.client;

            await updateTelegramStatus(chatId, `🚀 **انتقال آغاز شد!**\n\n📥 **در حال دریافت فایل از تلگرام...**`);

            // 1. Download via MTProto
            const messages = await client.getMessages(BigInt(chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) {
                throw new Error("پیام یا فایل در تلگرام یافت نشد.");
            }

            console.log(`[Start] Downloading message ${messageId} (${fileName})...`);
            const writeStream = fs.createWriteStream(downloadedFilePath, {
                highWaterMark: config.performance.downloadChunkSize
            });

            let lastProgressUpdate = 0;

            await client.downloadMedia(messages[0].media, {
                outputFile: writeStream,
                workers: config.performance.downloadWorkers,
                progressCallback: async (downloaded, total) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate >= 4000 || downloaded === total) {
                        lastProgressUpdate = now;
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? downloaded / elapsed : 0;
                        const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                        const bar = drawProgressBar(percent);

                        const progressMsg = `📥 **در حال دریافت از تلگرام:**\n` +
                                            `${bar} **${percent}%**\n` +
                                            `📊 **حجم:** ${formatBytes(downloaded)} / ${formatBytes(total)}\n` +
                                            `⚡ **سرعت:** ${formatSpeed(speed)}`;

                        await updateTelegramStatus(chatId, progressMsg);
                    }
                }
            });

            targetPath = downloadedFilePath;

            // 2. Compress Video via FFmpeg
            if (isVideo && shouldCompress) {
                await updateTelegramStatus(chatId, `⚙️ **در حال فشرده‌سازی ویدیو به کیفیت 480p...**`);
                const compressedPath = path.join(config.performance.tempDir, `compressed_${Date.now()}.mp4`);

                await new Promise((resolve, reject) => {
                    const ffmpeg = spawn('ffmpeg', [
                        '-i', downloadedFilePath,
                        '-threads', '0',
                        '-c:v', 'libx264',
                        '-crf', '28',
                        '-preset', 'ultrafast',
                        '-vf', 'scale=-2:480',
                        '-c:a', 'aac',
                        '-b:a', '128k',
                        '-movflags', '+faststart',
                        '-y', compressedPath
                    ]);

                    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
                    ffmpeg.on('error', err => reject(err));
                });

                targetPath = compressedPath;
            }

            const stats = await fs.promises.stat(targetPath);
            const actualSize = stats.size;
            const caption = messages[0].text || messages[0].caption || "";

            // 3. Upload to Bale
            if (destinations.includes('bale') && config.bale) {
                await updateTelegramStatus(chatId, `📤 **در حال ارسال به بله...**`);
                await this.uploadToBale(targetPath, isVideo, fileName, caption, actualSize);
            }

            // 4. Upload to Rubika
            if (destinations.includes('rubika') && config.rubika) {
                await updateTelegramStatus(chatId, `📤 **در حال ارسال به روبیکا...**`);
                await this.uploadToRubikaAsDocument(targetPath, fileName, caption, actualSize);
            }

            const elapsedTime = Math.round((Date.now() - startTime) / 1000);
            const successMsg = `✅ **انتقال با موفقیت کامل شد!**\n\n` +
                               `📁 **فایل:** ${fileName}\n` +
                               `📏 **حجم نهایی:** ${formatBytes(actualSize)}\n` +
                               `⏱️ **زمان کل:** ${elapsedTime} ثانیه`;

            await updateTelegramStatus(chatId, successMsg);

            await this.notifyCloudflare({
                event: 'transfer_completed',
                fileId: messageId,
                originalSize: fileSize || actualSize,
                compressed: shouldCompress,
                destinations,
                elapsedTime
            });

            await this.cleanupFile(downloadedFilePath);
            if (targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            process.exit(0);

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            
            const processChatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
            await updateTelegramStatus(processChatId, `❌ **خطا در انجام انتقال:**\n\`${err.message || String(err)}\``);

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

    async uploadToBale(filePath, isVideo, fileName, caption, fileSize) {
        const BALE_MAX_BYTES = 19.5 * 1024 * 1024;

        if (fileSize > BALE_MAX_BYTES && isVideo) {
            const parts = await this.splitVideoPlayableSegments(filePath, BALE_MAX_BYTES);

            for (let i = 0; i < parts.length; i++) {
                const partPath = parts[i];
                const partFileName = `part_${i + 1}_${fileName}`;
                const partCaption = `پارت ${i + 1} از ${parts.length}\n${caption}`;

                await this.sendBaleSingle(partPath, true, partFileName, partCaption);
                await this.cleanupFile(partPath);
            }
        } else {
            await this.sendBaleSingle(filePath, isVideo, fileName, caption);
        }
    }

    sendBaleSingle(filePath, isVideo, fileName, caption) {
        return new Promise(async (resolve, reject) => {
            try {
                const stats = await fs.promises.stat(filePath);
                const formData = new FormData();
                formData.append('chat_id', config.bale.chatId);
                if (caption) formData.append('caption', caption);

                const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.uploadChunkSize });
                formData.append(isVideo ? 'video' : 'document', fileStream, {
                    filename: fileName,
                    knownLength: stats.size
                });

                const endpoint = isVideo ? 'sendVideo' : 'sendDocument';
                const req = https.request({
                    hostname: 'tapi.bale.ai',
                    path: `/bot${config.bale.botToken}/${endpoint}`,
                    method: 'POST',
                    headers: formData.getHeaders()
                }, (res) => {
                    let resData = '';
                    res.on('data', chunk => resData += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Bale HTTP ${res.statusCode}: ${resData}`));
                        }
                    });
                });

                req.on('error', err => reject(err));
                formData.pipe(req);
            } catch (e) { reject(e); }
        });
    }

    async uploadToRubikaAsDocument(filePath, fileName, caption, fileSize) {
        const rubikaBaseUrl = config.rubika.baseUrl || 'https://botapi.rubika.ir/v3/';

        // 1. Request upload URL
        const uploadInfo = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/requestSendFile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'File' })
        }).then(r => r.json());

        // Rubika wraps response under data object: { status: "OK", data: { upload_url: "..." } }
        const uploadUrl = uploadInfo?.data?.upload_url || uploadInfo?.upload_url;

        if (!uploadUrl) {
            throw new Error(`Rubika requestSendFile failed: ${JSON.stringify(uploadInfo)}`);
        }

        // 2. Upload file binary stream
        const uploadResult = await new Promise((resolve, reject) => {
            const formData = new FormData();
            const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.uploadChunkSize });

            formData.append('file', fileStream, {
                filename: fileName,
                knownLength: fileSize
            });

            const parsedUrl = new URL(uploadUrl);
            const req = https.request({
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: formData.getHeaders()
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            });

            req.on('error', err => reject(err));
            formData.pipe(req);
        });

        const fileId = uploadResult?.data?.file_id || uploadResult?.file_id;

        if (!fileId) {
            throw new Error(`Rubika binary upload failed: ${JSON.stringify(uploadResult)}`);
        }

        // 3. Finalize message send
        const sendResponse = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/sendFile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.rubika.chatId,
                file_id: fileId,
                text: caption || `📥 فایل ${fileName}`
            })
        }).then(r => r.json());

        const messageId = sendResponse?.data?.message_id || sendResponse?.message_id;

        if (!messageId) {
            throw new Error(`Rubika sendFile failed: ${JSON.stringify(sendResponse)}`);
        }
    }

    splitVideoPlayableSegments(filePath, targetMaxBytes) {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration,size',
                '-of', 'json',
                filePath
            ]);

            let output = '';
            ffprobe.stdout.on('data', data => output += data.toString());

            ffprobe.on('close', async (code) => {
                if (code !== 0) return reject(new Error('ffprobe failed'));

                try {
                    const metadata = JSON.parse(output);
                    const duration = parseFloat(metadata.format.duration);
                    const totalSize = parseInt(metadata.format.size);

                    if (!duration || !totalSize) return reject(new Error("Invalid video metadata"));

                    const bytesPerSecond = totalSize / duration;
                    const targetSegmentDuration = Math.floor((targetMaxBytes * 0.92) / bytesPerSecond);

                    const parts = [];
                    const baseName = path.basename(filePath, '.mp4');
                    const dir = path.dirname(filePath);

                    let currentTime = 0;
                    let partIndex = 1;

                    while (currentTime < duration) {
                        const partPath = path.join(dir, `${baseName}_part${partIndex.toString().padStart(3, '0')}.mp4`);
                        const isLastPart = (currentTime + targetSegmentDuration) >= duration;
                        const currentDuration = isLastPart ? (duration - currentTime) : targetSegmentDuration;

                        const ffmpeg = spawn('ffmpeg', [
                            '-i', filePath,
                            '-ss', currentTime.toString(),
                            '-t', currentDuration.toString(),
                            '-c', 'copy',
                            '-avoid_negative_ts', 'make_zero',
                            '-movflags', '+faststart',
                            '-y', partPath
                        ]);

                        await new Promise((res, rej) => {
                            ffmpeg.on('close', code => code === 0 ? res() : rej(new Error(`Video segment failed with code ${code}`)));
                            ffmpeg.on('error', err => rej(err));
                        });

                        parts.push(partPath);
                        currentTime += targetSegmentDuration;
                        partIndex++;
                    }
                    resolve(parts);
                } catch (e) { reject(e); }
            });
        });
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