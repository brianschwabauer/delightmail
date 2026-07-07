/**
 * DelightMail server worker — hosts all Durable Object classes and the inbound
 * mail entrypoints. Deploy this BEFORE the app worker (the app binds these DOs
 * cross-script via script_name). See PLAN.html §2, §9.
 */
import { AuthDatabaseServer as BaseAuthDatabaseServer } from '@delightstack/auth/worker';
import { WebsocketServer } from '@delightstack/websocket/worker';
import { RateLimiterServer } from '@delightstack/rate-limiter';
import { createDevRpcHandler, DelightError } from '@delightstack/utilities';
import { MailboxServer } from './mailbox-server';
import { SyncEngine } from './sync-engine';
import { handleInboundEmail } from './email-in';
import { handleGmailWebhook } from './gmail-webhook';

export { RateLimiterServer, MailboxServer, SyncEngine };

export interface Env {
	AUTH: DurableObjectNamespace;
	MAILBOX: DurableObjectNamespace;
	SYNC: DurableObjectNamespace;
	WS: DurableObjectNamespace;
	RATE_LIMITER: DurableObjectNamespace;
	AI: unknown;
	KV: KVNamespace;
	R2: R2Bucket;
	JWT_KEY_SECRET?: string;
	CREDENTIALS_ENCRYPTION_KEY?: string;
	OWNER_EMAIL?: string;
	PUBLIC_APP_URL?: string;
	GMAIL_PUSH_AUDIENCE?: string;
	GMAIL_PUSH_SA_EMAIL?: string;
	/** "true" only in local dev (set in .dev.vars). MUST be unset in production. */
	DEV?: string;
}

// Dev-only JWT secret; must match the app worker's DEV_SECRET so sessions verify
// across the two workers. Production MUST set JWT_KEY_SECRET (fail closed below).
const DEV_JWT_SECRET = '00000000000000000000000000000000000000000000000000000000deadbeef';

/** Resolve the session-signing secret, failing closed in production (§13). */
function resolveJwtSecret(env: Env): string {
	if (env.JWT_KEY_SECRET) return env.JWT_KEY_SECRET;
	if (env.DEV === 'true') return DEV_JWT_SECRET;
	throw new Error(
		'JWT_KEY_SECRET is not set on the delightmail-server worker. Set it to the same ' +
			'64-hex value as the app worker: `wrangler secret put JWT_KEY_SECRET`.',
	);
}

/** Auth DO — app-specific config injected here (workerd only passes ctx, env). */
export class AuthServer extends BaseAuthDatabaseServer {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env as never, {
			secret: resolveJwtSecret(env),
			issuer: 'delightmail',
			permissions: ['owner', 'admin', 'member'],
			oauth_scopes: [],
			entitlements: ['ai', 'push', 'domains'],
		});
	}
}

/** WebSocket DO — one room per user (org). Relays entity + custom mail events. */
export class AppWebsocketServer extends WebsocketServer {
	constructor(ctx: DurableObjectState, env: Env) {
		super({}, ctx, env as never);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({
				ok: true,
				service: 'delightmail-server',
				bindings: {
					AUTH: !!env.AUTH,
					MAILBOX: !!env.MAILBOX,
					SYNC: !!env.SYNC,
					WS: !!env.WS,
					R2: !!env.R2,
					KV: !!env.KV,
				},
			});
		}

		// Gmail Pub/Sub push (§5.1). OIDC-verified inside the handler.
		if (url.pathname === '/webhooks/gmail' && request.method === 'POST') {
			return handleGmailWebhook(request, env);
		}

		// Everything below is the dev-only bridge that lets `vite dev` reach real
		// Durable Objects over HTTP (SvelteKit's dev proxy → /__rpc/ and the
		// /api/websocket upgrade). In production the app worker binds these DOs
		// cross-script and NEVER calls the server worker over HTTP, so leaving the
		// unauthenticated RPC/WS surface reachable would be a full tenant/auth bypass
		// whenever this worker has a public route (the Gmail webhook needs one).
		// Gate it hard on DEV, which is set only in .dev.vars.
		if (env.DEV !== 'true') return new Response('Not found', { status: 404 });

		if (url.pathname === '/api/websocket' && request.headers.get('Upgrade') === 'websocket') {
			const room = url.searchParams.get('room');
			if (!room) return new Response('Missing room', { status: 400 });
			const user_id = url.searchParams.get('user_id') ?? 'anonymous';
			const user_name = url.searchParams.get('user_name') ?? 'User';
			const headers = new Headers(request.headers);
			headers.set('X-WS-Meta', JSON.stringify({ room, meta: { user_id, user_name } }));
			const stub = env.WS.get(env.WS.idFromName(room));
			return stub.fetch(new Request(request.url, { method: request.method, headers }));
		}

		try {
			return await createDevRpcHandler(request, {
				AUTH: env.AUTH,
				MAILBOX: env.MAILBOX,
				SYNC: env.SYNC,
				WS: env.WS,
			});
		} catch (err) {
			return DelightError.from(err).toResponse();
		}
	},

	/** Cloudflare Email Routing inbound handler (§5.2). */
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		await handleInboundEmail(message, env, ctx);
	},
};
