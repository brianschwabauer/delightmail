<!-- The load in +page.ts always redirects into the mail layout's compose overlay;
     this page renders only in the brief moment before the redirect resolves. -->
<p class="redirecting">Opening compose…</p>

<style>
	.redirecting {
		padding: var(--size-4, 2rem);
		color: var(--color-text-disabled);
	}
</style>
