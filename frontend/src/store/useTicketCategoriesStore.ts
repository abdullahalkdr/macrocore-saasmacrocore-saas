import { create } from 'zustand';
import { get, post, put, del, ApiError } from '../api/client';

export interface TicketCategory {
  id: string;
  name: string;
  name_en: string | null;
  is_hr_sensitive: boolean;
  created_at: string;
  updated_at: string;
}

export interface TicketCategoryInput {
  name: string;
  name_en?: string | null;
  is_hr_sensitive?: boolean;
}

interface TicketCategoriesState {
  categories: TicketCategory[];
  loading: boolean;
  error: string | null;
  fetchCategories: () => Promise<void>;
  createCategory: (data: TicketCategoryInput) => Promise<void>;
  updateCategory: (id: string, data: Partial<TicketCategoryInput>) => Promise<void>;
  removeCategory: (id: string) => Promise<void>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Server state, no persist — matches useSLAStore/usePolicyStore (server data goes
// stale the moment another tab/user edits it).
//
// fetchCategories is consumed by SupportTicketsPage's ticket create/detail flows
// (Step 3). create/update/remove were added later for the categories admin tab
// on the same page (admin/manager only) — mirrors useSLAStore's
// call-API-then-refetch convention: these three don't catch their own errors,
// the caller's own try/catch (see SupportTicketsPage's category handlers)
// surfaces an inline error banner instead.
export const useTicketCategoriesStore = create<TicketCategoriesState>()((set, getStore) => ({
  categories: [],
  loading: false,
  error: null,

  fetchCategories: async () => {
    set({ loading: true, error: null });
    try {
      const r = await get<{ categories: TicketCategory[] }>('/ticket-categories');
      set({ categories: r.categories, loading: false });
    } catch (err) {
      // Non-fatal: SupportTicketsPage falls back to the legacy hardcoded
      // category strings when this list is empty, so a failed fetch degrades
      // the create form instead of breaking the page.
      set({ error: errMsg(err, 'Failed to load categories'), loading: false, categories: [] });
    }
  },

  createCategory: async (data) => {
    await post('/ticket-categories', data);
    await getStore().fetchCategories();
  },

  updateCategory: async (id, data) => {
    await put(`/ticket-categories/${id}`, data);
    await getStore().fetchCategories();
  },

  removeCategory: async (id) => {
    await del(`/ticket-categories/${id}`);
    await getStore().fetchCategories();
  },
}));
