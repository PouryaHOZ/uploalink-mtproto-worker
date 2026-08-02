import { Env, ActiveTransfer, ConnectedAccount, TransferRequest } from '../types';
import { CONSTANTS } from '../config/constants';

export class KVService {
    constructor(private env: Env) {}

    async getRateLimit(key: string): Promise<number> {
        const val = await this.env.LINKS.get(key, { type: 'text' }).catch(() => '0');
        return parseInt(val || '0');
    }

    async incrementRateLimit(key: string, current: number): Promise<void> {
        await this.env.LINKS.put(key, (current + 1).toString(), { expirationTtl: CONSTANTS.EXPIRATION.RATE_LIMIT });
    }

    async saveSession(userId: string, data: object): Promise<void> {
        await this.env.LINKS.put(`session:${userId}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.SESSION });
    }

    async getSession(userId: string): Promise<any> {
        return await this.env.LINKS.get(`session:${userId}`, { type: 'json' }).catch(() => null);
    }

    async saveConnectionRequest(code: string, data: object): Promise<void> {
        await this.env.LINKS.put(`connection_request:${code}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.CONNECTION_REQUEST });
    }

    async getConnectionRequest(code: string): Promise<any> {
        return await this.env.LINKS.get(`connection_request:${code}`, { type: 'json' }).catch(() => null);
    }

    async deleteConnectionRequest(code: string): Promise<void> {
        await this.env.LINKS.delete(`connection_request:${code}`);
    }

    async saveConnectedAccount(telegramUserId: string, account: ConnectedAccount): Promise<void> {
        await this.env.LINKS.put(`connected_account:${telegramUserId}`, JSON.stringify(account));
    }

    async savePlatformReverseAccount(platform: string, chatId: string, data: object): Promise<void> {
        await this.env.LINKS.put(`connected_account:${platform}:${chatId}`, JSON.stringify(data));
    }

    async getConnectedAccount(userId: string): Promise<ConnectedAccount | null> {
        return await this.env.LINKS.get(`connected_account:${userId}`, { type: 'json' }).catch(() => null);
    }

    async getPlatformReverseAccount(platform: string, chatId: string): Promise<any> {
        return await this.env.LINKS.get(`connected_account:${platform}:${chatId}`, { type: 'json' }).catch(() => null);
    }

    async deletePlatformReverseAccount(platform: string, chatId: string): Promise<void> {
        await this.env.LINKS.delete(`connected_account:${platform}:${chatId}`);
    }

    async deleteConnectedAccount(userId: string): Promise<void> {
        await this.env.LINKS.delete(`connected_account:${userId}`);
    }

    async saveTransferRequest(transferId: string, data: TransferRequest): Promise<void> {
        await this.env.LINKS.put(`transfer:${transferId}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.STATE_TRANSFER });
    }

    async getTransferRequest(transferId: string): Promise<TransferRequest | null> {
        return await this.env.LINKS.get(`transfer:${transferId}`, { type: 'json' }).catch(() => null);
    }

    async saveActiveTransfer(transferId: string, data: ActiveTransfer): Promise<void> {
        await this.env.LINKS.put(`active_transfer:${transferId}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.ACTIVE_TRANSFER });
    }

    async getAllActiveTransfers(): Promise<ActiveTransfer[]> {
        const transfers: ActiveTransfer[] = [];
        const keys = await this.env.LINKS.list({ prefix: 'active_transfer:' });
        for (const key of keys.keys) {
            const data = await this.env.LINKS.get(key.name, { type: 'json' }).catch(() => null);
            if (data) transfers.push(data as ActiveTransfer);
        }
        return transfers;
    }
}