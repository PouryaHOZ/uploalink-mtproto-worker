const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const FormData = require("form-data");
const stream = require("stream");

// Utilize RAM Disk in Linux environments for maximum I/O speed
const TEMP_DIR = fs.existsSync("/dev/shm") ? "/dev/shm/temp_transfers" : "./temp_transfers";

// Environment Configuration
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
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '67108864'), // 64MB
        uploadChunkSize: parseInt(process.env.UPLOAD_CHUNK_SIZE || '16777216'),    // 16MB
        tempDir: TEMP_DIR
    },
    cloudflare: {
        webhookUrl: process.env.CLOUDFLARE_WEBHOOK_URL || '',
        apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
    }
};

// Ensure temporary directory exists
if (!fs.existsSync(config.performance.tempDir)) {
    fs.mkdirSync(config.performance.tempDir, { recursive: true });
}

// Utility Helpers
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 بایت";
    const k = 1024;
    const sizes = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return "0 بایت/ثانیه";
    const k = 1024;
    const sizes = ["بایت/ثانیه", "کیلوبایت/ثانیه", "مگابایت/ثانیه", "گیگابایت/ثانیه"];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatETA(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return "محاسبه...";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins} دقیقه و ${secs} ثانیه` : `${secs} ثانیه`;
}

function drawProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

// Telegram MTProto Client Manager
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

// Core Transfer Logic
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

            // Extract Environment Inputs
            const messageId = process.env.MESSAGE_ID || '0';
            const fileName = process.env.FILE_NAME || `file_${Date.now()}`;
            const fileSize = parseInt(process.env.FILE_SIZE || '0');
            const isVideo = process.env.IS_VIDEO === 'true';
            const rawDestinations = process.env.DESTINATIONS || '';
            const destinations = rawDestinations ? rawDestinations.split(',') : ['bale', 'rubika'];
            const shouldCompress = process.env.SHOULD_COMPRESS === 'true';

            downloadedFilePath = path.join(config.performance.tempDir, fileName);
            const client = this.telegramClient.client;

            // 1. Fetch Telegram Message
            const messages = await client.getMessages(BigInt(config.telegram.chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) {
                throw new Error("پیام یا فایل در تلگرام یافت نشد.");
            }

            // 2. Download Media Stream
            console.log(`[Start] Downloading message ${messageId} (${fileName})...`);
            const writeStream = fs.createWriteStream(downloadedFilePath, {
                highWaterMark: config.performance.downloadChunkSize
            });

            let downloadedBytes = 0;
            let lastLogTime = 0;

            await client.downloadMedia(messages[0].media, {
                outputFile: writeStream,
                workers: config.performance.downloadWorkers,
                progressCallback: (downloaded, total) => {
                    downloadedBytes = downloaded;
                    const now = Date.now();
                    if (now - lastLogTime >= 5000 || downloaded === total) {
                        lastLogTime = now;
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? downloaded / elapsed : 0;
                        const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                        console.log(`[Download] ${percent}% - ${formatBytes(downloaded)}/${formatBytes(total)} | Speed: ${formatSpeed(speed)}`);
                    }
                }
            });

            targetPath = downloadedFilePath;

            // 3. Compress Video (if requested)
            if (isVideo && shouldCompress) {
                const compressedPath = path.join(config.performance.tempDir, `compressed_${Date.now()}.mp4`);
                console.log(`[FFmpeg] Compressing video to 480p...`);

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

                    let lastFfmpegLog = Date.now();
                    ffmpeg.stderr.on('data', (data) => {
                        const output = data.toString();
                        const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
                        if (timeMatch && Date.now() - lastFfmpegLog >= 5000) {
                            lastFfmpegLog = Date.now();
                            console.log(`[FFmpeg] Progress: ${timeMatch[1]}`);
                        }
                    });

                    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
                    ffmpeg.on('error', err => reject(err));
                });

                targetPath = compressedPath;
            }

            const stats = await fs.promises.stat(targetPath);
            const actualSize = stats.size;
            const caption = messages[0].text || messages[0].caption || "";

            // 4. Upload to Bale
            if (destinations.includes('bale') && config.bale) {
                await this.uploadToBale(targetPath, isVideo, fileName, caption, actualSize);
            }

            // 5. Upload to Rubika
            if (destinations.includes('rubika') && config.rubika) {
                const fileType = this.getRubikaFileType(fileName, isVideo, messages[0].media?.document?.mimeType);
                await this.uploadToRubika(targetPath, fileType, fileName, caption, actualSize);
            }

            const elapsedTime = (Date.now() - startTime) / 1000;
            console.log(`\n✅ Transfer Completed Successfully in ${formatETA(elapsedTime)}!`);

            // 6. Notify Cloudflare KV / Webhook of completion
            await this.notifyCloudflare({
                event: 'transfer_completed',
                fileId: messageId,
                originalSize: fileSize || actualSize,
                compressed: shouldCompress,
                destinations,
                elapsedTime
            });

            // Cleanup & Exit
            await this.cleanupFile(downloadedFilePath);
            if (targetPath !== downloadedFilePath) await this.cleanupFile(targetPath);
            await this.telegramClient.disconnect();
            process.exit(0);

        } catch (err) {
            console.error("❌ Transfer Execution Error:", err);
            
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

    // Upload to Bale (Handles Chunk Splitting for files > 20MB)
    async uploadToBale(filePath, isVideo, fileName, caption, fileSize) {
        const BALE_MAX_BYTES = 20 * 1024 * 1024;

        if (fileSize > BALE_MAX_BYTES) {
            console.log(`[Bale] File exceeds 20MB limit. Splitting into chunks...`);
            const parts = await this.splitFile(filePath, BALE_MAX_BYTES, isVideo);

            for (let i = 0; i < parts.length; i++) {
                const partPath = parts[i];
                const partFileName = `part_${i + 1}_${fileName}`;
                const partCaption = `پارت ${i + 1} از ${parts.length}\n${caption}`;

                console.log(`[Bale] Uploading chunk ${i + 1}/${parts.length}...`);
                await this.sendBaleSingle(partPath, isVideo, partFileName, partCaption);
                await this.cleanupFile(partPath);
            }
        } else {
            console.log(`[Bale] Uploading file...`);
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
                            console.log(`[Bale] Chunk/File uploaded successfully.`);
                            resolve();
                        } else {
                            reject(new Error(`Bale Upload Failed HTTP ${res.statusCode}: ${resData}`));
                        }
                    });
                });

                req.on('error', err => reject(err));
                formData.pipe(req);
            } catch (e) { reject(e); }
        });
    }

    // Upload to Rubika (v3 API Flow)
    async uploadToRubika(filePath, fileType, fileName, caption, fileSize) {
        console.log(`[Rubika] Requesting upload URL for type '${fileType}'...`);
        const rubikaBaseUrl = config.rubika.baseUrl || 'https://botapi.rubika.ir/v3/';

        const uploadInfo = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/requestSendFile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: fileType })
        }).then(r => r.json());

        if (!uploadInfo || !uploadInfo.upload_url) {
            throw new Error(`Rubika requestSendFile failed: ${JSON.stringify(uploadInfo)}`);
        }

        console.log(`[Rubika] Uploading file binary stream...`);
        const uploadResult = await new Promise((resolve, reject) => {
            const formData = new FormData();
            const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.uploadChunkSize });

            formData.append('file', fileStream, {
                filename: fileName,
                knownLength: fileSize
            });

            const parsedUrl = new URL(uploadInfo.upload_url);
            const req = https.request({
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: formData.getHeaders()
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Failed to parse Rubika upload response: ${data}`));
                    }
                });
            });

            req.on('error', err => reject(err));
            formData.pipe(req);
        });

        if (!uploadResult || !uploadResult.file_id) {
            throw new Error(`Rubika binary upload failed: ${JSON.stringify(uploadResult)}`);
        }

        console.log(`[Rubika] Finalizing message send...`);
        const sendResponse = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/sendFile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.rubika.chatId,
                file_id: uploadResult.file_id,
                text: caption || `📥 فایل ${fileName}`
            })
        }).then(r => r.json());

        if (!sendResponse || !sendResponse.message_id) {
            throw new Error(`Rubika sendFile failed: ${JSON.stringify(sendResponse)}`);
        }

        console.log(`[Rubika] Uploaded & sent successfully.`);
    }

    // Rubika File Type Mapper (FileTypeEnum)
    getRubikaFileType(fileName, isVideo, mimeType = '') {
        if (isVideo || mimeType.startsWith('video/')) return 'Video';
        if (mimeType.startsWith('image/')) return 'Image';
        if (mimeType.startsWith('audio/')) return mimeType.includes('ogg') ? 'Voice' : 'Music';
        if (fileName.toLowerCase().endsWith('.gif') || mimeType.includes('gif')) return 'Gif';
        return 'File';
    }

    // Split non-video or large files into pieces
    async splitFile(filePath, maxSize, isVideo) {
        if (isVideo) {
            return await this.splitVideoByBitrate(filePath, maxSize);
        }

        const stats = await fs.promises.stat(filePath);
        const fileSize = stats.size;
        const parts = [];
        const baseName = path.basename(filePath, path.extname(filePath));
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);

        const fd = await fs.promises.open(filePath, 'r');
        let bytesReadTotal = 0;
        let partIndex = 1;

        while (bytesReadTotal < fileSize) {
            const chunkSize = Math.min(maxSize, fileSize - bytesReadTotal);
            const buffer = Buffer.alloc(chunkSize);
            const { bytesRead } = await fd.read(buffer, 0, chunkSize, bytesReadTotal);

            const partName = path.join(dir, `${baseName}_part${partIndex.toString().padStart(3, '0')}${ext}`);
            await fs.promises.writeFile(partName, buffer.subarray(0, bytesRead));
            parts.push(partName);

            bytesReadTotal += chunkSize;
            partIndex++;
        }

        await fd.close();
        return parts;
    }

    splitVideoByBitrate(filePath, targetMaxBytes) {
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
                if (code !== 0) return reject(new Error('Failed to probe video metadata'));

                try {
                    const metadata = JSON.parse(output);
                    const duration = parseFloat(metadata.format.duration);
                    const totalSize = parseInt(metadata.format.size);

                    if (!duration || !totalSize) return reject(new Error("Invalid video metadata"));

                    const bytesPerSecond = totalSize / duration;
                    const targetSegmentDuration = Math.floor((targetMaxBytes * 0.95) / bytesPerSecond);

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
                            ffmpeg.on('close', code => code === 0 ? res() : rej(new Error(`Video chunk split failed with code ${code}`)));
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
        } catch (e) {
            console.error(`Error deleting temp file ${filePath}:`, e);
        }
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

// Main Execution
new FileTransferBot().start();