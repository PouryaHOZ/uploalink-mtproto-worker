// generate-session.js
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = 34195868; // e.g. 1234567 (number)
const apiHash = "c96a6025b5a18f68ed54f21979d112e1"; // e.g. "a1b2c3d4e5..."
const botToken = "8112579930:AAG0QcR7jHVcNuptMttwydwlWm6cAspnQ1A"; // e.g. "123456:ABC-DEF..."

const stringSession = new StringSession("");

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    botAuthToken: botToken,
  });

  console.log("\nYour TELEGRAM_SESSION_STRING is:\n");
  console.log(client.session.save());
  await client.disconnect();
})();