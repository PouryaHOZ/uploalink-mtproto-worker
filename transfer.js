const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const path = require("path");

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

const BALE_MAX_BYTES = 45 * 1024 * 1024; // 45 MB safety margin for Bale's 50MB limit

function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function drawProgressBar(percent, length = 10) {
    const filled = Math.round((percent / 100) * length);
    return "█".repeat(filled) + "░".repeat(length - filled);
}

async function updateTelegramStatus(messageId, text) {
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
        return messageId || data.result?.message_id;
    } catch (err) {
        console.error("Failed to update status message:", err.message);
        return messageId;
    }
}

// Splits a large file buffer into smaller 45MB files on disk
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

(async () => {
    let statusMsgId = null;
    try {
        statusMsgId = await updateTelegramStatus(null, "⚡ **در حال آماده‌سازی دریافت فایل...**");

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
        const filePath = "./temp_file";
        let lastUpdate = 0;

        // 1. Download from Telegram
        const buffer = await client.downloadMedia(msg.media, {
            progressCallback: async (downloaded, total) => {
                const now = Date.now();
                if (now - lastUpdate > 3500 || downloaded === total) {
                    lastUpdate = now;
                    const percent = Math.floor((downloaded / total) * 100);
                    const bar = drawProgressBar(percent);
                    const text = [
                        "📥 **در حال دریافت از تلگرام...**",
                        `\`[${bar}]\` ${percent}%`,
                        `📊 **حجم:** \`${formatBytes(downloaded)}\` / \`${formatBytes(total)}\``,
                    ].join("\n");

                    await updateTelegramStatus(statusMsgId, text);
                }
            },
        });

        fs.writeFileSync(filePath, buffer);
        const fileSize = buffer.length;

        // 2. Upload handling
        const caption = msg.text || msg.caption || "";

        if (fileSize <= BALE_MAX_BYTES) {
            // Send normally if <= 45MB
            await updateTelegramStatus(statusMsgId, "📤 **در حال ارسال به بله...**");
            const formData = new FormData();
            formData.append("chat_id", BALE_CHAT_ID);
            if (caption) formData.append("caption", caption);
            formData.append("document", new Blob([fs.readFileSync(filePath)]), "file");

            const res = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/sendDocument`, {
                method: "POST",
                body: formData,
            });
            if (!res.ok) throw new Error(await res.text());
        } else {
            // Split and send in parts if > 45MB
            await updateTelegramStatus(statusMsgId, `📦 **فایل بزرگتر از ۴۵ مگابایت است. در حال تقسیم‌بندی...**\nحجم کل: \`${formatBytes(fileSize)}\``);
            
            const parts = splitFile(filePath, BALE_MAX_BYTES);
            const totalParts = parts.length;

            for (let i = 0; i < totalParts; i++) {
                const partPath = parts[i];
                const partFileName = path.basename(partPath);

                await updateTelegramStatus(
                    statusMsgId,
                    `📤 **در حال ارسال پارت ${i + 1} از ${totalParts} به بله...**\n\`[${drawProgressBar(Math.floor(((i + 1) / totalParts) * 100))}]\``
                );

                const formData = new FormData();
                formData.append("chat_id", BALE_CHAT_ID);
                formData.append(
                    "caption",
                    `پارت ${i + 1} از ${totalParts}${caption ? `\n\n${caption}` : ""}`
                );
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
        fs.unlinkSync(filePath);
        await client.disconnect();
        process.exit(0);
    } catch (err) {
        console.error("Transfer failed:", err);
        if (statusMsgId) {
            await updateTelegramStatus(statusMsgId, `❌ **خطا در انتقال:** ${err.message}`);
        }
        process.exit(1);
    }
})();