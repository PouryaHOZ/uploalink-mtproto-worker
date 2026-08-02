const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const FormData = require("form-data");
const stream = require("stream");

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
        try {
            await this.telegramClient.connect();
            const messageId = process.env.MESSAGE_ID || '0';
            const fileName = process.env.FILE_NAME || `file_${Date.now()}`;
            const fileSize = parseInt(process.env.FILE_SIZE || '0');
            const isVideo = process.env.IS_VIDEO === 'true';
            const rawDestinations = process.env.DESTINATIONS || '';
            const destinations = rawDestinations ? rawDestinations.split(',') : ['bale', 'rubika'];
            const shouldCompress = process.env.SHOULD_COMPRESS === 'true';

            const filePath = path.join(config.performance.tempDir, fileName);
            const client = this.telegramClient.client;

            const messages = await client.getMessages(BigInt(config.telegram.chatId), { ids: [parseInt(messageId)] });
            if (!messages || !messages[0] || !messages[0].media) throw new Error("فایل در تلگرام یافت نشد.");

            console.log(`[Start] Downloading message ${messageId}...`);
            const writeStream = fs.createWriteStream(filePath, { highWaterMark: config.performance.downloadChunkSize });

            await client.downloadMedia(messages[0].media, {
                outputFile: writeStream,
                workers: config.performance.downloadWorkers
            });

            let targetPath = filePath;
            if (isVideo && shouldCompress) {
                const compressedPath = path.join(config.performance.tempDir, `compressed_${Date.now()}.mp4`);
                console.log(`[FFmpeg] Compressing video to 480p...`);
                await new Promise((resolve, reject) => {
                    const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-threads', '0', '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-vf', 'scale=-2:480', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', compressedPath]);
                    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg error')));
                });
                targetPath = compressedPath;
            }

            const stats = fs.statSync(targetPath);

            if (destinations.includes('bale') && config.bale) {
                console.log(`[Bale] Uploading file...`);
                const formData = new FormData();
                formData.append('chat_id', config.bale.chatId);
                formData.append(isVideo ? 'video' : 'document', fs.createReadStream(targetPath), { filename: fileName });
                
                await new Promise((resolve, reject) => {
                    const req = https.request({
                        hostname: 'tapi.bale.ai',
                        path: `/bot${config.bale.botToken}/${isVideo ? 'sendVideo' : 'sendDocument'}`,
                        method: 'POST',
                        headers: formData.getHeaders()
                    }, res => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject());
                    formData.pipe(req);
                });
            }

            if (destinations.includes('rubika') && config.rubika) {
                console.log(`[Rubika] Requesting upload URL...`);
                const rubikaBaseUrl = config.rubika.baseUrl || 'https://botapi.rubika.ir/v3/';
                const uploadInfo = await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/requestSendFile`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: isVideo ? 'Video' : 'File' })
                }).then(r => r.json());

                if (uploadInfo.ok) {
                    const formData = new FormData();
                    formData.append('file', fs.createReadStream(targetPath), { filename: fileName });
                    const parsedUrl = new URL(uploadInfo.result.upload_url);

                    const uploadRes = await new Promise((resolve, reject) => {
                        const req = https.request({
                            hostname: parsedUrl.hostname,
                            path: parsedUrl.pathname + parsedUrl.search,
                            method: 'POST',
                            headers: formData.getHeaders()
                        }, res => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => resolve(JSON.parse(data)));
                        });
                        formData.pipe(req);
                    });

                    if (uploadRes.ok) {
                        await fetch(`${rubikaBaseUrl}${config.rubika.botToken}/sendFile`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: config.rubika.chatId, file_id: uploadRes.result.file_id, text: `📥 فایل ${fileName}` })
                        });
                    }
                }
            }

            console.log("✅ Transfer Completed!");
            await this.telegramClient.disconnect();
            process.exit(0);

        } catch (err) {
            console.error("Transfer error:", err);
            await this.telegramClient.disconnect();
            process.exit(1);
        }
    }
}

new FileTransferBot().start();