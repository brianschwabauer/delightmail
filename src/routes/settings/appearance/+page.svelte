<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, toast } from '@delightstack/components';
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
	<div class="segmented">
		{#each ['system', 'light', 'dark'] as const as t (t)}
			<button class:active={theme === t} onclick={() => setTheme(t)}>{t}</button>
		{/each}
	</div>
</section>

<section>
	<h3>Density</h3>
	<div class="segmented">
		{#each ['comfortable', 'compact'] as const as d (d)}
			<button class:active={density === d} onclick={() => setDensity(d)}>{d}</button>
		{/each}
	</div>
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
		margin: var(--size-4) 0 var(--size-2);
	}
	.segmented {
		display: inline-flex;
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-2);
		overflow: hidden;
	}
	.segmented button {
		padding: 6px 16px;
		border: none;
		background: var(--color-bg-2);
		color: inherit;
		cursor: pointer;
		text-transform: capitalize;
		font: inherit;
		border-right: 1px solid var(--color-outline);
	}
	.segmented button:last-child {
		border-right: none;
	}
	.segmented button.active {
		background: var(--color-primary);
		color: white;
	}
	.muted {
		color: var(--color-text-disabled);
		font-size: var(--font-size-0);
		margin-top: var(--size-2);
	}
</style>
