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
  // Which language THIS policy's TEXT is being read in — deliberately independent of
  // the interface language (langStore's `lang`). A policy is a compliance document: an
  // employee running the whole system in English must still be able to switch to
  // Arabic (or vice versa) to actually read it before agreeing. Defaults to the
  // interface language, but only when this specific policy has that translation —
  // falls back to Arabic otherwise (every policy always has `content`; `content_en` is
  // optional per policy, set in PolicyDetailsModal by whoever wrote it).
  const [readLang, setReadLang] = useState<'ar' | 'en'>(lang);
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
  const hasEnglish = !!current?.content_en;

  // Reset per new policy in the queue: scroll gate, error, AND which language it's
  // shown in — translation availability differs policy to policy, so re-derive rather
  // than carrying the previous policy's readLang forward.
  useEffect(() => {
    setHasReadToEnd(false);
    setError(null);
    if (!current) return;
    setReadLang(lang === 'en' && current.content_en ? 'en' : 'ar');
  }, [current?.id]);

  // Auto-pass the scroll gate when the rendered text is short enough to not scroll at
  // all — re-runs on readLang too, since the AR/EN versions of the same policy are
  // rarely the same length and one might fit the box while the other doesn't.
  useEffect(() => {
    const el = contentRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setHasReadToEnd(true);
  }, [current?.id, readLang]);

  function handleScroll() {
    const el = contentRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) setHasReadToEnd(true);
  }

  function switchLang(next: 'ar' | 'en') {
    if (next === readLang) return;
    setReadLang(next);
    // Different language = different text = a fresh read — require scrolling to the
    // end of THAT version too, same as a brand new policy would.
    setHasReadToEnd(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
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

  const displayName = (readLang === 'en' && current.name_en) || current.name;
  const displayContent = (readLang === 'en' && current.content_en) || current.content;

  return (
    <div className="modal-overlay" style={{ zIndex: 500 }}>
      <div className="modal-box" style={{ maxWidth: 640 }}>
        <div className="modal-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h3 style={{ margin: 0 }}>{displayName}</h3>
          {/* Only shown when this policy actually has an English version — nothing to
              toggle otherwise. Static "AR"/"EN" labels on purpose: these name a
              language, not interface chrome, so they don't run through t(). */}
          {hasEnglish && (
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                type="button"
                className={`btn btn-sm ${readLang === 'ar' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => switchLang('ar')}
              >
                AR
              </button>
              <button
                type="button"
                className={`btn btn-sm ${readLang === 'en' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => switchLang('en')}
              >
                EN
              </button>
            </div>
          )}
        </div>
        <div className="modal-body">
          <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
            {t.policies.acknowledgeIntro}
            {pending.length > 1 && ` (${pending.length} ${t.policies.acknowledgeRemaining})`}
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
