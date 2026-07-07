<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, ButtonGroup, toast } from '@delightstack/components';
	import { applyTheme, applyDensity, currentTheme, currentDensity, type Theme, type Density } from '$lib/theme';
	import { enablePush, isPushSupported } from '$lib/push-client';

	const { data } = $props();
	const { db } = $derived(data);

	let theme = $state<Theme>('system');
	let density = $state<Density>('comfortable');
	let pushSupported = $state(false);
	let enablingPush = $state(false);

	onMount(async () => {
		theme = currentTheme();
		density = currentDensity();
		pushSupported = await isPushSupported();
	});

	async function turnOnPush() {
		enablingPush = true;
		try {
			const r = await enablePush();
			toast(r.ok ? 'Notifications enabled on this device.' : r.reason || 'Could not enable notifications.');
		} finally {
			enablingPush = false;
		}
	}

	async function persist(patch: Record<string, unknown>) {
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			if (!e.loaded) await db.create('settings', { id: 'main', ...patch } as never);
			else await e.save(patch);
		} catch {
			/* settings sync is best-effort; local preference already applied */
		}
	}

	function setTheme(t: Theme) {
		theme = t;
		applyTheme(t);
		persist({ theme: t });
	}
	function setDensity(d: Density) {
		density = d;
		applyDensity(d);
		persist({ density: d });
	}
</script>

<svelte:head><title>Appearance · Settings</title></svelte:head>

<h2>Appearance</h2>

<section>
	<h3>Theme</h3>
	<ButtonGroup>
		{#each ['system', 'light', 'dark'] as const as t (t)}
			<Button active={theme === t} onclick={() => setTheme(t)} class="cap">{t}</Button>
		{/each}
	</ButtonGroup>
</section>

<section>
	<h3>Density</h3>
	<ButtonGroup>
		{#each ['comfortable', 'compact'] as const as d (d)}
			<Button active={density === d} onclick={() => setDensity(d)} class="cap">{d}</Button>
		{/each}
	</ButtonGroup>
	<p class="muted">Compact fits more conversations per screen.</p>
</section>

<section>
	<h3>Notifications</h3>
	{#if pushSupported}
		<Button disabled={enablingPush} onclick={turnOnPush}>
			{enablingPush ? 'Enabling…' : 'Enable push notifications'}
		</Button>
		<p class="muted">Get notified of important new mail even when the app is closed (needs VAPID keys configured; iOS requires the installed PWA).</p>
	{:else}
		<p class="muted">Push isn't supported on this device/browser.</p>
	{/if}
</section>

<style>
	h2 {
		font-size: var(--font-size-3);
	}
	h3 {
		font-size: var(--font-size-1);
		margin: var(--space-4) 0 var(--space-2);
	}
	:global(.cap) {
		text-transform: capitalize;
	}
	.muted {
		color: var(--color-text-disabled);
		font-size: var(--font-size-0);
		margin-top: var(--space-2);
	}
</style>
