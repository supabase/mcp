import { describe, expect, it } from 'vitest';
import { stepsAt } from '../../shared/StepStatus';
import { isTerminal, LABELS, progress } from './status';

type Status = Parameters<typeof progress>[0];

const states = (status: Status) => {
  const { step, failed } = progress(status);
  return stepsAt(LABELS, step, failed).map((s) => s.state);
};

const cases: [Status, string[], boolean][] = [
  ['CREATING_PROJECT', ['done', 'active', 'pending', 'pending'], false],
  ['RUNNING_MIGRATIONS', ['done', 'done', 'active', 'pending'], false],
  ['MIGRATIONS_FAILED', ['done', 'done', 'failed', 'pending'], true],
  ['MIGRATIONS_PASSED', ['done', 'done', 'done', 'active'], false],
  ['FUNCTIONS_FAILED', ['done', 'done', 'done', 'failed'], true],
  ['FUNCTIONS_DEPLOYED', ['done', 'done', 'done', 'done'], true],
];

describe('create-branch status', () => {
  it.each(cases)('%s', (status, expectedStates, terminal) => {
    expect(states(status)).toEqual(expectedStates);
    expect(isTerminal(status)).toBe(terminal);
  });

  it('treats an unknown status as the first provisioning step', () => {
    expect(progress('SOMETHING_NEW' as Status)).toEqual({
      step: 1,
      failed: false,
    });
    expect(isTerminal('SOMETHING_NEW' as Status)).toBe(false);
  });
});
