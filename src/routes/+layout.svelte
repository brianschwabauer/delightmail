<script lang="ts">
	import { Toaster, toast } from '@delightstack/components';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import './global.css';

	const { children } = $props();

	$effect(() => {
		const message = page.url.searchParams.get('toast');
		if (message) {
			toast(message);
			const url = new URL(page.url);
			url.searchParams.delete('toast');
			replaceState(url, {});
		}
	});

	// Register the PWA service worker (§10.4). Vite only builds it in production.
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
