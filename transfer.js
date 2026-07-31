const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");

const {
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    TELEGRAM_SESSION_STRING,
    BALE_BOT_TOKEN,
    MESSAGE_ID,
    TELEGRAM_CHAT_ID,
    BALE_CHAT_ID,
} = process.env;

(async () => {
    try {
        console.log("Initializing Telegram Client...");
        const client = new TelegramClient(
            new StringSession(TELEGRAM_SESSION_STRING.trim()),
            Number(TELEGRAM_API_ID),
            TELEGRAM_API_HASH.trim(),
            { connectionRetries: 5 }
        );

        await client.connect();
        console.log("Connected to Telegram MTProto.");

        const messages = await client.getMessages(Number(TELEGRAM_CHAT_ID), {
            ids: [Number(MESSAGE_ID)],
        });

        if (!messages || !messages[0] || !messages[0].media) {
            throw new Error("Message or media not found in Telegram.");
        }

        const msg = messages[0];
        console.log("Downloading media from Telegram...");

        // Download media into a buffer
        const buffer = await client.downloadMedia(msg.media, {});
        console.log(`Downloaded ${buffer.length} bytes.`);

        // Determine filename/caption
        const caption = msg.text || msg.caption || "";
        const filePath = "./temp_file";
        fs.writeFileSync(filePath, buffer);

        console.log("Uploading media to Bale...");
        const formData = new FormData();
        formData.append("chat_id", BALE_CHAT_ID);
        if (caption) formData.append("caption", caption);

        const fileBlob = new Blob([fs.readFileSync(filePath)]);
        formData.append("document", fileBlob, "file");

        const response = await fetch(`https://tapi.bale.ai/bot${BALE_BOT_TOKEN}/sendDocument`, {
            method: "POST",
            body: formData,
        });

        const resText = await response.text();
        if (!response.ok) {
            throw new Error(`Bale Upload Failed: ${resText}`);
        }

        console.log("File transferred successfully to Bale!");
        fs.unlinkSync(filePath);
        await client.disconnect();
        process.exit(0);
    } catch (err) {
        console.error("Transfer failed:", err);
        process.exit(1);
    }
})();