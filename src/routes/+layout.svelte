<script lang="ts">
	import { Toaster, toast } from '@delightstack/components';
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { dev } from '$app/env';
	import './global.css';

	const { children } = $props();

	// Surface a ?toast= message (e.g. the OAuth callback redirect) once per
	// navigation. This MUST NOT be an $effect over page.url: kit's shallow
	// navigation rewrites the history URL but never updates the reactive
	// page.url — while still re-cloning `page` — so an effect that strips the
	// param re-runs against the same stale ?toast= forever (an infinite
	// shallow-navigation loop: effect_update_depth_exceeded, Chrome throttles all
	// navigation, the whole page goes dead).
	afterNavigate(({ shallow }) => {
		// Kit 3 runs afterNavigate for shallow navigations too, including the one
		// below; skipping them keeps that loop from coming back.
		if (shallow) return;
		const message = page.url.searchParams.get('toast');
		if (!message) return;
		toast(message);
		const url = new URL(page.url.href);
		url.searchParams.delete('toast');
		void goto(url, { shallow: true, replace: true });
	});

	// Register the PWA service worker. Vite only builds it in production.
	onMount(() => {
		if (!dev && 'serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js', { type: 'module' }).catch(() => {});
		}
	});
</script>

<svelte:head>
	<title>Mail</title>
</svelte:head>

<Toaster />
{@render children()}
