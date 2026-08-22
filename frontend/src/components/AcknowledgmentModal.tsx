import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { ApiError } from '../api/client';
import { usePolicyStore } from '../store/usePolicyStore';

// Mounted once, globally, inside Layout.tsx (same pattern as App.tsx's <UpgradeModal />)
// — self-contained, no props. Pulls its own queue from usePolicyStore.pending and pops
// one policy at a time until the queue is empty.
//
// CRITICAL COMPLIANCE UX, per the spec: this is NOT built on the shared <Modal>
// component on purpose. <Modal> gives every dialog a header X button and a dirty-check
// — both are ways OUT of the dialog, and a mandatory policy acknowledgment must not
// have one. No backdrop click, no Escape, no X. The only way this modal closes is
// clicking "I Agree" after actually scrolling to the end of the text. It reuses the
// same modal-overlay/modal-box/modal-head/modal-body/modal-actions CSS classes purely
// for visual consistency with the rest of the app.
export default function AcknowledgmentModal() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const pending = usePolicyStore((s) => s.pending);
  const fetchPendingAcknowledgments = usePolicyStore((s) => s.fetchPendingAcknowledgments);
  const acknowledgePolicy = usePolicyStore((s) => s.acknowledgePolicy);

  const [hasReadToEnd, setHasReadToEnd] = useState(false);
  const [agreeing, setAgreeing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchPendingAcknowledgments();
    // Re-check on window focus too — covers an admin approving/linking a new mandatory
    // policy in another tab while this one sits open.
    function onFocus() {
      fetchPendingAcknowledgments();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchPendingAcknowledgments]);

  const current = pending[0] ?? null;

  // Reset the scroll gate for each new policy in the queue, and auto-pass it if the
  // text is short enough to not scroll at all — otherwise someone with a one-paragraph
  // policy and a tall monitor could never trigger a scroll event and would be stuck.
  useEffect(() => {
    setHasReadToEnd(false);
    setError(null);
    if (!current) return;
    const el = contentRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setHasReadToEnd(true);
  }, [current?.id]);

  function handleScroll() {
    const el = contentRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setHasReadToEnd(true);
  }

  async function handleAgree() {
    if (!current || !hasReadToEnd) return;
    setAgreeing(true);
    setError(null);
    try {
      await acknowledgePolicy(current.id);
      // usePolicyStore drops it from `pending` on success — the next render either
      // shows the next queued policy or, if that was the last one, this component
      // renders null below. No local "close" step needed.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.policies.acknowledgeFailed);
    } finally {
      setAgreeing(false);
    }
  }

  if (!current) return null;

  const displayName = (lang === 'en' && current.name_en) || current.name;
  const displayContent = (lang === 'en' && current.content_en) || current.content;

  return (
    <div className="modal-overlay" style={{ zIndex: 500 }}>
      <div className="modal-box" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3>{displayName}</h3>
        </div>
        <div className="modal-body">
          <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
            {t.policies.acknowledgeIntro}
            {pending.length > 1 && ` (${pending.length} ${t.policies.acknowledgeRemaining})`}
          </div>
          <div
            ref={contentRef}
            onScroll={handleScroll}
            style={{
              whiteSpace: 'pre-wrap',
              lineHeight: 1.9,
              maxHeight: '45vh',
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 14,
            }}
          >
            {displayContent}
          </div>
          {!hasReadToEnd && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{t.policies.scrollToContinue}</div>}
          {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" type="button" disabled={!hasReadToEnd || agreeing} onClick={handleAgree}>
            {agreeing ? t.common.loading : t.policies.iAgree}
          </button>
        </div>
      </div>
    </div>
  );
}
