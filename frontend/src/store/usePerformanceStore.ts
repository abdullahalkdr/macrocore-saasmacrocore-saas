import { create } from 'zustand';
import { get, post, patch, del, ApiError } from '../api/client';

// Server-data Zustand store (first of its kind in this codebase besides authStore,
// which is client-auth state with `persist`). No persist middleware here on purpose —
// this is always-refetch server data, not something that should survive a refresh
// stale. Convention: create/update/remove/finalize actions call the API directly and
// let errors propagate (the calling component's own try/catch — same pattern already
// used everywhere else, e.g. PayrollPage.handleSubmit — sets its own inline error
// banner), then re-fetch the affected list from the server as the single source of
// truth instead of hand-patching nested state. fetch* actions catch their own errors
// into `error` for background/page-load failures.

export type OKRStatus = 'draft' | 'active' | 'completed' | 'cancelled';
export type KeyResultStatus = 'on_track' | 'at_risk' | 'off_track' | 'done';
export type MetricType = 'number' | 'percentage' | 'currency' | 'boolean';

export interface KeyResult {
  id: string;
  objective_id: string;
  title: string;
  title_en: string | null;
  metric_type: MetricType;
  unit: string | null;
  target_value: number | null;
  current_value: number;
  weight: number;
  status: KeyResultStatus;
  created_at: string;
  updated_at: string;
}

export interface Objective {
  id: string;
  employee_id: string;
  employee_name?: string;
  title: string;
  title_en: string | null;
  description: string | null;
  period_start: string;
  period_end: string;
  status: OKRStatus;
  progress_pct: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  key_results: KeyResult[];
}

export type QuestionType = 'rating' | 'text' | 'scale';

export interface AppraisalForm {
  id: string;
  name: string;
  name_en: string | null;
  description: string | null;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AppraisalQuestion {
  id: string;
  form_id: string;
  question_text: string;
  question_text_en: string | null;
  question_type: QuestionType;
  max_score: number;
  weight: number;
  sort_order: number;
  created_at: string;
}

export type CycleStatus = 'draft' | 'open' | 'closed';
export type ReviewerType = 'self' | 'manager' | 'peer' | 'subordinate' | 'external';

export interface FeedbackCycle {
  id: string;
  form_id: string | null;
  name: string;
  name_en: string | null;
  period_start: string;
  period_end: string;
  status: CycleStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface FeedbackRequest {
  id: string;
  cycle_id: string;
  cycle_name?: string;
  subject_employee_id: string;
  subject_name?: string;
  reviewer_employee_id: string;
  reviewer_name?: string;
  reviewer_type: ReviewerType;
  status: string;
  overall_score: number | null;
  submitted_at: string | null;
  created_at: string;
}

export interface PerformanceScore {
  id: string;
  employee_id: string;
  employee_name?: string;
  cycle_id: string;
  okr_score: number | null;
  feedback_score: number | null;
  final_score: number | null;
  bonus_amount: number;
  payroll_adjustment_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PerformanceState {
  objectives: Objective[];
  forms: AppraisalForm[];
  questionsByForm: Record<string, AppraisalQuestion[]>;
  cycles: FeedbackCycle[];
  requests: FeedbackRequest[];
  scores: PerformanceScore[];
  loading: boolean;
  error: string | null;

  fetchObjectives: (params?: { employee_id?: string; status?: string }) => Promise<void>;
  createObjective: (data: {
    employee_id?: string;
    title: string;
    title_en?: string;
    description?: string;
    period_start: string;
    period_end: string;
  }) => Promise<Objective>;
  updateObjective: (id: string, patchData: Partial<Objective>) => Promise<void>;
  removeObjective: (id: string) => Promise<void>;
  createKeyResult: (
    objectiveId: string,
    data: { title: string; title_en?: string; metric_type?: MetricType; unit?: string; target_value?: number; weight?: number }
  ) => Promise<void>;
  updateKeyResult: (id: string, patchData: Partial<KeyResult>) => Promise<void>;
  removeKeyResult: (id: string) => Promise<void>;

  fetchForms: () => Promise<void>;
  createForm: (data: { name: string; name_en?: string; description?: string }) => Promise<AppraisalForm>;
  updateForm: (id: string, patchData: Partial<AppraisalForm>) => Promise<void>;
  removeForm: (id: string) => Promise<void>;

  fetchQuestions: (formId: string) => Promise<void>;
  createQuestion: (
    formId: string,
    data: { question_text: string; question_text_en?: string; question_type?: QuestionType; max_score?: number; weight?: number; sort_order?: number }
  ) => Promise<void>;
  updateQuestion: (id: string, formId: string, patchData: Partial<AppraisalQuestion>) => Promise<void>;
  removeQuestion: (id: string, formId: string) => Promise<void>;

  fetchCycles: () => Promise<void>;
  createCycle: (data: { name: string; name_en?: string; period_start: string; period_end: string; form_id?: string }) => Promise<FeedbackCycle>;
  updateCycle: (id: string, patchData: Partial<FeedbackCycle>) => Promise<void>;
  createRequests: (
    cycleId: string,
    requests: { subject_employee_id: string; reviewer_employee_id: string; reviewer_type?: ReviewerType }[]
  ) => Promise<void>;
  fetchRequests: (params?: { cycle_id?: string }) => Promise<void>;

  fetchScores: (params?: { employee_id?: string; cycle_id?: string }) => Promise<void>;
  upsertScore: (data: {
    employee_id: string;
    cycle_id: string;
    okr_score?: number;
    feedback_score?: number;
    final_score?: number;
    bonus_amount?: number;
  }) => Promise<void>;
  finalizeScore: (id: string, payrollId: string) => Promise<PerformanceScore>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}
function qs(params?: Record<string, string | undefined>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0);
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

export const usePerformanceStore = create<PerformanceState>()((set, getStore) => ({
  objectives: [],
  forms: [],
  questionsByForm: {},
  cycles: [],
  requests: [],
  scores: [],
  loading: false,
  error: null,

  fetchObjectives: async (params) => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ objectives: Objective[] }>(`/okr/objectives${qs(params)}`);
      set({ objectives: r.objectives, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load OKRs'), loading: false });
    }
  },
  createObjective: async (data) => {
    const r = await post<{ objective: Objective }>('/okr/objectives', data);
    await getStore().fetchObjectives();
    return r.objective;
  },
  updateObjective: async (id, patchData) => {
    await patch(`/okr/objectives/${id}`, patchData);
    await getStore().fetchObjectives();
  },
  removeObjective: async (id) => {
    await del(`/okr/objectives/${id}`);
    await getStore().fetchObjectives();
  },
  createKeyResult: async (objectiveId, data) => {
    await post(`/okr/objectives/${objectiveId}/key-results`, data);
    await getStore().fetchObjectives();
  },
  updateKeyResult: async (id, patchData) => {
    await patch(`/okr/key-results/${id}`, patchData);
    await getStore().fetchObjectives();
  },
  removeKeyResult: async (id) => {
    await del(`/okr/key-results/${id}`);
    await getStore().fetchObjectives();
  },

  fetchForms: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ forms: AppraisalForm[] }>('/appraisals/forms');
      set({ forms: r.forms, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load appraisal forms'), loading: false });
    }
  },
  createForm: async (data) => {
    const r = await post<{ form: AppraisalForm }>('/appraisals/forms', data);
    await getStore().fetchForms();
    return r.form;
  },
  updateForm: async (id, patchData) => {
    await patch(`/appraisals/forms/${id}`, patchData);
    await getStore().fetchForms();
  },
  removeForm: async (id) => {
    await del(`/appraisals/forms/${id}`);
    await getStore().fetchForms();
  },

  fetchQuestions: async (formId) => {
    try {
      const r = await get<{ questions: AppraisalQuestion[] }>(`/appraisals/forms/${formId}/questions`);
      set((s) => ({ questionsByForm: { ...s.questionsByForm, [formId]: r.questions } }));
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load appraisal questions') });
    }
  },
  createQuestion: async (formId, data) => {
    await post(`/appraisals/forms/${formId}/questions`, data);
    await getStore().fetchQuestions(formId);
  },
  updateQuestion: async (id, formId, patchData) => {
    await patch(`/appraisals/questions/${id}`, patchData);
    await getStore().fetchQuestions(formId);
  },
  removeQuestion: async (id, formId) => {
    await del(`/appraisals/questions/${id}`);
    await getStore().fetchQuestions(formId);
  },

  fetchCycles: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ cycles: FeedbackCycle[] }>('/feedback/cycles');
      set({ cycles: r.cycles, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load feedback cycles'), loading: false });
    }
  },
  createCycle: async (data) => {
    const r = await post<{ cycle: FeedbackCycle }>('/feedback/cycles', data);
    await getStore().fetchCycles();
    return r.cycle;
  },
  updateCycle: async (id, patchData) => {
    await patch(`/feedback/cycles/${id}`, patchData);
    await getStore().fetchCycles();
  },
  createRequests: async (cycleId, requests) => {
    await post(`/feedback/cycles/${cycleId}/requests`, { requests });
    await getStore().fetchRequests({ cycle_id: cycleId });
  },
  fetchRequests: async (params) => {
    try {
      const r = await get<{ requests: FeedbackRequest[] }>(`/feedback/requests${qs(params)}`);
      set({ requests: r.requests });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load feedback requests') });
    }
  },

  fetchScores: async (params) => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ scores: PerformanceScore[] }>(`/performance-scores${qs(params)}`);
      set({ scores: r.scores, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load performance scores'), loading: false });
    }
  },
  upsertScore: async (data) => {
    await post('/performance-scores', data);
    await getStore().fetchScores();
  },
  finalizeScore: async (id, payrollId) => {
    const r = await post<{ score: PerformanceScore }>(`/performance-scores/${id}/finalize`, { payroll_id: payrollId });
    await getStore().fetchScores();
    return r.score;
  },
}));
