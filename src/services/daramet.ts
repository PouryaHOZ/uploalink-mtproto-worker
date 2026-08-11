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

        // DEBUG: Log the RAW response to understand actual field names
        console.log(`[Daramet] RAW API response for "${term}":`, JSON.stringify(result).substring(0, 1000));

        // Handle various possible response shapes
        if (Array.isArray(result)) {
            console.log(`[Daramet] Response is array with ${result.length} items`);
            if (result.length > 0) {
                console.log(`[Daramet] First item keys:`, Object.keys(result[0]));
                console.log(`[Daramet] First item:`, JSON.stringify(result[0]).substring(0, 500));
            }
            return this.normalizeDonations(result);
        }
        
        // Try to find the array in different response shapes
        const possibleArrays = [
            { name: 'data', value: (result as DarametApiResponse).data },
            { name: 'donations', value: (result as DarametApiResponse).donations },
            { name: 'items', value: (result as DarametApiResponse).items },
            { name: 'list', value: (result as any).list },
            { name: 'results', value: (result as any).results },
            { name: 'records', value: (result as any).records },
        ];

        for (const { name, value } of possibleArrays) {
            if (Array.isArray(value)) {
                console.log(`[Daramet] Found array in '${name}' with ${value.length} items`);
                if (value.length > 0) {
                    console.log(`[Daramet] First item keys (${name}):`, Object.keys(value[0]));
                    console.log(`[Daramet] First item (${name}):`, JSON.stringify(value[0]).substring(0, 500));
                }
                return this.normalizeDonations(value);
            }
        }

        // Single object - check if it looks like a donation
        if (result && typeof result === 'object') {
            console.log(`[Daramet] Response keys (not array):`, Object.keys(result));
            
            // Check if this single object has donation-like fields
            const singleObj = result as any;
            const hasDonationField = singleObj.trackingCode || singleObj.amount || 
                                     singleObj.message || singleObj.TrackingCode ||
                                     singleObj.Amount || singleObj.Message;
            if (hasDonationField) {
                console.log(`[Daramet] Treating single object as donation`);
                return this.normalizeDonations([result as any]);
            }
        }

        console.warn(`[Daramet] Could not find donations in response structure. Keys:`, 
            result ? Object.keys(result) : 'null/undefined');
        return [];
    }

    /**
     * Normalize raw Daramet donation objects.
     * Handles multiple response structures including nested donator_data format.
     */
    private normalizeDonations(raw: any[]): DarametDonation[] {
        return raw.map((d, index) => {
            // DEBUG: Log all available keys in this donation object
            console.log(`[Daramet] normalizeDonations[${index}] raw keys:`, Object.keys(d));
            console.log(`[Daramet] normalizeDonations[${index}] raw:`, JSON.stringify(d).substring(0, 500));
            
            // Check for NESTED structure: { donator: "...", donator_data: {...} }
            const nestedData = d.donator_data || d.donorData || d.data || d.donation || null;
            
            // Use nested data if available, otherwise use flat structure
            const source = nestedData || d;
            
            console.log(`[Daramet] normalizeDonations[${index}] using ${nestedData ? 'NESTED (donator_data)' : 'FLAT'} structure`);
            if (nestedData) {
                console.log(`[Daramet] normalizeDonations[${index}] nested keys:`, Object.keys(source));
            }
            
            const normalized = {
                id: String(
                    source.id || 
                    d.id || 
                    source.Id || 
                    d.Id || 
                    source._id ||
                    d._id || 
                    ''
                ),
                
                // Try many possible tracking code field names
                trackingCode: String(
                    source.ref_id ||           // Daramet's actual field name!
                    source.refId ||
                    source.trackingCode || 
                    source.tracking_code || 
                    source.TrackingCode || 
                    source.TRACKING_CODE ||
                    d.ref_id ||               // Also check parent level
                    d.refId ||
                    d.trackingCode || 
                    d.tracking_code || 
                    d.TrackingCode || 
                    d.reference || 
                    d.ref || 
                    source.transactionId ||
                    source.transaction_id ||
                    d.transactionId ||
                    d.code ||
                    ''
                ),
                
                // Try many possible amount field names
                // NOTE: Daramet may return amount in different units (rials vs tomans)
                amount: Number(
                    source.amount || 
                    d.amount || 
                    source.Amount || 
                    d.Amount ||
                    source.AMOUNT ||
                    source.value || 
                    d.value || 
                    source.Value ||
                    d.Value ||
                    source.pay_amount ||
                    source.payAmount ||
                    d.pay_amount ||
                    d.payAmount ||
                    source.donateAmount ||
                    source.donate_amount ||
                    d.donateAmount ||
                    source.total ||
                    source.Total ||
                    d.total ||
                    d.Total ||
                    0
                ),
                
                // Try many possible message field names
                message: String(
                    source.message || 
                    d.message || 
                    source.Message || 
                    d.Message ||
                    source.MESSAGE ||
                    d.MESSAGE ||
                    source.note || 
                    d.note || 
                    source.Note ||
                    d.Note ||
                    source.description ||
                    d.description ||
                    source.Description ||
                    d.Description ||
                    source.comment ||
                    d.comment ||
                    source.text ||
                    d.text ||
                    source.msg ||
                    d.msg ||
                    ''
                ),
                
                donorName: source.donorName || d.donorName || 
                          source.donor_name || d.donor_name || 
                          source.name || d.name || 
                          source.Name || d.Name ||
                          source.userName || d.userName ||
                          source.donator || d.donator ||  // From nested structure
                          undefined,
                
                date: this.parseDonationDate(
                    source.timestamp ||      // Daramet's actual field name!
                    d.timestamp ||
                    source.date || 
                    d.date || 
                    source.Date || 
                    d.Date ||
                    source.DATE ||
                    d.DATE ||
                    source.createdAt || 
                    d.createdAt || 
                    source.created_at || 
                    d.created_at || 
                    source.CreatedAt ||
                    d.CreatedAt ||
                    source.createdDate ||
                    d.createdDate ||
                    source.paid_at ||
                    d.paid_at ||
                    source.paidAt ||
                    d.paidAt
                ),
                
                status: source.status || d.status || source.Status || d.Status || source.state || d.state
            };
            
            console.log(`[Daramet] normalizeDonations[${index}] result:`, {
                id: normalized.id,
                trackingCode: normalized.trackingCode || '(empty)',
                amount: normalized.amount,
                messageLength: normalized.message.length,
                messagePreview: normalized.message.substring(0, 50),
                date: normalized.date ? new Date(normalized.date).toISOString() : 'null',
                usedNested: !!nestedData
            });
            
            return normalized;
        });
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
     * Uses smart multi-strategy search for maximum reliability.
     * 
     * Strategy:
     * 1. Try FULL message text (exact match)
     * 2. If fails/empty, try last sentence (most distinctive part)
     * 3. If fails, try first 50 chars
     * 4. If all fail, return null
     */
    async findDonationByMessage(
        messageText: string,
        amount: number,
        minDate: number
    ): Promise<DarametDonation | null> {
        
        const trimmedMessage = messageText.trim();
        
        if (!trimmedMessage) {
            console.warn('[Daramet] Message text is empty');
            return null;
        }

        console.log(`[Daramet] 🔍 Smart search initiated...`, {
            messageLength: trimmedMessage.length,
            expectedAmount: amount,
            minDate: new Date(minDate).toISOString(),
            messagePreview: trimmedMessage.substring(0, 60) + (trimmedMessage.length > 60 ? '...' : '')
        });

        // Build search strategies in order of preference
        const strategies = this.buildSearchStrategies(trimmedMessage);
        
        console.log(`[Daramet] Will try ${strategies.length} search strategies`);

        for (let i = 0; i < strategies.length; i++) {
            const strategy = strategies[i];
            console.log(`[Daramet] Strategy ${i + 1}/${strategies.length}: ${strategy.name} ("${strategy.term.substring(0, 40)}...")`);
            
            try {
                const donations = await this.searchDonations(strategy.term);
                
                if (donations && donations.length > 0) {
                    console.log(`[Daramet] ✅ Strategy "${strategy.name}" returned ${donations.length} results!`);
                    
                    // Log what we got
                    donations.forEach((d, idx) => {
                        console.log(`[Daramet]   Result[${idx}]:`, {
                            trackingCode: d.trackingCode || '(empty)',
                            amount: d.amount,
                            msgLen: d.message?.length || 0,
                            msgPreview: d.message?.substring(0, 50),
                            date: d.date ? new Date(d.date).toISOString() : 'null'
                        });
                    });
                    
                    // Try to find exact match among results
                    const match = this.findExactMatch(donations, trimmedMessage, amount, minDate);
                    if (match) {
                        return match;
                    }
                    
                    console.log(`[Daramet] Strategy "${strategy.name}" got results but no exact match, trying next...`);
                } else {
                    console.log(`[Daramet] Strategy "${strategy.name}" returned 0 results`);
                }
                
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                console.warn(`[Daramet] Strategy "${strategy.name}" failed:`, errorMsg.substring(0, 100));
                
                // If it's a client error (4xx), don't retry with different strategies - just log and continue
                if (errorMsg.includes('400') || errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('422')) {
                    console.warn(`[Daramet] Client error detected, skipping to next strategy`);
                }
            }
        }

        console.warn(`[Daramet] ❌ All ${strategies.length} strategies exhausted - no match found`);
        return null;
    }

    /**
     * Build multiple search strategies from the message text.
     * Returns array of {name, term} objects in order of preference.
     */
    private buildSearchStrategies(message: string): Array<{name: string, term: string}> {
        const strategies: Array<{name: string, term: string}> = [];
        
        // Strategy 1: Full message (exact match attempt)
        strategies.push({ name: 'Full Message', term: message });
        
        // Strategy 2: Last sentence (often most distinctive)
        const sentences = message.split(/[.!?،؛\n]+/).filter(s => s.trim().length > 5);
        if (sentences.length >= 1) {
            const lastSentence = sentences[sentences.length - 1].trim();
            if (lastSentence !== message) {
                strategies.push({ name: 'Last Sentence', term: lastSentence });
            }
        }
        
        // Strategy 3: First 50 chars
        if (message.length > 50) {
            strategies.push({ name: 'First 50 Chars', term: message.substring(0, 50) });
        }
        
        // Strategy 4: Last 30 chars
        if (message.length > 30) {
            strategies.push({ name: 'Last 30 Chars', term: message.substring(message.length - 30) });
        }
        
        // Strategy 5: Middle portion (if long enough)
        if (message.length > 100) {
            const start = Math.floor(message.length / 2) - 25;
            strategies.push({ name: 'Middle 50 Chars', term: message.substring(start, start + 50) });
        }
        
        return strategies;
    }

    /**
     * Find an exact match from donation results.
     * Handles amount unit differences (rials vs tomans).
     */
    private findExactMatch(
        donations: DarametDonation[],
        targetMessage: string,
        expectedAmount: number,
        minDate: number
    ): DarametDonation | null {
        const targetNorm = normalizeMessage(targetMessage);

        for (const d of donations) {
            // Check amount with FLEXIBLE matching (handles rials/tomans conversion)
            // Daramet may return 800000 (rials) when we expect 80000 (tomans)
            if (!this.isAmountMatch(d.amount, expectedAmount)) {
                console.log(`[Daramet] ⏭️ Skip [${d.trackingCode || '?'}]: amount ${d.amount} ≠ ${expectedAmount} (ratio: ${(d.amount / expectedAmount).toFixed(1)}x)`);
                continue;
            }
            
            // Check date (lenient - skip if date=0 or Persian date that couldn't parse)
            if (d.date && minDate && d.date > 0 && d.date < minDate) {
                console.log(`[Daramet] ⏭️ Skip [${d.trackingCode || '?'}]: date too old`);
                continue;
            }
            
            // Check message (exact normalized match with FUZZY comparison)
            const dNorm = normalizeMessage(d.message);
            
            if (this.isMessageMatch(dNorm, targetNorm)) {
                console.log(`[Daramet] ✅ EXACT MATCH FOUND!`, {
                    trackingCode: d.trackingCode,
                    amount: d.amount,
                    messageLength: d.message?.length,
                    matchType: dNorm === targetNorm ? 'EXACT' : 'FUZZY'
                });
                return d;
            } else {
                // Log mismatch details
                console.log(`[Daramet] ⏭️ Skip [${d.trackingCode || '?'}]: message mismatch`);
                console.log(`[Daramet]    Expected (${targetNorm.length}ch): "${targetNorm.substring(0, 80)}"`);
                console.log(`[Daramet]    Got      (${dNorm.length}ch): "${dNorm.substring(0, 80)}"`);
            }
        }
        
        return null;
    }

    /**
     * Check if amounts match, handling common unit differences.
     * In Iran: 1 Toman = 10 Rials, so amounts may differ by 10x.
     */
    private isAmountMatch(actualAmount: number, expectedAmount: number): boolean {
        if (actualAmount === expectedAmount) return true;
        
        // Handle rials/tomans conversion (10x difference)
        if (actualAmount === expectedAmount * 10) {
            console.log(`[Daramet] Amount match: ${actualAmount} = ${expectedAmount} × 10 (rials/tomans)`);
            return true;
        }
        if (expectedAmount === actualAmount * 10) {
            console.log(`[Daramet] Amount match: ${expectedAmount} = ${actualAmount} × 10 (rials/tomans)`);
            return true;
        }
        
        // Allow small rounding differences (< 1%)
        const diffPercent = Math.abs(actualAmount - expectedAmount) / expectedAmount;
        if (diffPercent < 0.01) {
            console.log(`[Daramet] Amount match: within 1% tolerance (${diffPercent.toFixed(3)}%)`);
            return true;
        }
        
        return false;
    }

    /**
     * Check if messages match, with fuzzy comparison for trailing punctuation.
     * Handles cases where Daramet strips trailing dots, commas, etc.
     */
    private isMessageMatch(actual: string, expected: string): boolean {
        // Exact match first
        if (actual === expected) return true;
        
        // Fuzzy match: strip trailing punctuation and compare
        const stripTrailingPunctuation = (s: string): string => 
            s.replace(/[.!?،؛:,\s]+$/, '').trim();
        
        const actualStripped = stripTrailingPunctuation(actual);
        const expectedStripped = stripTrailingPunctuation(expected);
        
        if (actualStripped === expectedStripped) {
            console.log(`[Daramet] Message fuzzy match after stripping trailing punctuation`);
            return true;
        }
        
        // Also try stripping leading/trailing whitespace more aggressively
        const actualTrimmed = actual.trim();
        const expectedTrimmed = expected.trim();
        
        if (actualTrimmed === expectedTrimmed) {
            console.log(`[Daramet] Message fuzzy match after trimming whitespace`);
            return true;
        }
        
        // Check if one is substring of the other (for partial matches)
        if (actualTrimmed.includes(expectedTrimmed) || expectedTrimmed.includes(actualTrimmed)) {
            // Only allow if length difference is small (< 5 chars)
            const lengthDiff = Math.abs(actualTrimmed.length - expectedTrimmed.length);
            if (lengthDiff <= 5) {
                console.log(`[Daramet] Message fuzzy match (substring, diff=${lengthDiff}ch)`);
                return true;
            }
        }
        
        return false;
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
