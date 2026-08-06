import { create } from 'zustand';

// Deliberately a plain (non-persisted) store, and deliberately callable outside React
// (api/client.ts imports useUpgradeModalStore.getState() directly, not the hook) —
// that's what lets a 403 PLAN_UPGRADE_REQUIRED anywhere in the app pop the same modal
// without every single page needing to catch that error itself.
interface UpgradeModalState {
  open: boolean;
  message: string | null;
  openModal: (message?: string) => void;
  closeModal: () => void;
}

export const useUpgradeModalStore = create<UpgradeModalState>((set) => ({
  open: false,
  message: null,
  openModal: (message) => set({ open: true, message: message ?? null }),
  closeModal: () => set({ open: false, message: null }),
}));
