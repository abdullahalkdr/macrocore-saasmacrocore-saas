import { create } from 'zustand';
import { get, ApiError } from '../api/client';

export interface TicketCategory {
  id: string;
  name: string;
  name_en: string | null;
  is_hr_sensitive: boolean;
  created_at: string;
  updated_at: string;
}

interface TicketCategoriesState {
  categories: TicketCategory[];
  loading: boolean;
  error: string | null;
  fetchCategories: () => Promise<void>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Server state, no persist — matches useSLAStore/usePolicyStore (server data goes
// stale the moment another tab/user edits it).
//
// Read-only on purpose: Step 3's brief was consuming categories in the ticket
// create/detail flows, not a categories admin CRUD screen. The backend already
// has POST/PUT/DELETE /api/ticket-categories (Step 2) with no frontend caller
// yet — that's a follow-up, not something dropped silently.
export const useTicketCategoriesStore = create<TicketCategoriesState>()((set) => ({
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
}));
