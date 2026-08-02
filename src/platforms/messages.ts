export interface Messenger {
    sendMessage(chatId: string, text: string, replyMarkup?: any): Promise<void>;
    answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
}