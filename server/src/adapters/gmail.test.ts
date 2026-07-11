import { describe, it, expect } from 'vitest';
import { GmailApiError, RetryableError, isMessageGoneError, isAuthError } from './gmail';

describe('Gmail error classification (§5.1, R8 — never silently lose mail)', () => {
	it('treats 404/410 as a definitively-gone message (safe to skip)', () => {
		expect(isMessageGoneError(new GmailApiError(404, 'not found'))).toBe(true);
		expect(isMessageGoneError(new GmailApiError(410, 'gone'))).toBe(true);
	});

	it('does NOT treat transient/auth failures as gone (must retry, not skip)', () => {
		expect(isMessageGoneError(new GmailApiError(401, 'unauthorized'))).toBe(false);
		expect(isMessageGoneError(new GmailApiError(403, 'rate limit'))).toBe(false);
		expect(isMessageGoneError(new GmailApiError(400, 'bad request'))).toBe(false);
		expect(isMessageGoneError(new RetryableError('Gmail 503'))).toBe(false);
		expect(isMessageGoneError(new Error('AbortError: timeout'))).toBe(false);
		expect(isMessageGoneError(new TypeError('network error'))).toBe(false);
	});

	it('flags a 401 as an auth error so the cached token is dropped for the retry', () => {
		expect(isAuthError(new GmailApiError(401, 'unauthorized'))).toBe(true);
		expect(isAuthError(new GmailApiError(403, 'forbidden'))).toBe(false);
		expect(isAuthError(new Error('other'))).toBe(false);
	});

	it('GmailApiError carries the HTTP status', () => {
		const err = new GmailApiError(404, 'Gmail 404 on /messages/x');
		expect(err.status).toBe(404);
		expect(err).toBeInstanceOf(Error);
	});
});
