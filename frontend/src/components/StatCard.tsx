type StatColor = 'green' | 'red' | 'blue' | 'amber';

export default function StatCard({ label, value, color }: { label: string; value: string | number; color?: StatColor }) {
  return (
    <div className={`stat-card${color ? ` ${color}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
