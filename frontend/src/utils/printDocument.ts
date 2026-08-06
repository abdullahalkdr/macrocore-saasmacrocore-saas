// Shared print/PDF utility for all Sales documents (quotes, invoices, credit notes,
// cash invoices) — same window.open + document.write + print() pattern already
// established by PayrollPage.tsx's printPayslip(). No PDF library in the codebase;
// the browser's native print dialog offers "Save as PDF", which is what the Wafeq
// reference screenshots show being used.
export interface PrintItem {
  description: string;
  qty: number;
  unitPrice: number;
  discountPct?: number;
}

export interface PrintDocumentLabels {
  billTo: string;
  description: string;
  qty: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
  subtotal: string;
  total: string;
  notes: string;
  due: string;
}

export interface PrintDocumentOptions {
  companyName: string;
  docTypeLabel: string;
  number: string;
  date: string;
  dueDate?: string | null;
  customerName: string;
  items: PrintItem[];
  notes?: string | null;
  statusLabel?: string;
  labels: PrintDocumentLabels;
  dir?: 'rtl' | 'ltr';
  lang?: string;
}

function lineTotal(it: PrintItem) {
  return (it.qty || 0) * (it.unitPrice || 0) * (1 - (it.discountPct || 0) / 100);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function printDocument(opts: PrintDocumentOptions) {
  const win = window.open('', '_blank');
  if (!win) return;

  const dir = opts.dir || 'rtl';
  const lang = opts.lang || 'ar';
  const hasDiscount = opts.items.some((it) => (it.discountPct || 0) > 0);
  const subtotal = opts.items.reduce((sum, it) => sum + (it.qty || 0) * (it.unitPrice || 0), 0);
  const total = opts.items.reduce((sum, it) => sum + lineTotal(it), 0);
  const start = dir === 'rtl' ? 'right' : 'left';
  const end = dir === 'rtl' ? 'left' : 'right';

  const rowsHtml = opts.items
    .map(
      (it) => `
        <tr>
          <td>${escapeHtml(it.description)}</td>
          <td class="num">${it.qty}</td>
          <td class="num">${(it.unitPrice || 0).toFixed(3)}</td>
          ${hasDiscount ? `<td class="num">${it.discountPct ? `${it.discountPct}%` : '—'}</td>` : ''}
          <td class="num">${lineTotal(it).toFixed(3)}</td>
        </tr>`
    )
    .join('');

  win.document.write(`
    <!DOCTYPE html>
    <html dir="${dir}" lang="${lang}">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(opts.docTypeLabel)} ${escapeHtml(opts.number)}</title>
      <style>
        body { font-family: 'Tajawal', Arial, sans-serif; padding: 40px; color: #1c1917; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #F5A623; padding-bottom: 12px; margin-bottom: 24px; }
        h1 { font-size: 18px; margin: 0 0 6px; }
        .meta { color: #57534e; font-size: 12px; margin-top: 2px; }
        .doc-title { font-size: 20px; font-weight: 800; margin: 0 0 4px; text-align: ${end}; }
        .side { text-align: ${end}; }
        .status { display: inline-block; padding: 3px 10px; border-radius: 100px; font-size: 11px; font-weight: 700; background: #f5f5f4; color: #57534e; margin-top: 6px; }
        table { width: 100%; border-collapse: collapse; margin-top: 18px; }
        th { text-align: ${start}; font-size: 11px; color: #57534e; padding: 6px 4px; border-bottom: 1px solid #1c1917; }
        th.num, td.num { text-align: ${end}; }
        td { padding: 8px 4px; border-bottom: 1px solid #e7e5e4; font-size: 13px; }
        .totals { margin-top: 14px; margin-inline-start: auto; max-width: 260px; }
        .totals .row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; }
        .totals .row.total { font-weight: 800; font-size: 15px; border-top: 1px solid #1c1917; margin-top: 4px; padding-top: 8px; }
        @media print { body { padding: 0; } }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h1>${escapeHtml(opts.companyName)}</h1>
          <div class="meta">${escapeHtml(opts.labels.billTo)}: ${escapeHtml(opts.customerName || '—')}</div>
        </div>
        <div class="side">
          <div class="doc-title">${escapeHtml(opts.docTypeLabel)}</div>
          <div class="meta">${escapeHtml(opts.number)}</div>
          <div class="meta">${escapeHtml(opts.date)}</div>
          ${opts.dueDate ? `<div class="meta">${escapeHtml(opts.labels.due)}: ${escapeHtml(opts.dueDate)}</div>` : ''}
          ${opts.statusLabel ? `<div class="status">${escapeHtml(opts.statusLabel)}</div>` : ''}
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(opts.labels.description)}</th>
            <th class="num">${escapeHtml(opts.labels.qty)}</th>
            <th class="num">${escapeHtml(opts.labels.unitPrice)}</th>
            ${hasDiscount ? `<th class="num">${escapeHtml(opts.labels.discount)}</th>` : ''}
            <th class="num">${escapeHtml(opts.labels.lineTotal)}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="totals">
        ${hasDiscount ? `<div class="row"><span>${escapeHtml(opts.labels.subtotal)}</span><span>${subtotal.toFixed(3)} KD</span></div>` : ''}
        <div class="row total"><span>${escapeHtml(opts.labels.total)}</span><span>${total.toFixed(3)} KD</span></div>
      </div>
      ${
        opts.notes
          ? `<div style="margin-top: 20px;"><div class="meta" style="margin-bottom: 4px;">${escapeHtml(opts.labels.notes)}</div><div style="font-size: 13px;">${escapeHtml(opts.notes)}</div></div>`
          : ''
      }
    </body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
}
