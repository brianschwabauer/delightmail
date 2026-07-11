/// <reference types="@cloudflare/workers-types" />
import type { AuthLocals } from '@delightstack/auth/server';
import type { MailboxRpc } from '$lib/mailbox-rpc';

declare global {
	namespace App {
		interface Error {
			status?: number;
			message: string;
		}

		interface Locals extends AuthLocals {
			/** The current user's MailboxServer DO (lazy, undefined if no org). */
			db: MailboxRpc | undefined;

			/** The SyncEngine DO for a given account id. */
			syncEngineFor: (account_id: string) => DurableObjectStub | undefined;

			/** KV namespace for hot-path caches. */
			kv: KVNamespace | undefined;

			/** R2 bucket for raw mail, bodies, attachments. */
			r2: R2Bucket | undefined;
		}

		interface PageData {}

		interface PageState {
			/** Set by the mobile reader's shallow-routed history entry: opening a
			 *  thread pushes `{ threadOpen: true }` so the phone's back button /
			 *  edge-swipe pops back to the list instead of leaving the app. */
			threadOpen?: boolean;
		}

		interface Platform {
			context: ExecutionContext;
			env: CloudflareEnv;
			cf: CfProperties;
			caches: CacheStorage & { default: Cache };
		}

		interface CloudflareEnv {
			AUTH: DurableObjectNamespace;
			MAILBOX: DurableObjectNamespace;
			SYNC: DurableObjectNamespace;
			WS: DurableObjectNamespace;
			RATE_LIMITER: DurableObjectNamespace;
			AI: Ai;
			KV: KVNamespace;
			R2: R2Bucket;
			SELF: Fetcher;
			CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };

			// --- secrets / vars (see .dev.vars.example + README) ---
			PUBLIC_APP_URL: string;
			JWT_KEY_SECRET: string;
			CREDENTIALS_ENCRYPTION_KEY: string;
			OWNER_EMAIL?: string;
			SIGNUPS_ENABLED?: string;
			MAIL_FROM?: string;
			GOOGLE_CLIENT_ID?: string;
			GOOGLE_CLIENT_SECRET?: string;
			AI_GATEWAY_ACCOUNT_ID?: string;
			AI_GATEWAY_NAME?: string;
			AI_GATEWAY_TOKEN?: string;
			AI_TRIAGE_ROUTE?: string;
			VAPID_PUBLIC_KEY?: string;
			VAPID_PRIVATE_KEY?: string;
			VAPID_SUBJECT?: string;
			SMTP_RELAY_HOST?: string;
			SMTP_RELAY_PORT?: string;
			SMTP_RELAY_USER?: string;
			SMTP_RELAY_PASS?: string;
			SEND_DAILY_LIMIT?: string;
			IMAGE_PROXY?: string;
			GMAIL_FULL_SCOPE?: string;
			GMAIL_POLL_SECONDS?: string;
		}
	}
}

export {};
