<script lang="ts">
	import { page } from '$app/state';
	import FolderRail from '$lib/components/FolderRail.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import PasskeyPrompt from '$lib/components/PasskeyPrompt.svelte';

	const { data, children } = $props();
	const { auth, db, ws } = $derived(data);

	const view = $derived(page.params.view ?? 'inbox');
</script>

<div class="app">
	<FolderRail {db} {view} {auth} />
	<main class="content">
		{@render children()}
	</main>
</div>
<StatusBar {auth} {ws} />
<PasskeyPrompt {auth} />

<style>
	.app {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		height: 100dvh;
		height: calc(100dvh - var(--dm-statusbar-h, 28px));
	}
	.content {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		display: flex;
	}
	@media (max-width: 767px) {
		.app {
			grid-template-columns: 1fr;
		}
	}
</style>
