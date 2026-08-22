import { Fragment, FormEvent, useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import Tag from '../components/Tag';
import { IconPlus, IconTrash } from '../components/Icon';
import { useLangStore } from '../store/langStore';
import {
  APPRAISAL_TEMPLATES,
  AppraisalTemplateKey,
  OKR_CATEGORY_TEMPLATES,
  OkrCategoryKey,
} from '../constants/performanceTemplates';
import {
  usePerformanceStore,
  Objective,
  OKRStatus,
  MetricType,
  FeedbackCycle,
  CycleStatus,
  ReviewerType,
  PerformanceScore,
} from '../store/usePerformanceStore';

interface EmployeeOption {
  id: string;
  name: string;
}
interface PayrollOption {
  id: string;
  employee_id: string;
  month_year: string;
}

type Tab = 'okr' | 'appraisals' | 'feedback' | 'scores';

export default function PerformancePage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('okr');
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Background list-load failures (e.g. a network drop while a tab's initial
  // fetchObjectives/fetchForms/fetchCycles/fetchScores call is in flight) set this in
  // the store rather than throwing — surface it here too, not just action errors set
  // via setPageError, so a failed background load is never silently an empty table.
  const storeError = usePerformanceStore((s) => s.error);
  const displayedError = error || storeError;

  useEffect(() => {
    get<{ employees: EmployeeOption[] }>('/employees')
      .then((r) => setEmployees(r.employees))
      .catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader title={t.performance.title} subtitle={t.performance.subtitle} />
      {displayedError && <div className="error-banner">{displayedError}</div>}
      <div className="tabs">
        <button type="button" className={`tab-btn${tab === 'okr' ? ' active' : ''}`} onClick={() => setTab('okr')}>
          {t.performance.tabOkr}
        </button>
        <button type="button" className={`tab-btn${tab === 'appraisals' ? ' active' : ''}`} onClick={() => setTab('appraisals')}>
          {t.performance.tabAppraisals}
        </button>
        <button type="button" className={`tab-btn${tab === 'feedback' ? ' active' : ''}`} onClick={() => setTab('feedback')}>
          {t.performance.tabFeedback}
        </button>
        <button type="button" className={`tab-btn${tab === 'scores' ? ' active' : ''}`} onClick={() => setTab('scores')}>
          {t.performance.tabScores}
        </button>
      </div>
      {tab === 'okr' && <OkrTab employees={employees} setPageError={setError} />}
      {tab === 'appraisals' && <AppraisalsTab setPageError={setError} />}
      {tab === 'feedback' && <FeedbackTab employees={employees} setPageError={setError} />}
      {tab === 'scores' && <ScoresTab employees={employees} setPageError={setError} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// OKRs
// ---------------------------------------------------------------------------------
interface KrDraft {
  title: string;
  title_en?: string;
  metric_type: MetricType;
  unit: string;
  target_value: string;
  weight: string;
}
const EMPTY_KR_DRAFT: KrDraft = { title: '', title_en: '', metric_type: 'number', unit: '', target_value: '', weight: '1' };

function OkrTab({ employees, setPageError }: { employees: EmployeeOption[]; setPageError: (e: string | null) => void }) {
  const t = useT();
  const objectives = usePerformanceStore((s) => s.objectives);
  const fetchObjectives = usePerformanceStore((s) => s.fetchObjectives);
  const createObjective = usePerformanceStore((s) => s.createObjective);
  const removeObjective = usePerformanceStore((s) => s.removeObjective);
  const createKeyResult = usePerformanceStore((s) => s.createKeyResult);
  const updateKeyResult = usePerformanceStore((s) => s.updateKeyResult);
  const removeKeyResult = usePerformanceStore((s) => s.removeKeyResult);

  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [title, setTitle] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [description, setDescription] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [krDrafts, setKrDrafts] = useState<Record<string, KrDraft>>({});
  // Key Results captured inside the "New Objective" modal itself, before the
  // objective even exists yet — an OKR with zero key results isn't useful, so this
  // lets the admin add them in the same step instead of having to save the objective
  // first and only then expand its row to add key results one at a time.
  const [newKrs, setNewKrs] = useState<KrDraft[]>([]);
  // "Goal Category" template picker — product ask: a blank goal form is
  // intimidating, so offer a standard starting point. Purely a local-state
  // autofill; nothing here touches the backend or schema.
  const [categoryKey, setCategoryKey] = useState<OkrCategoryKey | 'custom' | ''>('');

  useEffect(() => {
    fetchObjectives();
  }, [fetchObjectives]);

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name || id;

  function openCreate() {
    setEmployeeId('');
    setTitle('');
    setTitleEn('');
    setDescription('');
    setPeriodStart('');
    setPeriodEnd('');
    setNewKrs([]);
    setCategoryKey('');
    setOpen(true);
  }
  function handleCategoryChange(value: string) {
    const key = value as OkrCategoryKey | 'custom' | '';
    setCategoryKey(key);
    if (key === '' || key === 'custom') {
      // Custom / no selection — clear so the admin starts from a blank slate.
      setTitle('');
      setTitleEn('');
      setNewKrs([]);
      return;
    }
    const tpl = OKR_CATEGORY_TEMPLATES[key];
    setTitle(tpl.title);
    setTitleEn(tpl.title_en);
    setNewKrs(
      tpl.keyResults.map((kr) => ({
        title: kr.title,
        title_en: kr.title_en,
        metric_type: kr.metric_type,
        unit: kr.unit,
        target_value: '',
        weight: '1',
      }))
    );
  }
  function addNewKr() {
    setNewKrs((rows) => [...rows, { ...EMPTY_KR_DRAFT }]);
  }
  function updateNewKr(i: number, patch: Partial<KrDraft>) {
    setNewKrs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeNewKr(i: number) {
    setNewKrs((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setPageError(null);
    try {
      const objective = await createObjective({
        employee_id: employeeId || undefined,
        title,
        title_en: titleEn || undefined,
        description: description || undefined,
        period_start: periodStart,
        period_end: periodEnd,
      });
      for (const kr of newKrs) {
        if (!kr.title.trim()) continue;
        await createKeyResult(objective.id, {
          title: kr.title.trim(),
          title_en: kr.title_en || undefined,
          metric_type: kr.metric_type,
          unit: kr.unit || undefined,
          target_value: kr.target_value ? Number(kr.target_value) : undefined,
          weight: kr.weight ? Number(kr.weight) : undefined,
        });
      }
      setOpen(false);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteObjective(id: string) {
    if (!confirm(t.performance.deleteConfirm)) return;
    try {
      await removeObjective(id);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.deleteFailed);
    }
  }

  function draftFor(objectiveId: string): KrDraft {
    return krDrafts[objectiveId] ?? EMPTY_KR_DRAFT;
  }
  function patchDraft(objectiveId: string, patch: Partial<KrDraft>) {
    setKrDrafts((d) => ({ ...d, [objectiveId]: { ...draftFor(objectiveId), ...patch } }));
  }
  async function handleAddKeyResult(objectiveId: string) {
    const draft = draftFor(objectiveId);
    if (!draft.title.trim()) return;
    try {
      await createKeyResult(objectiveId, {
        title: draft.title.trim(),
        metric_type: draft.metric_type,
        unit: draft.unit || undefined,
        target_value: draft.target_value ? Number(draft.target_value) : undefined,
        weight: draft.weight ? Number(draft.weight) : undefined,
      });
      setKrDrafts((d) => ({ ...d, [objectiveId]: EMPTY_KR_DRAFT }));
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    }
  }
  async function handleKrCurrentChange(objectiveId: string, krId: string, value: string) {
    try {
      await updateKeyResult(krId, { current_value: Number(value) });
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.updateFailed);
    }
  }
  async function handleKrStatusChange(krId: string, status: string) {
    try {
      await updateKeyResult(krId, { status: status as Objective['key_results'][number]['status'] });
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.updateFailed);
    }
  }
  async function handleRemoveKr(krId: string) {
    if (!confirm(t.performance.deleteConfirm)) return;
    try {
      await removeKeyResult(krId);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.deleteFailed);
    }
  }

  function statusLabel(status: OKRStatus) {
    return status === 'draft'
      ? t.performance.statusDraft
      : status === 'active'
        ? t.performance.statusActive
        : status === 'completed'
          ? t.performance.statusCompleted
          : t.performance.statusCancelled;
  }
  function statusTag(status: OKRStatus) {
    const color = status === 'completed' ? 'green' : status === 'cancelled' ? 'gray' : status === 'active' ? 'amber' : 'gray';
    return <Tag color={color}>{statusLabel(status)}</Tag>;
  }

  return (
    <div>
      <div className="section-title-row">
        <span className="muted">{objectives.length}</span>
        <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
          <IconPlus /> {t.performance.newObjective}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.performance.employeeCol}</th>
                <th>{t.performance.objectiveTitle}</th>
                <th>{t.performance.periodStart}</th>
                <th>{t.performance.periodEnd}</th>
                <th className="num">{t.performance.progress}</th>
                <th>{t.performance.statusCol}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {objectives.map((o) => (
                <Fragment key={o.id}>
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setExpandedId(expandedId === o.id ? null : o.id)}>
                    <td>{o.employee_name || employeeName(o.employee_id)}</td>
                    <td style={{ fontWeight: 700 }}>{o.title}</td>
                    <td>{o.period_start}</td>
                    <td>{o.period_end}</td>
                    <td className="num">{o.progress_pct}%</td>
                    <td>{statusTag(o.status)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title={t.common.delete} onClick={(e) => { e.stopPropagation(); handleDeleteObjective(o.id); }}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                  {expandedId === o.id && (
                    <tr>
                      <td colSpan={7} style={{ backgroundColor: '#fafaf9', padding: '12px 16px' }}>
                        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{t.performance.keyResultsTitle}</div>
                        {o.key_results.length > 0 && (
                          <table className="data-table" style={{ marginBottom: 10 }}>
                            <thead>
                              <tr>
                                <th>{t.performance.krTitle}</th>
                                <th>{t.performance.krMetricType}</th>
                                <th className="num">{t.performance.krTarget}</th>
                                <th className="num">{t.performance.krCurrent}</th>
                                <th className="num">{t.performance.krWeight}</th>
                                <th>{t.performance.krStatus}</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {o.key_results.map((kr) => (
                                <tr key={kr.id}>
                                  <td>{kr.title}{kr.unit ? ` (${kr.unit})` : ''}</td>
                                  <td>
                                    {kr.metric_type === 'number' && t.performance.metricNumber}
                                    {kr.metric_type === 'percentage' && t.performance.metricPercentage}
                                    {kr.metric_type === 'currency' && t.performance.metricCurrency}
                                    {kr.metric_type === 'boolean' && t.performance.metricBoolean}
                                  </td>
                                  <td className="num">{kr.target_value ?? '—'}</td>
                                  <td className="num">
                                    <input
                                      type="number"
                                      style={{ width: 90 }}
                                      defaultValue={kr.current_value}
                                      onBlur={(e) => handleKrCurrentChange(o.id, kr.id, e.target.value)}
                                    />
                                  </td>
                                  <td className="num">{kr.weight}</td>
                                  <td>
                                    <select value={kr.status} onChange={(e) => handleKrStatusChange(kr.id, e.target.value)}>
                                      <option value="on_track">{t.performance.krStatusOnTrack}</option>
                                      <option value="at_risk">{t.performance.krStatusAtRisk}</option>
                                      <option value="off_track">{t.performance.krStatusOffTrack}</option>
                                      <option value="done">{t.performance.krStatusDone}</option>
                                    </select>
                                  </td>
                                  <td>
                                    <button className="icon-btn" onClick={() => handleRemoveKr(kr.id)}>
                                      <IconTrash />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <div className="form-row" style={{ alignItems: 'center' }}>
                          <div className="field" style={{ flex: 2 }}>
                            <input
                              placeholder={t.performance.krTitle}
                              value={draftFor(o.id).title}
                              onChange={(e) => patchDraft(o.id, { title: e.target.value })}
                            />
                          </div>
                          <div className="field" style={{ width: 130 }}>
                            <select value={draftFor(o.id).metric_type} onChange={(e) => patchDraft(o.id, { metric_type: e.target.value as MetricType })}>
                              <option value="number">{t.performance.metricNumber}</option>
                              <option value="percentage">{t.performance.metricPercentage}</option>
                              <option value="currency">{t.performance.metricCurrency}</option>
                              <option value="boolean">{t.performance.metricBoolean}</option>
                            </select>
                          </div>
                          <div className="field" style={{ width: 90 }}>
                            <input placeholder={t.performance.krUnit} value={draftFor(o.id).unit} onChange={(e) => patchDraft(o.id, { unit: e.target.value })} />
                          </div>
                          <div className="field" style={{ width: 90 }}>
                            <input
                              type="number"
                              placeholder={t.performance.krTarget}
                              value={draftFor(o.id).target_value}
                              onChange={(e) => patchDraft(o.id, { target_value: e.target.value })}
                            />
                          </div>
                          <div className="field" style={{ width: 70 }}>
                            <input
                              type="number"
                              placeholder={t.performance.krWeight}
                              value={draftFor(o.id).weight}
                              onChange={(e) => patchDraft(o.id, { weight: e.target.value })}
                            />
                          </div>
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleAddKeyResult(o.id)}>
                            <IconPlus /> {t.performance.addKeyResult}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {objectives.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <div>{t.performance.objectivesEmpty}</div>
                      <button className="btn btn-primary btn-sm" type="button" onClick={openCreate} style={{ marginTop: 10 }}>
                        <IconPlus /> {t.performance.newObjective}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.performance.newObjective}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="okr-form" disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="okr-form" onSubmit={handleCreate} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.performance.goalCategoryLabel}</label>
              <select value={categoryKey} onChange={(e) => handleCategoryChange(e.target.value)}>
                <option value="">{t.performance.goalCategoryPlaceholder}</option>
                <option value="sales">{t.performance.categorySales}</option>
                <option value="customerSuccess">{t.performance.categoryCustomerSuccess}</option>
                <option value="operational">{t.performance.categoryOperational}</option>
                <option value="custom">{t.performance.templateCustom}</option>
              </select>
            </div>
            <div className="field">
              <label>{t.performance.objectiveEmployee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                <option value="">{t.payroll.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.performance.objectiveTitle}</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.performance.objectiveTitleEn}</label>
              <input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.performance.periodStart}</label>
              <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.performance.periodEnd}</label>
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.performance.objectiveDescription}</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>
          </form>

          <div className="hr" />
          <div className="section-title-row">
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.performance.keyResultsTitle}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={addNewKr}>
              <IconPlus /> {t.performance.addKeyResult}
            </button>
          </div>
          {newKrs.map((kr, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 8 }}>
              <div className="field" style={{ flex: 2 }}>
                <input placeholder={t.performance.krTitle} value={kr.title} onChange={(e) => updateNewKr(i, { title: e.target.value })} />
              </div>
              <div className="field" style={{ width: 130 }}>
                <select value={kr.metric_type} onChange={(e) => updateNewKr(i, { metric_type: e.target.value as MetricType })}>
                  <option value="number">{t.performance.metricNumber}</option>
                  <option value="percentage">{t.performance.metricPercentage}</option>
                  <option value="currency">{t.performance.metricCurrency}</option>
                  <option value="boolean">{t.performance.metricBoolean}</option>
                </select>
              </div>
              <div className="field" style={{ width: 90 }}>
                <input placeholder={t.performance.krUnit} value={kr.unit} onChange={(e) => updateNewKr(i, { unit: e.target.value })} />
              </div>
              <div className="field" style={{ width: 90 }}>
                <input
                  type="number"
                  placeholder={t.performance.krTarget}
                  value={kr.target_value}
                  onChange={(e) => updateNewKr(i, { target_value: e.target.value })}
                />
              </div>
              <div className="field" style={{ width: 70 }}>
                <input
                  type="number"
                  placeholder={t.performance.krWeight}
                  value={kr.weight}
                  onChange={(e) => updateNewKr(i, { weight: e.target.value })}
                />
              </div>
              <button className="icon-btn" type="button" onClick={() => removeNewKr(i)}>
                <IconTrash />
              </button>
            </div>
          ))}
          {newKrs.length === 0 && <p className="muted" style={{ fontSize: 12 }}>{t.performance.noKeyResultsYetHint}</p>}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Appraisal Forms
// ---------------------------------------------------------------------------------
function AppraisalsTab({ setPageError }: { setPageError: (e: string | null) => void }) {
  const t = useT();
  const forms = usePerformanceStore((s) => s.forms);
  const questionsByForm = usePerformanceStore((s) => s.questionsByForm);
  const fetchForms = usePerformanceStore((s) => s.fetchForms);
  const createForm = usePerformanceStore((s) => s.createForm);
  const removeForm = usePerformanceStore((s) => s.removeForm);
  const fetchQuestions = usePerformanceStore((s) => s.fetchQuestions);
  const createQuestion = usePerformanceStore((s) => s.createQuestion);
  const removeQuestion = usePerformanceStore((s) => s.removeQuestion);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [expandedFormId, setExpandedFormId] = useState<string | null>(null);
  const [qDraft, setQDraft] = useState({ question_text: '', question_type: 'rating' as const, max_score: '5', weight: '1' });
  // Questions captured inside the "New Form" modal itself, before the form even
  // exists yet — same reasoning as OkrTab's newKrs: a form with zero questions isn't
  // useful, so let the admin add them in the same step instead of saving first and
  // only then expanding the row to add questions one at a time.
  const [newQuestions, setNewQuestions] = useState<{ question_text: string; question_text_en?: string; question_type: 'rating' | 'text' | 'scale'; max_score: string; weight: string }[]>(
    []
  );
  // "Template" picker — same product ask as OkrTab's categoryKey: a blank
  // appraisal form is intimidating, so offer a standard starting point. Purely
  // a local-state autofill; nothing here touches the backend or schema.
  const [templateKey, setTemplateKey] = useState<AppraisalTemplateKey | 'custom' | ''>('');
  const lang = useLangStore((s) => s.lang);

  useEffect(() => {
    fetchForms();
  }, [fetchForms]);

  function openCreate() {
    setName('');
    setNameEn('');
    setDescription('');
    setNewQuestions([]);
    setTemplateKey('');
    setOpen(true);
  }
  function handleTemplateChange(value: string) {
    const key = value as AppraisalTemplateKey | 'custom' | '';
    setTemplateKey(key);
    if (key === '' || key === 'custom') {
      // Custom / no selection — clear so the admin starts from a blank slate.
      setName('');
      setNameEn('');
      setDescription('');
      setNewQuestions([]);
      return;
    }
    const tpl = APPRAISAL_TEMPLATES[key];
    setName(tpl.name);
    setNameEn(tpl.name_en);
    setDescription(lang === 'ar' ? tpl.description_ar : tpl.description_en);
    setNewQuestions(
      tpl.questions.map((q) => ({
        question_text: q.question_text,
        question_text_en: q.question_text_en,
        question_type: q.question_type,
        max_score: String(q.max_score),
        weight: String(q.weight),
      }))
    );
  }
  function addNewQuestion() {
    setNewQuestions((rows) => [...rows, { question_text: '', question_type: 'rating', max_score: '5', weight: '1' }]);
  }
  function updateNewQuestion(i: number, patch: Partial<{ question_text: string; question_text_en?: string; question_type: 'rating' | 'text' | 'scale'; max_score: string; weight: string }>) {
    setNewQuestions((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeNewQuestion(i: number) {
    setNewQuestions((rows) => rows.filter((_, idx) => idx !== i));
  }
  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setPageError(null);
    try {
      const form = await createForm({ name, name_en: nameEn || undefined, description: description || undefined });
      for (const q of newQuestions) {
        if (!q.question_text.trim()) continue;
        await createQuestion(form.id, {
          question_text: q.question_text.trim(),
          question_text_en: q.question_text_en || undefined,
          question_type: q.question_type,
          max_score: q.max_score ? Number(q.max_score) : undefined,
          weight: q.weight ? Number(q.weight) : undefined,
        });
      }
      setOpen(false);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    } finally {
      setSaving(false);
    }
  }
  async function handleDeleteForm(id: string) {
    if (!confirm(t.performance.deleteConfirm)) return;
    try {
      await removeForm(id);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.deleteFailed);
    }
  }
  function toggleExpand(formId: string) {
    if (expandedFormId === formId) {
      setExpandedFormId(null);
      return;
    }
    setExpandedFormId(formId);
    if (!questionsByForm[formId]) fetchQuestions(formId);
  }
  async function handleAddQuestion(formId: string) {
    if (!qDraft.question_text.trim()) return;
    try {
      await createQuestion(formId, {
        question_text: qDraft.question_text.trim(),
        question_type: qDraft.question_type,
        max_score: Number(qDraft.max_score) || 5,
        weight: Number(qDraft.weight) || 1,
      });
      setQDraft({ question_text: '', question_type: 'rating', max_score: '5', weight: '1' });
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    }
  }
  async function handleRemoveQuestion(id: string, formId: string) {
    if (!confirm(t.performance.deleteConfirm)) return;
    try {
      await removeQuestion(id, formId);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.deleteFailed);
    }
  }

  return (
    <div>
      <div className="section-title-row">
        <span className="muted">{forms.length}</span>
        <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
          <IconPlus /> {t.performance.newForm}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.performance.formName}</th>
                <th>{t.performance.formActive}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <Fragment key={f.id}>
                  <tr key={f.id} style={{ cursor: 'pointer' }} onClick={() => toggleExpand(f.id)}>
                    <td style={{ fontWeight: 700 }}>{f.name}</td>
                    <td>{f.is_active ? <Tag color="green">{t.performance.yesLabel}</Tag> : <Tag color="gray">{t.performance.noLabel}</Tag>}</td>
                    <td>
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); handleDeleteForm(f.id); }}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                  {expandedFormId === f.id && (
                    <tr>
                      <td colSpan={3} style={{ backgroundColor: '#fafaf9', padding: '12px 16px' }}>
                        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{t.performance.questionsTitle}</div>
                        {(questionsByForm[f.id] ?? []).length > 0 && (
                          <table className="data-table" style={{ marginBottom: 10 }}>
                            <thead>
                              <tr>
                                <th>{t.performance.questionText}</th>
                                <th>{t.performance.questionType}</th>
                                <th className="num">{t.performance.maxScore}</th>
                                <th className="num">{t.performance.weight}</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {(questionsByForm[f.id] ?? []).map((q) => (
                                <tr key={q.id}>
                                  <td>{q.question_text}</td>
                                  <td>
                                    {q.question_type === 'rating' && t.performance.typeRating}
                                    {q.question_type === 'text' && t.performance.typeText}
                                    {q.question_type === 'scale' && t.performance.typeScale}
                                  </td>
                                  <td className="num">{q.max_score}</td>
                                  <td className="num">{q.weight}</td>
                                  <td>
                                    <button className="icon-btn" onClick={() => handleRemoveQuestion(q.id, f.id)}>
                                      <IconTrash />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {(questionsByForm[f.id] ?? []).length === 0 && (
                          <div className="empty-state" style={{ marginBottom: 10 }}>
                            {t.performance.questionsEmpty}
                          </div>
                        )}
                        <div className="form-row">
                          <div className="field" style={{ flex: 2 }}>
                            <input
                              placeholder={t.performance.questionText}
                              value={qDraft.question_text}
                              onChange={(e) => setQDraft((d) => ({ ...d, question_text: e.target.value }))}
                            />
                          </div>
                          <div className="field" style={{ width: 110 }}>
                            <select
                              value={qDraft.question_type}
                              onChange={(e) => setQDraft((d) => ({ ...d, question_type: e.target.value as typeof d.question_type }))}
                            >
                              <option value="rating">{t.performance.typeRating}</option>
                              <option value="text">{t.performance.typeText}</option>
                              <option value="scale">{t.performance.typeScale}</option>
                            </select>
                          </div>
                          <div className="field" style={{ width: 90 }}>
                            <input
                              type="number"
                              placeholder={t.performance.maxScore}
                              value={qDraft.max_score}
                              onChange={(e) => setQDraft((d) => ({ ...d, max_score: e.target.value }))}
                            />
                          </div>
                          <div className="field" style={{ width: 70 }}>
                            <input
                              type="number"
                              placeholder={t.performance.weight}
                              value={qDraft.weight}
                              onChange={(e) => setQDraft((d) => ({ ...d, weight: e.target.value }))}
                            />
                          </div>
                          <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleAddQuestion(f.id)}>
                            <IconPlus /> {t.performance.addQuestion}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {forms.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <div className="empty-state">
                      <div>{t.performance.formsEmpty}</div>
                      <button className="btn btn-primary btn-sm" type="button" onClick={openCreate} style={{ marginTop: 10 }}>
                        <IconPlus /> {t.performance.newForm}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.performance.newForm}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="appraisal-form-form" disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="appraisal-form-form" onSubmit={handleCreate} className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.performance.templateLabel}</label>
              <select value={templateKey} onChange={(e) => handleTemplateChange(e.target.value)}>
                <option value="">{t.performance.templatePickPlaceholder}</option>
                <option value="annual360">{t.performance.templateAnnual360}</option>
                <option value="quarterly">{t.performance.templateQuarterly}</option>
                <option value="probationary">{t.performance.templateProbationary}</option>
                <option value="custom">{t.performance.templateCustom}</option>
              </select>
            </div>
            <div className="field">
              <label>{t.performance.formName}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.performance.formNameEn}</label>
              <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.performance.formDescription}</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>
          </form>

          <div className="hr" />
          <div className="section-title-row">
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--stone-500)' }}>{t.performance.questionsTitle}</span>
            <button className="btn btn-secondary btn-sm" type="button" onClick={addNewQuestion}>
              <IconPlus /> {t.performance.addQuestion}
            </button>
          </div>
          {newQuestions.map((q, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 8 }}>
              <div className="field" style={{ flex: 2 }}>
                <input
                  placeholder={t.performance.questionText}
                  value={q.question_text}
                  onChange={(e) => updateNewQuestion(i, { question_text: e.target.value })}
                />
              </div>
              <div className="field" style={{ width: 110 }}>
                <select value={q.question_type} onChange={(e) => updateNewQuestion(i, { question_type: e.target.value as 'rating' | 'text' | 'scale' })}>
                  <option value="rating">{t.performance.typeRating}</option>
                  <option value="text">{t.performance.typeText}</option>
                  <option value="scale">{t.performance.typeScale}</option>
                </select>
              </div>
              <div className="field" style={{ width: 90 }}>
                <input
                  type="number"
                  placeholder={t.performance.maxScore}
                  value={q.max_score}
                  onChange={(e) => updateNewQuestion(i, { max_score: e.target.value })}
                />
              </div>
              <div className="field" style={{ width: 70 }}>
                <input
                  type="number"
                  placeholder={t.performance.weight}
                  value={q.weight}
                  onChange={(e) => updateNewQuestion(i, { weight: e.target.value })}
                />
              </div>
              <button className="icon-btn" type="button" onClick={() => removeNewQuestion(i)}>
                <IconTrash />
              </button>
            </div>
          ))}
          {newQuestions.length === 0 && <p className="muted" style={{ fontSize: 12 }}>{t.performance.noQuestionsYetHint}</p>}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Feedback Cycles
// ---------------------------------------------------------------------------------
function FeedbackTab({ employees, setPageError }: { employees: EmployeeOption[]; setPageError: (e: string | null) => void }) {
  const t = useT();
  const cycles = usePerformanceStore((s) => s.cycles);
  const forms = usePerformanceStore((s) => s.forms);
  const requests = usePerformanceStore((s) => s.requests);
  const fetchCycles = usePerformanceStore((s) => s.fetchCycles);
  const fetchForms = usePerformanceStore((s) => s.fetchForms);
  const createCycle = usePerformanceStore((s) => s.createCycle);
  const updateCycle = usePerformanceStore((s) => s.updateCycle);
  const createRequests = usePerformanceStore((s) => s.createRequests);
  const fetchRequests = usePerformanceStore((s) => s.fetchRequests);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [formId, setFormId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [saving, setSaving] = useState(false);

  const [assignCycle, setAssignCycle] = useState<FeedbackCycle | null>(null);
  const [assignRows, setAssignRows] = useState<{ subject_employee_id: string; reviewer_employee_id: string; reviewer_type: ReviewerType }[]>([]);
  const [assignSaving, setAssignSaving] = useState(false);

  useEffect(() => {
    fetchCycles();
    fetchForms();
  }, [fetchCycles, fetchForms]);

  function openCreate() {
    setName('');
    setNameEn('');
    setFormId('');
    setPeriodStart('');
    setPeriodEnd('');
    setOpen(true);
  }
  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setPageError(null);
    try {
      await createCycle({ name, name_en: nameEn || undefined, form_id: formId || undefined, period_start: periodStart, period_end: periodEnd });
      setOpen(false);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    } finally {
      setSaving(false);
    }
  }
  async function handleStatusChange(cycle: FeedbackCycle, status: CycleStatus) {
    try {
      await updateCycle(cycle.id, { status });
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.updateFailed);
    }
  }

  function openAssign(cycle: FeedbackCycle) {
    setAssignCycle(cycle);
    setAssignRows([{ subject_employee_id: '', reviewer_employee_id: '', reviewer_type: 'peer' }]);
    fetchRequests({ cycle_id: cycle.id });
  }
  function addAssignRow() {
    setAssignRows((r) => [...r, { subject_employee_id: '', reviewer_employee_id: '', reviewer_type: 'peer' }]);
  }
  function patchAssignRow(i: number, patch: Partial<{ subject_employee_id: string; reviewer_employee_id: string; reviewer_type: ReviewerType }>) {
    setAssignRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeAssignRow(i: number) {
    setAssignRows((rows) => rows.filter((_, idx) => idx !== i));
  }
  async function handleSaveAssignments() {
    if (!assignCycle) return;
    const valid = assignRows.filter((r) => r.subject_employee_id && r.reviewer_employee_id);
    if (valid.length === 0) return;
    setAssignSaving(true);
    setPageError(null);
    try {
      await createRequests(assignCycle.id, valid);
      setAssignRows([{ subject_employee_id: '', reviewer_employee_id: '', reviewer_type: 'peer' }]);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    } finally {
      setAssignSaving(false);
    }
  }

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name || id;
  function cycleStatusLabel(status: CycleStatus) {
    return status === 'draft' ? t.performance.cycleStatusDraft : status === 'open' ? t.performance.cycleStatusOpen : t.performance.cycleStatusClosed;
  }

  return (
    <div>
      <div className="section-title-row">
        <span className="muted">{cycles.length}</span>
        <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
          <IconPlus /> {t.performance.newCycle}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.performance.cycleName}</th>
                <th>{t.performance.periodStart}</th>
                <th>{t.performance.periodEnd}</th>
                <th>{t.performance.cycleStatus}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 700 }}>{c.name}</td>
                  <td>{c.period_start}</td>
                  <td>{c.period_end}</td>
                  <td>
                    <select value={c.status} onChange={(e) => handleStatusChange(c, e.target.value as CycleStatus)}>
                      <option value="draft">{t.performance.cycleStatusDraft}</option>
                      <option value="open">{t.performance.cycleStatusOpen}</option>
                      <option value="closed">{t.performance.cycleStatusClosed}</option>
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => openAssign(c)}>
                      {t.performance.assignReviewers}
                    </button>
                  </td>
                </tr>
              ))}
              {cycles.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">
                      <div>{t.performance.cyclesEmpty}</div>
                      <button className="btn btn-primary btn-sm" type="button" onClick={openCreate} style={{ marginTop: 10 }}>
                        <IconPlus /> {t.performance.newCycle}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.performance.newCycle}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="cycle-form" disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="cycle-form" onSubmit={handleCreate} className="field-grid">
            <div className="field">
              <label>{t.performance.cycleName}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.performance.cycleNameEn}</label>
              <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.performance.cycleForm}</label>
              <select value={formId} onChange={(e) => setFormId(e.target.value)}>
                <option value="">{t.performance.cycleFormNone}</option>
                {forms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.performance.periodStart}</label>
              <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t.performance.periodEnd}</label>
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
            </div>
          </form>
        </Modal>
      )}

      {assignCycle && (
        <Modal title={t.performance.assignReviewersTitle(assignCycle.name)} onClose={() => setAssignCycle(null)}>
          {requests.filter((r) => r.cycle_id === assignCycle.id).length > 0 && (
            <p className="muted" style={{ fontSize: 12 }}>
              {t.performance.requestsForCycle(requests.filter((r) => r.cycle_id === assignCycle.id).length)}
            </p>
          )}
          {assignRows.map((row, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <select value={row.subject_employee_id} onChange={(e) => patchAssignRow(i, { subject_employee_id: e.target.value })}>
                  <option value="">{t.performance.subjectEmployee}</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <select value={row.reviewer_employee_id} onChange={(e) => patchAssignRow(i, { reviewer_employee_id: e.target.value })}>
                  <option value="">{t.performance.reviewerEmployee}</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ width: 130 }}>
                <select value={row.reviewer_type} onChange={(e) => patchAssignRow(i, { reviewer_type: e.target.value as ReviewerType })}>
                  <option value="self">{t.performance.reviewerSelf}</option>
                  <option value="manager">{t.performance.reviewerManager}</option>
                  <option value="peer">{t.performance.reviewerPeer}</option>
                  <option value="subordinate">{t.performance.reviewerSubordinate}</option>
                  <option value="external">{t.performance.reviewerExternal}</option>
                </select>
              </div>
              <button className="icon-btn" type="button" onClick={() => removeAssignRow(i)}>
                <IconTrash />
              </button>
            </div>
          ))}
          <div className="section-title-row">
            <button className="btn btn-secondary btn-sm" type="button" onClick={addAssignRow}>
              <IconPlus /> {t.performance.addAssignmentRow}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveAssignments} disabled={assignSaving}>
              {assignSaving ? t.common.loading : t.performance.saveAssignments}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Performance Scores
// ---------------------------------------------------------------------------------
function ScoresTab({ employees, setPageError }: { employees: EmployeeOption[]; setPageError: (e: string | null) => void }) {
  const t = useT();
  const scores = usePerformanceStore((s) => s.scores);
  const cycles = usePerformanceStore((s) => s.cycles);
  const fetchScores = usePerformanceStore((s) => s.fetchScores);
  const fetchCycles = usePerformanceStore((s) => s.fetchCycles);
  const upsertScore = usePerformanceStore((s) => s.upsertScore);
  const finalizeScore = usePerformanceStore((s) => s.finalizeScore);

  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [okrScore, setOkrScore] = useState('');
  const [feedbackScore, setFeedbackScore] = useState('');
  const [finalScore, setFinalScore] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const [finalizeTarget, setFinalizeTarget] = useState<PerformanceScore | null>(null);
  const [payrollOptions, setPayrollOptions] = useState<PayrollOption[]>([]);
  const [selectedPayrollId, setSelectedPayrollId] = useState('');
  const [finalizeSaving, setFinalizeSaving] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  useEffect(() => {
    fetchScores();
    fetchCycles();
  }, [fetchScores, fetchCycles]);

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name || id;

  function openCreate() {
    setEmployeeId('');
    setCycleId('');
    setOkrScore('');
    setFeedbackScore('');
    setFinalScore('');
    setBonusAmount('');
    setOpen(true);
  }
  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setPageError(null);
    try {
      await upsertScore({
        employee_id: employeeId,
        cycle_id: cycleId,
        okr_score: okrScore ? Number(okrScore) : undefined,
        feedback_score: feedbackScore ? Number(feedbackScore) : undefined,
        final_score: finalScore ? Number(finalScore) : undefined,
        bonus_amount: bonusAmount ? Number(bonusAmount) : undefined,
      });
      setOpen(false);
    } catch (err) {
      setPageError(err instanceof ApiError ? err.message : t.performance.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function openFinalize(score: PerformanceScore) {
    if (!score.bonus_amount || Number(score.bonus_amount) <= 0) {
      setPageError(t.performance.noBonusToFinalize);
      return;
    }
    if (score.payroll_adjustment_id) {
      setPageError(t.performance.alreadyFinalized);
      return;
    }
    setFinalizeTarget(score);
    setSelectedPayrollId('');
    setFinalizeError(null);
    try {
      const r = await get<{ payroll: PayrollOption[] }>('/payroll');
      setPayrollOptions(r.payroll.filter((p) => p.employee_id === score.employee_id));
    } catch {
      setPayrollOptions([]);
    }
  }
  async function handleFinalize() {
    if (!finalizeTarget || !selectedPayrollId) return;
    setFinalizeSaving(true);
    setFinalizeError(null);
    try {
      await finalizeScore(finalizeTarget.id, selectedPayrollId);
      setFinalizeTarget(null);
    } catch (err) {
      setFinalizeError(err instanceof ApiError ? err.message : t.performance.finalizeFailed);
    } finally {
      setFinalizeSaving(false);
    }
  }

  return (
    <div>
      <div className="section-title-row">
        <span className="muted">{scores.length}</span>
        <button className="btn btn-primary btn-sm" type="button" onClick={openCreate}>
          <IconPlus /> {t.performance.newScore}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.performance.employeeCol}</th>
                <th className="num">{t.performance.okrScore}</th>
                <th className="num">{t.performance.feedbackScore}</th>
                <th className="num">{t.performance.finalScoreLabel}</th>
                <th className="num">{t.performance.bonusAmount}</th>
                <th>{t.performance.statusCol}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 700 }}>{s.employee_name || employeeName(s.employee_id)}</td>
                  <td className="num">{s.okr_score ?? '—'}</td>
                  <td className="num">{s.feedback_score ?? '—'}</td>
                  <td className="num">{s.final_score ?? '—'}</td>
                  <td className="num">{Number(s.bonus_amount || 0).toFixed(3)} KD</td>
                  <td>
                    {s.payroll_adjustment_id ? (
                      <Tag color="green">{t.performance.statusFinalized}</Tag>
                    ) : (
                      <Tag color="gray">{t.performance.statusDraftScore}</Tag>
                    )}
                  </td>
                  <td>
                    {!s.payroll_adjustment_id && (
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => openFinalize(s)}>
                        {t.performance.finalize}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {scores.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <div>{t.performance.scoresEmpty}</div>
                      <button className="btn btn-primary btn-sm" type="button" onClick={openCreate} style={{ marginTop: 10 }}>
                        <IconPlus /> {t.performance.newScore}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <Modal
          title={t.performance.newScore}
          onClose={() => setOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="score-form" disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="score-form" onSubmit={handleCreate} className="field-grid">
            <div className="field">
              <label>{t.performance.scoreEmployee}</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                <option value="">{t.payroll.selectEmployee}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.performance.scoreCycle}</label>
              <select value={cycleId} onChange={(e) => setCycleId(e.target.value)} required>
                <option value="">{t.performance.selectCyclePlaceholder}</option>
                {cycles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t.performance.okrScore}</label>
              <input type="number" step="0.01" value={okrScore} onChange={(e) => setOkrScore(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.performance.feedbackScore}</label>
              <input type="number" step="0.01" value={feedbackScore} onChange={(e) => setFeedbackScore(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.performance.finalScoreLabel}</label>
              <input type="number" step="0.01" value={finalScore} onChange={(e) => setFinalScore(e.target.value)} />
            </div>
            <div className="field">
              <label>{t.performance.bonusAmount}</label>
              <input type="number" step="0.001" value={bonusAmount} onChange={(e) => setBonusAmount(e.target.value)} />
            </div>
          </form>
        </Modal>
      )}

      {finalizeTarget && (
        <Modal
          title={t.performance.finalizeModalTitle}
          onClose={() => setFinalizeTarget(null)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="button" onClick={handleFinalize} disabled={finalizeSaving || !selectedPayrollId}>
                {finalizeSaving ? t.common.loading : t.performance.finalizeBtn}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          {finalizeError && <div className="error-banner">{finalizeError}</div>}
          <p className="muted" style={{ fontSize: 13 }}>{t.performance.finalizeHint}</p>
          <div className="field">
            <label>{t.performance.selectPayrollRecord}</label>
            <select value={selectedPayrollId} onChange={(e) => setSelectedPayrollId(e.target.value)}>
              <option value="">{t.performance.selectPayrollPlaceholder}</option>
              {payrollOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.month_year}
                </option>
              ))}
            </select>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{t.performance.finalizeSuccessNote}</p>
        </Modal>
      )}
    </div>
  );
}
