const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");
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
    if (!bytes || bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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
 * Sends a message with Inline Keyboard buttons and polls until the user makes a choice.
 */
async function askCompressionPreference(statusMsgId) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: "⚡ Compress (480p)", callback_data: "compress_yes" },
                { text: "📁 Keep Original", callback_data: "compress_no" }
            ]
        ]
    };

    const text = "🎬 **Video detected!**\nDo you want to compress the video before transferring?";
    statusMsgId = await updateTelegramStatus(statusMsgId, text, keyboard);

    // Poll Telegram getUpdates API for the button interaction
    let userChoice = null;
    let offset = 0;

    // Get initial offset to ignore old updates
    try {
        const initRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1`);
        const initData = await initRes.json();
        if (initData.ok && initData.result.length > 0) {
            offset = initData.result[initData.result.length - 1].update_id + 1;
        }
    } catch (e) {}

    while (userChoice === null) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=10`);
            const data = await res.json();

            if (data.ok && data.result) {
                for (const update of data.result) {
                    offset = update.update_id + 1;
                    if (update.callback_query && String(update.callback_query.message.chat.id) === String(TELEGRAM_CHAT_ID)) {
                        const dataVal = update.callback_query.data;
                        if (dataVal === "compress_yes") userChoice = true;
                        if (dataVal === "compress_no") userChoice = false;

                        // Answer Callback Query to stop loading animation on Telegram UI
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ callback_query_id: update.callback_query.id, text: "Choice recorded!" })
                        });

                        if (userChoice !== null) break;
                    }
                }
            }
        } catch (err) {
            console.error("Polling error:", err);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return { userChoice, statusMsgId };
}

function getVideoMetadata(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
}

function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
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
            .on("end", () => resolve(outputPath))
            .on("error", (err) => reject(err));
    });
}

function splitVideoByBitrate(inputPath, targetMaxBytes) {
    return new Promise(async (resolve, reject) => {
        try {
            const metadata = await getVideoMetadata(inputPath);
            const duration = metadata.format.duration;
            const totalSize = metadata.format.size;

            if (!duration || !totalSize) {
                return reject(new Error("Unable to calculate video duration or size."));
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
        statusMsgId = await updateTelegramStatus(null, "⚡ **Preparing download pipeline...**");

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
            throw new Error("File not found in Telegram.");
        }

        const msg = messages[0];
        const isVideo = msg.media.document?.mimeType?.startsWith("video/") || false;
        let shouldCompress = false;

        // Ask user if they want compression BEFORE downloading (only for videos)
        if (isVideo) {
            const result = await askCompressionPreference(statusMsgId);
            shouldCompress = result.userChoice;
            statusMsgId = result.statusMsgId;
        }

        statusMsgId = await updateTelegramStatus(statusMsgId, "📥 **Starting download from Telegram...**");

        let lastUpdate = Date.now();
        const writeStream = fs.createWriteStream(rawFilePath, {
            highWaterMark: 64 * 1024 * 1024
        });

        await client.downloadMedia(msg.media, {
            outputFile: writeStream,
            workers: 14,
            progressCallback: async (downloaded, total) => {
                const now = Date.now();
                if (now - lastUpdate > 8000 || downloaded === total) {
                    lastUpdate = now;
                    const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                    const bar = drawProgressBar(percent);
                    const text = [
                        "📥 **Downloading from Telegram...**",
                        `\`[${bar}]\` ${percent}%`,
                        `📊 **Size:** \`${formatBytes(downloaded)}\` / \`${formatBytes(total)}\``,
                    ].join("\n");

                    statusMsgId = await updateTelegramStatus(statusMsgId, text);
                }
            },
        });

        let targetUploadPath = rawFilePath;

        // Compress only if the user approved it earlier
        if (isVideo && shouldCompress) {
            statusMsgId = await updateTelegramStatus(statusMsgId, "⚙️ **Compressing video (480p Multithreaded)...**");
            
            try {
                await compressVideo(rawFilePath, compressedFilePath);
                targetUploadPath = compressedFilePath;
            } catch (ffmpegErr) {
                console.warn("Compression failed, proceeding with original file:", ffmpegErr.message);
            }
        }

        const fileSize = fs.statSync(targetUploadPath).size;
        const rawCaption = msg.text || msg.caption || "";
        const endpoint = isVideo ? "sendVideo" : "sendDocument";
        const fileParamName = isVideo ? "video" : "document";

        if (fileSize <= BALE_MAX_BYTES) {
            statusMsgId = await updateTelegramStatus(statusMsgId, "📤 **Uploading to Bale...**");
            
            const formData = new FormData();
            formData.append("chat_id", BALE_CHAT_ID);
            if (rawCaption) {
                formData.append("caption", truncateCaption(rawCaption));
            }
            
            const uploadFileName = isVideo ? "video.mp4" : path.basename(targetUploadPath);
            formData.append(fileParamName, new Blob([fs.readFileSync(targetUploadPath)]), uploadFileName);

            const res = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/${endpoint}`, {
                method: "POST",
                body: formData,
            });

            if (!res.ok) throw new Error(await res.text());
        } else {
            statusMsgId = await updateTelegramStatus(
                statusMsgId,
                `📦 **File exceeds Bale limit (20MB). Splitting into parts...**\nTotal Size: \`${formatBytes(fileSize)}\``
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

                statusMsgId = await updateTelegramStatus(
                    statusMsgId,
                    `📤 **Uploading part ${i + 1} of ${totalParts} to Bale...**\n\`[${drawProgressBar(Math.floor(((i + 1) / totalParts) * 100))}]\``
                );

                const partCaption = truncateCaption(`پارت ${i + 1} از ${totalParts}${rawCaption ? `\n\n${rawCaption}` : ""}`);

                const formData = new FormData();
                formData.append("chat_id", BALE_CHAT_ID);
                formData.append("caption", partCaption);
                formData.append(fileParamName, new Blob([fs.readFileSync(partPath)]), partFileName);

                const res = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/${endpoint}`, {
                    method: "POST",
                    body: formData,
                });

                if (!res.ok) {
                    throw new Error(`Failed to upload part ${i + 1}: ${await res.text()}`);
                }

                fs.unlinkSync(partPath);
            }
        }

        await updateTelegramStatus(statusMsgId, "✅ **Transfer completed successfully!**");
        cleanUpFiles(rawFilePath, compressedFilePath, generatedParts);
        await client.disconnect();
        process.exit(0);
    } catch (err) {
        console.error("Transfer failed:", err);
        cleanUpFiles(rawFilePath, compressedFilePath, generatedParts);
        if (statusMsgId) {
            await updateTelegramStatus(statusMsgId, `❌ **Transfer Error:** ${err.message}`);
        }
        process.exit(1);
    }
})();