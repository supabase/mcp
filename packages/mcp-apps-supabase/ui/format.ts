// Ported from Studio's components/ui/Charts/Charts.utils.tsx (dayjs replaced
// by Intl).

/** `123` -> "123", `123.123` -> "123.12". */
export const numberFormatter = (num: number, precision = 2) =>
  isFloat(num) ? precisionFormatter(num, precision) : num.toLocaleString();

export const isFloat = (num: number) => String(num).includes('.');

/** `0.00123` with precision 2 -> "<0.01". */
export const precisionFormatter = (num: number, precision: number): string => {
  if (precision === 0) return String(Math.round(num));
  const threshold = 1 / 10 ** precision;
  if (num > 0 && num < threshold) return `<${threshold.toFixed(precision)}`;
  if (num < 0 && num > -threshold) return `>-${threshold.toFixed(precision)}`;
  if (isFloat(num)) {
    const [head = '0', tail = ''] = String(num).split('.');
    return `${Number(head).toLocaleString()}.${tail.slice(0, precision)}`;
  }
  return `${num.toLocaleString()}.${'0'.repeat(precision)}`;
};

/** `1500` -> "1.5K". Keeps Y-axis ticks short. */
export const compactNumberFormatter = (num: number): string =>
  new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(num);

/** `1234.56` -> "1,235ms". */
export const millisecondFormatter = (value: number, precision = 0) => {
  if (!Number.isFinite(value)) return '0ms';
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })}ms`;
};

/** `99.99` -> "99.99%", `100` -> "100%". */
export const formatPercentage = (value: number, precision = 2) => {
  if (Math.abs(value - 100) < 1e-6) return '100%';
  if (Number.isInteger(value)) return `${value}%`;
  const formatted = precisionFormatter(value, precision);
  if (formatted.startsWith('<') || formatted.startsWith('>')) {
    return `${formatted}%`;
  }
  if (formatted.includes('.')) {
    const [head, tail = ''] = formatted.split('.');
    return `${head}.${tail.padEnd(precision, '0')}%`;
  }
  return `${formatted}%`;
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const timeTickFormatter = (value: string) =>
  timeFormat.format(new Date(value));

export const timestampFormatter = (value: string) =>
  dateTimeFormat.format(new Date(value));
