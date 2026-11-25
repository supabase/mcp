import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapUntrusted } from '../../shared/test-utils';
import { ShowRow } from './ShowRow';

const { callTool, host } = vi.hoisted(() => ({
  callTool: vi.fn(),
  host: {
    toolCall: { status: 'loading' } as
      | { status: 'loading' }
      | { status: 'ready'; data: unknown }
      | { status: 'error'; message: string },
    input: undefined as Record<string, unknown> | undefined,
    canCallTools: true,
  },
}));

vi.mock('../../shared/use-mcp-view', () => ({
  useMcpView: () => ({
    toolCall: host.toolCall,
    input: host.input,
    callTool: host.canCallTools ? callTool : undefined,
    inputText: (key: string) => {
      const value = host.input?.[key];
      return typeof value === 'string' ? value : undefined;
    },
  }),
}));

const column = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  format: 'text',
  data_type: 'text',
  nullable: true,
  default_value: null,
  identity: false,
  generated: false,
  updatable: true,
  enums: [],
  ...extra,
});

const TABLE = {
  schema: 'public',
  name: 'orders',
  primary_keys: ['id'],
  editable: true,
  columns: [
    column('id', { format: 'int8', nullable: false, identity: true }),
    column('note'),
    column('paid', { format: 'bool', nullable: false }),
  ],
};
const ROW = { id: 42, note: 'Gift wrap', paid: false };

const field = (name: string) =>
  screen.getByLabelText(name, { selector: 'input, select, textarea' }) as
    | HTMLInputElement
    | HTMLSelectElement;

beforeEach(() => {
  callTool.mockReset();
  host.toolCall = { status: 'ready', data: { table: TABLE, row: ROW } };
  host.input = { project_id: 'abcdefghijklmnopqrst', table: 'orders', key: {} };
  host.canCallTools = true;
});
afterEach(cleanup);

describe('ShowRow', () => {
  it('shows each column, with the key locked and the rest editable', () => {
    render(<ShowRow />);

    expect(screen.getByRole('heading').textContent).toBe(
      'Edit row in public.orders'
    );
    expect(field('id (primary key)').value).toBe('42');
    expect(field('id (primary key)').disabled).toBe(true);
    expect(field('note').value).toBe('Gift wrap');
    expect(field('note').disabled).toBe(false);
    expect(field('paid').value).toBe('false');
    expect(screen.getByText('0 fields changed')).toBeTruthy();
  });

  it('saves only the changed field through execute_sql and shows the stored row', async () => {
    callTool.mockResolvedValue({
      result: wrapUntrusted([{ ...ROW, note: 'No wrap' }]),
    });
    render(<ShowRow />);

    fireEvent.change(field('note'), { target: { value: 'No wrap' } });
    expect(screen.getByText('1 field changed')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    );

    expect(callTool).toHaveBeenCalledWith('execute_sql', {
      project_id: 'abcdefghijklmnopqrst',
      query: `update "public"."orders" set "note" = E'No wrap' where "id" = E'42' returning *;`,
    });
    expect(screen.getByRole('status').textContent).toBe('Row saved');
    expect(screen.getByText('0 fields changed')).toBeTruthy();
  });

  it('writes NULL when a nullable field is switched to NULL', async () => {
    callTool.mockResolvedValue({
      result: wrapUntrusted([{ ...ROW, note: null }]),
    });
    render(<ShowRow />);

    fireEvent.change(field('note value mode'), { target: { value: 'null' } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    );
    expect(callTool.mock.calls[0]![1].query).toContain('set "note" = NULL');
  });

  it('keeps edits and explains when saving fails', async () => {
    callTool.mockRejectedValue(new Error('permission denied for table orders'));
    render(<ShowRow />);

    fireEvent.change(field('note'), { target: { value: 'No wrap' } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    );
    expect(screen.getByText('Failed to save row')).toBeTruthy();
    expect(screen.getByText('permission denied for table orders')).toBeTruthy();
    expect(field('note').value).toBe('No wrap');
  });

  it('asks before discarding edits', () => {
    render(<ShowRow />);

    fireEvent.change(field('note'), { target: { value: 'No wrap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset changes' }));
    expect(screen.getByText('Discard your unsaved changes?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(field('note').value).toBe('Gift wrap');
  });

  it('opens read-only where the server says the row can’t change', () => {
    host.toolCall = {
      status: 'ready',
      data: { table: { ...TABLE, editable: false }, row: ROW },
    };
    render(<ShowRow />);

    expect(field('note').disabled).toBe(true);
    expect(screen.getByText('This row is read-only.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('refreshes the row by its key, only while there are no edits', async () => {
    callTool.mockResolvedValue({
      result: wrapUntrusted([{ ...ROW, note: 'Changed elsewhere' }]),
    });
    render(<ShowRow />);

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Refresh row' }))
    );
    expect(callTool.mock.calls[0]![1].query).toBe(
      `select * from "public"."orders" where "id" = E'42' limit 1;`
    );
    expect(field('note').value).toBe('Changed elsewhere');

    fireEvent.change(field('note'), { target: { value: 'Mine' } });
    expect(screen.getByRole('button', { name: 'Refresh row' })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('says why when the row could not be read', () => {
    host.toolCall = {
      status: 'error',
      message: 'No row in public.orders has that key.',
    };
    render(<ShowRow />);

    expect(screen.getByText('Failed to load row')).toBeTruthy();
    expect(
      screen.getByText('Error: No row in public.orders has that key.')
    ).toBeTruthy();
  });
});
