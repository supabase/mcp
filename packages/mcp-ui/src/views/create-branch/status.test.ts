import { describe, expect, it } from 'vitest';
import type { Progress } from '../../shared/use-creation-status';
import { progress } from './status';

type Status = Parameters<typeof progress>[0];

const cases: [Status, Progress][] = [
  ['CREATING_PROJECT', { state: 'step', label: 'Creating', step: 2, of: 4 }],
  [
    'RUNNING_MIGRATIONS',
    { state: 'step', label: 'Running migrations', step: 3, of: 4 },
  ],
  ['MIGRATIONS_FAILED', { state: 'failed', during: 'Running migrations' }],
  [
    'MIGRATIONS_PASSED',
    { state: 'step', label: 'Deploying functions', step: 4, of: 4 },
  ],
  ['FUNCTIONS_FAILED', { state: 'failed', during: 'Deploying functions' }],
  ['FUNCTIONS_DEPLOYED', { state: 'done' }],
];

describe('create-branch status', () => {
  it.each(cases)('%s', (status, expected) => {
    expect(progress(status)).toEqual(expected);
  });

  it('treats an unknown status as the first step', () => {
    expect(progress('SOMETHING_NEW' as Status)).toEqual({
      state: 'step',
      label: 'Creating',
      step: 2,
      of: 4,
    });
  });
});
