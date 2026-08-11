import { Env, DarametDonation } from '../types';
import { CONSTANTS } from '../config/constants';

/**
 * Normalize a message string for matching (used in both Python generator and runtime).
 * Removes zero-width chars, collapses whitespace, lowercases.
 */
export function normalizeMessage(s: string): string {
    return s
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

interface DarametApiResponse {
    data?: DarametDonation[] | DarametDonation;
    donations?: DarametDonation[];
    items?: DarametDonation[];
    total?: number;
    totalPages?: number;
    currentPage?: number;
    [key: string]: any;
}

/**
 * Client for the Daramet (donation platform) API.
 *
 * Endpoints (from official docs):
 *   POST /api/v2/Donates/Search   { term: string }   - search by message or tracking code
 *   POST /api/v2/Donates/Messages  { Page: number }    - paginated recent donations
 *   GET  /api/Donates/Messages                        - last 20 with messages
 *   GET  /api/v2/Goal                                  - active goal details
 *   GET  /api/v2/Total                                 - total count and amount
 *   GET  /api/Donates/HighToLow                        - top 20 donations
 */
export class DarametClient {
    private token: string;
    private username: string;
    private baseUrl: string;
    
    // Retry settings for API resilience
    private maxRetries = 3;
    private retryDelayMs = 1000;

    constructor(env: Env) {
        this.token = env.DARAMET_API_TOKEN;
        this.username = env.DARAMET_USERNAME;
        this.baseUrl = (env.DARAMET_BASE_URL || CONSTANTS.DARAMET.BASE_URL).replace(/\/$/, '');
    }

    /**
     * Internal: send an authenticated request to the Daramet API.
     * Includes retry logic for transient failures.
     */
    private async request<T = any>(method: string, path: string, body?: any, attempt: number = 1): Promise<T> {
        if (!this.token) {
            throw new Error('DARAMET_API_TOKEN is not configured. Run: wrangler secret put DARAMET_API_TOKEN');
        }
        
        const url = `${this.baseUrl}${path}`;
        
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    'Authorization': this.token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: body ? JSON.stringify(body) : undefined
            });

            if (!res.ok) {
                const text = await res.text();
                console.error(`Daramet API ${method} ${path} failed [${res.status}] (attempt ${attempt}/${this.maxRetries}): ${text.substring(0, 200)}`);
                
                // Don't retry on client errors (4xx), only server errors (5xx) and network issues
                if (res.status >= 400 && res.status < 500) {
                    throw new Error(`Daramet API HTTP ${res.status}: Client error`);
                }
                
                // Retry on server errors
                if (attempt < this.maxRetries) {
                    await this.sleep(this.retryDelayMs * attempt);
                    return this.request<T>(method, path, body, attempt + 1);
                }
                
                throw new Error(`Daramet API HTTP ${res.status}: ${text.substring(0, 100)}`);
            }

            return res.json() as Promise<T>;
            
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const isNetworkError = errorMsg.includes('fetch') || 
                                   errorMsg.includes('network') || 
                                   errorMsg.includes('timeout') ||
                                   errorMsg.includes('ECONNRESET') ||
                                   errorMsg.includes('abort');
            
            // Retry on network errors
            if (isNetworkError && attempt < this.maxRetries) {
                console.warn(`Daramet API network error (attempt ${attempt}/${this.maxRetries}), retrying...`);
                await this.sleep(this.retryDelayMs * attempt);
                return this.request<T>(method, path, body, attempt + 1);
            }
            
            throw err;
        }
    }

    /**
     * Simple sleep utility for retry delays
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Search donations by message text or tracking code.
     * Uses POST /api/v2/Donates/Search with { term } body.
     * Returns a normalized list of donations.
     */
    async searchDonations(term: string): Promise<DarametDonation[]> {
        const result = await this.request<DarametApiResponse | DarametDonation[]>(
            'POST',
            CONSTANTS.DARAMET.SEARCH_ENDPOINT,
            { term }
        );

        // Handle various possible response shapes
        if (Array.isArray(result)) return this.normalizeDonations(result);
        if (Array.isArray((result as DarametApiResponse).data)) {
            return this.normalizeDonations((result as DarametApiResponse).data as DarametDonation[]);
        }
        if (Array.isArray((result as DarametApiResponse).donations)) {
            return this.normalizeDonations((result as DarametApiResponse).donations!);
        }
        if (Array.isArray((result as DarametApiResponse).items)) {
            return this.normalizeDonations((result as DarametApiResponse).items!);
        }
        // Single object
        if (result && typeof result === 'object' && (result as DarametDonation).trackingCode) {
            return this.normalizeDonations([result as DarametDonation]);
        }
        return [];
    }

    /**
     * Normalize raw Daramet donation objects (handles snake_case and camelCase).
     */
    private normalizeDonations(raw: any[]): DarametDonation[] {
        return raw.map(d => ({
            id: String(d.id || d.Id || d._id || ''),
            trackingCode: String(d.trackingCode || d.tracking_code || d.TrackingCode || d.reference || d.ref || ''),
            amount: Number(d.amount || d.Amount || d.value || 0),
            message: String(d.message || d.Message || d.note || ''),
            donorName: d.donorName || d.donor_name || d.name || undefined,
            date: this.parseDonationDate(d.date || d.Date || d.createdAt || d.created_at),
            status: d.status || d.Status
        }));
    }

    /**
     * Parse various date formats from Daramet (Persian date, ISO, epoch).
     */
    private parseDonationDate(raw: any): number {
        if (!raw) return 0;
        if (typeof raw === 'number') {
            // epoch seconds or ms
            return raw < 1e12 ? raw * 1000 : raw;
        }
        const s = String(raw);
        // Try ISO
        const iso = Date.parse(s);
        if (!isNaN(iso)) return iso;
        // Try Persian date - basic support (returns 0 on failure, caller will skip date filter)
        return 0;
    }

    /**
     * Find a donation matching a specific message text and minimum date.
     * Returns the first donation with matching normalized message and amount.
     * 
     * DEBUG: Logs detailed info about why matches fail to help diagnose issues.
     */
    async findDonationByMessage(
        messageText: string,
        amount: number,
        minDate: number
    ): Promise<DarametDonation | null> {
        const searchTerm = this.extractSearchTerm(messageText);
        if (!searchTerm) {
            console.warn('[Daramet] extractSearchTerm returned empty for message:', messageText.substring(0, 50));
            return null;
        }

        console.log(`[Daramet] Searching for donation...`, {
            searchTerm: searchTerm.substring(0, 50),
            expectedAmount: amount,
            minDate: new Date(minDate).toISOString(),
            minDateRaw: minDate,
            originalMessageLength: messageText.length
        });

        let donations: DarametDonation[];
        try {
            donations = await this.searchDonations(searchTerm);
        } catch (err) {
            console.error('searchDonations failed:', err);
            return null;
        }

        console.log(`[Daramet] searchDonations returned ${donations.length} results for term:`, searchTerm.substring(0, 50));

        // Log all returned donations for debugging
        if (donations.length > 0) {
            donations.forEach((d, i) => {
                console.log(`[Daramet] Result[${i}]:`, {
                    trackingCode: d.trackingCode,
                    amount: d.amount,
                    message: d.message?.substring(0, 60),
                    date: d.date ? new Date(d.date).toISOString() : 'null',
                    dateRaw: d.date
                });
            });
        } else {
            console.warn(`[Daramet] ❌ No results from searchDonations! Trying with full message...`);
            
            // FALLBACK: Try searching with FULL message (not just extracted term)
            try {
                const fullMessageResults = await this.searchDonations(messageText.substring(0, 50));
                console.log(`[Daramet] Full message search returned ${fullMessageResults.length} results`);
                
                if (fullMessageResults.length > 0) {
                    donations = fullMessageResults;
                    donations.forEach((d, i) => {
                        console.log(`[Daramet] FullMsgResult[${i}]:`, {
                            trackingCode: d.trackingCode,
                            amount: d.amount,
                            message: d.message?.substring(0, 60),
                            date: d.date ? new Date(d.date).toISOString() : 'null'
                        });
                    });
                }
            } catch (fallbackErr) {
                console.error('[Daramet] Full message fallback search also failed:', fallbackErr);
            }
        }

        const targetNorm = normalizeMessage(messageText);

        for (const d of donations) {
            // DEBUG: Log why each donation is being skipped
            if (d.amount !== amount) {
                console.log(`[Daramet] ⏭️ Skipping ${d.trackingCode}: amount mismatch (${d.amount} ≠ ${amount})`);
                continue;
            }
            
            // Date check - be more lenient with date parsing
            // If date is 0 or can't parse, don't skip based on date (might be Persian date)
            if (d.date && minDate && d.date > 0) {
                if (d.date < minDate) {
                    console.log(`[Daramet] ⏭️ Skipping ${d.trackingCode}: date too old (${new Date(d.date).toISOString()} < ${new Date(minDate).toISOString()})`);
                    continue;
                }
            }
            
            const dNorm = normalizeMessage(d.message);
            if (dNorm === targetNorm) {
                console.log(`[Daramet] ✅ FOUND matching donation:`, {
                    trackingCode: d.trackingCode,
                    amount: d.amount,
                    messageMatch: true
                });
                return d;
            } else {
                // Show what's different about the message
                console.log(`[Daramet] ⏭️ Skipping ${d.trackingCode}: message mismatch`);
                console.log(`[Daramet]    Expected: "${targetNorm.substring(0, 80)}"`);
                console.log(`[Daramet]    Got:      "${dNorm.substring(0, 80)}"`);
            }
        }
        
        console.warn(`[Daramet] ❌ No matching donation found after checking ${donations.length} results`);
        return null;
    }

    /**
     * Find a donation by tracking code, then verify the message matches.
     */
    async findDonationByTrackingCode(
        trackingCode: string,
        expectedMessageText: string,
        amount: number,
        minDate: number
    ): Promise<{ matched: boolean; donation?: DarametDonation; reason?: string }> {
        let donations: DarametDonation[];
        try {
            donations = await this.searchDonations(trackingCode.trim());
        } catch (err) {
            console.error('searchDonations failed:', err);
            return { matched: false, reason: 'api_error' };
        }

        const donation = donations.find(d =>
            d.trackingCode && d.trackingCode.toLowerCase() === trackingCode.trim().toLowerCase()
        );

        if (!donation) {
            return { matched: false, reason: 'tracking_code_not_found' };
        }
        if (donation.amount !== amount) {
            return { matched: false, reason: 'amount_mismatch' };
        }
        if (donation.date && minDate && donation.date < minDate) {
            return { matched: false, reason: 'date_before_payment_request' };
        }
        const donationNorm = normalizeMessage(donation.message);
        const expectedNorm = normalizeMessage(expectedMessageText);
        if (donationNorm !== expectedNorm) {
            return { matched: false, reason: 'message_mismatch' };
        }
        return { matched: true, donation };
    }

    /**
     * Extract a distinctive search term from a message.
     * Prefers the last sentence (often more distinctive), falls back to first 30 chars.
     */
    private extractSearchTerm(text: string): string {
        if (!text) return '';
        // Split by Persian and Latin punctuation
        const sentences = text.split(/[.!?،؛\n]/).map(s => s.trim()).filter(s => s.length > 5);
        if (sentences.length >= 2) {
            const last = sentences[sentences.length - 1];
            if (last.length >= 10) return last;
        }
        return text.substring(0, Math.min(30, text.length));
    }

    /**
     * Build the webintent payment URL.
     */
    buildWebintentUrl(amount: number, message: string): string {
        const encoded = encodeURIComponent(message);
        return `${this.baseUrl}/${this.username}?webintent&donate=${amount}&message=${encoded}`;
    }

    /**
     * Get recent donations (paginated).
     */
    async getRecentDonations(page: number = 1): Promise<DarametDonation[]> {
        const result = await this.request<DarametApiResponse | DarametDonation[]>(
            'POST',
            CONSTANTS.DARAMET.MESSAGES_ENDPOINT,
            { Page: page }
        );
        if (Array.isArray(result)) return this.normalizeDonations(result);
        if (Array.isArray((result as DarametApiResponse).data)) {
            return this.normalizeDonations((result as DarametApiResponse).data as DarametDonation[]);
        }
        if (Array.isArray((result as DarametApiResponse).donations)) {
            return this.normalizeDonations((result as DarametApiResponse).donations!);
        }
        if (Array.isArray((result as DarametApiResponse).items)) {
            return this.normalizeDonations((result as DarametApiResponse).items!);
        }
        return [];
    }
}
