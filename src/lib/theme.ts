/**
 * Theme application. The preference (`system|light|dark`) is stored in
 * localStorage for a flash-free boot (see app.html) and mirrored to the settings
 * table for cross-device sync. `data-theme` on <html> drives the OKLCH tokens.
 */
import { createSubscriber } from 'svelte/reactivity';

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export function applyTheme(theme: Theme): void {
	if (typeof document === 'undefined') return;
	localStorage.setItem('dm-theme', theme);
	const dark =
		theme === 'dark' ||
		(theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function applyDensity(density: Density): void {
	if (typeof document === 'undefined') return;
	localStorage.setItem('dm-density', density);
	document.documentElement.dataset.density = density;
}

export function currentTheme(): Theme {
	if (typeof localStorage === 'undefined') return 'system';
	return (localStorage.getItem('dm-theme') as Theme) ?? 'system';
}

/** The theme actually in effect right now ('system' resolved via media query). */
export function resolvedScheme(): 'light' | 'dark' {
	if (typeof document === 'undefined') return 'light';
	// data-theme is stamped by applyTheme at boot — the cheapest truthful source.
	return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
/**
 * The resolved scheme as reactive state: reading `scheme.current` inside an
 * effect or template re-runs it whenever `data-theme` flips — a manual theme
 * change, or the OS switching light/dark while the theme is 'system'.
 */
class ReactiveScheme {
	#subscribe = createSubscriber((update) => {
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});
		return () => observer.disconnect();
	});
	get current(): 'light' | 'dark' {
		if (typeof document !== 'undefined') this.#subscribe();
		return resolvedScheme();
	}
}
export const scheme = new ReactiveScheme();

export function currentDensity(): Density {
	if (typeof localStorage === 'undefined') return 'comfortable';
	return (localStorage.getItem('dm-density') as Density) ?? 'comfortable';
}
