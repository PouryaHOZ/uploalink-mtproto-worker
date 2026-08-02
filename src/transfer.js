const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const FormData = require("form-data");
const stream = require("stream");

// Configuration
const config = {
    telegram: {
        apiId: parseInt(process.env.TELEGRAM_API_ID || '0'),
        apiHash: process.env.TELEGRAM_API_HASH || '',
        sessionString: process.env.TELEGRAM_SESSION_STRING || '',
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || '',
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
        downloadWorkers: parseInt(process.env.DOWNLOAD_WORKERS || '32'),
        downloadChunkSize: parseInt(process.env.DOWNLOAD_CHUNK_SIZE || '16777216'), // 16MB
        uploadChunkSize: parseInt(process.env.UPLOAD_CHUNK_SIZE || '8388608'), // 8MB
        maxRetries: parseInt(process.env.MAX_RETRIES || '5'),
        tempDir: process.env.TEMP_DIR || './temp_transfers',
        maxConcurrentTransfers: parseInt(process.env.MAX_CONCURRENT_TRANSFERS || '5')
    },
    cloudflare: {
        webhookUrl: process.env.CLOUDFLARE_WEBHOOK_URL || '',
        apiToken: process.env.CLOUDFLARE_API_TOKEN || ''
    }
};

// Ensure temp directory exists
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

        // Small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
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

// Optimized HTTP Agent
const optimizedAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 60000,
    maxSockets: 100,
    maxFreeSockets: 50,
    scheduling: 'lifo',
    timeout: 30000,
    freeSocketTimeout: 30000
});

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

function truncateCaption(text, limit = 4096) {
    if (!text) return "";
    return text.length > limit ? text.substring(0, limit - 3) + "..." : text;
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
                downloadBufferSize: config.performance.downloadChunkSize,
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
        this.activeAccount = this.getDefaultAccount();
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
            // Connect to Telegram
            await this.telegramClient.connect();
            console.log("Connected to Telegram");

            // Check if we have a specific message to process
            if (process.env.MESSAGE_ID) {
                await this.processMessage(parseInt(process.env.MESSAGE_ID));
            } else {
                // In GitHub Actions, we expect to be triggered with specific parameters
                await this.processFromEnv();
            }
        } catch (error) {
            console.error("Error starting bot:", error);
            process.exit(1);
        }
    }

    async processFromEnv() {
        // Get parameters from environment variables
        const messageId = process.env.MESSAGE_ID || '0';
        const chatId = process.env.CHAT_ID || config.telegram.chatId;
        const fileName = process.env.FILE_NAME || `file_${Date.now()}`;
        const fileSize = parseInt(process.env.FILE_SIZE || '0');
        const isVideo = process.env.IS_VIDEO === 'true';
        const mimeType = process.env.MIME_TYPE || '';
        const fileId = process.env.FILE_ID || '';
        const destinations = process.env.DESTINATIONS ?
            process.env.DESTINATIONS.split(',') :
            this.getDefaultDestinations();
        const shouldCompress = process.env.SHOULD_COMPRESS === 'true';
        const account = process.env.ACCOUNT || this.getDefaultAccount();
        const platform = process.env.PLATFORM || 'telegram';

        if (!messageId) {
            console.error("No message ID provided in environment variables");
            process.exit(1);
        }

        // For Telegram, we need to fetch the message from Telegram's API
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
            // For Bale and Rubika, we assume the file is already available in the environment
            // and we can directly process it
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

    // Process file directly from environment variables (for Bale and Rubika)
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
                throw new Error("پیام یا فایل یافت نشد.");
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
                shouldCompress: overrides.shouldCompress || undefined,
                account: overrides.account || this.getDefaultAccount(),
                originalMessage: message
            });

            // If compression preference wasn't provided, ask for it (in a real app)
            const transfer = this.transferManager.getTransfer(fileId);
            if (transfer.isVideo && transfer.shouldCompress === undefined) {
                // In GitHub Actions, we can't ask interactively, so default to false
                transfer.shouldCompress = false;
            }

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

            // Download the file if it's from Telegram
            let filePath = '';
            if (platform === 'telegram' && transfer.originalMessage) {
                filePath = await this.downloadFile(fileId, transfer.originalMessage, 30, this.estimateProcessTimes(fileSize, isVideo, shouldCompress));
            } else {
                // For Bale and Rubika, we assume the file is already available in the temp directory
                // In a real implementation, you would download the file from Bale/Rubika's API
                filePath = path.join(config.performance.tempDir, transfer.fileName || `file_${fileId}`);
                console.log(`Using existing file for platform ${platform}: ${filePath}`);
            }

            // Calculate weights for progress bar
            const downloadWeight = 30;
            const compressWeight = shouldCompress && isVideo ? 20 : 0;
            const uploadWeights = {
                bale: destinations.includes('bale') ? 20 : 0,
                rubika: destinations.includes('rubika') ? 20 : 0,
                telegram: 10
            };

            // Estimate times
            const estimates = this.estimateProcessTimes(fileSize, isVideo, shouldCompress);

            // Create initial status message
            const initialText = this.createStatusMessage(
                fileId,
                0,
                downloadWeight,
                compressWeight,
                uploadWeights,
                estimates,
                'downloading',
                0,
                fileSize
            );

            // In GitHub Actions, we can't update Telegram messages, so we'll just log
            console.log(`File ${fileId} - ${initialText}`);

            // Compression if needed
            let targetPath = filePath;
            if (isVideo && shouldCompress) {
                targetPath = await this.compressFile(fileId, filePath, compressWeight, estimates);
            }

            // Upload to destinations
            const fileStats = fs.statSync(targetPath);
            const actualFileSize = fileStats.size;
            const caption = transfer.originalMessage?.text || transfer.originalMessage?.caption || "";

            // Upload to Telegram (forward) if not the source platform
            if (uploadWeights.telegram > 0 && platform !== 'telegram') {
                await this.uploadToTelegram(fileId, transfer, uploadWeights.telegram, estimates);
            }

            // Upload to Bale if selected and not the source platform
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

            // Upload to Rubika if selected and not the source platform
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

            // Final status
            const elapsedTime = (Date.now() - transfer.startTime) / 1000;
            const finalText = this.createFinalMessage(fileId, fileSize, shouldCompress, destinations, elapsedTime);

            console.log(`File ${fileId} - ${finalText}`);

            // Notify Cloudflare Workers of completion
            await this.notifyCompletion(fileId, {
                status: 'completed',
                fileId,
                originalSize: fileSize,
                compressed: shouldCompress,
                destinations,
                elapsedTime
            });

            // Clean up
            await this.transferManager.cleanupTransfer(fileId);

        } catch (error) {
            console.error(`Error processing file ${fileId}:`, error);
            await this.notifyError(`Error processing file ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
            await this.notifyCompletion(fileId, {
                status: 'failed',
                fileId,
                error: error instanceof Error ? error.message : String(error)
            });
            await this.transferManager.cleanupTransfer(fileId);
        }
    }

    async downloadFile(fileId, message, downloadWeight, estimates) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) throw new Error("Transfer not found");

        const client = this.telegramClient.getClient();
        const filePath = transfer.filePath;
        const fileSize = transfer.fileSize || 0;

        return new Promise(async (resolve, reject) => {
            try {
                const writeStream = fs.createWriteStream(filePath, {
                    highWaterMark: config.performance.downloadChunkSize
                });

                let downloadedBytes = 0;
                const startTime = Date.now();
                let lastUpdate = 0;

                await client.downloadMedia(message.media, {
                    outputFile: writeStream,
                    workers: config.performance.downloadWorkers,
                    progressCallback: async (downloaded, total) => {
                        downloadedBytes = downloaded;
                        const now = Date.now();

                        if (now - lastUpdate >= 500 || downloaded === total) {
                            lastUpdate = now;
                            const elapsedSec = (now - startTime) / 1000;
                            const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                            const remainingBytes = total - downloaded;
                            const etaSec = speed > 0 ? Math.max(0, remainingBytes / speed) : 0;

                            const stepPercent = total ? Math.floor((downloaded / total) * 100) : 0;
                            const masterPercent = Math.floor((stepPercent * downloadWeight) / 100);

                            const text = this.createStatusMessage(
                                fileId,
                                masterPercent,
                                downloadWeight,
                                transfer.shouldCompress && transfer.isVideo ? 20 : 0,
                                {
                                    bale: transfer.destinations?.includes('bale') ? 20 : 0,
                                    rubika: transfer.destinations?.includes('rubika') ? 20 : 0,
                                    telegram: 10
                                },
                                estimates,
                                'downloading',
                                stepPercent,
                                total,
                                downloaded,
                                speed,
                                etaSec
                            );

                            console.log(`File ${fileId} Download: ${stepPercent}% - ${formatBytes(downloaded)}/${formatBytes(total)}`);
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
        const isVideo = transfer.isVideo || false;

        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let lastUpdate = 0;

            const command = spawn('ffmpeg', [
                '-i', inputPath,
                '-threads', '0',
                '-c:v', 'libx264',
                '-crf', '28',
                '-preset', 'ultrafast',
                '-vf', 'scale=-2:480',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart',
                '-x264-params', 'ref=1:bframes=1:scenecut=0',
                '-y', outputPath
            ]);

            command.stderr.on('data', (data) => {
                const output = data.toString();
                const progressMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (progressMatch) {
                    const timeStr = progressMatch[1];
                    const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
                    const currentTime = hours * 3600 + minutes * 60 + seconds;

                    // We need duration for percentage calculation
                    // For now, we'll just log the progress
                    const now = Date.now();
                    if (now - lastUpdate >= 500) {
                        lastUpdate = now;
                        console.log(`File ${fileId} Compression: ${timeStr} processed`);
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

            command.on('error', (err) => {
                reject(err);
            });
        });
    }

    async getVideoMetadata(inputPath) {
        return new Promise((resolve, reject) => {
            const command = spawn('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration,size',
                '-show_entries', 'stream=codec_type,width,height',
                '-of', 'json',
                inputPath
            ]);

            let output = '';
            command.stdout.on('data', (data) => {
                output += data.toString();
            });

            command.on('close', (code) => {
                if (code === 0) {
                    try {
                        const metadata = JSON.parse(output);
                        resolve(metadata);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`ffprobe failed with code ${code}`));
                }
            });

            command.on('error', (err) => {
                reject(err);
            });
        });
    }

    async uploadToTelegram(fileId, transfer, weight, estimates) {
        if (!transfer) {
            console.error(`Transfer ${fileId} not found`);
            return;
        }

        const client = this.telegramClient.getClient();

        try {
            // If the transfer has an original message (from Telegram), forward it
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
                console.log(`File ${fileId} - Forwarded to Telegram`);
            } else {
                // If the transfer is from another platform, upload the file directly
                // This is a simplified approach; in a real implementation, you would upload the file
                console.log(`File ${fileId} - Upload to Telegram not implemented for non-Telegram sources`);
            }
        } catch (err) {
            console.error(`Error uploading to Telegram for file ${fileId}:`, err);
            // Continue with other uploads even if Telegram upload fails
        }
    }

    async uploadToBale(fileId, filePath, fileType, endpoint, fileName, caption, weight, estimates, fileSize) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) throw new Error("Transfer not found");

        if (!config.bale) {
            console.warn("Bale configuration not available");
            return;
        }

        const BALE_MAX_BYTES = 20 * 1024 * 1024;

        if (fileSize > BALE_MAX_BYTES) {
            // Split the file
            const parts = this.splitFile(filePath, BALE_MAX_BYTES, transfer.isVideo || false);
            transfer.parts = parts;

            const totalParts = parts.length;
            for (let i = 0; i < totalParts; i++) {
                const partPath = parts[i];
                const partFileName = `part_${i + 1}_${fileName}`;
                const partCaption = `پارت ${i + 1} از ${totalParts}\n${caption}`;

                await this.uploadToBaleSingle(
                    fileId,
                    partPath,
                    fileType,
                    endpoint,
                    partFileName,
                    partCaption,
                    weight / totalParts,
                    estimates,
                    i,
                    totalParts
                );

                // Clean up part file
                try {
                    await fs.promises.unlink(partPath);
                } catch (err) {
                    console.error(`Error deleting part file ${partPath}:`, err);
                }
            }
        } else {
            await this.uploadToBaleSingle(
                fileId,
                filePath,
                fileType,
                endpoint,
                fileName,
                caption,
                weight,
                estimates
            );
        }
    }

    async uploadToBaleSingle(fileId, filePath, fileType, endpoint, fileName, caption, weight, estimates, partIndex, totalParts) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) throw new Error("Transfer not found");

        if (!config.bale) return;

        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        return new Promise(async (resolve, reject) => {
            try {
                const boundary = `----BaleUploadBoundary${Date.now()}${Math.random().toString(16).substring(2)}`;
                const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${config.bale.chatId}\r\n` +
                                  (caption ? `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` : '') +
                                  `--${boundary}\r\nContent-Disposition: form-data; name="${fileType}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;

                const footerStr = `\r\n--${boundary}--\r\n`;
                const headerBuffer = Buffer.from(headerStr, 'utf8');
                const footerBuffer = Buffer.from(footerStr, 'utf8');

                const options = {
                    hostname: 'tapi.bale.ai',
                    path: `/bot${config.bale.botToken}/${endpoint}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': headerBuffer.length + fileSize + footerBuffer.length,
                        'Connection': 'keep-alive'
                    },
                    agent: optimizedAgent
                };

                const req = https.request(options, (res) => {
                    let resData = '';
                    res.on('data', (chunk) => { resData += chunk; });
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const json = JSON.parse(resData);
                                if (json.ok) {
                                    console.log(`File ${fileId} - Uploaded to Bale: ${partIndex !== undefined ? `Part ${partIndex + 1}/${totalParts}` : 'Complete'}`);
                                    resolve();
                                } else {
                                    reject(new Error(json.description || resData));
                                }
                            } catch (e) {
                                resolve();
                            }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
                        }
                    });
                });

                req.on('error', (err) => reject(err));

                // Stream the file with progress tracking
                const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.downloadChunkSize });
                let uploadedBytes = 0;
                const startTime = Date.now();
                let lastUpdate = 0;

                fileStream.on('data', (chunk) => {
                    uploadedBytes += chunk.length;
                    req.write(chunk);

                    const now = Date.now();
                    if (now - lastUpdate >= 500 || uploadedBytes === fileSize) {
                        lastUpdate = now;
                        const elapsedSec = (now - startTime) / 1000;
                        const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                        const remainingBytes = fileSize - uploadedBytes;
                        const etaSec = speed > 0 ? Math.max(0, remainingBytes / speed) : 0;
                        const percent = Math.min(100, Math.floor((uploadedBytes / fileSize) * 100));

                        console.log(`File ${fileId} Bale Upload: ${percent}% - ${formatBytes(uploadedBytes)}/${formatBytes(fileSize)}`);
                    }
                });

                fileStream.on('end', () => {
                    req.write(footerBuffer);
                    req.end();
                });

                fileStream.on('error', (err) => {
                    req.destroy();
                    reject(err);
                });

                // Write header
                req.write(headerBuffer);
            } catch (err) {
                reject(err);
            }
        });
    }

    async uploadToRubika(fileId, filePath, fileType, fileName, caption, weight, estimates, fileSize) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) throw new Error("Transfer not found");

        if (!config.rubika) {
            console.warn("Rubika configuration not available");
            return;
        }

        try {
            // Step 1: Request upload URL using the correct Rubika API method
            const rubikaBaseUrl = config.rubika.baseUrl || 'https://botapi.rubika.ir/v3/';
            const uploadInfo = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/requestSendFile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: fileType }),
                agent: optimizedAgent
            }).then(res => res.json());

            if (!uploadInfo.ok) {
                throw new Error(uploadInfo.description || "خطا در دریافت اطلاعات آپلود روبیکا");
            }

            // Step 2: Upload the file using multipart/form-data
            let uploadedBytes = 0;
            const startTime = Date.now();
            let lastUpdate = 0;

            // Create a file stream with progress tracking
            const fileStream = fs.createReadStream(filePath, { highWaterMark: config.performance.uploadChunkSize });
            
            // Create a custom stream to track bytes uploaded
            const trackedStream = new stream.Transform({
                transform(chunk, encoding, callback) {
                    uploadedBytes += chunk.length;
                    
                    const now = Date.now();
                    if (now - lastUpdate >= 500 || uploadedBytes === fileSize) {
                        lastUpdate = now;
                        const elapsedSec = (now - startTime) / 1000;
                        const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                        const remainingBytes = fileSize - uploadedBytes;
                        const etaSec = speed > 0 ? Math.max(0, remainingBytes / speed) : 0;
                        const percent = Math.min(100, Math.floor((uploadedBytes / fileSize) * 100));

                        // Update progress
                        const downloadWeight = 30;
                        const compressWeight = transfer.shouldCompress && transfer.isVideo ? 20 : 0;
                        const telegramWeight = 10;
                        const baleWeight = transfer.destinations?.includes('bale') ? 20 : 0;
                        
                        const currentWeight = downloadWeight + compressWeight + telegramWeight + baleWeight + (percent * weight / 100);
                        const masterPercent = Math.min(100, Math.floor(currentWeight));

                        console.log(`File ${fileId} Rubika Upload: ${percent}% - ${formatBytes(uploadedBytes)}/${formatBytes(fileSize)}`);
                    }
                    
                    this.push(chunk);
                    callback();
                }
            });

            // Pipe the file stream through the tracking stream
            fileStream.pipe(trackedStream);

            // Create form data with the tracked stream
            const formData = new FormData();
            formData.append('file', trackedStream, {
                filename: fileName,
                knownLength: fileSize
            });

            // Step 3: Upload to Rubika using the provided upload URL
            const uploadResponse = await fetch(uploadInfo.result.upload_url, {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders(),
                agent: optimizedAgent
            });

            if (!uploadResponse.ok) {
                const errorText = await uploadResponse.text();
                throw new Error(`HTTP ${uploadResponse.status}: ${errorText}`);
            }

            const uploadResult = await uploadResponse.json();

            if (!uploadResult.ok) {
                throw new Error(uploadResult.description || "خطا در آپلود فایل به روبیکا");
            }

            // Step 4: Send the file to chat using sendFile method
            const sendResponse = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/sendFile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: config.rubika.chatId,
                    file_id: uploadResult.result.file_id,
                    text: caption
                }),
                agent: optimizedAgent
            }).then(res => res.json());

            if (!sendResponse.ok) {
                throw new Error(sendResponse.description || "خطا در ارسال فایل به روبیکا");
            }

            console.log(`File ${fileId} - Uploaded to Rubika successfully`);
            transfer.rubikaMsgId = sendResponse.result?.message_id;
            
            // Notify Cloudflare Worker of completion
            if (process.env.CLOUDFLARE_WEBHOOK_URL) {
                await fetch(process.env.CLOUDFLARE_WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
                    },
                    body: JSON.stringify({
                        event: 'transfer_progress',
                        fileId: fileId,
                        progress: 100,
                        status: 'completed'
                    })
                }).catch(err => console.error('Failed to notify Cloudflare:', err));
                
            }
            
        } catch (err) {
            console.error(`Error uploading to Rubika for file ${fileId}:`, err);
            
            // Notify Cloudflare Worker of failure
            if (process.env.CLOUDFLARE_WEBHOOK_URL) {
                await fetch(process.env.CLOUDFLARE_WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
                    },
                    body: JSON.stringify({
                        event: 'transfer_error',
                        fileId: fileId,
                        error: err.message
                    })
                }).catch(err => console.error('Failed to notify Cloudflare:', err));
            }
            
            throw err;
        }
    }

    splitFile(filePath, maxSize, isVideo) {
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        const parts = [];
        const baseName = path.basename(filePath, path.extname(filePath));
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);

        if (isVideo) {
            // For videos, we'll use ffmpeg to split by time
            return this.splitVideoByBitrate(filePath, maxSize);
        } else {
            // For other files, split by bytes
            const fd = fs.openSync(filePath, 'r');
            let bytesRead = 0;
            let partIndex = 1;

            while (bytesRead < fileSize) {
                const chunkSize = Math.min(maxSize, fileSize - bytesRead);
                const buffer = Buffer.alloc(chunkSize);
                fs.readSync(fd, buffer, 0, chunkSize, bytesRead);

                const partName = path.join(dir, `${baseName}_part${partIndex.toString().padStart(3, '0')}${ext}`);
                fs.writeFileSync(partName, buffer);
                parts.push(partName);

                bytesRead += chunkSize;
                partIndex++;
            }

            fs.closeSync(fd);
            return parts;
        }
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
                command.stdout.on('data', (data) => {
                    output += data.toString();
                });

                command.on('close', async (code) => {
                    if (code !== 0) {
                        return reject(new Error('Failed to get video metadata'));
                    }

                    try {
                        const metadata = JSON.parse(output);
                        const duration = parseFloat(metadata.format.duration);
                        const totalSize = parseInt(metadata.format.size);

                        if (!duration || !totalSize) {
                            return reject(new Error("Could not determine video duration or size"));
                        }

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
                                        reject(new Error(`FFmpeg failed with code ${code}`));
                                    }
                                });

                                ffmpegCommand.on('error', (err) => {
                                    reject(err);
                                });
                            });

                            currentTime += targetSegmentDuration;
                            partIndex++;
                        }

                        resolve(parts);
                    } catch (e) {
                        reject(e);
                    }
                });

                command.on('error', (err) => {
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
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

        const estUploadSizeBale = willCompress ? fileSize * compressedSizeRatio : fileSize;
        const estUploadSecBale = Math.ceil(estUploadSizeBale / (3 * 1024 * 1024));

        const estUploadSizeRubika = willCompress ? fileSize * compressedSizeRatio : fileSize;
        const estUploadSecRubika = Math.ceil(estUploadSizeRubika / (5 * 1024 * 1024));

        const totalEstSec = estDownloadSec + estCompressSec + estUploadSecBale + estUploadSecRubika;

        return {
            estDownloadSec,
            estCompressSec,
            estUploadSecBale,
            estUploadSecRubika,
            totalEstSec
        };
    }

    // Helper: Get Rubika file type based on transfer info
    getRubikaFileType(transfer) {
        if (!transfer) return 'File';

        const mimeType = transfer.mimeType || '';
        const isVideo = transfer.isVideo || false;

        if (isVideo || mimeType.startsWith('video/')) {
            return 'Video';
        }

        if (mimeType.startsWith('image/')) {
            return 'Image';
        }

        if (mimeType.startsWith('audio/')) {
            // Check if it's a voice message (typically OGG)
            if (mimeType.includes('ogg')) {
                return 'Voice';
            }
            // Otherwise, treat as music
            return 'Music';
        }

        // Check file extension for GIF
        const fileName = transfer.fileName || '';
        if (fileName.toLowerCase().endsWith('.gif') || mimeType.includes('gif')) {
            return 'Gif';
        }

        // Default to File
        return 'File';
    }

    createStatusMessage(fileId, masterPercent, downloadWeight, compressWeight, uploadWeights, estimates, currentStage, stepPercent = 0, totalBytes = 0, currentBytes = 0, speed = 0, etaSec = 0) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) return "Transfer not found";

        const fileSize = transfer.fileSize || 0;
        const isVideo = transfer.isVideo || false;
        const shouldCompress = transfer.shouldCompress || false;
        const destinations = transfer.destinations || [];

        const masterBar = drawProgressBar(masterPercent);
        const stepBar = drawProgressBar(stepPercent);

        let stageDescription = '';
        let stageDetails = '';

        switch (currentStage) {
            case 'downloading':
                stageDescription = '📥 **مرحله ۱: دانلود از تلگرام**';
                stageDetails = `📊 **حجم:** \`${formatBytes(currentBytes)}\` / \`${formatBytes(totalBytes)}\``;
                break;
            case 'compressing':
                stageDescription = '⚙️ **مرحله ۲: فشرده‌سازی ویدیو (480p)**';
                stageDetails = `⏳ **زمان باقی‌مانده:** \`${formatETA(etaSec)}\``;
                if (speed > 0) {
                    stageDetails += `\n⚡ **سرعت پردازش:** \`${speed.toFixed(1)} فریم/ثانیه\``;
                }
                break;
            case 'uploading_telegram':
                stageDescription = '📤 **مرحله ۳: آپلود به تلگرام**';
                stageDetails = '✅ **فایل با موفقیت به تلگرام ارسال شد**';
                break;
            case 'uploading_bale':
                stageDescription = '📤 **مرحله ۴: آپلود به بله**';
                stageDetails = `📊 **حجم:** \`${formatBytes(currentBytes)}\` / \`${formatBytes(totalBytes)}\``;
                break;
            case 'uploading_rubika':
                stageDescription = '📤 **مرحله ۵: آپلود به روبیکا**';
                stageDetails = `📊 **حجم:** \`${formatBytes(currentBytes)}\` / \`${formatBytes(totalBytes)}\``;
                break;
            default:
                stageDescription = '🔄 **در حال پردازش**';
        }

        if (speed > 0 && currentStage !== 'compressing') {
            stageDetails += `\n🚀 **سرعت:** \`${formatSpeed(speed)}\``;
        }
        if (etaSec > 0) {
            stageDetails += `\n⏳ **زمان باقی‌مانده:** \`${formatETA(etaSec)}\``;
        }

        const estimationLines = [
            `📁 **فایل ${fileId} - ${formatBytes(fileSize)}**`,
            `⏱ **تخمین کل زمان:** \`~${formatETA(estimates.totalEstSec)}\``,
            `🔹 **دانلود:** \`~${formatETA(estimates.estDownloadSec)}\` (سرعت: ~25 مگابایت/ثانیه)`
        ];

        if (shouldCompress && isVideo) {
            estimationLines.push(`🔹 **فشرده‌سازی:** \`~${formatETA(estimates.estCompressSec)}\``);
        }

        if (uploadWeights.telegram > 0) {
            estimationLines.push(`🔹 **آپلود به تلگرام:** \`~${formatETA(estimates.estUploadSecBale)}\``);
        }

        if (destinations.includes('bale')) {
            estimationLines.push(`🔹 **آپلود به بله:** \`~${formatETA(estimates.estUploadSecBale)}\``);
        }

        if (destinations.includes('rubika')) {
            estimationLines.push(`🔹 **آپلود به روبیکا:** \`~${formatETA(estimates.estUploadSecRubika)}\``);
        }

        estimationLines.push("-----------------------------------");

        const messageParts = [
            ...estimationLines,
            `🏆 **پیشرفت کل:** \`[${masterBar}]\` ${masterPercent}%`,
            "-----------------------------------",
            stageDescription,
            `\`[${stepBar}]\` ${stepPercent}%`,
            stageDetails
        ];

        if (destinations.length > 0) {
            messageParts.push("-----------------------------------");
            messageParts.push(`📌 **مقصد(های) ارسال:** ${destinations.map(d => d === 'bale' ? 'بله' : 'روبیکا').join(' و ')}`);
        }

        return messageParts.filter(Boolean).join("\n");
    }

    createFinalMessage(fileId, originalSize, wasCompressed, destinations, elapsedTime) {
        const transfer = this.transferManager.getTransfer(fileId);
        if (!transfer) return "Transfer not found";

        const finalBar = drawProgressBar(100);
        const compressedSize = wasCompressed ? Math.floor(originalSize * 0.4) : originalSize;

        const messageParts = [
            `📁 **فایل ${fileId}**`,
            `🏆 **پیشرفت کل:** \`[${finalBar}]\` 100%`,
            "-----------------------------------",
            "✅ **انتقال با موفقیت کامل انجام شد!**",
            "",
            "📌 **خلاصه انتقال:**",
            `- حجم اصلی: ${formatBytes(originalSize)}`,
            wasCompressed ? `- حجم فشرده: ${formatBytes(compressedSize)}` : '',
            `- مقصد(های) ارسال: ${destinations.map(d => d === 'bale' ? 'بله' : 'روبیکا').join(' و ')}`,
            "",
            `⚡ **سرعت دانلود متوسط:** ~25 مگابایت/ثانیه`,
            `🕒 **زمان کل:** ${formatETA(elapsedTime)}`
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
                body: JSON.stringify({
                    event: 'transfer_complete',
                    ...data
                })
            });
        } catch (error) {
            console.error("Error notifying completion:", error);
        }
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
                body: JSON.stringify({
                    event: 'transfer_error',
                    error,
                    timestamp: new Date().toISOString()
                })
            });
        } catch (err) {
            console.error("Error notifying error:", err);
        }
    }
}

// Main execution
async function main() {
    const bot = new FileTransferBot();

    try {
        await bot.start();
    } catch (error) {
        console.error("Fatal error:", error);
        process.exit(1);
    }
}

// Start the application
main();
