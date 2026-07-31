import { describe, expect, test, vi } from 'vitest';

import {
  runSdkControlWithTimeout,
  SdkControlTimeoutError,
  SdkFirstResponseWatchdog,
} from '../container/agent-runner/src/sdk-control.js';

describe('agent-runner SDK control requests', () => {
  test('returns a healthy control response', async () => {
    await expect(
      runSdkControlWithTimeout(
        'getContextUsage',
        async () => ({ totalTokens: 42 }),
        100,
      ),
    ).resolves.toEqual({ totalTokens: 42 });
  });

  test('fails open when a diagnostic control request never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = runSdkControlWithTimeout(
        'getContextUsage',
        () => new Promise<never>(() => {}),
        5_000,
      );
      const rejection = expect(pending).rejects.toEqual(
        new SdkControlTimeoutError('getContextUsage', 5_000),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  test('preserves a real SDK control error', async () => {
    const failure = new Error('control transport closed');
    await expect(
      runSdkControlWithTimeout(
        'getContextUsage',
        async () => {
          throw failure;
        },
        100,
      ),
    ).rejects.toBe(failure);
  });

  test('fires when the SDK never forwards a first model response', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      watchdog.observe('system');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(['assistant', 'result', 'stream_event'])(
    'clears the first-response watchdog on %s',
    async (messageType) => {
      vi.useFakeTimers();
      try {
        const onTimeout = vi.fn();
        const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

        watchdog.observe(messageType);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(onTimeout).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('pause() suspends the deadline for a long compaction round-trip', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(60_000, onTimeout);

      // Compaction starts early in the turn (PreCompact) before the budget
      // elapses; the summarization request itself emits no first-response.
      await vi.advanceTimersByTimeAsync(3_000);
      watchdog.pause();

      // A slow compaction can far exceed the original first-response budget.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(onTimeout).not.toHaveBeenCalled();

      // The real post-compaction model response still clears the guard.
      watchdog.observe('assistant');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not treat a non-terminal rate-limit warning as a model response', () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = new SdkFirstResponseWatchdog(1_000, onTimeout);

      watchdog.observe('rate_limit_event');
      vi.advanceTimersByTime(1_000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
