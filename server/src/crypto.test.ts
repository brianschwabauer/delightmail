import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from './crypto';

const KEY = 'a'.repeat(64); // 32-byte hex

describe('credential encryption', () => {
	it('round-trips a secret through encrypt/decrypt', async () => {
		const ct = await encryptSecret('hunter2', KEY);
		expect(ct).not.toContain('hunter2');
		expect(await decryptSecret(ct, KEY)).toBe('hunter2');
	});

	it('uses a fresh IV per encryption (no reuse)', async () => {
		const a = await encryptSecret('same', KEY);
		const b = await encryptSecret('same', KEY);
		expect(a).not.toBe(b);
	});

	it('rejects a key that is not 64 hex chars', async () => {
		// 32 chars = AES-128 by accident under the old length check.
		await expect(encryptSecret('x', 'a'.repeat(32))).rejects.toThrow(/64-char hex/);
		await expect(encryptSecret('x', undefined)).rejects.toThrow(/64-char hex/);
	});

	it('rejects a non-hex passphrase (which would parse to near-zero bytes)', async () => {
		const passphrase = 'my-super-secret-credentials-key!'; // 32 chars, not hex
		await expect(encryptSecret('x', passphrase)).rejects.toThrow(/64-char hex/);
	});

	it('returns null when decrypting with the wrong key rather than throwing', async () => {
		const ct = await encryptSecret('secret', KEY);
		expect(await decryptSecret(ct, 'b'.repeat(64))).toBeNull();
	});
});
