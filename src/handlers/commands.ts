import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { TelegramPlatform } from '../platforms/telegram';
import { Platform, Env, ConnectedAccount } from '../types';
import { generateConnectionCode, generatePlatformLink, toPersianDigits } from '../utils/helpers';
import { generateSimpleToken } from '../utils/crypto';
import { CONSTANTS } from '../config/constants';

export async function handleStartCommand(env: Env, kv: KVService, messenger: Messenger, chatId: string, platform: Platform, user?: any): Promise<void> {
    const userName = user?.first_name || 'کاربر گرامی';
    const userId = user?.id?.toString() || chatId;

    if (platform === 'telegram' && userId) {
        const authToken = await generateSimpleToken(userId, env.JWT_SECRET || 'default_secret');
        await kv.saveSession(userId, { token: authToken, userId, chatId, userName, platform, createdAt: Date.now() });
    }

    const connectedAcc = await kv.getConnectedAccount(userId);
    const rubikaStatus = connectedAcc?.rubikaChatId ? '✅ متصل' : '❌ غیرمتصل';
    const baleStatus = connectedAcc?.baleChatId ? '✅ متصل' : '❌ غیرمتصل';

    const welcomeMessage = platform === 'telegram'
        ? `✨ **به ربات انتقال هوشمند فایل خوش آمدید!**\n\n👤 **کاربر:** ${userName}\n📌 **وضعیت اتصال پلتفرم‌ها:**\n• روبیکا: ${rubikaStatus}\n• بله: ${baleStatus}\n\n⚡ **راهنمای سریع:**\n۱. با دستور /link حساب‌های خود را متصل کنید.\n۲. هر فایلی را در تلگرام ارسال کنید تا انتقال یابد.\n۳. با /status وضعیت ویدیوها و فایل‌ها را پیگیری کنید.`
        : `👋 **سلام ${userName}!**\n\nبرای اتصال این پلتفرم به تلگرام، ابتدا دستور /start را در ربات تلگرام ارسال کنید.`;

    await messenger.sendMessage(chatId, welcomeMessage);
}

export async function handleConnectionCode(env: Env, kv: KVService, messenger: Messenger, code: string, chatId: string, platform: Platform, user?: any): Promise<void> {
    const cleanCode = code.trim().toUpperCase();
    const chatIdStr = chatId.toString();
    const connectionRequest = await kv.getConnectionRequest(cleanCode);

    if (!connectionRequest || Date.now() > connectionRequest.expiresAt || connectionRequest.targetPlatform !== platform) {
        await messenger.sendMessage(chatIdStr, '❌ **کد واردشده نامعتبر یا منقضی شده است.**\nلطفاً کد جدیدی دریافت کنید.');
        return;
    }

    const telegramUserIdStr = connectionRequest.telegramUserId.toString();
    const telegramChatIdStr = connectionRequest.telegramChatId.toString();

    // Fetch existing links to avoid overwriting the other platform
    const existingAcc = (await kv.getConnectedAccount(telegramUserIdStr)) || { connectedAt: Date.now() };
    const connectedAccount: ConnectedAccount = {
        ...existingAcc,
        telegramUserId: telegramUserIdStr,
        telegramChatId: telegramChatIdStr,
        lastUsed: Date.now()
    };

    if (platform === 'rubika') connectedAccount.rubikaChatId = chatIdStr;
    if (platform === 'bale') connectedAccount.baleChatId = chatIdStr;

    await kv.saveConnectedAccount(telegramUserIdStr, connectedAccount);
    await kv.savePlatformReverseAccount(platform, chatIdStr, {
        telegramUserId: telegramUserIdStr,
        telegramChatId: telegramChatIdStr,
        userName: connectionRequest.userName,
        connectedAt: Date.now()
    });

    const platformName = platform === 'bale' ? 'بله' : 'روبیکا';

    // 1. Send confirmation message to Rubika/Bale
    await messenger.sendMessage(chatIdStr, `🎉 **اتصال با موفقیت انجام شد!**\nحساب ${platformName} شما به تلگرام متصل گردید.`);

    // 2. Direct confirmation notification to Telegram user
    const telegramMessenger = new TelegramPlatform(env);
    await telegramMessenger.sendMessage(
        telegramChatIdStr,
        `🎉 **حساب ${platformName} با موفقیت به تلگرام متصل شد!**\n\nاز این پس فایل‌های ارسالی شما مستقیماً به ${platformName} منتقل خواهند شد.`
    );

    await kv.deleteConnectionRequest(cleanCode);
}

export async function askLinkSelection(messenger: Messenger, chatId: string, platform: Platform): Promise<void> {
    if (platform === 'telegram') {
        await messenger.sendMessage(chatId, `🔗 **اتصال به پیام‌رسان‌های داخلی:**\nلطفاً پلتفرم موردنظر خود را جهت اتصال انتخاب کنید:`, {
            inline_keyboard: [
                [{ text: '📌 اتصال به روبیکا', callback_data: `link:rubika` },
                 { text: '📌 اتصال به بله', callback_data: `link:bale` }]
            ]
        });
    }
}

export async function askUnlinkSelection(kv: KVService, messenger: Messenger, chatId: string): Promise<void> {
    const account = await kv.getConnectedAccount(chatId);
    const buttons = [];
    if (account?.rubikaChatId) buttons.push({ text: '🔴 قطع اتصال روبیکا', callback_data: `unlink:rubika` });
    if (account?.baleChatId) buttons.push({ text: '🔴 قطع اتصال بله', callback_data: `unlink:bale` });

    if (buttons.length === 0) {
        await messenger.sendMessage(chatId, `❌ **هیچ پلتفرمی به حساب شما متصل نیست.**`);
        return;
    }

    await messenger.sendMessage(chatId, `⚠️ **قطع اتصال پلتفرم‌ها:**\nکدام اتصال حذف شود؟`, { inline_keyboard: [buttons] });
}

export async function handleStatusCommand(kv: KVService, messenger: Messenger, chatId: string): Promise<void> {
    const account = await kv.getConnectedAccount(chatId);
    const rubikaStatus = account?.rubikaChatId ? '✅ متصل' : '❌ غیرمتصل';
    const baleStatus = account?.baleChatId ? '✅ متصل' : '❌ غیرمتصل';

    const transfers = await kv.getAllActiveTransfers();
    const userTransfers = transfers.filter(t => t.transferRequest.chatId === chatId);

    let statusCard = `📊 **داشبورد وضعیت سیستم:**\n\n` +
                     `📱 **پلتفرم‌های متصل:**\n` +
                     `• روبیکا: ${rubikaStatus}\n` +
                     `• بله: ${baleStatus}\n\n` +
                     `🔄 **فایل‌های در حال انتقال:** ${toPersianDigits(userTransfers.length.toString())} مورد\n`;

    if (userTransfers.length > 0) {
        statusCard += `\n📋 **جزئیات:**\n`;
        userTransfers.forEach((t, i) => {
            statusCard += `${toPersianDigits((i + 1).toString())}. **${t.transferRequest.fileName}** — وضعیت: \`${t.status}\`\n`;
        });
    }

    await messenger.sendMessage(chatId, statusCard);
}