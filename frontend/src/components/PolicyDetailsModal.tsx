import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import { ApiError } from '../api/client';
import Modal from './Modal';
import { usePolicyStore, PolicyRole, POLICY_ROLES } from '../store/usePolicyStore';

interface PolicyDetailsModalProps {
  policyId: string;
  onClose: () => void;
}

// Content view + role linking only — status transitions (submit/approve/archive) live
// on PoliciesPage's own row buttons, per how the spec split the two responsibilities.
export default function PolicyDetailsModal({ policyId, onClose }: PolicyDetailsModalProps) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const selected = usePolicyStore((s) => s.selected);
  const selectedLoading = usePolicyStore((s) => s.selectedLoading);
  const getPolicyDetails = usePolicyStore((s) => s.getPolicyDetails);
  const setRoles = usePolicyStore((s) => s.setRoles);

  const [checkedRoles, setCheckedRoles] = useState<PolicyRole[]>([]);
  const [rolesSaving, setRolesSaving] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesSaved, setRolesSaved] = useState(false);

  useEffect(() => {
    getPolicyDetails(policyId);
  }, [policyId, getPolicyDetails]);

  // Re-sync the checkbox draft whenever a fresh copy of THIS policy loads (initial
  // load, or after a save round-trips through getPolicyDetails again) — not on every
  // render, so mid-edit checkbox state isn't stomped by the still-stale `selected`
  // from the moment right after clicking a checkbox but before the save reload lands.
  useEffect(() => {
    if (selected && selected.id === policyId) setCheckedRoles(selected.linked_roles);
  }, [selected, policyId]);

  function toggleRole(role: PolicyRole) {
    setRolesSaved(false);
    setCheckedRoles((cur) => (cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role]));
  }

  async function handleSaveRoles() {
    if (checkedRoles.length === 0) return;
    setRolesSaving(true);
    setRolesError(null);
    try {
      await setRoles(policyId, checkedRoles);
      setRolesSaved(true);
      setTimeout(() => setRolesSaved(false), 2000);
    } catch (err) {
      setRolesError(err instanceof ApiError ? err.message : t.policies.rolesSaveFailed);
    } finally {
      setRolesSaving(false);
    }
  }

  const ROLE_LABELS: Record<PolicyRole, string> = {
    admin: t.policies.roleAdmin,
    manager: t.policies.roleManager,
    employee: t.policies.roleEmployee,
  };

  const displayName = selected ? (lang === 'en' && selected.name_en) || selected.name : '';
  const displayContent = selected ? (lang === 'en' && selected.content_en) || selected.content : '';

  return (
    <Modal title={displayName || t.policies.viewDetails} onClose={onClose} actions={<button className="btn btn-secondary" type="button" onClick={onClose}>{t.common.close}</button>}>
      {selectedLoading && !selected && <div className="empty-state">{t.common.loading}</div>}

      {selected && selected.id === policyId && (
        <div>
          <div className="muted" style={{ marginBottom: 12 }}>
            v{selected.version} · {t.policies.totalAcknowledged}: {selected.acknowledgment_summary.total_acknowledged}
            {' · '}
            {t.policies.lastAcknowledgedAt}:{' '}
            {selected.acknowledgment_summary.last_acknowledged_at
              ? new Date(selected.acknowledgment_summary.last_acknowledged_at).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB')
              : t.policies.never}
          </div>

          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.9, marginBottom: 20 }}>{displayContent}</div>

          {isManager && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>{t.policies.rolesTitle}</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
                {POLICY_ROLES.map((role) => (
                  <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={checkedRoles.includes(role)} onChange={() => toggleRole(role)} />
                    {ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
              {rolesError && <div className="error-banner">{rolesError}</div>}
              {checkedRoles.length === 0 && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t.policies.rolesRequireOne}</div>}
              <button className="btn btn-primary btn-sm" type="button" disabled={rolesSaving || checkedRoles.length === 0} onClick={handleSaveRoles}>
                {rolesSaving ? t.common.loading : t.policies.rolesSaveBtn}
              </button>
              {rolesSaved && <span className="badge open" style={{ marginInlineStart: 8 }}>{t.policies.rolesSaved}</span>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
