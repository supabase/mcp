import { describe, expect, it } from 'vitest';
import { progress } from './status';

describe('create-project status', () => {
  it.each(['REMOVED', 'INIT_FAILED', 'RESTORE_FAILED', 'UPGRADE_FAILED'])(
    '%s fails the creating step',
    (status) =>
      expect(progress(status)).toEqual({ state: 'failed', during: 'Creating' })
  );

  it.each(['COMING_UP', 'UNKNOWN'])('%s is creating', (status) =>
    expect(progress(status)).toEqual({
      state: 'step',
      label: 'Creating',
      step: 2,
      of: 3,
    })
  );

  it('ACTIVE_UNHEALTHY is checking health', () => {
    expect(progress('ACTIVE_UNHEALTHY')).toEqual({
      state: 'step',
      label: 'Checking health',
      step: 3,
      of: 3,
    });
  });

  it('ACTIVE_HEALTHY is done', () => {
    expect(progress('ACTIVE_HEALTHY')).toEqual({ state: 'done' });
  });

  // Statuses a new project shouldn't reach: shown with Studio's label, and
  // neutral while they're still changing.
  it.each([
    ['INACTIVE', 'Paused', false],
    ['PAUSING', 'Pausing', true],
    ['RESTARTING', 'Restarting', true],
  ])('%s shows as %s', (status, label, isChanging) =>
    expect(progress(status)).toEqual({
      state: 'other',
      label,
      tone: undefined,
      isChanging,
    })
  );
});
