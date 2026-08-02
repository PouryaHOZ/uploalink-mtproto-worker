import { Messenger } from './messenger';
import { Env } from '../types';

export class TelegramPlatform implements Messenger {
    constructor(private env: Env) {}

    async sendMessage(chatId: string, text: string, replyMarkup?: any): Promise<void> {
        const url = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'Markdown',
                ...(replyMarkup && { reply_markup: JSON.stringify(replyMarkup) })
            })
        });
    }

    async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
        const url = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
        });
    }
}