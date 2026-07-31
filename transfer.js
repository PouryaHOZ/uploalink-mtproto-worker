const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
const https = require("https");
const ffmpeg = require("fluent-ffmpeg");

const {
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    TELEGRAM_SESSION_STRING,
    TELEGRAM_BOT_TOKEN,
    BALE_BOT_TOKEN,
    MESSAGE_ID,
    TELEGRAM_CHAT_ID,
    BALE_CHAT_ID,
} = process.env;

const BALE_MAX_BYTES = 20 * 1024 * 1024;
const BALE_MAX_CAPTION_LENGTH = 4096;

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

function truncateCaption(text, limit = BALE_MAX_CAPTION_LENGTH) {
    if (!text) return "";
    return text.length > limit ? text.substring(0, limit - 3) + "..." : text;
}

async function updateTelegramStatus(messageId, text, replyMarkup = null) {
    if (!TELEGRAM_BOT_TOKEN) return null;

    try {
        const url = messageId
            ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`
            : `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

        const body = messageId
            ? { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: "Markdown" }
            : { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };

        if (replyMarkup) {
            body.reply_markup = replyMarkup;
        }

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        const data = await res.json();
        if (!data.ok) return messageId;
        return messageId || data.result?.message_id;
    } catch (err) {
        return messageId;
    }
}

/**
 * پرسش از کاربر جهت فشرده‌سازی ویدیو
 */
async function askCompressionPreference(client, statusMsgId) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: "⚡ فشرده‌سازی (480p)", callback_data: "compress_yes" },
                { text: "📁 حفظ فایل اصلی", callback_data: "compress_no" }
            ]
        ]
    };

    const text = "🎬 **ویدیو شناسایی شد!**\nآیا می‌خواهید ویدیو قبل از انتقال فشرده‌سازی شود؟";
    statusMsgId = await updateTelegramStatus(statusMsgId, text, keyboard);

    return new Promise((resolve) => {
        const callbackHandler = async (event) => {
            try {
                if (event.className === "UpdateBotCallbackQuery") {
                    const dataStr = event.data.toString("utf8");
                    if (dataStr === "compress_yes" || dataStr === "compress_no") {
                        client.removeEventHandler(callbackHandler);
                        
                        await client.invoke(
                            new Api.messages.SetBotCallbackAnswer({
                                queryId: event.queryId,
                                message: "انتخاب شما ثبت شد!"
                            })
                        );

                        resolve({
                            userChoice: dataStr === "compress_yes",
                            statusMsgId
                        });
                    }
                }
            } catch (err) {
                console.error("خطا در پاسخ دکمه:", err);
            }
        };

        client.addEventHandler(callbackHandler);
    });
}

function getVideoMetadata(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
}

/**
 * فشرده‌سازی ویدیو با گزارش پیشرفت و به‌روزرسانی هر ۱ ثانیه
 */
function compressVideo(inputPath, outputPath, duration, onProgress) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let lastUpdate = 0;

        ffmpeg(inputPath)
            .outputOptions([
                "-threads 0",
                "-c:v libx264",
                "-crf 28",
                "-preset ultrafast",
                "-vf scale=-2:480",
                "-c:a aac",
                "-b:a 128k",
                "-movflags +faststart"
            ])
            .save(outputPath)
            .on("progress", (progress) => {
                let percent = progress.percent;
                if ((!percent || percent <= 0) && duration && progress.timemark) {
                    const parts = progress.timemark.split(":");
                    if (parts.length === 3) {
                        const secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                        percent = (secs / duration) * 100;
                    }
                }

                percent = Math.min(100, Math.max(0, percent || 0));
                const now = Date.now();

                // به‌روزرسانی هر ۱ ثانیه (1000 میلی‌ثانیه)
                if (now - lastUpdate >= 1000 || percent === 100) {
                    lastUpdate = now;
                    const elapsedSec = (now - startTime) / 1000;
                    let etaSec = 0;
                    if (percent > 0 && elapsedSec > 0) {
                        const totalEstimatedSec = (elapsedSec / percent) * 100;
                        etaSec = Math.max(0, totalEstimatedSec - elapsedSec);
                    }
                    if (onProgress) {
                        onProgress({ percent: Math.floor(percent), etaSec, fps: progress.currentFps });
                    }
                }
            })
            .on("end", () => resolve(outputPath))
            .on("error", (err) => reject(err));
    });
}

/**
 * آپلود فایل به بله همراه با استریم و به‌روزرسانی هر ۱ ثانیه
 */
function uploadToBaleWithProgress(endpoint, fileParamName, filePath, fileName, caption, onProgress) {
    return new Promise((resolve, reject) => {
        const boundary = "----BaleUploadBoundary" + Date.now().toString(16);
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        let headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${BALE_CHAT_ID}\r\n`;
        if (caption) {
            headerStr += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
        }
        headerStr += `--${boundary}\r\nContent-Disposition: form-data; name="${fileParamName}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;

        const footerStr = `\r\n--${boundary}--\r\n`;

        const headerBuffer = Buffer.from(headerStr, "utf8");
        const footerBuffer = Buffer.from(footerStr, "utf8");
        const totalPayloadSize = headerBuffer.length + fileSize + footerBuffer.length;

        const options = {
            hostname: "tapi.bale.ai",
            path: `/bot${BALE_BOT_TOKEN}/${endpoint}`,
            method: "POST",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": totalPayloadSize
            }
        };

        const req = https.request(options, (res) => {
            let resData = "";
            res.on("data", (chunk) => { resData += chunk; });
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const json = JSON.parse(resData);
                        if (json.ok) resolve(json);
                        else reject(new Error(json.description || resData));
                    } catch (e) {
                        resolve(resData);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
                }
            });
        });

        req.on("error", (err) => reject(err));

        req.write(headerBuffer);

        const fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        let uploadedBytes = 0;
        const startTime = Date.now();
        let lastUpdate = Date.now();

        fileStream.on("data", (chunk) => {
            uploadedBytes += chunk.length;
            req.write(chunk);

            const now = Date.now();
            // به‌روزرسانی هر ۱ ثانیه (1000 میلی‌ثانیه)
            if (now - lastUpdate >= 1000 || uploadedBytes === fileSize) {
                lastUpdate = now;
                const elapsedSec = (now - startTime) / 1000;
                const speed = elapsedSec > 0 ? uploadedBytes / elapsedSec : 0;
                const remainingBytes = fileSize - uploadedBytes;
                const etaSec = speed > 0 ? Math.max(0, remainingBytes / speed) : 0;
                const percent = Math.min(100, Math.floor((uploadedBytes / fileSize) * 100));

                if (onProgress) {
                    onProgress({ percent, uploaded: uploadedBytes, total: fileSize, speed, etaSec });
                }
            }
        });

        fileStream.on("end", () => {
            req.write(footerBuffer);
            req.end();
        });

        fileStream.on("error", (err) => {
            req.destroy();
            reject(err);
        });
    });
}

function splitVideoByBitrate(inputPath, targetMaxBytes) {
    return new Promise(async (resolve, reject) => {
        try {
            const metadata = await getVideoMetadata(inputPath);
            const duration = metadata.format.duration;
            const totalSize = metadata.format.size;

            if (!duration || !totalSize) {
                return reject(new Error("محاسبه مدت زمان یا حجم ویدیو امکان‌پذیر نیست."));
            }

            const bytesPerSecond = totalSize / duration;
            const targetSegmentDuration = Math.floor((targetMaxBytes * 0.95) / bytesPerSecond);

            const parts = [];
            const outputPrefix = inputPath.replace(/\.[^/.]+$/, "");

            let currentTime = 0;
            let partIndex = 1;
            let completed = 0;
            const tasks = [];

            while (currentTime < duration) {
                const partPath = `${outputPrefix}_part${String(partIndex).padStart(3, "0")}.mp4`;
                const startTime = currentTime;
                const isLastPart = (currentTime + targetSegmentDuration) >= duration;
                const currentDuration = isLastPart ? (duration - currentTime) : targetSegmentDuration;

                tasks.push({ startTime, duration: currentDuration, partPath });
                currentTime += targetSegmentDuration;
                partIndex++;
            }

            for (const task of tasks) {
                const command = ffmpeg(inputPath).setStartTime(task.startTime);

                if (task.startTime + task.duration < duration) {
                    command.setDuration(task.duration);
                }

                command
                    .outputOptions([
                        "-threads 0",
                        "-c copy",
                        "-avoid_negative_ts make_zero",
                        "-movflags +faststart"
                    ])
                    .save(task.partPath)
                    .on("end", () => {
                        parts.push(task.partPath);
                        completed++;
                        if (completed === tasks.length) {
                            parts.sort();
                            resolve(parts);
                        }
                    })
                    .on("error", (err) => reject(err));
            }
        } catch (err) {
            reject(err);
        }
    });
}

function splitRawFileBytes(filePath, chunkSize) {
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;
    const parts = [];
    const fd = fs.openSync(filePath, "r");

    let bytesRead = 0;
    let partIndex = 1;

    while (bytesRead < totalSize) {
        const currentChunkSize = Math.min(chunkSize, totalSize - bytesRead);
        const buffer = Buffer.alloc(currentChunkSize);
        fs.readSync(fd, buffer, 0, currentChunkSize, bytesRead);

        const partName = `${filePath}.part${String(partIndex).padStart(3, "0")}`;
        fs.writeFileSync(partName, buffer);
        parts.push(partName);

        bytesRead += currentChunkSize;
        partIndex++;
    }

    fs.closeSync(fd);
    return parts;
}

function cleanUpFiles(...filePaths) {
    for (const filePath of filePaths.flat()) {
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
    }
}

(async () => {
    let statusMsgId = null;
    
    const rawFilePath = path.join(".", "temp_raw_file");
    const compressedFilePath = path.join(".", "temp_compressed.mp4");
    let generatedParts = [];

    try {
        statusMsgId = await updateTelegramStatus(null, "⚡ **در حال آماده‌سازی خط انتقال...**");

        const client = new TelegramClient(
            new StringSession(TELEGRAM_SESSION_STRING.trim()),
            Number(TELEGRAM_API_ID),
            TELEGRAM_API_HASH.trim(),
            { connectionRetries: 5 }
        );

        await client.connect();

        const messages = await client.getMessages(Number(TELEGRAM_CHAT_ID), {
            ids: [Number(MESSAGE_ID)],
        });

        if (!messages || !messages[0] || !messages[0].media) {
            throw new Error("فایل در تلگرام یافت نشد.");
        }

        const msg = messages[0];
        const isVideo = msg.media.document?.mimeType?.startsWith("video/") || false;
        let shouldCompress = false;

        if (isVideo) {
            const result = await askCompressionPreference(client, statusMsgId);
            shouldCompress = result.userChoice;
            statusMsgId = result.statusMsgId;
        }

        statusMsgId = await updateTelegramStatus(statusMsgId, "📥 **در حال شروع دانلود از تلگرام...**");

        let lastUpdate = Date.now();
        const downloadStartTime = Date.now();
        const writeStream = fs.createWriteStream(rawFilePath, {
            highWaterMark: 64 * 1024 * 1024
        });

        await client.downloadMedia(msg.media, {
            outputFile: writeStream,
            workers: 14,
            progressCallback: async (downloaded, total) => {
                const now = Date.now();
                // به‌روزرسانی هر ۱ ثانیه (1000 میلی‌ثانیه)
                if (now - lastUpdate >= 1000 || downloaded === total) {
                    lastUpdate = now;
                    const elapsedSec = (now - downloadStartTime) / 1000;
                    const speed = elapsedSec > 0 ? downloaded / elapsedSec : 0;
                    const remainingBytes = total - downloaded;
                    const etaSec = speed > 0 ? Math.max(0, remainingBytes / speed) : 0;

                    const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                    const bar = drawProgressBar(percent);
                    const text = [
                        "📥 **در حال دانلود از تلگرام...**",
                        `\`[${bar}]\` ${percent}%`,
                        `📊 **حجم:** \`${formatBytes(downloaded)}\` / \`${formatBytes(total)}\``,
                        `🚀 **سرعت دانلود:** \`${formatSpeed(speed)}\``,
                        `⏳ **زمان باقی‌مانده دانلود:** \`${formatETA(etaSec)}\``,
                    ].join("\n");

                    statusMsgId = await updateTelegramStatus(statusMsgId, text);
                }
            },
        });

        let targetUploadPath = rawFilePath;

        if (isVideo && shouldCompress) {
            statusMsgId = await updateTelegramStatus(statusMsgId, "⚙️ **در حال شروع فشرده‌سازی ویدیو...**");
            
            try {
                const metadata = await getVideoMetadata(rawFilePath).catch(() => null);
                const duration = metadata?.format?.duration || 0;

                await compressVideo(rawFilePath, compressedFilePath, duration, async (p) => {
                    const bar = drawProgressBar(p.percent);
                    const fpsText = p.fps ? `\n⚡ **سرعت پردازش:** \`${p.fps} فریم/ثانیه\`` : "";
                    const text = [
                        "⚙️ **در حال فشرده‌سازی ویدیو (480p)...**",
                        `\`[${bar}]\` ${p.percent}%`,
                        fpsText,
                        `⏳ **زمان باقی‌مانده فشرده‌سازی:** \`${formatETA(p.etaSec)}\``
                    ].filter(Boolean).join("\n");

                    statusMsgId = await updateTelegramStatus(statusMsgId, text);
                });
                targetUploadPath = compressedFilePath;
            } catch (ffmpegErr) {
                console.warn("فشرده‌سازی ناموفق بود، ادامه با فایل اصلی:", ffmpegErr.message);
            }
        }

        const fileSize = fs.statSync(targetUploadPath).size;
        const rawCaption = msg.text || msg.caption || "";
        const endpoint = isVideo ? "sendVideo" : "sendDocument";
        const fileParamName = isVideo ? "video" : "document";

        if (fileSize <= BALE_MAX_BYTES) {
            const uploadFileName = isVideo ? "video.mp4" : path.basename(targetUploadPath);

            await uploadToBaleWithProgress(
                endpoint,
                fileParamName,
                targetUploadPath,
                uploadFileName,
                truncateCaption(rawCaption),
                async (p) => {
                    const bar = drawProgressBar(p.percent);
                    const text = [
                        "📤 **در حال آپلود به بله...**",
                        `\`[${bar}]\` ${p.percent}%`,
                        `📊 **حجم:** \`${formatBytes(p.uploaded)}\` / \`${formatBytes(p.total)}\``,
                        `🚀 **سرعت آپلود:** \`${formatSpeed(p.speed)}\``,
                        `⏳ **زمان باقی‌مانده آپلود:** \`${formatETA(p.etaSec)}\``,
                    ].join("\n");

                    statusMsgId = await updateTelegramStatus(statusMsgId, text);
                }
            );
        } else {
            statusMsgId = await updateTelegramStatus(
                statusMsgId,
                `📦 **حجم فایل بیش از حد مجاز بله (20 مگابایت) است. در حال تقسیم فایل...**\nحجم کل: \`${formatBytes(fileSize)}\``
            );

            if (isVideo) {
                generatedParts = await splitVideoByBitrate(targetUploadPath, BALE_MAX_BYTES);
            } else {
                generatedParts = splitRawFileBytes(targetUploadPath, BALE_MAX_BYTES);
            }

            const totalParts = generatedParts.length;

            for (let i = 0; i < totalParts; i++) {
                const partPath = generatedParts[i];
                const partFileName = path.basename(partPath);
                const partCaption = truncateCaption(`پارت ${i + 1} از ${totalParts}${rawCaption ? `\n\n${rawCaption}` : ""}`);

                await uploadToBaleWithProgress(
                    endpoint,
                    fileParamName,
                    partPath,
                    partFileName,
                    partCaption,
                    async (p) => {
                        const bar = drawProgressBar(p.percent);
                        const text = [
                            `📤 **در حال آپلود پارت ${i + 1} از ${totalParts} به بله...**`,
                            `\`[${bar}]\` ${p.percent}%`,
                            `📊 **حجم پارت:** \`${formatBytes(p.uploaded)}\` / \`${formatBytes(p.total)}\``,
                            `🚀 **سرعت آپلود:** \`${formatSpeed(p.speed)}\``,
                            `⏳ **زمان باقی‌مانده پارت:** \`${formatETA(p.etaSec)}\``,
                        ].join("\n");

                        statusMsgId = await updateTelegramStatus(statusMsgId, text);
                    }
                );

                fs.unlinkSync(partPath);
            }
        }

        await updateTelegramStatus(statusMsgId, "✅ **انتقال با موفقیت انجام شد!**");
        cleanUpFiles(rawFilePath, compressedFilePath, generatedParts);
        await client.disconnect();
        process.exit(0);
    } catch (err) {
        console.error("انتقال با خطا مواجه شد:", err);
        cleanUpFiles(rawFilePath, compressedFilePath, generatedParts);
        if (statusMsgId) {
            await updateTelegramStatus(statusMsgId, `❌ **خطای انتقال:** ${err.message}`);
        }
        process.exit(1);
    }
})();