<script lang="ts">
	import { tick, getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import type { MailDatabaseClient } from '$lib/clients';
	import type { ComposeInit } from './Compose.svelte';

	const compose = getContext<{ open: (init?: ComposeInit) => void }>('mail:compose');

	interface Command {
		id: string;
		label: string;
		hint?: string;
		run: () => void;
	}
	interface Props {
		db: MailDatabaseClient;
		open: boolean;
		onClose: () => void;
	}
	const { open, onClose }: Props = $props();

	let query = $state('');
	let active = $state(0);
	let input = $state<HTMLInputElement>();

	const commands: Command[] = [
		{ id: 'inbox', label: 'Go to Inbox', hint: 'g i', run: () => goto('/mail/inbox') },
		{ id: 'filtered', label: 'Go to AI Filtered', hint: 'g f', run: () => goto('/mail/filtered') },
		{ id: 'starred', label: 'Go to Starred', hint: 'g s', run: () => goto('/mail/starred') },
		{ id: 'sent', label: 'Go to Sent', hint: 'g t', run: () => goto('/mail/sent') },
		{ id: 'drafts', label: 'Go to Drafts', hint: 'g d', run: () => goto('/mail/drafts') },
		{ id: 'archive', label: 'Go to Archive', hint: 'g a', run: () => goto('/mail/archive') },
		{ id: 'spam', label: 'Go to Spam', run: () => goto('/mail/spam') },
		{ id: 'trash', label: 'Go to Trash', run: () => goto('/mail/trash') },
		{ id: 'compose', label: 'Compose new message', hint: 'n', run: () => compose.open() },
		{ id: 'settings-accounts', label: 'Settings: Accounts', run: () => goto('/settings/accounts') },
		{ id: 'settings-ai', label: 'Settings: AI Triage', run: () => goto('/settings/ai') },
		{ id: 'settings-appearance', label: 'Settings: Appearance', run: () => goto('/settings/appearance') },
		{ id: 'settings-keyboard', label: 'Settings: Keyboard', run: () => goto('/settings/keyboard') },
		{ id: 'settings-subscriptions', label: 'Settings: Subscriptions', run: () => goto('/settings/subscriptions') },
	];

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return commands;
		return commands
			.map((c) => ({ c, score: fuzzyScore(c.label.toLowerCase(), q) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.c);
	});

	$effect(() => {
		if (open) {
			query = '';
			active = 0;
			tick().then(() => input?.focus());
		}
	});
	$effect(() => {
		if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
	});

	function choose(cmd?: Command) {
		const c = cmd ?? filtered[active];
		if (!c) return;
		onClose();
		c.run();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') return onClose();
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(filtered.length - 1, active + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(0, active - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose();
		}
	}

	function fuzzyScore(text: string, q: string): number {
		let ti = 0;
		let score = 0;
		let streak = 0;
		for (const ch of q) {
			const found = text.indexOf(ch, ti);
			if (found === -1) return 0;
			streak = found === ti ? streak + 2 : 1;
			score += streak;
			ti = found + 1;
		}
		return score;
	}
</script>

{#if open}
	<div class="scrim" role="button" tabindex="-1" onclick={onClose} onkeydown={() => {}}>
		<div
			class="palette"
			role="dialog"
			aria-label="Command palette"
			onclick={(e) => e.stopPropagation()}>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:this={input}
				bind:value={query}
				placeholder="Type a command…"
				onkeydown={onKeydown}
				autofocus />
			<ul>
				{#each filtered as c, i (c.id)}
					<li class:active={i === active}>
						<button onmousemove={() => (active = i)} onclick={() => choose(c)}>
							<span>{c.label}</span>
							{#if c.hint}<kbd>{c.hint}</kbd>{/if}
						</button>
					</li>
				{/each}
				{#if filtered.length === 0}
					<li class="none">No matching commands</li>
				{/if}
			</ul>
		</div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: color-mix(in oklch, black 35%, transparent);
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 12vh;
		z-index: 120;
	}
	.palette {
		width: min(560px, 92vw);
		background: var(--color-bg-1);
		border: 1px solid var(--color-outline);
		border-radius: var(--radius-3);
		box-shadow: var(--shadow-4, 0 20px 60px rgba(0, 0, 0, 0.4));
		overflow: hidden;
	}
	.palette input {
		width: 100%;
		padding: var(--size-3) var(--size-4);
		border: none;
		border-bottom: 1px solid var(--color-outline);
		background: transparent;
		color: inherit;
		font-size: var(--font-size-1);
		outline: none;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: var(--size-1);
		max-height: 50vh;
		overflow-y: auto;
	}
	li button {
		width: 100%;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--size-3);
		padding: 8px 12px;
		border: none;
		background: none;
		border-radius: var(--radius-2);
		color: inherit;
		cursor: pointer;
		font: inherit;
		text-align: left;
	}
	li.active button {
		background: var(--color-primary);
		color: white;
	}
	li.active kbd {
		color: white;
		border-color: rgba(255, 255, 255, 0.4);
	}
	kbd {
		font-family: var(--font-mono, monospace);
		font-size: 0.75em;
		border: 1px solid var(--color-outline);
		border-radius: 4px;
		padding: 0 5px;
		color: var(--color-text-disabled);
	}
	.none {
		padding: var(--size-3) var(--size-4);
		color: var(--color-text-disabled);
	}
</style>
