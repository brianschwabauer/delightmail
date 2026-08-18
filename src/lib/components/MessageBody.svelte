<script lang="ts">
	/**
	 * Renders a message body inside a sandboxed iframe. The body HTML is
	 * served sanitized from /api/messages/:id/body with a strict CSP
	 * (`default-src 'none'`), and the sandbox omits `allow-scripts`, so scripts can
	 * never run even if sanitization missed something. We DO grant
	 * `allow-same-origin` — with `allow-scripts` absent that grants no script
	 * capability, but it lets the parent read `contentDocument` to auto-size the
	 * frame (without it the document is opaque-origin and the read throws,
	 * pinning every body at the 120px default).
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
	/** The frame stays invisible until its height is measured — painting the
	 *  120px default first flashed an inner scrollbar for one frame, then grew. */
	let sized = $state(false);

	// Reveal on DOM-ready, not on `load`. An iframe's load event waits for every
	// remote IMAGE in the email, so gating visibility on it left image-heavy
	// newsletters showing the skeleton for seconds after the HTML had already
	// arrived. Instead: poll for the document (same-origin, so readable), reveal
	// the moment its body has content, and let a ResizeObserver keep the frame
	// height honest as images stream in below. `load` stays as the settler for
	// the empty/error cases the poll deliberately leaves alone.
	let observer: ResizeObserver | null = null;
	$effect(() => {
		const el = iframe;
		if (!el) return;
		let raf = 0;
		const poll = () => {
			if (!tryReveal(el)) raf = requestAnimationFrame(poll);
		};
		raf = requestAnimationFrame(poll);
		return () => {
			cancelAnimationFrame(raf);
			observer?.disconnect();
			observer = null;
		};
	});

	function docOf(el: HTMLIFrameElement | undefined): Document | null {
		try {
			return el?.contentDocument ?? null;
		} catch {
			return null; // cross-origin (shouldn't happen) — onLoad's default height stands
		}
	}

	/** Reveal + start observing once the real document has content. Returns true
	 *  when settled (revealed or failed) so the poll stops. */
	function tryReveal(el: HTMLIFrameElement): boolean {
		const doc = docOf(el);
		// Still on the initial about:blank — the real navigation hasn't committed.
		if (!doc || !doc.location?.pathname.includes('/api/messages/')) return false;
		// An error response (404/500) is JSON — the browser renders it as raw
		// text in the frame. Fall back to the excerpt rather than showing it.
		if (doc.contentType === 'application/json') {
			failed = true;
			sized = true;
			return true;
		}
		// No content yet: either still streaming (keep polling) or a genuinely
		// empty body — that case is settled by onLoad, which fires fast when
		// there are no subresources to wait for.
		if (!doc.body?.innerHTML?.trim()) return false;
		// Scrollbar-flash guard: images finishing after reveal grow the body, and
		// for the beat before the ResizeObserver's height lands the content is
		// taller than the frame — the frame's internal scrollbar would blink on.
		// Suppress the document's own scrollbar until `load` (onLoad restores it,
		// so a body taller than the height cap can still scroll internally).
		doc.documentElement.style.overflowY = 'hidden';
		measure(doc);
		sized = true;
		// Images/fonts loading after reveal grow the body — track it so the frame
		// never clips content it already shows.
		observer = new ResizeObserver(() => measure(doc));
		observer.observe(doc.body);
		return true;
	}

	/** The first measure sizes the frame exactly; after that, grow ONLY when the
	 *  content overflows the frame. A body styled `height:100%` reports
	 *  scrollHeight == the frame's own viewport, so an unconditional `h + 24`
	 *  on every ResizeObserver tick fed the frame its own height back (+24
	 *  each round) and ballooned short emails to the 4000px cap. */
	let measured = false;
	function measure(doc: Document) {
		const h = doc.body?.scrollHeight ?? 0;
		if (h <= 0) return;
		if (!measured) {
			measured = true;
			frameHeight = Math.min(h + 24, 4000);
		} else if (h > frameHeight) {
			frameHeight = Math.min(h + 24, 4000);
		}
	}

	function onLoad() {
		sized = true;
		const doc = docOf(iframe);
		if (!doc) return;
		// Empty response → show the excerpt instead of a blank sheet. Checked
		// FIRST: an empty document's body.scrollHeight is the iframe viewport
		// height (never 0), so gating this behind `scrollHeight === 0` made the
		// fallback unreachable and text-only mail rendered as a white void.
		if (!doc.body?.innerHTML?.trim()) {
			failed = true;
			return;
		}
		if (doc.contentType === 'application/json') {
			failed = true;
			return;
		}
		// Final measure with all subresources in; also covers the case where the
		// poll somehow never caught the document mid-stream.
		measure(doc);
		// Everything is in and the frame is sized — hand the scrollbar back so a
		// body taller than the 4000px cap can scroll inside the frame.
		doc.documentElement.style.overflowY = '';
		if (!observer) {
			observer = new ResizeObserver(() => measure(doc));
			observer.observe(doc.body);
		}
	}
</script>

{#if failed || !hasHtml}
	<pre class="excerpt">{excerpt || '(no content)'}</pre>
{:else}
	<iframe
		bind:this={iframe}
		title="Message body"
		src="/api/messages/{encodeURIComponent(messageId)}/body?scheme={scheme}&v=3"
		class:dark={scheme === 'dark'}
		class:sized
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
		/* Hidden until the body DOM is measured; the un-sized 120px default
		   otherwise paints its internal scrollbar for a frame before growing.
		   Opacity (not visibility) so the load + measure still happen normally. */
		opacity: 0;
	}
	iframe.sized {
		opacity: 1;
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
