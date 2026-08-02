// Generic "array of rows -> downloadable CSV" helper, reused by any list page that
// wants an export button (Expenses, Payroll, etc.) — same UTF-8 BOM + Blob download
// approach ReportsPage.tsx already used for its single-report summary export.
export function exportRowsToCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers, ...rows].map((row) => row.map((cell) => JSON.stringify(String(cell))).join(','));
  const csv = lines.join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
