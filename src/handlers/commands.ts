import { KVService } from '../services/kv';
import { Messenger } from '../platforms/messenger';
import { Platform, Env, ConnectedAccount } from '../types';
import { generateConnectionCode, generatePlatformLink } from '../utils/helpers';
import { generateSimpleToken } from '../utils/crypto';
import { CONSTANTS } from '../config/constants';

export async function handleConnectionCode(env: Env, kv: KVService, messenger: Messenger, code: string, chatId: string, platform: Platform, user?: any): Promise<void> {
    const cleanCode = code.trim().toUpperCase();
    const chatIdStr = chatId.toString();
    const connectionRequest = await kv.getConnectionRequest(cleanCode);

    if (!connectionRequest || Date.now() > connectionRequest.expiresAt || connectionRequest.targetPlatform !== platform) {
        await messenger.sendMessage(chatIdStr, '❌ کد نامعتبر یا منقضی شده است.');
        return;
    }

    const telegramUserIdStr = connectionRequest.telegramUserId.toString();
    const connectedAccount: ConnectedAccount = { connectedAt: Date.now(), lastUsed: Date.now() };

    if (platform === 'rubika') connectedAccount.rubikaChatId = chatIdStr;
    if (platform === 'bale') connectedAccount.baleChatId = chatIdStr;

    await kv.saveConnectedAccount(telegramUserIdStr, connectedAccount);
    await kv.savePlatformReverseAccount(platform, chatIdStr, {
        telegramUserId: telegramUserIdStr,
        telegramChatId: connectionRequest.telegramChatId,
        userName: connectionRequest.userName,
        connectedAt: Date.now()
    });

    const successMessage = platform === 'bale'
        ? `✅ اتصال با موفقیت برقرار شد!\nble.ir/uploalinkbot?start=${cleanCode}`
        : `✅ اتصال با موفقیت برقرار شد!\n${CONSTANTS.RUBIKA_LINK}`;

    await messenger.sendMessage(chatIdStr, successMessage);
    await kv.deleteConnectionRequest(cleanCode);
}

export async function handleStartCommand(env: Env, kv: KVService, messenger: Messenger, chatId: string, platform: Platform, user?: any): Promise<void> {
    const userName = user?.first_name || 'کاربر';
    const userId = user?.id?.toString() || chatId;

    if (platform === 'telegram' && userId) {
        const authToken = await generateSimpleToken(userId, env.JWT_SECRET || 'default_secret');
        await kv.saveSession(userId, { token: authToken, userId, chatId, userName, platform, createdAt: Date.now() });
    }

    const welcomeMessage = platform === 'telegram'
        ? `👋 سلام ${userName}!\n\nبه ربات انتقال فایل خوش آمدید!\n💡 دستورات:\n- /link: اتصال به روبیکا یا بله\n- /unlink: قطع اتصال\n- /status: وضعیت انتقال`
        : `👋 سلام ${userName}!\nبرای اتصال به تلگرام دستور /start را در ربات تلگرام (@uploalinkbot) ارسال کنید.`;

    await messenger.sendMessage(chatId, welcomeMessage);
}

export async function askLinkSelection(messenger: Messenger, chatId: string, platform: Platform): Promise<void> {
    if (platform === 'telegram') {
        await messenger.sendMessage(chatId, `🔗 **لطفاً پلتفرم مورد نظر برای اتصال را انتخاب کنید:**`, {
            inline_keyboard: [
                [{ text: '📌 روبیکا', callback_data: `select_link_platform_rubika_${chatId}` },
                 { text: '📌 بله', callback_data: `select_link_platform_bale_${chatId}` }]
            ]
        });
    }
}

export async function askUnlinkSelection(kv: KVService, messenger: Messenger, chatId: string): Promise<void> {
    const account = await kv.getConnectedAccount(chatId);
    const buttons = [];
    if (account?.rubikaChatId) buttons.push({ text: '📌 روبیکا', callback_data: `select_unlink_platform_rubika_${chatId}` });
    if (account?.baleChatId) buttons.push({ text: '📌 بله', callback_data: `select_unlink_platform_bale_${chatId}` });

    if (buttons.length === 0) {
        await messenger.sendMessage(chatId, `❌ هیچ پلتفرمی متصل نیست.`);
        return;
    }

    await messenger.sendMessage(chatId, `🔗 **حذف لینک:**`, { inline_keyboard: [buttons] });
}

export async function handleStatusCommand(kv: KVService, messenger: Messenger, chatId: string): Promise<void> {
    const transfers = await kv.getAllActiveTransfers();
    const userTransfers = transfers.filter(t => t.transferRequest.chatId === chatId);

    let statusMessage = userTransfers.length > 0 ? `📊 **وضعیت انتقال‌ها:**\n\n` : `📊 هیچ انتقال فعالی یافت نشد.\n\n`;
    userTransfers.forEach((t, i) => {
        statusMessage += `${i + 1}. **${t.transferRequest.fileName}** - وضعیت: ${t.status}\n`;
    });

    await messenger.sendMessage(chatId, statusMessage);
}