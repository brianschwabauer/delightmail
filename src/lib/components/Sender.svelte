<script lang="ts">
	import { Avatar, Popover } from '@delightstack/components';
	import { verifiedAvatarUrl } from '$lib/mail/avatar.svelte';

	/** The sender name in a message head, with a hover popover revealing who it
	 *  actually is — display name plus the real address (selectable, so a
	 *  spoofed-looking sender can be inspected without opening anything). */
	interface Props {
		name: string;
		email?: string;
	}
	const { name, email }: Props = $props();

	let ref = $state<HTMLElement>();
</script>

<span class="from" bind:this={ref}>{name}</span>
{#if email || name}
	<Popover
		ref_element={ref}
		open_on_hover
		placement="bottom-start"
		disable_initial_focus
		hover_delay={250}>
		<span class="card">
			<Avatar {name} src={verifiedAvatarUrl(email)} size="3" />
			<span class="meta">
				<span class="name">{name}</span>
				{#if email}
					<span class="email">{email}</span>
				{:else}
					<span class="email unknown">address unavailable</span>
				{/if}
			</span>
		</span>
	</Popover>
{/if}

<style>
	.from {
		font-weight: var(--font-weight-semibold, 600);
		font-size: var(--font-size-0);
		/* This span is the popover's anchor. As a flex item in the message head's
		   .meta column it would stretch to the full column width, parking the
		   popover arrow at the row's center instead of under the name — size it
		   to its text (ellipsized when the column is narrower). */
		align-self: flex-start;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		max-width: 340px;
	}
	.meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-weight: var(--font-weight-semibold, 600);
		font-size: var(--font-size-0);
	}
	.email {
		font-family: var(--font-mono);
		font-size: var(--font-size-00);
		color: var(--color-text-muted, var(--color-text-disabled));
		overflow-wrap: anywhere;
		user-select: text;
	}
	.email.unknown {
		font-family: inherit;
		font-style: italic;
	}
</style>
