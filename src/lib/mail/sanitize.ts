/**
 * Email HTML sanitizer. Email HTML is hostile input: strip scripts, forms,
 * event handlers, and external stylesheets; keep inline styles, tables, and
 * images. Runs once at ingest; the result is ALSO rendered inside a sandboxed,
 * CSP-pinned iframe, so this is defense-in-depth, not the only barrier.
 *
 * Pure and Workers-compatible (unified/rehype pipeline). Unit-tested against an
 * XSS corpus in sanitize.test.ts — every payload must come out inert.
 */
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import { sanitize, defaultSchema, type Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';

// Minimal hast shapes (avoid a direct dependency on the `hast` types package).
interface HastElement {
	type: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: unknown[];
}
type HastRoot = { type: 'root'; children: unknown[] };

/** A permissive-but-safe schema for rendering marketing/email HTML. */
const emailSchema: Schema = {
	...defaultSchema,
	// Remote images load by design (non-goals); allow cid: + data: too.
	protocols: {
		...defaultSchema.protocols,
		src: ['http', 'https', 'cid', 'data'],
		href: ['http', 'https', 'mailto', 'tel'],
	},
	tagNames: [
		...(defaultSchema.tagNames ?? []),
		'table',
		'thead',
		'tbody',
		'tfoot',
		'tr',
		'td',
		'th',
		'colgroup',
		'col',
		'center',
		'font',
		'figure',
		'figcaption',
		'style', // scoped inline <style> is kept; <link rel=stylesheet> is not
	],
	attributes: {
		...defaultSchema.attributes,
		'*': [...(defaultSchema.attributes?.['*'] ?? []), 'style', 'align', 'valign', 'bgcolor', 'width', 'height'],
		a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
		img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'width', 'height', 'style'],
		table: ['border', 'cellpadding', 'cellspacing', 'width', 'align', 'bgcolor', 'style'],
		td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor', 'style'],
		th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor', 'style'],
		font: ['color', 'face', 'size'],
	},
	// Belt-and-suspenders: explicitly strip dangerous elements even if listed.
	// `title` is stripped WITH its text: dropping only the tag leaked the email's
	// <title> as bare text at the top of the rendered body.
	strip: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base', 'title'],
	// Don't prefix ids/names with `user-content-`. Clobbering guards a host page's
	// scripts from DOM shadowing, but this HTML is only ever served as its own
	// script-free document (sandboxed iframe, CSP default-src 'none'). The prefix
	// actively breaks mail: id selectors in kept <style> blocks (`#body { … }` —
	// how real newsletters do dark mode) stop matching their now-renamed elements.
	clobber: [],
};

export interface SanitizeOptions {
	/** Rewrite `cid:` image srcs to this attachment endpoint prefix. */
	cidBase?: string;
	/** Map of contentId → attachment id for cid rewriting. */
	cidMap?: Record<string, string>;
	/** Force http image srcs to https. @default true */
	upgradeInsecureImages?: boolean;
}

export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): string {
	if (!html) return '';
	const tree = unified().use(rehypeParse, { fragment: true }).parse(html);

	const clean = sanitize(tree, emailSchema) as unknown as HastRoot;
	rewriteTree(clean, opts);
	return toHtml(clean as never);
}

/** Walk the sanitized tree: rewrite cid: images, upgrade http→https, harden links. */
function rewriteTree(node: HastRoot | HastElement, opts: SanitizeOptions): void {
	const children = node.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		const el = child as HastElement;
		if (el.type === 'element') {
			if (el.tagName === 'img') hardenImage(el, opts);
			if (el.tagName === 'a') hardenLink(el);
			rewriteTree(el, opts);
		}
	}
}

function hardenImage(el: HastElement, opts: SanitizeOptions): void {
	const src = el.properties?.src;
	if (typeof src !== 'string') return;
	if (src.startsWith('cid:')) {
		const cid = src.slice(4).replace(/[<>]/g, '');
		const attId = opts.cidMap?.[cid];
		if (attId && opts.cidBase) {
			el.properties!.src = `${opts.cidBase}/${attId}`;
		} else {
			// No mapping — drop the broken cid image src.
			delete el.properties!.src;
		}
	} else if ((opts.upgradeInsecureImages ?? true) && src.startsWith('http://')) {
		el.properties!.src = 'https://' + src.slice('http://'.length);
	}
}

function hardenLink(el: HastElement): void {
	if (typeof el.properties?.href === 'string') {
		el.properties.target = '_blank';
		el.properties.rel = 'noopener noreferrer';
	}
}
