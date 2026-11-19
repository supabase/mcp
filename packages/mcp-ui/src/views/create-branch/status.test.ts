import { describe, expect, it } from 'vitest';
import type { Progress } from '../../shared/use-creation-status';
import { progress } from './status';

type Status = Parameters<typeof progress>[0];

const cases: [Status, Progress][] = [
  ['CREATING_PROJECT', { state: 'step', step: 1 }],
  ['RUNNING_MIGRATIONS', { state: 'step', step: 2 }],
  ['MIGRATIONS_FAILED', { state: 'failed', step: 2 }],
  ['MIGRATIONS_PASSED', { state: 'step', step: 3 }],
  ['FUNCTIONS_FAILED', { state: 'failed', step: 3 }],
  ['FUNCTIONS_DEPLOYED', { state: 'done' }],
];

describe('create-branch status', () => {
  it.each(cases)('%s', (status, expected) => {
    expect(progress(status)).toEqual(expected);
  });

  it('treats an unknown status as the first step', () => {
    expect(progress('SOMETHING_NEW' as Status)).toEqual({
      state: 'step',
      step: 1,
    });
  });
});
