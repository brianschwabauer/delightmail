import { describe, it, expect, vi, afterEach } from 'vitest';
import { armUndoSend, takeUndoSend } from './undo-send';

afterEach(() => vi.useRealTimers());

describe('undo send', () => {
	it('hands the undo out once, to whichever of toast or Ctrl+Z asks first', () => {
		const undo = vi.fn();
		armUndoSend(10, undo);
		takeUndoSend()?.();
		expect(takeUndoSend()).toBeNull();
		expect(undo).toHaveBeenCalledTimes(1);
	});

	it('expires with the window', () => {
		vi.useFakeTimers();
		armUndoSend(10, () => {});
		vi.advanceTimersByTime(10_000);
		expect(takeUndoSend()).toBeNull();
	});

	it('a newer send replaces the older one', () => {
		const first = vi.fn();
		const second = vi.fn();
		armUndoSend(10, first);
		armUndoSend(10, second);
		takeUndoSend()?.();
		expect(second).toHaveBeenCalled();
		expect(first).not.toHaveBeenCalled();
	});
});
