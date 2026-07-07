<script lang="ts">
	/**
	 * Renders a message body inside a sandboxed iframe (§12). The body HTML is
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

	let iframe = $state<HTMLIFrameElement>();
	let frameHeight = $state(120);
	let failed = $state(false);

	function onLoad() {
		try {
			const doc = iframe?.contentDocument;
			if (!doc) return;
			const h = doc.body?.scrollHeight ?? 0;
			if (h > 0) frameHeight = Math.min(h + 24, 4000);
			else if (!doc.body?.innerHTML?.trim()) failed = true;
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
		src="/api/messages/{encodeURIComponent(messageId)}/body"
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
	.excerpt {
		padding: var(--size-3);
		white-space: pre-wrap;
		font-family: inherit;
		margin: 0;
		font-size: var(--font-size-0);
	}
</style>
