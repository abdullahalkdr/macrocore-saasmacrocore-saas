import { useNavigate } from 'react-router-dom';
import { useT } from '../../i18n';

export default function SetupSection() {
  const t = useT();
  const navigate = useNavigate();

  // Cost Centers (MIGRATION_051) and Projects (MIGRATION_052) both graduated out
  // of `placeholders` below and into their own active cards, same "manage" button +
  // navigate() pattern as Branches above -- each now has a real page behind its own
  // flat route instead of being a disabled "coming soon" tile.
  const placeholders = [
    { title: t.account.sections.periodStatusTitle, desc: t.account.sections.periodStatusDesc, icon: '🔒' },
  ];

  return (
    <div>
      <div className="card">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{t.account.sections.branchesTitle}</h2>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/locations')}>
            {t.account.setup.manageBranches}
          </button>
        </div>
        <div className="card-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {t.account.sections.branchesDesc}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{t.account.sections.costCentersTitle}</h2>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/cost-centers')}>
            {t.account.setup.manageCostCenters}
          </button>
        </div>
        <div className="card-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {t.account.sections.costCentersDesc}
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{t.account.sections.projectsTitle}</h2>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/projects')}>
            {t.account.setup.manageProjects}
          </button>
        </div>
        <div className="card-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {t.account.sections.projectsDesc}
          </p>
        </div>
      </div>

      <div className="field-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {placeholders.map((p) => (
          <div className="card" key={p.title} style={{ opacity: 0.65 }}>
            <div className="card-body" style={{ display: 'flex', gap: 12 }}>
              <span style={{ fontSize: 20 }}>{p.icon}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {p.title} <span className="badge closed">{t.account.comingSoon}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{p.desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
