import { Messenger } from './messenger';
import { Env } from '../types';

export class BalePlatform implements Messenger {
    constructor(private env: Env) {}

    async sendMessage(chatId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!this.env.BALE_BOT_TOKEN) return;
        const url = `https://tapi.bale.ai/bot${this.env.BALE_BOT_TOKEN}/sendMessage`;
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

    async editMessageText(chatId: string, messageId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!this.env.BALE_BOT_TOKEN) return;
        const url = `https://tapi.bale.ai/bot${this.env.BALE_BOT_TOKEN}/editMessageText`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: 'Markdown',
                reply_markup: replyMarkup ? JSON.stringify(replyMarkup) : { inline_keyboard: [] }
            })
        });
    }

    async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
        if (!this.env.BALE_BOT_TOKEN) return;
        const url = `https://tapi.bale.ai/bot${this.env.BALE_BOT_TOKEN}/answerCallbackQuery`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
        });
    }
}