import { useEffect, useState } from 'react';
import { get, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import LocationModal, { Location } from '../components/LocationModal';
import { IconPlus, IconTrash, IconWarning } from '../components/Icon';

type ExpiryStatus = 'expired' | 'expiring' | 'safe';

// Same three-bucket classification CompanyFilesPage.tsx already uses for its
// issue/expiry document tracking (30-day warning window) — reused here so a
// location's license/lease reads consistently with how every other
// expiry-tracked document in the app is judged, instead of inventing a second
// threshold convention.
function statusFromDays(days: number | null): ExpiryStatus {
  if (days === null) return 'safe';
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'safe';
}

function worstStatus(a: ExpiryStatus, b: ExpiryStatus): ExpiryStatus {
  if (a === 'expired' || b === 'expired') return 'expired';
  if (a === 'expiring' || b === 'expiring') return 'expiring';
  return 'safe';
}

function statusColor(status: ExpiryStatus): string {
  if (status === 'expired') return '#e74c3c';
  if (status === 'expiring') return '#f39c12';
  return '#27ae60';
}

export default function LocationsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const TYPE_LABELS: Record<string, string> = {
    kiosk: t.locations.typeKiosk,
    warehouse: t.locations.typeWarehouse,
    retail: t.locations.typeRetail,
    dark_kitchen: t.locations.typeDarkKitchen,
    head_office: t.locations.typeHeadOffice,
  };
  const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
    kiosk: { bg: '#fff4e5', fg: '#b45309' },
    warehouse: { bg: '#e8f0fe', fg: '#1a56db' },
    retail: { bg: '#f3e8ff', fg: '#7e22ce' },
    dark_kitchen: { bg: '#fee2e2', fg: '#b91c1c' },
    head_office: { bg: '#e6f9f0', fg: '#0f7a4d' },
  };

  const [items, setItems] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    get<{ locations: Location[] }>('/locations')
      .then((r) => setItems(r.locations))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.locations.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function locationStatus(l: Location): ExpiryStatus {
    return worstStatus(statusFromDays(l.license_days_until_expiry), statusFromDays(l.lease_days_until_expiry));
  }

  function formatDate(d: string | null) {
    return d ? new Date(d).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '—';
  }

  async function handleDelete(id: string) {
    if (!confirm(t.locations.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/locations/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.locations.deleteFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.locations.title} subtitle={t.locations.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.locations.count(items.length)}</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <IconPlus /> {t.locations.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.locations.name}</th>
                <th>{t.locations.type}</th>
                <th>{t.locations.manager}</th>
                <th>{t.locations.area}</th>
                <th>{t.locations.address}</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => {
                const status = locationStatus(l);
                const licenseStatus = statusFromDays(l.license_days_until_expiry);
                const leaseStatus = statusFromDays(l.lease_days_until_expiry);
                const typeColor = TYPE_COLORS[l.type] || TYPE_COLORS.kiosk;
                return (
                  <tr key={l.id}>
                    <td style={{ fontWeight: 700 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {status !== 'safe' && (
                          <span
                            title={
                              [
                                licenseStatus !== 'safe'
                                  ? `${t.locations.licenseLabel}: ${licenseStatus === 'expired' ? t.locations.expired : `${l.license_days_until_expiry} ${t.locations.daysLeft}`}`
                                  : null,
                                leaseStatus !== 'safe'
                                  ? `${t.locations.leaseLabel}: ${leaseStatus === 'expired' ? t.locations.expired : `${l.lease_days_until_expiry} ${t.locations.daysLeft}`}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            }
                            style={{ color: statusColor(status), display: 'inline-flex' }}
                          >
                            <IconWarning size={14} />
                          </span>
                        )}
                        {l.name}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          padding: '2px 10px',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 700,
                          backgroundColor: typeColor.bg,
                          color: typeColor.fg,
                        }}
                      >
                        {TYPE_LABELS[l.type] || l.type}
                      </span>
                    </td>
                    <td>{l.manager_name || '—'}</td>
                    <td>{l.area || '—'}</td>
                    <td>{l.address || '—'}</td>
                    <td style={{ fontSize: 12, color: status === 'safe' ? 'var(--muted)' : statusColor(status), whiteSpace: 'nowrap' }}>
                      {licenseStatus !== 'safe' && (
                        <div>
                          {t.locations.licenseLabel}: {formatDate(l.license_expiry_date)}
                        </div>
                      )}
                      {leaseStatus !== 'safe' && (
                        <div>
                          {t.locations.leaseLabel}: {formatDate(l.lease_expiry_date)}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setEditing(l);
                          setOpen(true);
                        }}
                      >
                        {t.locations.edit}
                      </button>{' '}
                      <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(l.id)}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">{t.locations.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <LocationModal
          location={editing}
          onClose={() => setOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
