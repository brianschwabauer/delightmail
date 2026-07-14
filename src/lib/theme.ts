/**
 * Theme application. The preference (`system|light|dark`) is stored in
 * localStorage for a flash-free boot (see app.html) and mirrored to the settings
 * table for cross-device sync. `data-theme` on <html> drives the OKLCH tokens.
 */
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
export function currentDensity(): Density {
	if (typeof localStorage === 'undefined') return 'comfortable';
	return (localStorage.getItem('dm-density') as Density) ?? 'comfortable';
}
