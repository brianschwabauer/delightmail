<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, ButtonGroup, Input, toast } from '@delightstack/components';
	import { applyTheme, applyDensity, currentTheme, currentDensity, type Theme, type Density } from '$lib/theme';
	import { enablePush, isPushSupported } from '$lib/push-client';
	import { soundsEnabled, setSoundsEnabled, playTick } from '$lib/mail/sound';

	const { data } = $props();
	const { db } = $derived(data);

	let theme = $state<Theme>('system');
	let density = $state<Density>('comfortable');
	let pushSupported = $state(false);
	let enablingPush = $state(false);
	let quietStart = $state<string | null>('');
	let quietEnd = $state<string | null>('');
	let sounds = $state(false);
	let undoSeconds = $state(10);
	const UNDO_CHOICES = [5, 10, 20, 30] as const;
	const THEMES: Array<{ value: Theme; label: string }> = [
		{ value: 'system', label: 'System' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
	];
	const DENSITIES: Array<{ value: Density; label: string }> = [
		{ value: 'comfortable', label: 'Comfortable' },
		{ value: 'compact', label: 'Compact' },
	];

	function setSounds(on: boolean) {
		sounds = on;
		setSoundsEnabled(on);
		if (on) playTick('archive'); // preview the tick right away
		persist({ sounds: on });
	}

	onMount(async () => {
		theme = currentTheme();
		density = currentDensity();
		sounds = soundsEnabled();
		pushSupported = await isPushSupported();
		try {
			const e = db.entity('settings', 'main');
			await e.load();
			const settings = (e.loaded ? e.value : {}) as {
				quiet_hours?: string;
				undo_send_seconds?: number;
			};
			if (settings.undo_send_seconds) undoSeconds = settings.undo_send_seconds;
			const win = settings.quiet_hours;
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

	function setUndoSeconds(n: number) {
		undoSeconds = n;
		persist({ undo_send_seconds: n });
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

<!-- The selected option is filled with the brand colour; the others stay outlined.
     (ButtonGroup's own `active` tint is too faint to read as "selected".) -->
<section>
	<h3>Theme</h3>
	<ButtonGroup>
		{#each THEMES as t (t.value)}
			<Button
				outline={theme !== t.value}
				aria-pressed={theme === t.value}
				onclick={() => setTheme(t.value)}>{t.label}</Button>
		{/each}
	</ButtonGroup>
</section>

<section>
	<h3>Density</h3>
	<ButtonGroup>
		{#each DENSITIES as d (d.value)}
			<Button
				outline={density !== d.value}
				aria-pressed={density === d.value}
				onclick={() => setDensity(d.value)}>{d.label}</Button>
		{/each}
	</ButtonGroup>
	<p class="muted">Compact fits more conversations on screen.</p>
</section>

<section>
	<h3>Sounds</h3>
	<ButtonGroup>
		<Button outline={sounds} aria-pressed={!sounds} onclick={() => setSounds(false)}>
			Silent
		</Button>
		<Button outline={!sounds} aria-pressed={sounds} onclick={() => setSounds(true)}>
			Subtle sounds
		</Button>
	</ButtonGroup>
	<p class="muted">A soft click when you archive or delete.</p>
</section>

<section>
	<h3>Undo send</h3>
	<ButtonGroup>
		{#each UNDO_CHOICES as n (n)}
			<Button
				outline={undoSeconds !== n}
				aria-pressed={undoSeconds === n}
				onclick={() => setUndoSeconds(n)}>{n} seconds</Button>
		{/each}
	</ButtonGroup>
	<p class="muted">
		How long a sent message waits before it leaves. Press Undo in the toast, or Ctrl+Z, to take it back.
	</p>
</section>

<section>
	<h3>Notifications</h3>
	{#if pushSupported}
		<Button disabled={enablingPush} onclick={turnOnPush}>
			{enablingPush ? 'Enabling…' : 'Enable push notifications'}
		</Button>
		<p class="muted">
			Get notified of important new mail while the app is closed. On iPhone, install the app to
			your home screen first.
		</p>
	{:else}
		<p class="muted">This browser can't show push notifications.</p>
	{/if}

	<h3>Quiet hours</h3>
	<div class="quiet">
		<Input type="time" label="From" bind:value={quietStart} onchange={setQuietHours} />
		<Input type="time" label="Until" bind:value={quietEnd} onchange={setQuietHours} />
		{#if quietStart || quietEnd}
			<Button outline onclick={clearQuietHours}>Clear</Button>
		{/if}
	</div>
	<p class="muted">No notifications during these hours, in your local time.</p>
</section>

<style>
	h2 {
		font-size: var(--font-size-3);
	}
	h3 {
		font-size: var(--font-size-1);
		margin: var(--space-4) 0 var(--space-2);
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
		/* Sized to the value: a time is ~8 characters. */
		& > :global(*:not(button)) {
			inline-size: 10rem;
		}
	}
</style>
