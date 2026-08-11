<script lang="ts">
	/**
	 * Renders a message body inside a sandboxed iframe. The body HTML is
	 * served sanitized from /api/messages/:id/body with a strict CSP
	 * (`default-src 'none'`), and the sandbox omits `allow-scripts`, so scripts can
	 * never run even if sanitization missed something. We DO grant
	 * `allow-same-origin` — with `allow-scripts` absent that grants no script
	 * capability, but it lets the parent read `contentDocument.scrollHeight` to
	 * auto-size the frame (without it the document is opaque-origin and the read
	 * throws, pinning every body at the 120px default).
	 */
	interface Props {
		messageId: string;
		excerpt: string;
		/** Whether the message has a stored HTML body (else render the excerpt). */
		hasHtml?: boolean;
	}
	const { messageId, excerpt, hasHtml = false }: Props = $props();

	import { resolvedScheme } from '$lib/theme';
	// Captured once per mount — a theme flip re-renders the whole app anyway.
	const scheme = resolvedScheme();

	let iframe = $state<HTMLIFrameElement>();
	let frameHeight = $state(120);
	let failed = $state(false);

	function onLoad() {
		try {
			const doc = iframe?.contentDocument;
			if (!doc) return;
			// Empty response → show the excerpt instead of a blank sheet. Checked
			// FIRST: an empty document's body.scrollHeight is the iframe viewport
			// height (never 0), so gating this behind `scrollHeight === 0` made the
			// fallback unreachable and text-only mail rendered as a white void.
			if (!doc.body?.innerHTML?.trim()) {
				failed = true;
				return;
			}
			const h = doc.body?.scrollHeight ?? 0;
			if (h > 0) frameHeight = Math.min(h + 24, 4000);
		} catch {
			// Cross-origin measurement blocked — keep a default height.
		}
	}
</script>

{#if failed || !hasHtml}
	<pre class="excerpt">{excerpt || '(no content)'}</pre>
{:else}
	<iframe
		bind:this={iframe}
		title="Message body"
		src="/api/messages/{encodeURIComponent(messageId)}/body?scheme={scheme}"
		class:dark={scheme === 'dark'}
		sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
		referrerpolicy="no-referrer"
		style:height="{frameHeight}px"
		onload={onLoad}></iframe>
{/if}

<style>
	iframe {
		width: 100%;
		border: none;
		background: white;
		display: block;
	}
	/* Match the endpoint's dark palette so the frame never flashes white while
	   loading. Emails that paint their own background stay on their white sheet
	   (the endpoint only darkens unstyled mail — a brief white flash is correct
	   for those). */
	iframe.dark {
		background: #16181c;
	}
	.excerpt {
		padding: var(--space-4);
		white-space: pre-wrap;
		font-family: inherit;
		margin: 0;
		font-size: 0.9375rem;
		line-height: 1.65;
		overflow-wrap: break-word;
	}
</style>
