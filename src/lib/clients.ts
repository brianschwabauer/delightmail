/**
 * Wire the WebSocket, Database, and AI clients for a request. Called once in
 * the mail layout's `load` (see routes/mail/+layout.ts). Mirrors the delightstack
 * example app's clients.ts, specialized for the mail schema.
 */
import { browser } from '$app/environment';
import { DatabaseClient, type DatabaseClientConfig } from '@delightstack/database/client';
import { WebsocketClient } from '@delightstack/websocket/client';
import { AiClient } from '@delightstack/ai/client';
import type { AuthClient } from '@delightstack/auth/client';
import { tables } from './schema';

/** Custom websocket events beyond the built-in `entity:*`. */
export interface MailEvents {
	'mail:new': {
		thread_id: string;
		message_id: string;
		folder: string;
		category?: string;
		from?: { name?: string; email?: string };
		subject?: string;
	};
	'sync:progress': { account_id: string; phase: string; percent: number; detail?: string };
	'send:status': { message_id: string; status: string; error?: string };
	'triage:done': { message_id: string; verdict: unknown };
}

export type MailDatabaseClient = DatabaseClient<typeof tables>;

export async function createClients(options: {
	auth: AuthClient;
	fetch: typeof globalThis.fetch;
	dev?: boolean;
	entities?: DatabaseClientConfig<typeof tables>['entities'];
}): Promise<{ ws: WebsocketClient; db: MailDatabaseClient; ai: AiClient }> {
	const { auth, fetch, dev, entities } = options;

	const ws = new WebsocketClient({
		dev,
		dev_query: {
			user_id: auth.id ?? undefined,
			user_name: auth.name ?? undefined,
		},
	});

	const db = new DatabaseClient({
		tables,
		// v2: the 2026-07 "empty inbox" incident left some devices with a truncated
		// client index that believed it was fully synced (docs silently dropped by
		// insert failures the library used to swallow — fixed in
		// @delightstack/database). A new IDB name abandons any such index and
		// resyncs from scratch; the old `delightmail:<org>` database is unused.
		db_name: `delightmail:v2:${auth.org_id}`,
		fetch,
		hooks: ws.databaseHooks(),
		// `thread` and `message` stay in CLIENT search mode: every keystroke and
		// folder switch renders from the local index with zero network round trips,
		// which is the app's core promise (offline lists included). The library's
		// per-entity threshold still switches an enormous mailbox to server search
		// automatically — but based on the real index size, not inflated counters.
		entities,
		dev,
	});

	const ai = new AiClient({ ws });

	// The websocket client stays idle until it is told which room to join, and
	// nothing was ever telling it — so the connection was never opened, the status
	// bar read "Offline" forever, and no live event (new mail, sync progress, send
	// status) ever reached the client. The app quietly fell back to polling, which
	// is why it looked like it worked. The room is the org: see the WS handle in
	// hooks.server.ts, which routes to one DO per org.
	//
	// Browser-only: connect() runs through a SharedWorker, which does not exist
	// during SSR (this load is universal).
	if (browser && auth.org_id) await ws.connect(auth.org_id);

	await db.init();

	return { ws, db, ai };
}
