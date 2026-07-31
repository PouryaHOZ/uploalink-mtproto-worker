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

// Set max split size to 20 MB to stay well under Nginx proxy limits
const BALE_MAX_BYTES = 30 * 1024 * 1024;
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

async function updateTelegramStatus(messageId, text) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.error("TELEGRAM_BOT_TOKEN environment variable is missing!");
        return null;
    }

    try {
        const url = messageId
            ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`
            : `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

        const body = messageId
            ? { chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text, parse_mode: "Markdown" }
            : { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" };

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        const data = await res.json();
        if (!data.ok) {
            console.error("Telegram API Error:", JSON.stringify(data));
            return messageId;
        }
        return messageId || data.result?.message_id;
    } catch (err) {
        console.error("Failed to update Telegram status message:", err.message);
        return messageId;
    }
}

function compressVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                "-c:v libx264",
                "-crf 28",            // High compression quality target
                "-preset fast",
                "-vf scale=-2:480",   // Downscale height to 480p
                "-c:a aac",
                "-b:a 128k"
            ])
            .save(outputPath)
            .on("end", () => resolve(outputPath))
            .on("error", (err) => reject(err));
    });
}

function splitFile(filePath, chunkSize) {
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
    const rawFilePath = "./temp_raw_file";
    const compressedFilePath = "./temp_compressed.mp4";
    let generatedParts = [];

    try {
        statusMsgId = await updateTelegramStatus(null, "⚡ **در حال آماده‌سازی دریافت فایل...**");
        console.log("Status Message ID created:", statusMsgId);

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
        let lastUpdate = Date.now();

        console.log("Downloading directly to file...");
        await client.downloadMedia(msg.media, {
            outputFile: rawFilePath,
            progressCallback: async (downloaded, total) => {
                const now = Date.now();
                if (now - lastUpdate > 3500 || downloaded === total) {
                    lastUpdate = now;
                    const percent = total ? Math.floor((downloaded / total) * 100) : 0;
                    const bar = drawProgressBar(percent);
                    const text = [
                        "📥 **در حال دریافت از تلگرام...**",
                        `\`[${bar}]\` ${percent}%`,
                        `📊 **حجم:** \`${formatBytes(downloaded)}\` / \`${formatBytes(total)}\``,
                    ].join("\n");

                    statusMsgId = await updateTelegramStatus(statusMsgId, text);
                }
            },
        });

        let targetUploadPath = rawFilePath;
        const isVideo = msg.media.document?.mimeType?.startsWith("video/") || false;

        if (isVideo) {
            statusMsgId = await updateTelegramStatus(statusMsgId, "⚙️ **در حال فشرده‌سازی ویدیو (480p)...**");
            console.log("Compressing video to 480p...");
            
            try {
                await compressVideo(rawFilePath, compressedFilePath);
                targetUploadPath = compressedFilePath;
                console.log("Video compression successful.");
            } catch (ffmpegErr) {
                console.warn("Compression failed, proceeding with original file:", ffmpegErr.message);
            }
        }

        const fileSize = fs.statSync(targetUploadPath).size;
        console.log(`Processing complete. Final upload size: ${fileSize} bytes`);

        const rawCaption = msg.text || msg.caption || "";

        if (fileSize <= BALE_MAX_BYTES) {
            statusMsgId = await updateTelegramStatus(statusMsgId, "📤 **در حال ارسال به بله...**");
            
            const formData = new FormData();
            formData.append("chat_id", BALE_CHAT_ID);
            if (rawCaption) {
                formData.append("caption", truncateCaption(rawCaption));
            }
            
            formData.append("document", new Blob([fs.readFileSync(targetUploadPath)]), path.basename(targetUploadPath));

            const res = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/sendDocument`, {
                method: "POST",
                body: formData,
            });

            if (!res.ok) throw new Error(await res.text());
        } else {
            statusMsgId = await updateTelegramStatus(
                statusMsgId,
                `📦 **فایل بزرگتر از سقف مجاز بله (20MB) است. در حال تقسیم‌بندی...**\nحجم کل: \`${formatBytes(fileSize)}\``
            );

            generatedParts = splitFile(targetUploadPath, BALE_MAX_BYTES);
            const totalParts = generatedParts.length;

            for (let i = 0; i < totalParts; i++) {
                const partPath = generatedParts[i];
                const partFileName = path.basename(partPath);

                statusMsgId = await updateTelegramStatus(
                    statusMsgId,
                    `📤 **در حال ارسال پارت ${i + 1} از ${totalParts} به بله...**\n\`[${drawProgressBar(Math.floor(((i + 1) / totalParts) * 100))}]\``
                );

                const partCaption = truncateCaption(`پارت ${i + 1} از ${totalParts}${rawCaption ? `\n\n${rawCaption}` : ""}`);

                const formData = new FormData();
                formData.append("chat_id", BALE_CHAT_ID);
                formData.append("caption", partCaption);
                formData.append("document", new Blob([fs.readFileSync(partPath)]), partFileName);

                const res = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/sendDocument`, {
                    method: "POST",
                    body: formData,
                });

                if (!res.ok) {
                    throw new Error(`خطا در ارسال پارت ${i + 1}: ${await res.text()}`);
                }

                fs.unlinkSync(partPath);
            }
        }

        await updateTelegramStatus(statusMsgId, "✅ **تمامی پارت‌های فایل با موفقیت به بله منتقل شدند!**");
        cleanUpFiles(rawFilePath, compressedFilePath, generatedParts);
        await client.disconnect();
        process.exit(0);
    } catch (err) {
        console.error("Transfer failed:", err);
        cleanUpFiles(rawFilePath, compressedFilePath, generatedParts);
        if (statusMsgId) {
            await updateTelegramStatus(statusMsgId, `❌ **خطا در انتقال:** ${err.message}`);
        }
        process.exit(1);
    }
})();