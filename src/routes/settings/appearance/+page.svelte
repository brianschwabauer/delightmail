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
	let quietStart = $state('');
	let quietEnd = $state('');

	onMount(async () => {
		theme = currentTheme();
		density = currentDensity();
		pushSupported = await isPushSupported();
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const win = (e.loaded ? (e.value as { quiet_hours?: string }) : {})?.quiet_hours;
			const m = win?.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
			if (m) {
				quietStart = m[1].padStart(5, '0');
				quietEnd = m[2].padStart(5, '0');
			}
		} catch {
			/* offline — leave empty */
		}
	});

	function setQuietHours() {
		// The window is user-local time; persist the browser's IANA timezone with
		// it so the server evaluates the window in the right zone (incl. DST).
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (quietStart && quietEnd && quietStart !== quietEnd) {
			persist({ quiet_hours: `${quietStart}-${quietEnd}`, timezone });
		} else {
			persist({ quiet_hours: '', timezone });
		}
	}

	function clearQuietHours() {
		quietStart = '';
		quietEnd = '';
		persist({ quiet_hours: '' });
	}

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
	<ButtonGroup outline>
		{#each ['system', 'light', 'dark'] as const as t (t)}
			<Button active={theme === t} onclick={() => setTheme(t)} class="cap">{t}</Button>
		{/each}
	</ButtonGroup>
</section>

<section>
	<h3>Density</h3>
	<ButtonGroup outline>
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

	<h3>Quiet hours</h3>
	<div class="quiet">
		<input type="time" bind:value={quietStart} onchange={setQuietHours} aria-label="Quiet hours start" />
		<span>to</span>
		<input type="time" bind:value={quietEnd} onchange={setQuietHours} aria-label="Quiet hours end" />
		{#if quietStart || quietEnd}
			<Button onclick={clearQuietHours}>Clear</Button>
		{/if}
	</div>
	<p class="muted">Pushes are suppressed during this window (your local time — timezone is saved automatically).</p>
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
	.quiet {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.quiet input {
		background: var(--color-bg-2);
		color: inherit;
		border: 1px solid var(--color-border, rgba(128, 128, 128, 0.35));
		border-radius: var(--radius-2, 6px);
		padding: var(--space-1) var(--space-2);
		font: inherit;
	}
</style>
