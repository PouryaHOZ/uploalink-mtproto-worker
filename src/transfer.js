const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const FormData = require("form-data");
const stream = require("stream");

// استفاده از RAM Disk (شبیه‌سازی حافظه موقت در لینوکس) برای جلوگیری از گلوگاه I/O دیسک
const TEMP_DIR = fs.existsSync("/dev/shm") ? "/dev/shm/temp_transfers" : "./temp_transfers";

// Configuration
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
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '14'), // سقف اتصال موازی ایمن
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '67108864'), // 64MB High-Water Mark
        uploadChunkSize: parseInt(process.env.UPLOAD_CHUNK_SIZE || '16777216'), // 16MB
        maxRetries: parseInt(process.env.MAX_RETRIES || '5'),
        tempDir: TEMP_DIR,
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '5')
    },
    cloudflare: {
        webhookUrl: process.env.CLOUDFLARE_WEBHOOK_URL || '',
        apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
    }
};

// Ensure temp directory exists asynchronously
if (!fs.existsSync(config.performance.tempDir)) {
    fs.mkdirSync(config.performance.tempDir, { recursive: true });
}

// Global Transfer Manager
class TransferManager {
    constructor() {
        this.activeTransfers = new Map();
        this.nextId = 1;
        this.messageQueue = [];
        this.isProcessingQueue = false;
    }

    async addTransfer(info) {
        const id = this.nextId++;
        const transfer = {
            id,
            status: 'initializing',
            startTime: Date.now(),
            lastUpdate: 0,
            progress: 0,
            statusMsgId: null,
            rubikaMsgId: null,
            baleMsgId: null,
            filePath: path.join(config.performance.tempDir, `transfer_${id}_${Date.now()}`),
            compressedPath: path.join(config.performance.tempDir, `compressed_${id}_${Date.now()}.mp4`),
            parts: [],
            ...info
        };

        this.activeTransfers.set(id, transfer);
        return id;
    }

    getTransfer(id) {
        return this.activeTransfers.get(id);
    }

    updateTransfer(id, updates) {
        const transfer = this.activeTransfers.get(id);
        if (transfer) {
            Object.assign(transfer, updates);
        }
        return transfer;
    }

    removeTransfer(id) {
        this.activeTransfers.delete(id);
    }

    async queueMessage(updateFunc) {
        this.messageQueue.push(updateFunc);
        if (!this.isProcessingQueue) {
            await this.processQueue();
        }
    }

    async processQueue() {
        if (this.messageQueue.length === 0) {
            this.isProcessingQueue = false;
            return;
        }

        this.isProcessingQueue = true;
        const updateFunc = this.messageQueue.shift();

        try {
            await updateFunc();
        } catch (err) {
            console.error("Error in message queue:", err);
        }

        // Throttle updates to avoid API limits (1.5 seconds)
        await new Promise(resolve => setTimeout(resolve, 1500));
        await this.processQueue();
    }

    async cleanupTransfer(id) {
        const transfer = this.activeTransfers.get(id);
        if (transfer) {
            try {
                if (fs.existsSync(transfer.filePath)) {
                    await fs.promises.unlink(transfer.filePath);
                }
                if (transfer.compressedPath && fs.existsSync(transfer.compressedPath)) {
                    await fs.promises.unlink(transfer.compressedPath);
                }
                for (const part of transfer.parts) {
                    if (fs.existsSync(part)) {
                        await fs.promises.unlink(part);
                    }
                }
            } catch (err) {
                console.error(`Error cleaning up transfer ${id}:`, err);
            }
        }
        this.removeTransfer(id);
    }
}

// Utility Functions
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
    if (mins > 0) {
        return `${mins} دقیقه و ${secs} ثانیه`;
    }
    return `${secs} ثانیه`;
}

function drawProgressBar(percent, length = 10) {
    const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
    return "█".repeat(filled) + "░".repeat(length - filled);
}

// Telegram Client Manager
class TelegramClientManager {
    constructor() {
        this.client = new TelegramClient(
            new StringSession(config.telegram.sessionString),
            config.telegram.apiId,
            config.telegram.apiHash,
            {
                connectionRetries: 5,
                retryDelay: 1000,
                floodSleepThreshold: 10,
                requestRetries: 5,
                downloadWorkers: config.performance.downloadWorkers,
                useWSS: false,
                deviceModel: 'FileTransferBot',
                systemVersion: 'Optimized',
                appVersion: '2.0.0'
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

    getClient() {
        return this.client;
    }
}

// Main Application Class
class FileTransferBot {
    constructor() {
        this.transferManager = new TransferManager();
        this.telegramClient = new TelegramClientManager();
        this.availableAccounts = this.getAvailableAccounts();
    }

    getAvailableAccounts() {
        const accounts = [];
        if (config.bale) accounts.push('bale');
        if (config.rubika) accounts.push('rubika');
        return accounts.length > 0 ? accounts : ['bale', 'rubika'];
    }

    getDefaultAccount() {
        if (this.availableAccounts.length === 1) {
            return this.availableAccounts[0];
        }
        return 'both';
    }

    async start() {
        try {
            await this.telegramClient.connect();
            console.log("Connected to Telegram via MTProto");

            await this.processFromEnv();
        } catch (error) {
            console.error("Error starting bot:", error);
            process.exit(1);
        }
    }

    async processFromEnv() {
        // Read upper-case mappings sent directly from index.ts / Action workflow payload
        const messageId = process.env.MESSAGE_ID || '0';
        const chatId = config.telegram.chatId;
        const fileName = process.env.FILE_NAME || `file_${Date.now()}`;
        const fileSize = parseInt(process.env.FILE_SIZE || '0');
        const isVideo = process.env.IS_VIDEO === 'true';
        const mimeType = process.env.MIME_TYPE || '';
        const fileId = process.env.FILE_ID || '';
        const rawDestinations = process.env.DESTINATIONS || '';
        const destinations = rawDestinations ? rawDestinations.split(',') : this.getDefaultDestinations();
        const shouldCompress = process.env.SHOULD_COMPRESS === 'true';
        const account = process.env.ACCOUNT || this.getDefaultAccount();
        const platform = process.env.PLATFORM || 'telegram';

        if (!messageId || messageId === '0') {
            console.error("No valid message ID provided in environment variables");
            process.exit(1);
        }

        if (platform === 'telegram') {
            await this.processMessage(parseInt(messageId), {
                chatId,
                fileName,
                fileSize,
                isVideo,
                mimeType,
                fileId,
                destinations,
                shouldCompress,
                account,
                platform
            });
        } else {
            await this.processFileFromEnv({
                messageId,
                chatId,
                fileName,
                fileSize,
                isVideo,
                mimeType,
                fileId,
                destinations,
                shouldCompress,
                account,
                platform
            });
        }
    }

    getDefaultDestinations() {
        const destinations = [];
        if (config.bale) destinations.push('bale');
        if (config.rubika) destinations.push('rubika');
        if (config.telegram.botToken) destinations.push('telegram');
        return destinations.length > 0 ? destinations : ['bale', 'rubika', 'telegram'];
    }

    async processFileFromEnv(overrides = {}) {
        const fileId = await this.transferManager.addTransfer({
            messageId: overrides.messageId || Date.now().toString(),
            fileName: overrides.fileName || `file_${Date.now()}`,
            fileSize: overrides.fileSize || 0,
            isVideo: overrides.isVideo || false,
            mimeType: overrides.mimeType || '',
            fileId: overrides.fileId || '',
            destinations: overrides.destinations || this.getDefaultDestinations(),
            shouldCompress: overrides.shouldCompress || false,
            account: overrides.account || this.getDefaultAccount(),
            platform: overrides.platform || 'telegram',
            chatId: overrides.chatId || config.telegram.chatId
        });

        await this.processFile(fileId);
    }

    async processMessage(messageId, overrides = {}) {
        try {
            const client = this.telegramClient.getClient();
            const messages = await client.getMessages(
                BigInt(config.telegram.chatId),
                { ids: [messageId] }
            );

            if (!messages || !messages[0] || !messages[0].media) {
                throw new Error("پیام یا فایل در چت تلگرام یافت نشد.");
            }

            const message = messages[0];
            const fileId = await this.transferManager.addTransfer({
                messageId: message.id.toString(),
                fileName: overrides.fileName || message.media.document?.fileName || `file_${Date.now()}`,
                fileSize: overrides.fileSize || message.media.document?.size || message.media.photo?.sizes?.slice(-1)[0]?.size || 0,
                isVideo: overrides.isVideo || message.media.document?.mimeType?.startsWith("video/") || false,
                mimeType: overrides.mimeType || message.media.document?.mimeType,
                fileId: overrides.fileId || message.media.document?.id.toString(),
                destinations: overrides.destinations || this.getDefaultDestinations(),
                shouldCompress: overrides.shouldCompress !== undefined ? overrides.shouldCompress : false,
                account: overrides.account || this.getDefaultAccount(),
                originalMessage: message
            });

            await this.processFile(fileId);
        } catch (error) {
            console.error("Error processing message:", error);
            await this.notifyError(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    async processFile(fileId) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) {
            console.error(`Transfer ${fileId} not found`);
            return;
        }

        try {
            transfer.updateTransfer(fileId, { status: 'downloading' });

            const isVideo = transfer.isVideo || false;
            const fileSize = transfer.fileSize || 0;
            const shouldCompress = transfer.shouldCompress || false;
            const destinations = transfer.destinations || [];
            const platform = transfer.platform || 'telegram';

            const estimates = this.estimateProcessTimes(fileSize, isVideo, shouldCompress);

            // Calculate weights
            const downloadWeight = 30;
            const compressWeight = shouldCompress && isVideo ? 20 : 0;
            const uploadWeights = {
                bale: destinations.includes('bale') ? 20 : 0,
                rubika: destinations.includes('rubika') ? 20 : 0,
                telegram: 10
            };

            let filePath = '';
            if (platform === 'telegram' && transfer.originalMessage) {
                filePath = await this.downloadFile(fileId, transfer.originalMessage, downloadWeight, estimates);
            } else {
                filePath = path.join(config.performance.tempDir, transfer.fileName || `file_${fileId}`);
                console.log(`Using existing local file for platform ${platform}: ${filePath}`);
            }

            let targetPath = filePath;
            if (isVideo && shouldCompress) {
                targetPath = await this.compressFile(fileId, filePath, compressWeight, estimates);
            }

            const fileStats = fs.statSync(targetPath);
            const actualFileSize = fileStats.size;
            const caption = transfer.originalMessage?.text || transfer.originalMessage?.caption || "";

            if (uploadWeights.telegram > 0 && platform !== 'telegram') {
                await this.uploadToTelegram(fileId, transfer, uploadWeights.telegram, estimates);
            }

            if ((destinations.includes('bale') || transfer.account === 'bale' || transfer.account === 'both') && platform !== 'bale') {
                await this.uploadToBale(
                    fileId,
                    targetPath,
                    isVideo ? "video" : "document",
                    isVideo ? "sendVideo" : "sendDocument",
                    transfer.fileName || `file_${fileId}.mp4`,
                    `📤 از ${platform === 'telegram' ? 'تلگرام' : platform === 'rubika' ? 'روبیکا' : 'بله'} - فایل ${transfer.fileName}\n${caption}`,
                    uploadWeights.bale,
                    estimates,
                    actualFileSize
                );
            }

            if ((destinations.includes('rubika') || transfer.account === 'rubika' || transfer.account === 'both') && platform !== 'rubika') {
                const rubikaFileType = this.getRubikaFileType(transfer);
                await this.uploadToRubika(
                    fileId,
                    targetPath,
                    rubikaFileType,
                    transfer.fileName || `file_${fileId}${isVideo ? '.mp4' : ''}`,
                    `📥 فایل ${transfer.fileName} از ${platform === 'telegram' ? 'تلگرام' : platform === 'bale' ? 'بله' : 'روبیکا'}\n${caption}`,
                    uploadWeights.rubika,
                    estimates,
                    actualFileSize
                );
            }

            const elapsedTime = (Date.now() - transfer.startTime) / 1000;
            const finalText = this.createFinalMessage(fileId, fileSize, shouldCompress, destinations, elapsedTime);

            console.log(`\n✅ File ${fileId} Processing Complete:\n${finalText}`);

            await this.notifyCompletion(fileId, {
                status: 'completed',
                fileId,
                originalSize: fileSize,
                compressed: shouldCompress,
                destinations,
                elapsedTime
            });

            await this.transferManager.cleanupTransfer(fileId);
            await this.telegramClient.disconnect();

        } catch (error) {
            console.error(`Error processing file ${fileId}:`, error);
            await this.notifyError(`Error processing file ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
            await this.notifyCompletion(fileId, {
                status: 'failed',
                fileId,
                error: error instanceof Error ? error.message : String(error)
            });
            await this.transferManager.cleanupTransfer(fileId);
            await this.telegramClient.disconnect();
            process.exit(1);
        }
    }

    async downloadFile(fileId, message, downloadWeight, estimates) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) throw new Error("Transfer not found");

        const client = this.telegramClient.getClient();
        const filePath = transfer.filePath;

        return new Promise(async (resolve, reject) => {
            try {
                // Backpressure stream to handle fast network to disk I/O cleanly
                const writeStream = fs.createWriteStream(filePath, {
                    highWaterMark: config.performance.downloadChunkSize
                });

                let downloadedBytes = 0;
                const startTime = Date.now();
                let lastUpdate = 0;

                await client.downloadMedia(message.media, {
                    outputFile: writeStream,
                    workers: config.performance.downloadWorkers, // Concurrent chunks
                    progressCallback: async (downloaded, total) => {
                        downloadedBytes = downloaded;
                        const now = Date.now();

                        // Throttle logging to strictly 5 seconds
                        if (now - lastUpdate >= 5000 || downloaded === total) {
                            lastUpdate = now;
                            const elapsedSec = (now - startTime) / 1000;
                            const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                            const stepPercent = total ? Math.floor((downloaded / total) * 100) : 0;

                            console.log(`[File ${fileId}] Download: ${stepPercent}% - ${formatBytes(downloaded)}/${formatBytes(total)} | Speed: ${formatSpeed(speed)}`);
                        }
                    }
                });

                resolve(filePath);
            } catch (err) {
                reject(err);
            }
        });
    }

    async compressFile(fileId, inputPath, compressWeight, estimates) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) throw new Error("Transfer not found");

        const outputPath = transfer.compressedPath;

        return new Promise((resolve, reject) => {
            let lastUpdate = Date.now();

            const command = spawn('ffmpeg', [
                '-i', inputPath,
                '-threads', '0', // Utilize all GitHub Runner CPUs
                '-c:v', 'libx264',
                '-crf', '28',
                '-preset', 'ultrafast',
                '-vf', 'scale=-2:480',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', outputPath
            ]);

            command.stderr.on('data', (data) => {
                const output = data.toString();
                const progressMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (progressMatch) {
                    const timeStr = progressMatch[1];
                    const now = Date.now();
                    if (now - lastUpdate >= 5000) {
                        lastUpdate = now;
                        console.log(`[File ${fileId}] Compression: ${timeStr} processed`);
                    }
                }
            });

            command.on('close', (code) => {
                if (code === 0) {
                    resolve(outputPath);
                } else {
                    reject(new Error(`FFmpeg failed with code ${code}`));
                }
            });

            command.on('error', (err) => reject(err));
        });
    }

    async uploadToTelegram(fileId, transfer, weight, estimates) {
        if (!transfer) return;
        const client = this.telegramClient.getClient();

        try {
            if (transfer.originalMessage) {
                await client.invoke(
                    new Api.messages.ForwardMessages({
                        fromPeer: new Api.InputPeerChannel({
                            channelId: BigInt(config.telegram.chatId),
                            accessHash: await client.getChannelAccessHash(config.telegram.chatId)
                        }),
                        id: [transfer.originalMessage.id],
                        toPeer: new Api.InputPeerChannel({
                            channelId: BigInt(config.telegram.chatId),
                            accessHash: await client.getChannelAccessHash(config.telegram.chatId)
                        }),
                        randomId: [Api.utils.getRandomId()],
                        scheduleDate: undefined
                    })
                );
                console.log(`[File ${fileId}] Forwarded securely to Telegram`);
            }
        } catch (err) {
            console.error(`Error uploading/forwarding to Telegram for file ${fileId}:`, err);
        }
    }

    async uploadToBale(fileId, filePath, fileType, endpoint, fileName, caption, weight, estimates, fileSize) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer || !config.bale) return;

        const BALE_MAX_BYTES = 20 * 1024 * 1024;

        if (fileSize > BALE_MAX_BYTES) {
            console.log(`[File ${fileId}] Exceeds Bale limit. Executing asynchronous split...`);
            const parts = await this.splitFile(filePath, BALE_MAX_BYTES, transfer.isVideo || false);
            transfer.parts = parts;

            const totalParts = parts.length;
            for (let i = 0; i < totalParts; i++) {
                const partPath = parts[i];
                const partFileName = `part_${i + 1}_${fileName}`;
                const partCaption = `پارت ${i + 1} از ${totalParts}\n${caption}`;

                await this.uploadToBaleSingle(
                    fileId, partPath, fileType, endpoint, partFileName, partCaption, i, totalParts
                );
            }
        } else {
            await this.uploadToBaleSingle(fileId, filePath, fileType, endpoint, fileName, caption);
        }
    }

    async uploadToBaleSingle(fileId, filePath, fileType, endpoint, fileName, caption, partIndex, totalParts) {
        if (!config.bale) return;
        const stats = await fs.promises.stat(filePath);
        const fileSize = stats.size;

        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('chat_id', config.bale.chatId);
            if (caption) formData.append('caption', caption);

            // Create progress tracking transform stream
            let uploadedBytes = 0;
            const startTime = Date.now();
            let lastUpdate = 0;

            const trackedStream = new stream.Transform({
                transform(chunk, encoding, callback) {
                    uploadedBytes += chunk.length;
                    const now = Date.now();

                    if (now - lastUpdate >= 5000 || uploadedBytes === fileSize) {
                        lastUpdate = now;
                        const elapsedSec = (now - startTime) / 1000;
                        const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                        const percent = Math.min(100, Math.floor((uploadedBytes / fileSize) * 100));
                        console.log(`[File ${fileId}] Bale Upload: ${percent}% - ${formatBytes(uploadedBytes)}/${formatBytes(fileSize)} | Speed: ${formatSpeed(speed)}`);
                    }
                    this.push(chunk);
                    callback();
                }
            });

            const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.uploadChunkSize });
            fileStream.pipe(trackedStream);

            // Using form-data package appended streams
            formData.append(fileType === 'video' ? 'video' : 'document', trackedStream, {
                filename: fileName,
                knownLength: fileSize
            });

            const options = {
                hostname: 'tapi.bale.ai',
                path: `/bot${config.bale.botToken}/${endpoint}`,
                method: 'POST',
                headers: formData.getHeaders()
            };

            const req = https.request(options, (res) => {
                let resData = '';
                res.on('data', (chunk) => { resData += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const json = JSON.parse(resData);
                            if (json.ok) {
                                console.log(`[File ${fileId}] Uploaded to Bale: ${partIndex !== undefined ? `Part ${partIndex + 1}/${totalParts}` : 'Complete'}`);
                                resolve();
                            } else {
                                reject(new Error(json.description || resData));
                            }
                        } catch (e) { resolve(); }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
                    }
                });
            });

            req.on('error', (err) => reject(err));
            formData.pipe(req); // Native piping prevents RAM overflow
        });
    }

    async uploadToRubika(fileId, filePath, fileType, fileName, caption, weight, estimates, fileSize) {
        if (!config.rubika) return;

        try {
            const rubikaBaseUrl = config.rubika.baseUrl || 'https://botapi.rubika.ir/v3/';

            // Native Fetch uses standard API without optimizedAgent that breaks Node 18+ undici
            const uploadInfo = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/requestSendFile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: fileType })
            }).then(res => res.json());

            if (!uploadInfo.ok) {
                throw new Error(uploadInfo.description || "خطا در دریافت اطلاعات آپلود روبیکا");
            }

            return new Promise((resolve, reject) => {
                const formData = new FormData();
                let uploadedBytes = 0;
                let lastUpdate = Date.now();

                const trackedStream = new stream.Transform({
                    transform(chunk, encoding, callback) {
                        uploadedBytes += chunk.length;
                        const now = Date.now();
                        if (now - lastUpdate >= 5000 || uploadedBytes === fileSize) {
                            lastUpdate = now;
                            const percent = Math.min(100, Math.floor((uploadedBytes / fileSize) * 100));
                            console.log(`[File ${fileId}] Rubika Upload: ${percent}% - ${formatBytes(uploadedBytes)}/${formatBytes(fileSize)}`);
                        }
                        this.push(chunk);
                        callback();
                    }
                });

                const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.uploadChunkSize });
                fileStream.pipe(trackedStream);

                formData.append('file', trackedStream, {
                    filename: fileName,
                    knownLength: fileSize
                });

                // Utilize https request natively to maintain pure streaming pipeline for form-data
                const parsedUrl = new URL(uploadInfo.result.upload_url);
                const options = {
                    hostname: parsedUrl.hostname,
                    path: parsedUrl.pathname + parsedUrl.search,
                    method: 'POST',
                    headers: formData.getHeaders()
                };

                const req = https.request(options, (res) => {
                    let resData = '';
                    res.on('data', (chunk) => { resData += chunk; });
                    res.on('end', async () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            const uploadResult = JSON.parse(resData);
                            if (!uploadResult.ok) return reject(new Error(uploadResult.description));

                            try {
                                const sendResponse = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/sendFile`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: config.rubika.chatId,
                                        file_id: uploadResult.result.file_id,
                                        text: caption
                                    })
                                }).then(r => r.json());

                                if (!sendResponse.ok) throw new Error(sendResponse.description);
                                console.log(`[File ${fileId}] Uploaded to Rubika successfully`);
                                resolve();
                            } catch (e) { reject(e); }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
                        }
                    });
                });

                req.on('error', (err) => reject(err));
                formData.pipe(req);
            });
        } catch (err) {
            console.error(`Error uploading to Rubika for file ${fileId}:`, err);
            throw err;
        }
    }

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

        // Asynchronous non-blocking file read/write for memory safety
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
        return new Promise(async (resolve, reject) => {
            try {
                const command = spawn('ffprobe', [
                    '-v', 'error',
                    '-show_entries', 'format=duration,size',
                    '-of', 'json',
                    filePath
                ]);

                let output = '';
                command.stdout.on('data', (data) => { output += data.toString(); });

                command.on('close', async (code) => {
                    if (code !== 0) return reject(new Error('Failed to get video metadata'));

                    try {
                        const metadata = JSON.parse(output);
                        const duration = parseFloat(metadata.format.duration);
                        const totalSize = parseInt(metadata.format.size);

                        if (!duration || !totalSize) return reject(new Error("Could not determine video duration or size"));

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

                            const ffmpegCommand = spawn('ffmpeg', [
                                '-i', filePath,
                                '-ss', currentTime.toString(),
                                '-t', currentDuration.toString(),
                                '-c', 'copy',
                                '-avoid_negative_ts', 'make_zero',
                                '-movflags', '+faststart',
                                '-y', partPath
                            ]);

                            await new Promise((resolve, reject) => {
                                ffmpegCommand.on('close', (code) => {
                                    if (code === 0) {
                                        parts.push(partPath);
                                        resolve();
                                    } else {
                                        reject(new Error(`FFmpeg split failed with code ${code}`));
                                    }
                                });
                                ffmpegCommand.on('error', (err) => reject(err));
                            });

                            currentTime += targetSegmentDuration;
                            partIndex++;
                        }
                        resolve(parts);
                    } catch (e) { reject(e); }
                });
                command.on('error', (err) => reject(err));
            } catch (err) { reject(err); }
        });
    }

    estimateProcessTimes(fileSize, isVideo, willCompress) {
        const estDownloadSec = Math.ceil(fileSize / (25 * 1024 * 1024));
        let estCompressSec = 0;
        let compressedSizeRatio = 1;

        if (isVideo && willCompress) {
            estCompressSec = Math.ceil((fileSize / (1024 * 1024)) * 2.5);
            compressedSizeRatio = 0.4;
        }

        const estUploadSize = willCompress ? fileSize * compressedSizeRatio : fileSize;
        const estUploadSecBale = Math.ceil(estUploadSize / (3 * 1024 * 1024));
        const estUploadSecRubika = Math.ceil(estUploadSize / (5 * 1024 * 1024));
        const totalEstSec = estDownloadSec + estCompressSec + estUploadSecBale + estUploadSecRubika;

        return { estDownloadSec, estCompressSec, estUploadSecBale, estUploadSecRubika, totalEstSec };
    }

    getRubikaFileType(transfer) {
        if (!transfer) return 'File';
        const mimeType = transfer.mimeType || '';
        const isVideo = transfer.isVideo || false;

        if (isVideo || mimeType.startsWith('video/')) return 'Video';
        if (mimeType.startsWith('image/')) return 'Image';
        if (mimeType.startsWith('audio/')) return mimeType.includes('ogg') ? 'Voice' : 'Music';
        if ((transfer.fileName || '').toLowerCase().endsWith('.gif') || mimeType.includes('gif')) return 'Gif';
        return 'File';
    }

    createFinalMessage(fileId, originalSize, wasCompressed, destinations, elapsedTime) {
        const compressedSize = wasCompressed ? Math.floor(originalSize * 0.4) : originalSize;
        const messageParts = [
            `📁 **فایل ${fileId}**`,
            `🏆 **پیشرفت کل:** \`[${drawProgressBar(100)}]\` 100%`,
            "-----------------------------------",
            "✅ **انتقال با موفقیت کامل انجام شد!**",
            "",
            "📌 **خلاصه انتقال:**",
            `- حجم اصلی: ${formatBytes(originalSize)}`,
            wasCompressed ? `- حجم فشرده: ${formatBytes(compressedSize)}` : '',
            `- مقصد(های) ارسال: ${destinations.map(d => d === 'bale' ? 'بله' : d === 'rubika' ? 'روبیکا' : 'تلگرام').join(' و ')}`,
            "",
            `🕒 **زمان کل پردازش:** ${formatETA(elapsedTime)}`
        ];
        return messageParts.filter(Boolean).join("\n");
    }

    async notifyCompletion(fileId, data) {
        if (!config.cloudflare.webhookUrl) return;
        try {
            await fetch(config.cloudflare.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.cloudflare.apiToken}`
                },
                body: JSON.stringify({ event: 'transfer_completed', ...data })
            });
        } catch (error) { console.error("Error notifying completion:", error); }
    }

    async notifyError(error) {
        if (!config.cloudflare.webhookUrl) return;
        try {
            await fetch(config.cloudflare.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.cloudflare.apiToken}`
                },
                body: JSON.stringify({ event: 'transfer_error', error, timestamp: new Date().toISOString() })
            });
        } catch (err) { console.error("Error notifying error:", err); }
    }
}

// Main execution
async function main() {
    const bot = new FileTransferBot();
    await bot.start();
}

main();
