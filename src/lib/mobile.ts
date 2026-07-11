/**
 * The one mobile breakpoint, shared by CSS and behavior. Components gate their
 * layout with `@media (max-width: 767px)`; behavior (history pushes, tap-to-
 * select, preview gating) reads this reactive query so the two can never
 * disagree. SSR-safe: falls back to `false` on the server.
 */
import { MediaQuery } from 'svelte/reactivity';

export const isMobile = new MediaQuery('(max-width: 767px)', false);
