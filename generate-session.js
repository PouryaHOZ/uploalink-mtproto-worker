// generate-session.js
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = YOUR_TELEGRAM_API_ID; // e.g. 1234567 (number)
const apiHash = "YOUR_TELEGRAM_API_HASH"; // e.g. "a1b2c3d4e5..."
const botToken = "YOUR_TELEGRAM_BOT_TOKEN"; // e.g. "123456:ABC-DEF..."

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