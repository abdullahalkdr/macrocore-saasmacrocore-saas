// Exact icon set (Lucide-style, stroke-based) carried over from the CornLab kiosk app
// so macrocore's UI reads as the same visual family. Icons.plus/edit/trash/etc there
// were raw SVG strings injected via innerHTML; here they're just small components.
interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
}) as const;

export const IconPlus = ({ size = 13 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.5} strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconEdit = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

// MIGRATION_059 — ticket/reply attachments: the "attach a file" action
// (paperclip) and the generic-document chip icon for a non-image attachment
// (an image attachment renders as an actual thumbnail instead, no icon needed).
export const IconPaperclip = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
  </svg>
);

export const IconFile = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

export const IconTrash = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z" />
  </svg>
);

// Reopening a closed accounting period (PeriodClosingPage.tsx) is a distinct
// action from deleting a row -- reusing IconTrash there read as "delete this
// period record" to accountants, when it actually un-locks retroactive edits.
// Same lucide "unlock" glyph shape as the rest of this stroke-based set.
export const IconUnlock = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 019.9-1" />
  </svg>
);

export const IconBuilding = ({ size = 26 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 21h18M6 21V7l6-4 6 4v14M10 21v-6h4v6" />
  </svg>
);

export const IconEye = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
    <circle cx={12} cy={12} r={3} />
  </svg>
);

export const IconDashboard = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x={3} y={3} width={7} height={9} rx={1} />
    <rect x={14} y={3} width={7} height={5} rx={1} />
    <rect x={14} y={12} width={7} height={9} rx={1} />
    <rect x={3} y={16} width={7} height={5} rx={1} />
  </svg>
);

export const IconProduct = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 8L12 3 3 8l9 5 9-5z" />
    <path d="M3 8v8l9 5 9-5V8M12 13v8" />
  </svg>
);

export const IconSales = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 3 3 5-6" />
  </svg>
);

export const IconExpense = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x={2} y={6} width={20} height={12} rx={2} />
    <circle cx={12} cy={12} r={2.5} />
    <path d="M6 6v-.5A1.5 1.5 0 017.5 4h9A1.5 1.5 0 0118 5.5V6" />
  </svg>
);

export const IconEmployee = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx={12} cy={8} r={4} />
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
  </svg>
);

export const IconAttendance = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx={12} cy={12} r={9} />
    <path d="M12 7v5l3 3" />
  </svg>
);

export const IconPayroll = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <rect x={3} y={5} width={18} height={14} rx={2} />
    <path d="M3 10h18M7 15h4" />
  </svg>
);

export const IconReports = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 19V5M4 19h16M8 19v-6M13 19V9M18 19v-4" />
  </svg>
);

export const IconSettings = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx={12} cy={12} r={3} />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);

export const IconClose = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export const IconLogout = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
);

export const IconBell = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
  </svg>
);

export const IconChevronRight = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l6-6-6-6" />
  </svg>
);

export const IconMenu = ({ size = 20 }: IconProps) => (
  <svg {...base(size)} strokeLinecap="round">
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);

export const IconPrinter = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z" />
  </svg>
);

export const IconWarning = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01" />
  </svg>
);

export const IconEyeOff = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a19.7 19.7 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a19.6 19.6 0 01-2.16 3.19M14.12 14.12a3 3 0 11-4.24-4.24" />
    <path d="M1 1l22 22" />
  </svg>
);

// Approval Workflow Engine (MIGRATION_055) — a check-in-a-shield reads as "governance /
// sign-off" better than a plain checkmark, matching Payroll/Settings' use of a
// recognizable pictogram rather than a generic icon.
export const IconApproval = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

// Polish Batch 4 — stroke icons replacing the emoji that were used as icons.
// Same lucide-style 24px stroke set as above; aria-hidden because every use is
// decorative (the button/label next to it carries the accessible name).
const deco = { 'aria-hidden': true, focusable: false } as const;

export const IconSun = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round">
    <circle cx={12} cy={12} r={4} />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

export const IconMoon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a6 6 0 009 9 9 9 0 11-9-9z" />
  </svg>
);

export const IconKey = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <circle cx={7.5} cy={15.5} r={5.5} />
    <path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
  </svg>
);

export const IconStore = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l1.5-5h15L21 9M3 9h18M4 9v11a1 1 0 001 1h14a1 1 0 001-1V9M9 21v-6h6v6" />
  </svg>
);

export const IconUsers = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <circle cx={9} cy={7} r={4} />
    <path d="M2 21v-2a4 4 0 014-4h6a4 4 0 014 4v2M16 3.13a4 4 0 010 7.75M22 21v-2a4 4 0 00-3-3.87" />
  </svg>
);

export const IconCard = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round">
    <rect x={2} y={5} width={20} height={14} rx={2} />
    <path d="M2 10h20M6 15h4" />
  </svg>
);

export const IconMail = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <rect x={2} y={4} width={20} height={16} rx={2} />
    <path d="M22 7l-10 6L2 7" />
  </svg>
);

export const IconReceipt = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

export const IconRepeat = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 2l4 4-4 4M3 11v-1a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 01-4 4H3" />
  </svg>
);

// Directional: mirrors under dir="rtl" via .icon-flip-rtl (styles.css) so the
// "go back" arrow points toward the reading start in both languages.
export const IconUndo = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} className="icon-flip-rtl" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11" />
  </svg>
);

export const IconCheck = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const IconClock = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round" strokeLinejoin="round">
    <circle cx={12} cy={12} r={9} />
    <path d="M12 7v5l3 3" />
  </svg>
);

export const IconMinus = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} {...deco} strokeLinecap="round">
    <path d="M5 12h14" />
  </svg>
);
