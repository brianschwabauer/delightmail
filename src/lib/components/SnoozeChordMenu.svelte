<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import {
		snoozeChordOptions,
		nextWeekdayMorning,
		fmtWake,
		type SnoozeOption,
	} from '$lib/mail/snooze';

	interface Props {
		/** How many conversations the snooze will act on (for the title). */
		count: number;
		onPick: (at: number) => void;
		onClose: () => void;
	}
	const { count, onPick, onClose }: Props = $props();

	// Options are computed once per open — the menu is short-lived, so the wake
	// times can't drift meaningfully while it's up.
	const options: SnoozeOption[] = snoozeChordOptions();
	const default_at = nextWeekdayMorning();

	// Which-key behavior: the chord works immediately, but the panel only paints
	// after a beat — a fast "z z" or "z 2" never flashes a menu. No animation:
	// past the delay it appears fully formed.
	const SHOW_DELAY_MS = 150;
	let visible = $state(false);

	function handleKey(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopImmediatePropagation();
			onClose();
			return;
		}
		if (e.key === 'z') {
			e.preventDefault();
			e.stopImmediatePropagation();
			onPick(default_at);
			return;
		}
		const opt = options.find((o) => o.key === e.key);
		if (opt) {
			e.preventDefault();
			e.stopImmediatePropagation();
			onPick(opt.at);
			return;
		}
		// The menu owns the keyboard while open — nothing leaks to the app below.
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	onMount(() => {
		// Capture phase so this wins over the layout's window keydown listener.
		window.addEventListener('keydown', handleKey, { capture: true });
		const timer = setTimeout(() => (visible = true), SHOW_DELAY_MS);
		return () => {
			window.removeEventListener('keydown', handleKey, { capture: true });
			clearTimeout(timer);
		};
	});
</script>

{#if visible}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={onClose}>
		<div
			class="panel"
			role="menu"
			tabindex="-1"
			aria-label="Snooze until"
			onclick={(e) => e.stopPropagation()}>
			<header>
				<Icon name="clock" size={15} />
				<span class="title">Snooze {count === 1 ? 'conversation' : `${count} conversations`}</span>
				<kbd class="esc">Esc</kbd>
			</header>
			<button class="row" role="menuitem" onclick={() => onPick(default_at)}>
				<kbd>z</kbd>
				<span class="label">Next weekday</span>
				<span class="wake">{fmtWake(default_at)}</span>
			</button>
			{#each options as o (o.key)}
				<button class="row" role="menuitem" onclick={() => onPick(o.at)}>
					<kbd>{o.key}</kbd>
					<span class="label">{o.label}</span>
					<span class="wake">{fmtWake(o.at)}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	/* Deliberately transition-free: the chord menu appears fully formed (past the
	   which-key delay) and vanishes the instant a key resolves it. */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--layer-modal, 400);
		display: grid;
		place-items: center;
		background: color-mix(in oklab, black 25%, transparent);
	}
	.panel {
		--radius: var(--radius-lg, 12px);
		--inset: var(--space-2);
		min-width: 320px;
		padding: var(--inset);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		background: var(--color-bg-1);
		box-shadow: var(--shadow-4, 0 8px 32px rgb(0 0 0 / 0.35));
	}
	@supports (corner-shape: squircle) {
		.panel {
			corner-shape: squircle;
			border-radius: calc(var(--radius) * 2);
		}
	}
	header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2) var(--space-2);
		color: var(--color-text-muted, var(--color-text-disabled));
		font-size: var(--font-size-0);
	}
	.title {
		flex: 1;
		font-weight: var(--font-weight-medium, 500);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: 7px var(--space-2);
		border: none;
		border-radius: calc(var(--radius) - var(--inset));
		background: none;
		color: var(--color-text);
		font: inherit;
		font-size: var(--font-size-0);
		text-align: left;
		cursor: pointer;
		transition: background-color 250ms;
	}
	.row:hover {
		background: var(--color-bg-2);
		transition: none;
	}
	.row .label {
		flex: 1;
	}
	.wake {
		color: var(--color-text-disabled);
		font-size: var(--font-size-00);
		font-variant-numeric: tabular-nums;
	}
	kbd {
		display: inline-grid;
		place-items: center;
		min-width: 20px;
		height: 20px;
		padding: 0 5px;
		font-family: var(--font-mono);
		font-size: 0.78em;
		background: var(--color-bg-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 4px);
	}
	.esc {
		opacity: 0.7;
	}
</style>
