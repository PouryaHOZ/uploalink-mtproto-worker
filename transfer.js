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

const BALE_MAX_BYTES = 45 * 1024 * 1024;

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
        const filePath = "./temp_file";
        let lastUpdate = 0;

        console.log("Downloading directly to file...");
        await client.downloadMedia(msg.media, {
            outputFile: filePath,
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

        const fileSize = fs.statSync(filePath).size;
        console.log(`Download finished. File size: ${fileSize} bytes`);

        const caption = msg.text || msg.caption || "";

        if (fileSize <= BALE_MAX_BYTES) {
            statusMsgId = await updateTelegramStatus(statusMsgId, "📤 **در حال ارسال به بله...**");
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
            statusMsgId = await updateTelegramStatus(
                statusMsgId,
                `📦 **فایل بزرگتر از ۴۵ مگابایت است. در حال تقسیم‌بندی...**\nحجم کل: \`${formatBytes(fileSize)}\``
            );

            const parts = splitFile(filePath, BALE_MAX_BYTES);
            const totalParts = parts.length;

            for (let i = 0; i < totalParts; i++) {
                const partPath = parts[i];
                const partFileName = path.basename(partPath);

                statusMsgId = await updateTelegramStatus(
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
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
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