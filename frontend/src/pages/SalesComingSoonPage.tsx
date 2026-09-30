import { ReactNode } from 'react';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import { IconReceipt, IconRepeat, IconUndo, IconExpense, IconSettings } from '../components/Icon';

type Variant = 'customerReceipts' | 'recurringInvoices' | 'creditNotes' | 'cashInvoices' | 'salesSettings';

const ICONS: Record<Variant, ReactNode> = {
  customerReceipts: <IconReceipt size={26} />,
  recurringInvoices: <IconRepeat size={26} />,
  creditNotes: <IconUndo size={26} />,
  cashInvoices: <IconExpense size={26} />,
  salesSettings: <IconSettings size={26} />,
};

// Shared stub for the Sales sub-sections that aren't built yet (customer receipts,
// recurring invoices, credit notes, cash invoices, sales settings) — kept in the nav
// submenu so the full Wafeq-style section list is there from day one, but each opens
// to an honest "not built yet" page instead of a broken route. Same visual language as
// account/SetupSection.tsx's placeholder tiles.
export default function SalesComingSoonPage({ variant }: { variant: Variant }) {
  const t = useT();
  const title = t.salesDocs[`${variant}Title`];
  const subtitle = t.salesDocs[`${variant}Subtitle`];
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="card" style={{ opacity: 0.75 }}>
        <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)', display: 'flex', flexShrink: 0 }} aria-hidden="true">{ICONS[variant]}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {title} <span className="badge closed">{t.account.comingSoon}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{t.salesDocs.comingSoonHint}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
