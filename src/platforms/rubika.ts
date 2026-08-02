import { Messenger } from './messenger';
import { Env, NormalizedMessage } from '../types';

export class RubikaPlatform implements Messenger {
    constructor(private env: Env) {}

    private get baseUrl(): string {
        return this.env.RUBIKA_BASE_URL || 'https://botapi.rubika.ir/v3/';
    }

    async sendMessage(chatId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!this.env.RUBIKA_BOT_TOKEN) return;
        const url = `${this.baseUrl}${this.env.RUBIKA_BOT_TOKEN}/sendMessage`;

        let inlineKeypad: any = undefined;
        if (replyMarkup && replyMarkup.inline_keyboard) {
            inlineKeypad = {
                rows: replyMarkup.inline_keyboard.map((row: any[]) => ({
                    buttons: row.map((btn: any) => ({
                        id: btn.callback_data,
                        type: 'Simple',
                        button_text: btn.text
                    }))
                }))
            };
        }

        const body: any = {
            chat_id: chatId,
            text,
            ...(inlineKeypad && { inline_keypad: inlineKeypad })
        };

        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    async answerCallbackQuery(): Promise<void> {
        return Promise.resolve();
    }
}

export function parseRubikaUpdate(update: any): NormalizedMessage | null {
    if (update?.update) {
        const up = update.update;
        if (up.type === 'NewMessage' && up.new_message) {
            const msg = up.new_message;
            return {
                chatId: (up.chat_id || msg.sender_id).toString(),
                userId: (msg.sender_id || 'unknown').toString(),
                userName: msg.sender?.first_name || 'کاربر',
                text: (msg.text || '').trim(),
                isFile: !!(msg.file),
                isCallback: false,
                raw: msg
            };
        }
    }

    if (update?.inline_message) {
        const inlineMsg = update.inline_message;
        return {
            chatId: (inlineMsg.chat_id || inlineMsg.sender_id).toString(),
            userId: (inlineMsg.sender_id || 'unknown').toString(),
            userName: 'کاربر',
            text: inlineMsg.aux_data?.button_id || (inlineMsg.text || '').trim(),
            isFile: false,
            isCallback: true,
            raw: inlineMsg
        };
    }

    return null;
}