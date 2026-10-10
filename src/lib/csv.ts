/**
 * A CSV file Excel and Google Sheets open correctly: a byte-order mark so Arabic names survive, quoted cells where
 * needed, and cells starting with = + - @ prefixed with ' so a spreadsheet never runs them as formulas.
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
