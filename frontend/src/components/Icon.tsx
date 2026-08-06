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

export const IconTrash = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z" />
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
