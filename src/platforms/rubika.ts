import { Messenger } from './messenger';
import { Env, NormalizedMessage } from '../types';

export class RubikaPlatform implements Messenger {
    constructor(private env: Env) {}

    async sendMessage(chatId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!this.env.RUBIKA_BOT_TOKEN) return;
        const baseUrl = this.env.RUBIKA_BASE_URL || 'https://botapi.rubika.ir/v3/';
        const url = `${baseUrl}${this.env.RUBIKA_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                ...(replyMarkup && { inline_keypad: replyMarkup })
            })
        });
    }

    async answerCallbackQuery(): Promise<void> {
        // روبیکا Toast اعلانات callback ندارد
        return Promise.resolve();
    }
}

export function parseRubikaUpdate(update: any): NormalizedMessage | null {
    const msg = update?.update?.new_message || update?.update?.message || update?.message;
    if (!msg) return null;

    return {
        chatId: (msg.chat_id || msg.sender_id).toString(),
        userId: (msg.sender_id || msg.from?.id || 'unknown').toString(),
        userName: msg.sender?.first_name || 'کاربر',
        text: (msg.text || '').trim(),
        isFile: !!(msg.file || msg.document || msg.photo || msg.video || msg.audio || msg.voice),
        raw: msg
    };
}