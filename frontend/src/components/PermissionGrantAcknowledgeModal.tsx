import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { ApiError } from '../api/client';
import Modal from './Modal';
import { usePolicyStore, PendingPermissionGrant } from '../store/usePolicyStore';

interface PermissionGrantAcknowledgeModalProps {
  grant: PendingPermissionGrant;
  onClose: () => void;
}

// Policy Gate pilot (MIGRATION_074/075) — Step 3. Opened from the "Policies &
// Acknowledgments" section on the employee's own profile (ProfileSection.tsx), either
// by clicking a pending grant directly or via the notification bell's deep link into
// that section.
//
// Deliberately built on the SHARED <Modal> component, unlike the pre-existing
// AcknowledgmentModal (the mandatory, blocking, login-time queue for
// role_policy_requirements policies) — Abdullah's explicit requirement for this pilot
// is the opposite: "let the employee open the pending policy, close it without
// acknowledging, and return later." <Modal> gives this a header X button and no
// backdrop-dismiss surprise (closing here does nothing destructive — the pending grant
// stays exactly as it was, nothing is lost by closing).
//
// The scroll-to-bottom gate before the confirm button activates is still enforced,
// same discipline as AcknowledgmentModal — reading the policy in full is the whole
// point of an acknowledgment gate regardless of whether the dialog is dismissible.
// Same AR/EN read-language toggle as AcknowledgmentModal/PolicyDetailsModal (added
// 2026-09 for the general P&P module) for visual/behavioral consistency, independent
// of the interface language.
export default function PermissionGrantAcknowledgeModal({ grant, onClose }: PermissionGrantAcknowledgeModalProps) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const acknowledgePendingGrant = usePolicyStore((s) => s.acknowledgePendingGrant);

  const [hasReadToEnd, setHasReadToEnd] = useState(false);
  const [readLang, setReadLang] = useState<'ar' | 'en'>(lang === 'en' && grant.content_en ? 'en' : 'ar');
  const [agreeing, setAgreeing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasEnglish = !!grant.content_en;

  // Auto-pass the scroll gate when the rendered text is short enough to not scroll at
  // all (same as AcknowledgmentModal) — re-runs on readLang since the AR/EN versions
  // are rarely the same length.
  useEffect(() => {
    const el = contentRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setHasReadToEnd(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readLang]);

  function handleScroll() {
    const el = contentRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setHasReadToEnd(true);
  }

  function switchLang(next: 'ar' | 'en') {
    if (next === readLang) return;
    setReadLang(next);
    setHasReadToEnd(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

  async function handleConfirm() {
    if (!hasReadToEnd) return;
    setAgreeing(true);
    setError(null);
    try {
      await acknowledgePendingGrant(grant.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.policyGrants.acknowledgeFailed);
    } finally {
      setAgreeing(false);
    }
  }

  const displayName = (readLang === 'en' && grant.name_en) || grant.name;
  const displayContent = (readLang === 'en' && grant.content_en) || grant.content;

  return (
    <Modal
      title={displayName}
      onClose={onClose}
      actions={
        <button className="btn btn-primary" type="button" disabled={!hasReadToEnd || agreeing} onClick={handleConfirm}>
          {agreeing ? t.common.loading : t.account.policyGrants.confirmButton}
        </button>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12 }}>{t.account.policyGrants.modalIntro}</div>
        {/* Only shown when this policy actually has an English version — static
            "AR"/"EN" labels on purpose, same as AcknowledgmentModal/PolicyDetailsModal:
            these name a language, not interface chrome, so they don't run through t(). */}
        {hasEnglish && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button type="button" className={`btn btn-sm ${readLang === 'ar' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => switchLang('ar')}>
              AR
            </button>
            <button type="button" className={`btn btn-sm ${readLang === 'en' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => switchLang('en')}>
              EN
            </button>
          </div>
        )}
      </div>
      <div
        ref={contentRef}
        onScroll={handleScroll}
        dir={readLang === 'ar' ? 'rtl' : 'ltr'}
        style={{
          whiteSpace: 'pre-wrap',
          lineHeight: 1.9,
          maxHeight: '45vh',
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 14,
          textAlign: readLang === 'ar' ? 'right' : 'left',
        }}
      >
        {displayContent}
      </div>
      {!hasReadToEnd && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{t.policies.scrollToContinue}</div>}
      {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
