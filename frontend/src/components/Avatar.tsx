export default function Avatar({ name, color = 'var(--amber-100)', textColor = 'var(--amber-700)' }: { name: string; color?: string; textColor?: string }) {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: '50%',
        background: color,
        color: textColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: 14,
        flexShrink: 0,
      }}
    >
      {(name || '؟').slice(0, 1).toUpperCase()}
    </div>
  );
}
