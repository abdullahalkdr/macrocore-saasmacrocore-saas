import { create } from 'zustand';
import { get, put, del, ApiError } from '../api/client';

export type SLAPriority = 'low' | 'medium' | 'high' | 'urgent';
export const SLA_PRIORITIES: SLAPriority[] = ['low', 'medium', 'high', 'urgent'];

export interface SLAPolicy {
  id: string;
  priority: SLAPriority;
  response_minutes: number;
  resolution_minutes: number;
  escalate_after_minutes: number | null;
  escalate_to_role: string;
  updated_at: string;
}

export interface SLASummaryRow {
  category: string;
  priority: SLAPriority;
  status: string;
  total: number;
  response_breached: number;
  resolution_breached: number;
  escalated: number;
}

interface SLAState {
  policies: SLAPolicy[];
  summary: SLASummaryRow[];
  loading: boolean;
  error: string | null;

  fetchPolicies: () => Promise<void>;
  upsertPolicy: (
    priority: SLAPriority,
    data: { response_minutes: number; resolution_minutes: number; escalate_after_minutes?: number | null; escalate_to_role?: string }
  ) => Promise<void>;
  removePolicy: (priority: SLAPriority) => Promise<void>;
  fetchSlaReport: () => Promise<void>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Mirrors usePerformanceStore's conventions: create/update/remove call the API and
// let the caller's own try/catch handle its own inline error banner (see
// SLAManagementPage), fetch* actions catch into `error` for background loads.
export const useSLAStore = create<SLAState>()((set, getStore) => ({
  policies: [],
  summary: [],
  loading: false,
  error: null,

  fetchPolicies: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ policies: SLAPolicy[] }>('/sla-policies');
      set({ policies: r.policies, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load SLA policies'), loading: false });
    }
  },
  upsertPolicy: async (priority, data) => {
    await put(`/sla-policies/${priority}`, data);
    await getStore().fetchPolicies();
  },
  removePolicy: async (priority) => {
    await del(`/sla-policies/${priority}`);
    await getStore().fetchPolicies();
  },
  fetchSlaReport: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ summary: SLASummaryRow[] }>('/support/tickets/sla-report');
      set({ summary: r.summary, loading: false });
    } catch (err) {
      set({ error: errMsg(err, 'Failed to load SLA report'), loading: false });
    }
  },
}));
