export async function generateSimpleToken(userId: string, secret: string): Promise<string> {
    const data = `${userId}:${Date.now()}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const hexSig = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${btoa(data)}.${hexSig}`;
}

export async function verifySimpleToken(token: string, secret: string): Promise<string | null> {
    try {
        const [dataB64, signature] = token.split('.');
        if (!dataB64 || !signature) return null;
        
        const decodedData = atob(dataB64);
        const [userId, timestamp] = decodedData.split(':');
        
        if (Date.now() - parseInt(timestamp) > 86400000) return null;

        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const expectedSignatureBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(decodedData));
        const expectedSignature = Array.from(new Uint8Array(expectedSignatureBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        
        return signature === expectedSignature ? userId : null;
    } catch {
        return null;
    }
}