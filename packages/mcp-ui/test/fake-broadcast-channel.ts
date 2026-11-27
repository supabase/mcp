/**
 * A `BroadcastChannel` for tests, standing in for the browser's: a message
 * reaches every other open channel with the same name, as a copy, a
 * microtask later, and never the channel that posted it. Install it with
 * `vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)` and call
 * `FakeBroadcastChannel.reset()` after each test.
 */
export class FakeBroadcastChannel {
  /** Every channel opened and not yet closed. */
  static open = new Set<FakeBroadcastChannel>();

  static reset() {
    FakeBroadcastChannel.open.clear();
  }

  onmessage: ((event: MessageEvent) => void) | null = null;
  /** Everything posted on this channel, in order. */
  readonly posted: unknown[] = [];

  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }

  postMessage(data: unknown) {
    if (!FakeBroadcastChannel.open.has(this)) {
      throw new DOMException('The channel is closed.', 'InvalidStateError');
    }
    this.posted.push(data);
    for (const other of FakeBroadcastChannel.open) {
      if (other === this || other.name !== this.name) continue;
      const copy = structuredClone(data);
      queueMicrotask(() => {
        if (FakeBroadcastChannel.open.has(other)) {
          other.onmessage?.(new MessageEvent('message', { data: copy }));
        }
      });
    }
  }

  close() {
    FakeBroadcastChannel.open.delete(this);
  }
}
