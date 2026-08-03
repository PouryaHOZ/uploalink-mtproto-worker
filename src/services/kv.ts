import { Env, ActiveTransfer, ConnectedAccount, TransferRequest } from '../types';
import { CONSTANTS } from '../config/constants';

export class KVService {
    constructor(private env: Env) {}

    async saveSession(userId: string, data: object): Promise<void> { await this.env.LINKS.put(`session:${userId}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.SESSION }); }
    async getSession(userId: string): Promise<any> { return await this.env.LINKS.get(`session:${userId}`, { type: 'json' }).catch(() => null); }
    async saveConnectionRequest(code: string, data: object): Promise<void> { await this.env.LINKS.put(`connection_request:${code}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.CONNECTION_REQUEST }); }
    async getConnectionRequest(code: string): Promise<any> { return await this.env.LINKS.get(`connection_request:${code}`, { type: 'json' }).catch(() => null); }
    async deleteConnectionRequest(code: string): Promise<void> { await this.env.LINKS.delete(`connection_request:${code}`); }
    async saveConnectedAccount(telegramUserId: string, account: ConnectedAccount): Promise<void> { await this.env.LINKS.put(`connected_account:${telegramUserId}`, JSON.stringify(account)); }
    async savePlatformReverseAccount(platform: string, chatId: string, data: object): Promise<void> { await this.env.LINKS.put(`connected_account:${platform}:${chatId}`, JSON.stringify(data)); }
    async getConnectedAccount(userId: string): Promise<ConnectedAccount | null> { return await this.env.LINKS.get(`connected_account:${userId}`, { type: 'json' }).catch(() => null); }
    async getPlatformReverseAccount(platform: string, chatId: string): Promise<any> { return await this.env.LINKS.get(`connected_account:${platform}:${chatId}`, { type: 'json' }).catch(() => null); }
    async deletePlatformReverseAccount(platform: string, chatId: string): Promise<void> { await this.env.LINKS.delete(`connected_account:${platform}:${chatId}`); }

    // --- USER VERSION TRACKING ---
    async getUserVersion(userId: string): Promise<string | null> {
        return await this.env.LINKS.get(`user_version:${userId}`);
    }
    async saveUserVersion(userId: string, version: string): Promise<void> {
        await this.env.LINKS.put(`user_version:${userId}`, version);
    }

    async saveTransferRequest(transferId: string, data: TransferRequest): Promise<void> {
        await this.env.LINKS.put(`transfer:${transferId}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.STATE_TRANSFER });
    }
    async getTransferRequest(transferId: string): Promise<TransferRequest | null> {
        return await this.env.LINKS.get(`transfer:${transferId}`, { type: 'json' }).catch(() => null);
    }
    
    // --- CANCELLATION FLAGS ---
    async setCancelFlag(transferId: string): Promise<void> {
        await this.env.LINKS.put(`cancel:${transferId}`, 'true', { expirationTtl: 600 });
    }
    async getCancelFlag(transferId: string): Promise<boolean> {
        const val = await this.env.LINKS.get(`cancel:${transferId}`);
        return val === 'true';
    }
    async deleteCancelFlag(transferId: string): Promise<void> {
        await this.env.LINKS.delete(`cancel:${transferId}`);
    }

    // --- QUEUE SYSTEM ---
    async getQueue(): Promise<string[]> {
        const q = await this.env.LINKS.get('transfer_queue', { type: 'json' });
        return Array.isArray(q) ? q : [];
    }
    
    async saveQueue(queue: string[]): Promise<void> {
        await this.env.LINKS.put('transfer_queue', JSON.stringify(queue));
    }

    async enqueueTransfer(transferId: string): Promise<number> {
        const queue = await this.getQueue();
        if (!queue.includes(transferId)) {
            queue.push(transferId);
            await this.saveQueue(queue);
        }
        return queue.indexOf(transferId) + 1;
    }

    async dequeueTransfer(transferId: string): Promise<void> {
        const queue = await this.getQueue();
        const newQueue = queue.filter(id => id !== transferId);
        await this.saveQueue(newQueue);
    }

    async getQueuePosition(transferId: string): Promise<number> {
        const queue = await this.getQueue();
        const idx = queue.indexOf(transferId);
        return idx !== -1 ? idx + 1 : 0;
    }

    async saveActiveTransfer(transferId: string, data: ActiveTransfer): Promise<void> {
        await this.env.LINKS.put(`active_transfer:${transferId}`, JSON.stringify(data), { expirationTtl: CONSTANTS.EXPIRATION.ACTIVE_TRANSFER });
    }

    async getActiveTransfer(transferId: string): Promise<ActiveTransfer | null> {
        return await this.env.LINKS.get(`active_transfer:${transferId}`, { type: 'json' }).catch(() => null);
    }

    async removeActiveTransfer(transferId: string): Promise<void> {
        await this.env.LINKS.delete(`active_transfer:${transferId}`);
    }

    async sweepAndGetActiveTransfers(): Promise<ActiveTransfer[]> {
        const transfers: ActiveTransfer[] = [];
        const keys = await this.env.LINKS.list({ prefix: 'active_transfer:' });
        const now = Date.now();
        const STALE_THRESHOLD_MS = 10 * 60 * 1000;

        for (const key of keys.keys) {
            const data = await this.env.LINKS.get(key.name, { type: 'json' }).catch(() => null) as ActiveTransfer | null;
            if (data) {
                if (now - data.createdAt > STALE_THRESHOLD_MS) {
                    await this.env.LINKS.delete(key.name);
                } else {
                    transfers.push(data);
                }
            } else {
                await this.env.LINKS.delete(key.name);
            }
        }
        return transfers;
    }

    async getAllActiveTransfers(): Promise<ActiveTransfer[]> {
        return await this.sweepAndGetActiveTransfers();
    }
}