export class SdkControlTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'SdkControlTimeoutError';
  }
}

/**
 * SDK control requests are diagnostic helpers, not part of the model stream.
 * They must never block consumption of assistant/rate-limit/result messages.
 */
export async function runSdkControlWithTimeout<T>(
  operation: string,
  request: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SdkControlTimeoutError(operation, timeoutMs)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FIRST_RESPONSE_MESSAGE_TYPES = new Set([
  'assistant',
  'result',
  'stream_event',
]);

/**
 * Last-resort guard for third-party CLI/provider combinations that persist an
 * API error to the transcript but never forward it through the SDK iterator.
 */
export class SdkFirstResponseWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observed = false;

  constructor(
    readonly timeoutMs: number,
    onTimeout: () => void,
  ) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.observed) return;
      this.observed = true;
      onTimeout();
    }, timeoutMs);
  }

  observe(messageType: string): void {
    if (!FIRST_RESPONSE_MESSAGE_TYPES.has(messageType)) return;
    this.observed = true;
    this.clear();
  }

  /**
   * Suspend the first-response deadline for a known-legitimate long operation.
   * An auto-compaction is a full model round-trip that summarizes the whole
   * conversation; on a near-full context it can easily exceed the first-response
   * budget while emitting no `assistant`/`stream_event`/`result` to the outer
   * iterator. Without this, a slow compaction is misclassified as a stalled
   * provider and surfaced as a terminal "provider exhausted" failure. The real
   * post-compaction model response still clears the guard via observe().
   */
  pause(): void {
    if (this.observed) return;
    this.clear();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
