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

        const body = {
            chat_id: chatId,
            text,
            ...(inlineKeypad && { inline_keypad: inlineKeypad })
        };

        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
        } catch (err) {
            console.error(`[Rubika] Network Error in sendMessage:`, err);
        }
    }

    async editMessageText(chatId: string, messageId: string, text: string, replyMarkup?: any): Promise<void> {
        if (!this.env.RUBIKA_BOT_TOKEN) return;
        
        // 1. Edit the message text
        await fetch(`${this.baseUrl}${this.env.RUBIKA_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
        });

        // 2. Clear or update the inline keypad
        let inlineKeypad = { rows: [] }; // Empty rows removes the keypad
        if (replyMarkup && replyMarkup.inline_keyboard && replyMarkup.inline_keyboard.length > 0) {
            inlineKeypad = {
                rows: replyMarkup.inline_keyboard.map((row: any[]) => ({
                    buttons: row.map((btn: any) => ({
                        id: btn.callback_data,
                        type: 'Simple',
                        button_text: btn.text
                    }))
                }))
            } as any;
        }

        await fetch(`${this.baseUrl}${this.env.RUBIKA_BOT_TOKEN}/editInlineKeypad`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, inline_keypad: inlineKeypad })
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