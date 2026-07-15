/**
 * Opt-in action sounds — a single ~45ms synthesized tick, no assets. Paired
 * with the row slide-out, triaging with `e e j e` becomes rhythmic. The
 * preference mirrors to localStorage (like theme/density) so the hot path
 * never waits on the settings table.
 */
let ctx: AudioContext | null = null;

export function soundsEnabled(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem('dm-sounds') === '1';
}

export function setSoundsEnabled(on: boolean): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem('dm-sounds', on ? '1' : '0');
}

/** A filtered sine tick — slightly lower for trash than archive. */
export function playTick(kind: 'archive' | 'trash' = 'archive'): void {
	if (!soundsEnabled() || typeof AudioContext === 'undefined') return;
	try {
		ctx ??= new AudioContext();
		if (ctx.state === 'suspended') void ctx.resume();
		const t = ctx.currentTime;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		const filter = ctx.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.value = 2400;
		osc.type = 'sine';
		osc.frequency.setValueAtTime(kind === 'archive' ? 880 : 587, t);
		osc.frequency.exponentialRampToValueAtTime(kind === 'archive' ? 659 : 440, t + 0.04);
		gain.gain.setValueAtTime(0.0001, t);
		gain.gain.exponentialRampToValueAtTime(0.1, t + 0.008);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
		osc.connect(filter);
		filter.connect(gain);
		gain.connect(ctx.destination);
		osc.start(t);
		osc.stop(t + 0.06);
	} catch {
		/* audio unavailable — silence is fine */
	}
}
