import './button.css';
import './row-editor.css';

import { useId, useRef, useState } from 'react';

import { Admonition } from './Admonition';
import { Select } from './Select';
import {
  KeyRoundIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  SpinnerIcon,
} from './icons';
import {
  buildRowValues,
  canEditColumn,
  initialRowDraft,
  isFieldChanged,
  isJsonColumn,
  isRowWritable,
  type FieldDraft,
  type FieldMode,
  type RowColumn,
  type RowTable,
} from './row-values';
import type { Row } from './sql-result';

/** Saves the changed `values` and resolves with the row as stored. */
export type SaveRow = (values: Row) => Promise<Row>;
/** Reads the row again. */
export type ReloadRow = () => Promise<Row>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One column's field, after `RowField` in the Supabase surfaces. */
function RowField({
  id,
  column,
  field,
  isPrimaryKey,
  isEditable,
  isBusy,
  onChange,
}: {
  id: string;
  column: RowColumn;
  field: FieldDraft;
  isPrimaryKey: boolean;
  isEditable: boolean;
  isBusy: boolean;
  onChange: (value: Partial<FieldDraft>) => void;
}) {
  const isDisabled = !isEditable || isBusy || field.mode !== 'value';
  const options =
    column.format === 'bool' ? ['true', 'false'] : (column.enums ?? []);
  const canChooseMode = isEditable && column.nullable;

  return (
    <div data-slot="field">
      <div data-slot="field-header">
        <label data-slot="field-label" htmlFor={id}>
          {isPrimaryKey && <KeyRoundIcon slot="field-key" size={12} />}
          <span data-slot="field-name">{column.name}</span>
          {isPrimaryKey && <span className="sr-only">{' (primary key)'}</span>}
        </label>
        <span data-slot="field-format">
          {column.format}
          {!isEditable && (
            <>
              <LockKeyholeIcon size={12} />
              <span className="sr-only">Not editable</span>
            </>
          )}
        </span>
      </div>
      <div data-slot="field-control">
        {options.length > 0 ? (
          <Select
            id={id}
            slot="value"
            value={field.raw}
            options={options.map((option) => ({
              value: option,
              label: option,
            }))}
            disabled={isDisabled}
            onChange={(raw) => onChange({ raw })}
          />
        ) : isJsonColumn(column) ? (
          <textarea
            id={id}
            data-slot="json"
            spellCheck={false}
            value={field.raw}
            disabled={isDisabled}
            onChange={(event) => onChange({ raw: event.target.value })}
          />
        ) : (
          <input
            id={id}
            data-slot="input"
            value={field.raw}
            disabled={isDisabled}
            onChange={(event) => onChange({ raw: event.target.value })}
          />
        )}
        {canChooseMode && (
          <Select
            slot="mode"
            label={`${column.name} value mode`}
            value={field.mode}
            options={[
              { value: 'value', label: 'Value' },
              { value: 'null', label: 'NULL' },
            ]}
            disabled={isBusy}
            onChange={(mode) => onChange({ mode: mode as FieldMode })}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One table row, editable in place: the row panel of the Supabase surfaces
 * (RowPanel with its RowEditorForm). A header names the row and refreshes
 * it; a field per column, with the primary key marked and columns that
 * can't change locked; a footer counts changes and saves or resets them,
 * asking before it discards edits.
 */
export function RowEditor({
  table,
  row: initialRow,
  readOnly = false,
  onSave,
  onReload,
}: {
  table: RowTable;
  row: Row;
  /** Shows the row without letting it change, e.g. when the host can't call tools. */
  readOnly?: boolean;
  onSave?: SaveRow;
  onReload?: ReloadRow;
}) {
  const id = useId();
  const [row, setRow] = useState(initialRow);
  const [initial, setInitial] = useState(() => initialRowDraft(table, row));
  const [draft, setDraft] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [notice, setNotice] = useState('');
  const [isConfirmingDiscard, setIsConfirmingDiscard] = useState(false);
  const lock = useRef(false);

  const isWritable = isRowWritable(
    table,
    readOnly || !onSave || isLoading,
    row
  );
  const changedColumns = table.columns.filter((column) =>
    isFieldChanged(draft[column.name], initial[column.name])
  );
  const isDirty = changedColumns.length > 0;
  const isBusy = isSaving || isLoading;

  /** Starts the form over from `next`, the row as stored. */
  function reset(next: Row) {
    const fresh = initialRowDraft(table, next);
    setRow(next);
    setInitial(fresh);
    setDraft(fresh);
    setIsConfirmingDiscard(false);
  }

  async function save() {
    if (lock.current || !isWritable || !onSave) return;
    lock.current = true;
    setIsSaving(true);
    setError('');
    setNotice('');
    try {
      const values = buildRowValues(table, draft, changedColumns, isWritable);
      if (Object.keys(values).length === 0) return;
      reset(await onSave(values));
      setNotice('Row saved');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setIsSaving(false);
    }
  }

  async function refresh() {
    if (!onReload || isDirty || lock.current) return;
    lock.current = true;
    setIsLoading(true);
    setRefreshError('');
    setNotice('');
    try {
      reset(await onReload());
      setNotice('Row refreshed');
    } catch (e) {
      setRefreshError(errorMessage(e));
    } finally {
      lock.current = false;
      setIsLoading(false);
    }
  }

  const title = `Edit row in ${table.schema}.${table.name}`;
  const summary = `${changedColumns.length} ${changedColumns.length === 1 ? 'field' : 'fields'} changed`;

  return (
    <section className="row-editor" aria-label={title} aria-busy={isBusy}>
      <header data-slot="header">
        <h2 data-slot="title" title={title}>
          {title}
        </h2>
        {onReload && (
          <button
            type="button"
            data-slot="refresh"
            aria-label="Refresh row"
            title="Refresh row"
            disabled={isBusy || isDirty}
            onClick={() => void refresh()}
          >
            {isLoading ? (
              <SpinnerIcon size={15} />
            ) : (
              <RefreshCwIcon size={15} />
            )}
          </button>
        )}
      </header>
      {notice && (
        <p data-slot="notice" role="status">
          {notice}
        </p>
      )}
      {refreshError && (
        <div data-slot="banner">
          <Admonition
            type="warning"
            title="Failed to refresh row"
            description={`Error: ${refreshError}`}
          />
        </div>
      )}
      <form
        data-slot="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div data-slot="fields">
          {table.columns.map((column) => (
            <RowField
              key={column.name}
              id={`${id}-${column.name}`}
              column={column}
              field={draft[column.name]!}
              isPrimaryKey={table.primary_keys.includes(column.name)}
              isEditable={canEditColumn(table, column, isWritable)}
              isBusy={isBusy}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  [column.name]: { ...current[column.name]!, ...value },
                }))
              }
            />
          ))}
        </div>
        {error && (
          <div data-slot="error">
            <Admonition
              type="destructive"
              title="Failed to save row"
              description={error}
            />
          </div>
        )}
        {!isWritable ? (
          <p data-slot="footer" data-state="read-only">
            This row is read-only.
          </p>
        ) : isConfirmingDiscard ? (
          <div data-slot="footer" role="alert">
            <p data-slot="footer-question">Discard your unsaved changes?</p>
            <button
              type="button"
              data-size="sm"
              onClick={() => setIsConfirmingDiscard(false)}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="danger"
              data-size="sm"
              onClick={() => reset(row)}
            >
              Discard changes
            </button>
          </div>
        ) : (
          <div data-slot="footer">
            <span data-slot="footer-summary">{summary}</span>
            <button
              type="button"
              data-size="sm"
              disabled={isBusy}
              onClick={() => {
                if (isDirty) {
                  setIsConfirmingDiscard(true);
                } else {
                  reset(row);
                  setNotice('');
                }
              }}
            >
              Reset changes
            </button>
            <button
              type="submit"
              className="primary"
              data-size="sm"
              disabled={isBusy || !isDirty}
            >
              {isSaving && <SpinnerIcon size={14} />}
              {isSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
