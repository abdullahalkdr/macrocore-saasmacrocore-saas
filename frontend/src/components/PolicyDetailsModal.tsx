import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import { ApiError } from '../api/client';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import { usePolicyStore, PolicyRole, POLICY_ROLES } from '../store/usePolicyStore';

interface PolicyDetailsModalProps {
  policyId: string;
  onClose: () => void;
}

// Policy Gate pilot (MIGRATION_074/075) — the one permission key that can currently be
// linked to a policy from this modal. Hand-maintained mirror of the backend's
// PILOT_GATED_PERMISSION_KEYS (permissions.controller.ts), same convention
// PermissionsPage.tsx's own PERMISSION_KEYS copy already follows — the backend stays
// the source of truth and 400s on anything else. Widen only after 'view_audit_log' is
// confirmed live, never on assumption.
const PILOT_GATED_PERMISSION_KEY = 'view_audit_log';

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
  const setPermissionGate = usePolicyStore((s) => s.setPermissionGate);

  const [checkedRoles, setCheckedRoles] = useState<PolicyRole[]>([]);
  const [rolesSaving, setRolesSaving] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [rolesSaved, setRolesSaved] = useState(false);
  // Policy Gate pilot — gateSaving covers both enable and disable; confirmingEnable
  // gates only the ENABLE path behind an extra click (see handleToggleGate below) —
  // disabling never silently replaces anything else, so it doesn't need one.
  const [gateSaving, setGateSaving] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  // Which language the CONTENT preview below is shown in — same reasoning as
  // AcknowledgmentModal: independent of the interface language (langStore's `lang`),
  // so a manager running the whole system in English can still switch to Arabic to
  // proofread that version (or vice versa) before publishing. Defaults to the
  // interface language, falling back to Arabic when this policy has no `content_en`.
  const [readLang, setReadLang] = useState<'ar' | 'en'>(lang);

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

  // Re-derive the preview language whenever a different policy's data lands —
  // translation availability differs policy to policy, so don't carry the previous
  // policy's readLang forward.
  useEffect(() => {
    if (selected && selected.id === policyId) {
      setReadLang(lang === 'en' && selected.content_en ? 'en' : 'ar');
    }
  }, [selected?.id, policyId]);

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

  // Policy Gate pilot — checking the box asks for confirmation first (it may silently
  // replace whichever policy currently gates this key — see setPermissionGate's own
  // comment in usePolicyStore.ts); unchecking (a real disable of THIS policy's gate)
  // never replaces anything else, so it goes straight through.
  function handleToggleGate(nextChecked: boolean) {
    setGateError(null);
    if (nextChecked) {
      setConfirmingEnable(true);
    } else {
      applyGateChange(false);
    }
  }

  async function applyGateChange(enabled: boolean) {
    setConfirmingEnable(false);
    setGateSaving(true);
    setGateError(null);
    try {
      await setPermissionGate(policyId, PILOT_GATED_PERMISSION_KEY, enabled);
    } catch (err) {
      setGateError(err instanceof ApiError ? err.message : t.policies.permissionGateSaveFailed);
    } finally {
      setGateSaving(false);
    }
  }

  const ROLE_LABELS: Record<PolicyRole, string> = {
    admin: t.policies.roleAdmin,
    manager: t.policies.roleManager,
    employee: t.policies.roleEmployee,
  };

  const hasEnglish = !!selected?.content_en;
  const displayName = selected ? (readLang === 'en' && selected.name_en) || selected.name : '';
  const displayContent = selected ? (readLang === 'en' && selected.content_en) || selected.content : '';

  return (
    <Modal title={displayName || t.policies.viewDetails} onClose={onClose} actions={<button className="btn btn-secondary" type="button" onClick={onClose}>{t.common.close}</button>}>
      {selectedLoading && !selected && <div className="empty-state">{t.common.loading}</div>}

      {selected && selected.id === policyId && (
        <div>
          <div className="muted" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span>
              v{selected.version} · {t.policies.totalAcknowledged}: {selected.acknowledgment_summary.total_acknowledged}
              {' · '}
              {t.policies.lastAcknowledgedAt}:{' '}
              {selected.acknowledgment_summary.last_acknowledged_at
                ? new Date(selected.acknowledgment_summary.last_acknowledged_at).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB')
                : t.policies.never}
            </span>
            {/* Only shown when this policy actually has an English version — nothing to
                toggle otherwise. Static "AR"/"EN" labels on purpose: these name a
                language, not interface chrome, so they don't run through t(). */}
            {hasEnglish && (
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${readLang === 'ar' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setReadLang('ar')}
                >
                  AR
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${readLang === 'en' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setReadLang('en')}
                >
                  EN
                </button>
              </div>
            )}
          </div>

          <div
            dir={readLang === 'ar' ? 'rtl' : 'ltr'}
            style={{ whiteSpace: 'pre-wrap', lineHeight: 1.9, marginBottom: 20, textAlign: readLang === 'ar' ? 'right' : 'left' }}
          >
            {displayContent}
          </div>

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

          {/* Policy Gate pilot (MIGRATION_074/075) — Step 3. Only an approved policy
              can be ENABLED as a gate (the checkbox stays disabled unless this policy
              already IS the gate, so an admin can still turn off a gate that's somehow
              linked to a non-approved policy, e.g. left over from before it was sent
              back to draft — updateStatus() already auto-cancels pending requests in
              that case, but doesn't clear the gate row itself). */}
          {isManager && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{t.policies.permissionGateTitle}</div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{t.policies.permissionGateHint}</div>
              {gateError && <div className="error-banner">{gateError}</div>}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selected.permission_gates.includes(PILOT_GATED_PERMISSION_KEY)}
                  disabled={gateSaving || (selected.status !== 'approved' && !selected.permission_gates.includes(PILOT_GATED_PERMISSION_KEY))}
                  onChange={(e) => handleToggleGate(e.target.checked)}
                />
                {t.permissions.keys.view_audit_log}
              </label>
              {selected.status !== 'approved' && !selected.permission_gates.includes(PILOT_GATED_PERMISSION_KEY) && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.policies.permissionGateRequiresApproved}</div>
              )}
            </div>
          )}
        </div>
      )}

      {confirmingEnable && (
        <ConfirmDialog
          title={t.policies.permissionGateEnableConfirmTitle}
          message={t.policies.permissionGateEnableConfirmMessage}
          confirmLabel={t.common.yes}
          cancelLabel={t.common.cancel}
          danger={false}
          onConfirm={() => applyGateChange(true)}
          onCancel={() => setConfirmingEnable(false)}
        />
      )}
    </Modal>
  );
}
