import { describe, expect, it } from 'vitest';
import { stepsAt } from '../../shared/StepStatus';
import { currentStep, isFailed, LABELS } from './status';

const states = (status: string) =>
  stepsAt(LABELS, currentStep(status), isFailed(status)).map((s) => s.state);

describe('create-project status', () => {
  it.each(['REMOVED', 'INIT_FAILED', 'RESTORE_FAILED', 'UPGRADE_FAILED'])(
    '%s is failed',
    (status) => {
      expect(isFailed(status)).toBe(true);
      expect(states(status)).toEqual(['done', 'failed', 'pending']);
    }
  );

  it.each(['COMING_UP', 'UNKNOWN'])('%s is provisioning', (status) => {
    expect(isFailed(status)).toBe(false);
    expect(states(status)).toEqual(['done', 'active', 'pending']);
  });

  it.each(['ACTIVE_UNHEALTHY', 'INACTIVE', 'PAUSING', 'RESTARTING'])(
    '%s is running health checks',
    (status) => {
      expect(isFailed(status)).toBe(false);
      expect(states(status)).toEqual(['done', 'done', 'active']);
    }
  );

  it('ACTIVE_HEALTHY has every step done', () => {
    expect(isFailed('ACTIVE_HEALTHY')).toBe(false);
    expect(states('ACTIVE_HEALTHY')).toEqual(['done', 'done', 'done']);
  });
});
