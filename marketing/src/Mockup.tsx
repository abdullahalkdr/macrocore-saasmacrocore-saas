import type { ReactNode } from 'react';
import type { MockupKind } from './content';

// CSS-drawn stand-ins for real product screenshots — keeps the marketing site
// dependency-free (no image assets to manage yet) while still giving each
// section the "here's the actual app" visual weight sites like Wafeq use.
function Chrome({ children }: { children: ReactNode }) {
  return (
    <div className="mk-window">
      <div className="mk-window-bar">
        <span />
        <span />
        <span />
      </div>
      <div className="mk-window-body">{children}</div>
    </div>
  );
}

function Bar({ w, tone = 'light' }: { w: number; tone?: 'light' | 'amber' | 'dark' }) {
  return <div className={`mk-bar mk-bar-${tone}`} style={{ width: `${w}%` }} />;
}

export function DashboardMockup() {
  return (
    <Chrome>
      <div className="mk-mock-dash">
        <div className="mk-mock-sidebar">
          <div className="mk-mock-dot" />
          {[70, 55, 65, 45, 60].map((w, i) => (
            <Bar key={i} w={w} tone={i === 0 ? 'amber' : 'light'} />
          ))}
        </div>
        <div className="mk-mock-main">
          <div className="mk-mock-cards">
            {[0, 1, 2].map((i) => (
              <div className="mk-mock-card" key={i}>
                <Bar w={50} />
                <div className="mk-mock-card-num" />
              </div>
            ))}
          </div>
          <div className="mk-mock-chart">
            {[40, 65, 30, 80, 55, 90, 45].map((h, i) => (
              <div key={i} className="mk-mock-chart-bar" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>
    </Chrome>
  );
}

export function InventoryMockup() {
  return (
    <Chrome>
      <div className="mk-mock-table">
        <div className="mk-mock-table-head">
          <Bar w={20} tone="dark" />
          <Bar w={15} tone="dark" />
          <Bar w={15} tone="dark" />
          <Bar w={15} tone="dark" />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div className="mk-mock-table-row" key={i}>
            <Bar w={30} />
            <Bar w={18} />
            <Bar w={18} />
            <span className={`mk-mock-pill ${i === 2 ? 'mk-mock-pill-warn' : ''}`} />
          </div>
        ))}
      </div>
    </Chrome>
  );
}

export function PayrollMockup() {
  return (
    <Chrome>
      <div className="mk-mock-payroll">
        <div className="mk-mock-payroll-summary">
          <div className="mk-mock-payroll-box">
            <Bar w={60} />
            <div className="mk-mock-card-num mk-mock-card-num-sm" />
          </div>
          <div className="mk-mock-payroll-box">
            <Bar w={60} />
            <div className="mk-mock-card-num mk-mock-card-num-sm" />
          </div>
        </div>
        {[0, 1, 2].map((i) => (
          <div className="mk-mock-payroll-row" key={i}>
            <Bar w={35} />
            <Bar w={12} tone="amber" />
          </div>
        ))}
      </div>
    </Chrome>
  );
}

export function ReportsMockup() {
  return (
    <Chrome>
      <div className="mk-mock-reports">
        <div className="mk-mock-chart mk-mock-chart-tall">
          {[30, 55, 40, 70, 50, 85, 60, 90].map((h, i) => (
            <div key={i} className="mk-mock-chart-bar" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="mk-mock-reports-list">
          {[0, 1, 2, 3].map((i) => (
            <div className="mk-mock-reports-row" key={i}>
              <Bar w={40} />
              <Bar w={15} tone={i === 0 ? 'amber' : 'light'} />
            </div>
          ))}
        </div>
      </div>
    </Chrome>
  );
}

const MAP: Record<MockupKind, () => JSX.Element> = {
  inventory: InventoryMockup,
  payroll: PayrollMockup,
  reports: ReportsMockup,
};

export default function Mockup({ kind }: { kind: MockupKind }) {
  const Component = MAP[kind];
  return <Component />;
}
