const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");

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

// Helper to format bytes into MB/GB
function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Generate visual progress bar [██████░░░░]
function drawProgressBar(percent, length = 10) {
    const filled = Math.round((percent / 100) * length);
    const empty = length - filled;
    return "█".repeat(filled) + "░".repeat(empty);
}

// Send or edit a message on Telegram Bot API
async function updateTelegramStatus(messageId, text) {
    try {
        if (!messageId) {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
            });
            const data = await res.json();
            return data.result?.message_id;
        } else {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    message_id: messageId,
                    text,
                    parse_mode: "Markdown",
                }),
            });
            return messageId;
        }
    } catch (err) {
        console.error("Failed to update status message:", err.message);
        return messageId;
    }
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

        console.log("Downloading from Telegram...");
        const buffer = await client.downloadMedia(msg.media, {
            progressCallback: async (downloaded, total) => {
                const now = Date.now();
                // Throttle updates to once every 3.5 seconds to avoid Telegram rate limits
                if (now - lastUpdate > 3500 || downloaded === total) {
                    lastUpdate = now;
                    const percent = Math.floor((downloaded / total) * 100);
                    const bar = drawProgressBar(percent);
                    const downloadedStr = formatBytes(downloaded);
                    const totalStr = formatBytes(total);

                    const text = [
                        "📥 **در حال دریافت از تلگرام...**",
                        `\`[${bar}]\` ${percent}%`,
                        `📊 **حجم:** \`${downloadedStr}\` / \`${totalStr}\``,
                    ].join("\n");

                    await updateTelegramStatus(statusMsgId, text);
                }
            },
        });

        fs.writeFileSync(filePath, buffer);

        await updateTelegramStatus(
            statusMsgId,
            `📤 **دریافت کامل شد! در حال ارسال به بله...**\nحجم فایل: \`${formatBytes(buffer.length)}\``
        );

        // Uploading to Bale
        const caption = msg.text || msg.caption || "";
        const formData = new FormData();
        formData.append("chat_id", BALE_CHAT_ID);
        if (caption) formData.append("caption", caption);

        const fileBlob = new Blob([fs.readFileSync(filePath)]);
        formData.append("document", fileBlob, "file");

        const response = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/sendDocument`, {
            method: "POST",
            body: formData,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`خطا در آپلود بله: ${errText}`);
        }

        await updateTelegramStatus(statusMsgId, "✅ **فایل با موفقیت به بله منتقل شد!**");

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