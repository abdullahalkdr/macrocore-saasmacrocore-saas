import { FormEvent, useEffect, useState } from 'react';
import { get, post, patch, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import Avatar from '../components/Avatar';
import { IconPlus, IconTrash, IconEdit } from '../components/Icon';
import { useDepartmentsStore } from '../store/useDepartmentsStore';
import { JOB_ROLE_GROUPS, JobRoleGroupKey, JobRoleKey, getVisibleJobRoleGroups } from '../constants/jobRolesCatalog';

interface Certificate {
  name: string;
  name_en?: string;
  issuer?: string;
  issued_date?: string;
  file_base64?: string;
}

interface Allowance {
  label: string;
  amount: number;
}

interface Location {
  id: string;
  name: string;
}

interface Employee {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  job_role: string | null;
  salary_monthly: number | null;
  status: string;
  photo_base64: string | null;
  civil_id: string | null;
  birth_date: string | null;
  weight_kg: number | null;
  prior_experience: string | null;
  certificates: Certificate[];
  age: number | null;
  wage_type: 'monthly' | 'hourly';
  hourly_rate: number | null;
  start_date: string | null;
  nationality: string | null;
  civil_id_expiry: string | null;
  residency_number: string | null;
  residency_expiry: string | null;
  passport_number: string | null;
  passport_expiry: string | null;
  bank_iban: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  location_id: string | null;
  location_name: string | null;
  department_id: string | null;
  department_name: string | null;
  department_name_en: string | null;
  allowances: Allowance[];
  shift_start_time: string | null;
  late_grace_minutes: number | null;
  days_until_civil_id_expiry: number | null;
  days_until_residency_expiry: number | null;
  days_until_passport_expiry: number | null;
}

// Enterprise Job Role Catalog (see ../constants/jobRolesCatalog.ts) replaced the
// old flat kiosk-only list. ALL_JOB_ROLE_KEYS covers every role across every
// group (not just the ones currently visible under the selected department) so
// an existing employee's stored job_role always resolves correctly regardless
// of which department they're in right now — see resolveJobRoleSelect below.
const ALL_JOB_ROLE_KEYS: JobRoleKey[] = Array.from(new Set(JOB_ROLE_GROUPS.flatMap((g) => g.roles)));
const JOB_ROLE_OTHER = '__other__';

function hasExpiryWarning(e: Employee): boolean {
  return [e.days_until_civil_id_expiry, e.days_until_residency_expiry, e.days_until_passport_expiry].some(
    (d) => d !== null && d <= 30
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface AllowanceRow {
  label: string;
  amount: string;
}

function emptyForm() {
  return {
    name: '',
    email: '',
    phone: '',
    jobRoleSelect: '',
    jobRole: '', // custom text, only used when jobRoleSelect === JOB_ROLE_OTHER
    salary: '',
    photoBase64: '' as string | null,
    civilId: '',
    birthDate: '',
    weightKg: '',
    priorExperience: '',
    certificates: [] as Certificate[],
    wageType: 'monthly' as 'monthly' | 'hourly',
    hourlyRate: '',
    startDate: '',
    nationality: '',
    civilIdExpiry: '',
    residencyNumber: '',
    residencyExpiry: '',
    passportNumber: '',
    passportExpiry: '',
    bankIban: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    locationId: '',
    departmentId: '',
    status: 'active' as 'active' | 'inactive',
    allowances: [] as AllowanceRow[],
    shiftStartTime: '',
    lateGraceMinutes: '',
  };
}

function calcAge(birthDate: string): number | null {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const hadBirthday = now.getMonth() > birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());
  if (!hadBirthday) age -= 1;
  return age;
}

export default function EmployeesPage() {
  const t = useT();
  const JOB_ROLE_LABELS: Record<JobRoleKey, string> = {
    legalDirector: t.employees.jobRoleLegalDirector,
    generalCounsel: t.employees.jobRoleGeneralCounsel,
    seniorLegalCounsel: t.employees.jobRoleSeniorLegalCounsel,
    legalCounsel: t.employees.jobRoleLegalCounsel,
    corporateLawyer: t.employees.jobRoleCorporateLawyer,
    legalResearcher: t.employees.jobRoleLegalResearcher,
    paralegal: t.employees.jobRoleParalegal,
    complianceOfficer: t.employees.jobRoleComplianceOfficer,
    boardSecretary: t.employees.jobRoleBoardSecretary,
    restaurantManager: t.employees.jobRoleRestaurantManager,
    assistantRestaurantManager: t.employees.jobRoleAssistantRestaurantManager,
    shiftSupervisor: t.employees.jobRoleShiftSupervisor,
    headChef: t.employees.jobRoleHeadChef,
    commisChef: t.employees.jobRoleCommisChef,
    barista: t.employees.jobRoleBarista,
    juiceMaker: t.employees.jobRoleJuiceMaker,
    cashier: t.employees.jobRoleCashier,
    waiter: t.employees.jobRoleWaiter,
    sandwichMaker: t.employees.jobRoleSandwichMaker,
    kitchenSteward: t.employees.jobRoleKitchenSteward,
    deliveryRider: t.employees.jobRoleDeliveryRider,
    storeManager: t.employees.jobRoleStoreManager,
    assistantStoreManager: t.employees.jobRoleAssistantStoreManager,
    departmentSupervisor: t.employees.jobRoleDepartmentSupervisor,
    salesAssociate: t.employees.jobRoleSalesAssociate,
    retailCashier: t.employees.jobRoleRetailCashier,
    receptionist: t.employees.jobRoleReceptionist,
    visualMerchandiser: t.employees.jobRoleVisualMerchandiser,
    storeKeeper: t.employees.jobRoleStoreKeeper,
    customerServiceAgent: t.employees.jobRoleCustomerServiceAgent,
    kioskSupervisor: t.employees.jobRoleKioskSupervisor,
    kioskOperator: t.employees.jobRoleKioskOperator,
    qualityAuditor: t.employees.jobRoleQualityAuditor,
    mysteryShopper: t.employees.jobRoleMysteryShopper,
    securityOfficer: t.employees.jobRoleSecurityOfficer,
    hrManager: t.employees.jobRoleHrManager,
    hrOfficer: t.employees.jobRoleHrOfficer,
    recruitmentSpecialist: t.employees.jobRoleRecruitmentSpecialist,
    payrollSpecialist: t.employees.jobRolePayrollSpecialist,
    trainingDevelopmentOfficer: t.employees.jobRoleTrainingDevelopmentOfficer,
    financeManager: t.employees.jobRoleFinanceManager,
    accountant: t.employees.jobRoleAccountant,
    accountsPayableOfficer: t.employees.jobRoleAccountsPayableOfficer,
    treasuryOfficer: t.employees.jobRoleTreasuryOfficer,
    internalAuditor: t.employees.jobRoleInternalAuditor,
    itManager: t.employees.jobRoleItManager,
    softwareDeveloper: t.employees.jobRoleSoftwareDeveloper,
    itSupportSpecialist: t.employees.jobRoleItSupportSpecialist,
    systemsAdministrator: t.employees.jobRoleSystemsAdministrator,
    networkEngineer: t.employees.jobRoleNetworkEngineer,
    marketingManager: t.employees.jobRoleMarketingManager,
    marketingSpecialist: t.employees.jobRoleMarketingSpecialist,
    socialMediaCoordinator: t.employees.jobRoleSocialMediaCoordinator,
    graphicDesigner: t.employees.jobRoleGraphicDesigner,
    contentCreator: t.employees.jobRoleContentCreator,
  };
  const JOB_ROLE_GROUP_LABELS: Record<JobRoleGroupKey, string> = {
    legal: t.employees.jobRoleGroupLegal,
    fnb: t.employees.jobRoleGroupFnb,
    retail: t.employees.jobRoleGroupRetail,
    kiosk: t.employees.jobRoleGroupKiosk,
    fieldControl: t.employees.jobRoleGroupFieldControl,
    hr: t.employees.jobRoleGroupHr,
    finance: t.employees.jobRoleGroupFinance,
    it: t.employees.jobRoleGroupIt,
    marketing: t.employees.jobRoleGroupMarketing,
  };
  const departments = useDepartmentsStore((s) => s.departments);
  const fetchDepartments = useDepartmentsStore((s) => s.fetchAll);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function load() {
    get<{ employees: Employee[] }>('/employees')
      .then((r) => setEmployees(r.employees))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.employees.loadFailed));
  }

  useEffect(() => {
    load();
    get<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
    fetchDepartments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Old free-text job_role values (entered before this dropdown existed) may not
  // match any known option's label — fall back to "Other" with the raw text kept
  // editable, instead of silently losing/blanking it.
  function resolveJobRoleSelect(raw: string): { select: string; custom: string } {
    for (const key of ALL_JOB_ROLE_KEYS) {
      if (raw === JOB_ROLE_LABELS[key]) return { select: key, custom: '' };
    }
    return raw ? { select: JOB_ROLE_OTHER, custom: raw } : { select: '', custom: '' };
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setOpen(true);
  }

  function openEdit(emp: Employee) {
    setEditingId(emp.id);
    const jobRoleResolved = resolveJobRoleSelect(emp.job_role || '');
    setForm({
      name: emp.name,
      email: emp.email || '',
      phone: emp.phone || '',
      jobRoleSelect: jobRoleResolved.select,
      jobRole: jobRoleResolved.custom,
      salary: emp.salary_monthly !== null ? String(emp.salary_monthly) : '',
      photoBase64: emp.photo_base64,
      civilId: emp.civil_id || '',
      birthDate: emp.birth_date ? emp.birth_date.slice(0, 10) : '',
      weightKg: emp.weight_kg !== null ? String(emp.weight_kg) : '',
      priorExperience: emp.prior_experience || '',
      certificates: emp.certificates || [],
      wageType: emp.wage_type || 'monthly',
      hourlyRate: emp.hourly_rate !== null ? String(emp.hourly_rate) : '',
      startDate: emp.start_date ? emp.start_date.slice(0, 10) : '',
      nationality: emp.nationality || '',
      civilIdExpiry: emp.civil_id_expiry ? emp.civil_id_expiry.slice(0, 10) : '',
      residencyNumber: emp.residency_number || '',
      residencyExpiry: emp.residency_expiry ? emp.residency_expiry.slice(0, 10) : '',
      passportNumber: emp.passport_number || '',
      passportExpiry: emp.passport_expiry ? emp.passport_expiry.slice(0, 10) : '',
      bankIban: emp.bank_iban || '',
      emergencyContactName: emp.emergency_contact_name || '',
      emergencyContactPhone: emp.emergency_contact_phone || '',
      locationId: emp.location_id || '',
      departmentId: emp.department_id || '',
      status: emp.status === 'inactive' ? 'inactive' : 'active',
      allowances: (emp.allowances || []).map((a) => ({ label: a.label, amount: String(a.amount) })),
      shiftStartTime: emp.shift_start_time ? emp.shift_start_time.slice(0, 5) : '',
      lateGraceMinutes: emp.late_grace_minutes !== null && emp.late_grace_minutes !== undefined ? String(emp.late_grace_minutes) : '',
    });
    setOpen(true);
  }

  async function handlePhotoChange(file: File | undefined) {
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    setForm((f) => ({ ...f, photoBase64: base64 }));
  }

  function addCertificate() {
    setForm((f) => ({ ...f, certificates: [...f.certificates, { name: '' }] }));
  }
  function updateCertificate(i: number, patchObj: Partial<Certificate>) {
    setForm((f) => ({ ...f, certificates: f.certificates.map((c, idx) => (idx === i ? { ...c, ...patchObj } : c)) }));
  }
  function removeCertificate(i: number) {
    setForm((f) => ({ ...f, certificates: f.certificates.filter((_, idx) => idx !== i) }));
  }
  async function handleCertificateFile(i: number, file: File | undefined) {
    if (!file) return;
    const base64 = await readFileAsBase64(file);
    updateCertificate(i, { file_base64: base64 });
  }

  function addAllowance() {
    setForm((f) => ({ ...f, allowances: [...f.allowances, { label: '', amount: '' }] }));
  }
  function updateAllowance(i: number, patchObj: Partial<AllowanceRow>) {
    setForm((f) => ({ ...f, allowances: f.allowances.map((a, idx) => (idx === i ? { ...a, ...patchObj } : a)) }));
  }
  function removeAllowance(i: number) {
    setForm((f) => ({ ...f, allowances: f.allowances.filter((_, idx) => idx !== i) }));
  }
  const allowancesTotal = form.allowances.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const finalJobRole =
        form.jobRoleSelect === JOB_ROLE_OTHER
          ? form.jobRole.trim()
          : form.jobRoleSelect
            ? JOB_ROLE_LABELS[form.jobRoleSelect as JobRoleKey]
            : '';
      const payload = {
        name: form.name,
        email: form.email || undefined,
        phone: form.phone || undefined,
        job_role: finalJobRole || undefined,
        salary_monthly: form.salary ? Number(form.salary) : undefined,
        photo_base64: form.photoBase64 || undefined,
        civil_id: form.civilId || undefined,
        birth_date: form.birthDate || undefined,
        weight_kg: form.weightKg ? Number(form.weightKg) : undefined,
        prior_experience: form.priorExperience || undefined,
        certificates: form.certificates.filter((c) => c.name.trim()),
        wage_type: form.wageType,
        hourly_rate: form.wageType === 'hourly' && form.hourlyRate ? Number(form.hourlyRate) : undefined,
        start_date: form.startDate || undefined,
        nationality: form.nationality || undefined,
        civil_id_expiry: form.civilIdExpiry || undefined,
        residency_number: form.residencyNumber || undefined,
        residency_expiry: form.residencyExpiry || undefined,
        passport_number: form.passportNumber || undefined,
        passport_expiry: form.passportExpiry || undefined,
        bank_iban: form.bankIban || undefined,
        emergency_contact_name: form.emergencyContactName || undefined,
        emergency_contact_phone: form.emergencyContactPhone || undefined,
        location_id: form.locationId || undefined,
        department_id: form.departmentId || undefined,
        status: editingId ? form.status : undefined,
        allowances: form.allowances
          .filter((a) => a.label.trim() && a.amount)
          .map((a) => ({ label: a.label.trim(), amount: Number(a.amount) })),
        shift_start_time: form.shiftStartTime || undefined,
        late_grace_minutes: form.lateGraceMinutes ? Number(form.lateGraceMinutes) : undefined,
      };
      if (editingId) {
        await patch(`/employees/${editingId}`, payload);
      } else {
        await post('/employees', payload);
      }
      setOpen(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.employees.saveFailed);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t.employees.deleteConfirm)) return;
    setError(null);
    try {
      await del(`/employees/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.employees.deleteFailed);
    }
  }

  const liveAge = calcAge(form.birthDate);

  return (
    <div>
      <PageHeader title={t.employees.title} subtitle={t.employees.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      {employees.filter(hasExpiryWarning).length > 0 && (
        <div style={{ padding: '12px', backgroundColor: '#ffe6e6', borderLeft: '4px solid #e74c3c', marginBottom: '16px', borderRadius: '4px' }}>
          <strong>{t.employees.expiryAlert(employees.filter(hasExpiryWarning).length)}</strong>
        </div>
      )}

      <div className="section-title-row">
        <span className="muted">{t.employees.count(employees.length)}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <IconPlus /> {t.employees.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>{t.employees.name}</th>
                <th>{t.employees.jobRole}</th>
                <th>{t.employees.department}</th>
                <th>{t.employees.location}</th>
                <th className="num">{t.employees.baseSalaryCol}</th>
                <th className="num">{t.employees.allowanceCol}</th>
                <th className="num">{t.employees.totalMonthlyCol}</th>
                <th>{t.employees.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const allowanceTotal = (e.allowances || []).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
                const baseDisplay =
                  e.wage_type === 'hourly'
                    ? e.hourly_rate !== null
                      ? t.employees.hourlyRateShort(Number(e.hourly_rate).toFixed(3))
                      : '—'
                    : e.salary_monthly !== null
                      ? `${Number(e.salary_monthly).toFixed(3)} KD`
                      : '—';
                const totalDisplay =
                  e.wage_type === 'monthly' && e.salary_monthly !== null
                    ? `${(Number(e.salary_monthly) + allowanceTotal).toFixed(3)} KD`
                    : '—';
                return (
                  <tr key={e.id} onClick={() => openEdit(e)} style={{ cursor: 'pointer' }}>
                    <td>
                      {e.photo_base64 ? (
                        <img src={e.photo_base64} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
                      ) : (
                        <Avatar name={e.name} />
                      )}
                    </td>
                    <td style={{ fontWeight: 700 }}>
                      {e.name}
                      {e.age !== null && <span className="muted" style={{ fontWeight: 400 }}> ({e.age})</span>}
                      {hasExpiryWarning(e) && (
                        <>
                          {' '}
                          <Tag color="amber">{t.employees.expiringBadge}</Tag>
                        </>
                      )}
                    </td>
                    <td>{e.job_role || '—'}</td>
                    <td>{e.department_name || '—'}</td>
                    <td>{e.location_name || '—'}</td>
                    <td className="num">{baseDisplay}</td>
                    <td className="num">{allowanceTotal > 0 ? `${allowanceTotal.toFixed(3)} KD` : '—'}</td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {totalDisplay}
                    </td>
                    <td>
                      {e.status === 'active' ? (
                        <Tag color="green">{t.common.active}</Tag>
                      ) : (
                        <Tag color="gray">{e.status === 'inactive' ? t.employees.statusInactive : e.status}</Tag>
                      )}
                    </td>
                    <td onClick={(ev) => ev.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title={t.employees.newItem} onClick={() => openEdit(e)}>
                        <IconEdit />
                      </button>
                      <button className="icon-btn" title={t.common.delete} onClick={() => handleDelete(e.id)}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">{t.employees.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={editingId ? form.name || t.employees.newItem : t.employees.newItem}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="employee-form" disabled={loading}>
                {loading ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="employee-form" onSubmit={handleSubmit}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 14 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field">
                  <label>{t.employees.name}</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
                </div>
                <div className="field">
                  <label>{t.employees.jobRole}</label>
                  <select
                    value={form.jobRoleSelect}
                    onChange={(e) =>
                      setForm({ ...form, jobRoleSelect: e.target.value, jobRole: e.target.value === JOB_ROLE_OTHER ? form.jobRole : '' })
                    }
                  >
                    <option value="">{t.employees.jobRoleSelectPlaceholder}</option>
                    {/* Optgroups react to the selected Department: picking "Operations" narrows
                        this down to the F&B/Retail/Kiosk groups only; no department selected
                        shows every group (see getVisibleJobRoleGroups). */}
                    {getVisibleJobRoleGroups(departments.find((d) => d.id === form.departmentId) || null).map((group) => (
                      <optgroup key={group.key} label={JOB_ROLE_GROUP_LABELS[group.key]}>
                        {group.roles.map((k) => (
                          <option key={k} value={k}>
                            {JOB_ROLE_LABELS[k]}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value={JOB_ROLE_OTHER}>{t.employees.jobRoleOther}</option>
                  </select>
                  {form.jobRoleSelect === JOB_ROLE_OTHER && (
                    <input
                      style={{ marginTop: 6 }}
                      value={form.jobRole}
                      onChange={(e) => setForm({ ...form, jobRole: e.target.value })}
                      placeholder={t.employees.jobRolePlaceholder}
                    />
                  )}
                </div>
                <div className="field">
                  <label>{t.employees.location}</label>
                  <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
                    <option value="">{t.employees.selectLocation}</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t.employees.department}</label>
                  <select
                    value={form.departmentId}
                    onChange={(e) => {
                      const nextDept = departments.find((d) => d.id === e.target.value) || null;
                      const stillVisible = getVisibleJobRoleGroups(nextDept).some((g) => g.roles.includes(form.jobRoleSelect as JobRoleKey));
                      setForm({
                        ...form,
                        departmentId: e.target.value,
                        jobRoleSelect: stillVisible || form.jobRoleSelect === '' || form.jobRoleSelect === JOB_ROLE_OTHER ? form.jobRoleSelect : '',
                      });
                    }}
                  >
                    <option value="">{t.employees.selectDepartment}</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                {form.photoBase64 ? (
                  <img src={form.photoBase64} alt="" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <Avatar name={form.name || '?'} />
                )}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handlePhotoChange(e.target.files?.[0])}
                  style={{ maxWidth: 150, fontSize: 11 }}
                />
              </div>
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.personalDataTitle}</span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t.employees.nationality}</label>
                <input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.civilId}</label>
                <input value={form.civilId} onChange={(e) => setForm({ ...form, civilId: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.phone}</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.birthDate}</label>
                <input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.weight}</label>
                <input type="number" step="0.1" value={form.weightKg} onChange={(e) => setForm({ ...form, weightKg: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.ageFieldLabel}</label>
                <input value={liveAge !== null ? String(liveAge) : ''} disabled />
              </div>
              {editingId && (
                <div className="field">
                  <label>{t.employees.status}</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}>
                    <option value="active">{t.common.active}</option>
                    <option value="inactive">{t.employees.statusInactive}</option>
                  </select>
                </div>
              )}
              <div className="field">
                <label>{t.employees.joinDate}</label>
                <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.email}</label>
                <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <label>{t.employees.priorExperience}</label>
              <textarea
                rows={2}
                value={form.priorExperience}
                onChange={(e) => setForm({ ...form, priorExperience: e.target.value })}
              />
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.payInfoTitle}</span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t.employees.wageType}</label>
                <select
                  value={form.wageType}
                  onChange={(e) => setForm({ ...form, wageType: e.target.value as 'monthly' | 'hourly' })}
                >
                  <option value="monthly">{t.employees.wageTypeMonthly}</option>
                  <option value="hourly">{t.employees.wageTypeHourly}</option>
                </select>
              </div>
              {form.wageType === 'hourly' ? (
                <div className="field">
                  <label>{t.employees.hourlyRate}</label>
                  <input
                    type="number"
                    step="0.001"
                    value={form.hourlyRate}
                    onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                  />
                </div>
              ) : (
                <div className="field">
                  <label>{t.employees.salary}</label>
                  <input type="number" step="0.001" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} />
                </div>
              )}
            </div>

            <div className="section-title-row" style={{ marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {t.employees.allowancesTitle} — {t.employees.allowancesTotal(allowancesTotal.toFixed(3))}
              </span>
              <button className="btn btn-secondary btn-sm" type="button" onClick={addAllowance}>
                <IconPlus /> {t.employees.addAllowance}
              </button>
            </div>
            {form.allowances.map((a, i) => (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <div className="field" style={{ flex: 2 }}>
                  <input
                    placeholder={t.employees.allowanceLabelPlaceholder}
                    value={a.label}
                    onChange={(e) => updateAllowance(i, { label: e.target.value })}
                  />
                </div>
                <div className="field">
                  <input type="number" step="0.001" placeholder="KD" value={a.amount} onChange={(e) => updateAllowance(i, { amount: e.target.value })} />
                </div>
                <button className="icon-btn" type="button" onClick={() => removeAllowance(i)} style={{ alignSelf: 'center' }}>
                  <IconTrash />
                </button>
              </div>
            ))}

            <div className="field-grid" style={{ marginTop: 10 }}>
              <div className="field">
                <label>{t.employees.lateGraceMinutes}</label>
                <input
                  type="number"
                  step="1"
                  min={0}
                  value={form.lateGraceMinutes}
                  onChange={(e) => setForm({ ...form, lateGraceMinutes: e.target.value })}
                />
              </div>
              <div className="field">
                <label>{t.employees.shiftStartTime}</label>
                <input type="time" value={form.shiftStartTime} onChange={(e) => setForm({ ...form, shiftStartTime: e.target.value })} />
              </div>
            </div>
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {t.employees.schedulingNote}
            </p>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.hrSectionTitle}</span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t.employees.civilIdExpiry}</label>
                <input type="date" value={form.civilIdExpiry} onChange={(e) => setForm({ ...form, civilIdExpiry: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.residencyNumber}</label>
                <input value={form.residencyNumber} onChange={(e) => setForm({ ...form, residencyNumber: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.residencyExpiry}</label>
                <input type="date" value={form.residencyExpiry} onChange={(e) => setForm({ ...form, residencyExpiry: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.passportNumber}</label>
                <input value={form.passportNumber} onChange={(e) => setForm({ ...form, passportNumber: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.passportExpiry}</label>
                <input type="date" value={form.passportExpiry} onChange={(e) => setForm({ ...form, passportExpiry: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.bankIban}</label>
                <input value={form.bankIban} onChange={(e) => setForm({ ...form, bankIban: e.target.value })} />
              </div>
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.emergencyContactTitle}</span>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>{t.employees.emergencyContactName}</label>
                <input value={form.emergencyContactName} onChange={(e) => setForm({ ...form, emergencyContactName: e.target.value })} />
              </div>
              <div className="field">
                <label>{t.employees.emergencyContactPhone}</label>
                <input value={form.emergencyContactPhone} onChange={(e) => setForm({ ...form, emergencyContactPhone: e.target.value })} />
              </div>
            </div>

            <div className="hr" />
            <div className="section-title-row">
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.employees.certificatesTitle}</span>
              <button className="btn btn-secondary btn-sm" type="button" onClick={addCertificate}>
                <IconPlus /> {t.employees.addCertificate}
              </button>
            </div>
            {form.certificates.map((c, i) => (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <div className="field" style={{ flex: 2 }}>
                  <input
                    placeholder={t.employees.certificateName}
                    value={c.name}
                    onChange={(e) => updateCertificate(i, { name: e.target.value })}
                  />
                </div>
                <div className="field" style={{ flex: 2 }}>
                  <input
                    placeholder={t.employees.certificateIssuer}
                    value={c.issuer || ''}
                    onChange={(e) => updateCertificate(i, { issuer: e.target.value })}
                  />
                </div>
                <div className="field">
                  <input type="date" value={c.issued_date || ''} onChange={(e) => updateCertificate(i, { issued_date: e.target.value })} />
                </div>
                <div className="field">
                  <input type="file" onChange={(e) => handleCertificateFile(i, e.target.files?.[0])} />
                </div>
                <button className="icon-btn" type="button" onClick={() => removeCertificate(i)} style={{ alignSelf: 'center' }}>
                  <IconTrash />
                </button>
              </div>
            ))}
          </form>
        </Modal>
      )}
    </div>
  );
}
