import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, ApiError } from '../api/client';
import { useT } from '../i18n';
import Modal from './Modal';

// Enterprise Facility Management upgrade (MIGRATION_050). Split out of LocationsPage.tsx
// (which used to render this inline) now that the field count justifies its own file and
// a tabbed layout, matching how PolicyDetailsModal/AcknowledgmentModal are their own
// components rather than living inline in their page.
export interface Location {
  id: string;
  name: string;
  address: string | null;
  area: string | null;
  type: 'kiosk' | 'warehouse' | 'retail' | 'dark_kitchen' | 'head_office';
  manager_id: string | null;
  manager_name: string | null;
  cost_center_code: string | null;
  contact_phone: string | null;
  gps_coordinates: string | null;
  municipality_license: string | null;
  license_expiry_date: string | null;
  lease_expiry_date: string | null;
  license_days_until_expiry: number | null;
  lease_days_until_expiry: number | null;
  created_at: string;
}

interface EmployeeOption {
  id: string;
  name: string;
}

interface LocationModalProps {
  location: Location | null; // null => creating a new location
  onClose: () => void;
  onSaved: () => void;
}

type TabKey = 'general' | 'operations' | 'legal';

const LOCATION_TYPE_OPTIONS = ['kiosk', 'warehouse', 'retail', 'dark_kitchen', 'head_office'] as const;

export default function LocationModal({ location, onClose, onSaved }: LocationModalProps) {
  const t = useT();

  const TYPE_LABELS: Record<string, string> = {
    kiosk: t.locations.typeKiosk,
    warehouse: t.locations.typeWarehouse,
    retail: t.locations.typeRetail,
    dark_kitchen: t.locations.typeDarkKitchen,
    head_office: t.locations.typeHeadOffice,
  };
  const TYPE_HELPERS: Record<string, string> = {
    kiosk: t.locations.typeHelperKiosk,
    warehouse: t.locations.typeHelperWarehouse,
    retail: t.locations.typeHelperRetail,
    dark_kitchen: t.locations.typeHelperDarkKitchen,
    head_office: t.locations.typeHelperHeadOffice,
  };

  const [tab, setTab] = useState<TabKey>('general');

  // General
  const [name, setName] = useState(location?.name ?? '');
  const [address, setAddress] = useState(location?.address ?? '');
  const [area, setArea] = useState(location?.area ?? '');
  const [type, setType] = useState<(typeof LOCATION_TYPE_OPTIONS)[number]>(location?.type ?? 'kiosk');
  const [contactPhone, setContactPhone] = useState(location?.contact_phone ?? '');
  const [gpsCoordinates, setGpsCoordinates] = useState(location?.gps_coordinates ?? '');

  // Operations
  const [managerId, setManagerId] = useState(location?.manager_id ?? '');

  // Legal & Financial
  const [costCenterCode, setCostCenterCode] = useState(location?.cost_center_code ?? '');
  const [municipalityLicense, setMunicipalityLicense] = useState(location?.municipality_license ?? '');
  const [licenseExpiryDate, setLicenseExpiryDate] = useState(location?.license_expiry_date?.slice(0, 10) ?? '');
  const [leaseExpiryDate, setLeaseExpiryDate] = useState(location?.lease_expiry_date?.slice(0, 10) ?? '');

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    get<{ employees: EmployeeOption[] }>('/employees')
      .then((r) => setEmployees(r.employees))
      .catch(() => {
        /* Manager dropdown just shows "no manager assigned" if this fails — not
           worth blocking the whole modal over the employee picker failing to load. */
      })
      .finally(() => setEmployeesLoading(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const payload = {
      name,
      address: address || undefined,
      area: area || undefined,
      type,
      contact_phone: contactPhone || undefined,
      gps_coordinates: gpsCoordinates || undefined,
      manager_id: managerId || null,
      cost_center_code: costCenterCode || undefined,
      municipality_license: municipalityLicense || undefined,
      license_expiry_date: licenseExpiryDate || null,
      lease_expiry_date: leaseExpiryDate || null,
    };
    try {
      if (location) {
        await patch(`/locations/${location.id}`, payload);
      } else {
        await post('/locations', payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.locations.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'general', label: t.locations.tabGeneral },
    { key: 'operations', label: t.locations.tabOperations },
    { key: 'legal', label: t.locations.tabLegal },
  ];

  return (
    <Modal
      title={location ? t.locations.editItem : t.locations.newItem}
      onClose={onClose}
      actions={(requestClose) => (
        <>
          <button className="btn btn-primary" type="submit" form="location-form" disabled={loading}>
            {loading ? t.common.loading : t.common.save}
          </button>
          <button className="btn btn-secondary" type="button" onClick={requestClose}>
            {t.common.cancel}
          </button>
        </>
      )}
    >
      {/* Tab strip — same toggle-button visual language as the type picker below and
          the rest of the app (btn-sm, primary when active, secondary otherwise) rather
          than introducing a new tab-specific component/CSS class for a single modal. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
        {TABS.map((tabDef) => (
          <button
            key={tabDef.key}
            type="button"
            onClick={() => setTab(tabDef.key)}
            className={`btn btn-sm ${tab === tabDef.key ? 'btn-primary' : 'btn-secondary'}`}
          >
            {tabDef.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Single form spanning all three tabs — only the active tab's div is displayed,
          the others stay mounted (display: none) so switching tabs never loses input
          the user already typed on another tab, and the browser's native required-field
          validation still sees every field on submit. */}
      <form id="location-form" onSubmit={handleSubmit}>
        <div style={{ display: tab === 'general' ? 'block' : 'none' }}>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>{t.locations.name}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>

          <div className="field" style={{ marginBottom: 4 }}>
            <label>{t.locations.type}</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {LOCATION_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setType(opt)}
                  className={`btn btn-sm ${type === opt ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: '1 1 30%', justifyContent: 'center' }}
                >
                  {TYPE_LABELS[opt]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{TYPE_HELPERS[type]}</div>
          </div>

          <div className="field-grid" style={{ marginTop: 14 }}>
            <div className="field">
              <label>{t.locations.area}</label>
              <input value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.locations.address}</label>
              <input value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.locations.contactPhone}</label>
              <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} type="tel" />
            </div>
            <div className="field">
              <label>{t.locations.gpsCoordinates}</label>
              <input value={gpsCoordinates} onChange={(e) => setGpsCoordinates(e.target.value)} placeholder="29.3759, 47.9774" />
            </div>
          </div>
        </div>

        <div style={{ display: tab === 'operations' ? 'block' : 'none' }}>
          <div className="field" style={{ marginBottom: 14 }}>
            <label>{t.locations.manager}</label>
            <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={employeesLoading}>
              <option value="">{employeesLoading ? t.locations.managerLoading : t.locations.managerNone}</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: tab === 'legal' ? 'block' : 'none' }}>
          <div className="field-grid">
            <div className="field">
              <label>{t.locations.costCenterCode}</label>
              <input value={costCenterCode} onChange={(e) => setCostCenterCode(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.locations.municipalityLicense}</label>
              <input value={municipalityLicense} onChange={(e) => setMunicipalityLicense(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.locations.licenseExpiryDate}</label>
              <input type="date" value={licenseExpiryDate} onChange={(e) => setLicenseExpiryDate(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.locations.leaseExpiryDate}</label>
              <input type="date" value={leaseExpiryDate} onChange={(e) => setLeaseExpiryDate(e.target.value)} />
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}
