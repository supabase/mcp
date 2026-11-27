import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '../../test/fake-broadcast-channel';
import {
  compareStamps,
  readStamp,
  useSupersession,
  type ViewKey,
  VIEWS_CHANNEL,
  type ViewStamp,
} from './use-supersession';

const ISSUES: ViewKey = { view: 'show-issues', project: 'abc' };

const stamp = (at: number, id = 'b', key: ViewKey = ISSUES): ViewStamp => ({
  key,
  at,
  id,
});

describe('compareStamps', () => {
  it('finds a later stamp with the same key newer, an earlier one older', () => {
    expect(compareStamps(stamp(1), stamp(2))).toBe('newer');
    expect(compareStamps(stamp(2), stamp(1))).toBe('older');
  });

  it('breaks a tie on the time by id', () => {
    expect(compareStamps(stamp(1, 'b'), stamp(1, 'c'))).toBe('newer');
    expect(compareStamps(stamp(1, 'b'), stamp(1, 'a'))).toBe('older');
  });

  it('ignores its own stamp', () => {
    expect(compareStamps(stamp(1, 'b'), stamp(1, 'b'))).toBe('other');
  });

  it('ignores a different view or project', () => {
    const mine = stamp(1);
    expect(
      compareStamps(mine, stamp(2, 'b', { view: 'other', project: 'abc' }))
    ).toBe('other');
    expect(
      compareStamps(
        mine,
        stamp(2, 'b', { view: 'show-issues', project: 'xyz' })
      )
    ).toBe('other');
    expect(compareStamps(mine, stamp(2, 'b', { view: 'show-issues' }))).toBe(
      'other'
    );
  });
});

describe('readStamp', () => {
  it('reads a stamp, with or without a project', () => {
    expect(readStamp(stamp(1))).toEqual(stamp(1));
    expect(readStamp({ key: { view: 'v' }, at: 1, id: 'a' })).toEqual({
      key: { view: 'v' },
      at: 1,
      id: 'a',
    });
  });

  it('ignores fields it does not know', () => {
    expect(readStamp({ ...stamp(1), from: 'a newer version' })).toEqual(
      stamp(1)
    );
  });

  it('drops anything else', () => {
    for (const data of [
      null,
      'hello',
      { key: ISSUES, at: '1', id: 'a' },
      { key: { view: 1 }, at: 1, id: 'a' },
      { key: { view: 'v', project: 2 }, at: 1, id: 'a' },
      { at: 1, id: 'a' },
      { key: ISSUES, at: Number.NaN, id: 'a' },
      { key: ISSUES, at: Number.POSITIVE_INFINITY, id: 'a' },
      { key: ISSUES, at: Number.NEGATIVE_INFINITY, id: 'a' },
    ]) {
      expect(readStamp(data)).toBeUndefined();
    }
  });
});

describe('useSupersession', () => {
  beforeEach(() => vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    FakeBroadcastChannel.reset();
  });

  /** Lets the channel's messages and their answers arrive. */
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve)));

  const mount = (at: number | undefined, key: ViewKey = ISSUES) =>
    renderHook(() => useSupersession(key, at));

  it('retires an older view when a newer one opens', async () => {
    const older = mount(1);
    await settle();
    expect(older.result.current).toBe(false);

    const newer = mount(2);
    await settle();
    expect(older.result.current).toBe(true);
    expect(newer.result.current).toBe(false);
  });

  it('retires an older view that mounts late, once the newer one answers', async () => {
    const newer = mount(2);
    await settle();
    const older = mount(1);
    await settle();

    expect(older.result.current).toBe(true);
    expect(newer.result.current).toBe(false);
  });

  it('ignores views of another project or another kind', async () => {
    const older = mount(1);
    mount(2, { view: 'show-issues', project: 'xyz' });
    mount(3, { view: 'show-logs', project: 'abc' });
    await settle();

    expect(older.result.current).toBe(false);
  });

  it('retires exactly one of two views opened at the same time', async () => {
    const first = mount(1);
    const second = mount(1);
    await settle();

    expect([first.result.current, second.result.current].sort()).toEqual([
      false,
      true,
    ]);
  });

  it('takes no part without a stamp', async () => {
    const unstamped = mount(undefined);
    await settle();
    expect(FakeBroadcastChannel.open.size).toBe(0);

    mount(2);
    await settle();
    expect(unstamped.result.current).toBe(false);
  });

  it('takes no part where the browser has no BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const view = mount(1);
    await settle();
    expect(view.result.current).toBe(false);
  });

  it('takes no part where the channel cannot be opened', async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new DOMException('Not allowed.', 'SecurityError');
        }
      }
    );
    const view = mount(1);
    await settle();
    expect(view.result.current).toBe(false);
    view.unmount();
  });

  it('keeps listening when its first post fails', async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class extends FakeBroadcastChannel {
        override postMessage(): void {
          throw new DOMException('Not allowed.', 'SecurityError');
        }
      }
    );
    const view = mount(1);
    await settle();
    expect(view.result.current).toBe(false);

    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    mount(2);
    await settle();
    expect(view.result.current).toBe(true);
  });

  it('carries on when its answer fails to post', async () => {
    const newer = mount(2);
    const [channel] = FakeBroadcastChannel.open;
    const post = vi.fn(() => {
      throw new DOMException('Not allowed.', 'SecurityError');
    });
    if (channel) channel.postMessage = post;

    mount(1);
    await settle();
    expect(post).toHaveBeenCalledOnce();
    expect(newer.result.current).toBe(false);
  });

  it('carries on when closing the channel fails', () => {
    const view = mount(1);
    const [channel] = FakeBroadcastChannel.open;
    const close = vi.fn(() => {
      throw new DOMException('Not allowed.', 'SecurityError');
    });
    if (channel) channel.close = close;

    expect(() => view.unmount()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it('posts its stamp once it has one, and closes the channel on unmount', async () => {
    const view = mount(5);
    const [channel] = FakeBroadcastChannel.open;
    expect(channel?.name).toBe(VIEWS_CHANNEL);
    expect(channel?.posted).toEqual([
      { key: ISSUES, at: 5, id: expect.any(String) },
    ]);

    view.unmount();
    expect(FakeBroadcastChannel.open.size).toBe(0);
  });

  it('stays retired', async () => {
    const older = mount(1);
    const newer = mount(2);
    await settle();
    newer.unmount();
    older.rerender();
    expect(older.result.current).toBe(true);
  });
});
