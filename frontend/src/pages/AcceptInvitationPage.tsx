import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, ApiError } from '../api/client';
import { useAuthStore, AuthUser } from '../store/authStore';
import { getDictionary } from '../i18n';
import { Lang, isRTL } from '../store/langStore';
import { IconBuilding, IconEye } from '../components/Icon';
import { deriveAcceptInvitationViewState, InvitationInfoResponse } from '../utils/acceptInvitationViewState';

interface AcceptInvitationResponse {
  success: boolean;
  user: AuthUser;
  token: string;
}

type LoadState = 'loading' | 'ready' | 'invalid' | 'expired' | 'revoked' | 'accepted';

// Public accept-invitation page — the invitee's counterpart to
// ResetPasswordPage.tsx's pattern (read a token from the URL, submit a new
// password), but reads GET /auth/invitations/:token first to prefill/confirm
// the name (decision 4's hybrid name experience) and to render one of a few
// known states (decision 8: expired / used / revoked / invalid must each be
// clear, never a generic error) before showing the form at all. On success,
// logs the invitee straight in (setAuth + /dashboard) rather than bouncing
// them to /login — they just proved control of the mailbox and set their own
// password in the same step, a second login would be redundant friction.
export default function AcceptInvitationPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [state, setState] = useState<LoadState>('loading');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Renders in the INVITATION's own language, not the visitor's ambient
  // site-wide toggle (decision 3 + review requirement) — 'ar' is just the
  // house default until the invitation loads and tells us otherwise; this
  // never reads from or writes to useLangStore, so it has no effect on any
  // other page or visitor.
  const [pageLang, setPageLang] = useState<Lang>('ar');
  const t = getDictionary(pageLang);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    get<InvitationInfoResponse>(`/auth/invitations/${encodeURIComponent(token)}`)
      .then((res) => {
        // deriveAcceptInvitationViewState() applies the invitation's language
        // BEFORE branching on valid/status — see its own comment for why
        // that ordering matters (live-QA fix, 2026-09-09: a revoked English
        // invitation used to render in Arabic because the old inline code
        // only read preferred_language inside the `valid: true` branch).
        const view = deriveAcceptInvitationViewState(res, 'ar');
        setPageLang(view.pageLang);
        setEmail(view.email);
        setCompanyName(view.companyName);
        setFullName(view.fullName);
        setState(view.state);
      })
      .catch(() => setState('invalid'));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t.auth.passwordsDontMatch);
      return;
    }
    setSubmitting(true);
    try {
      const res = await post<AcceptInvitationResponse>('/auth/accept-invitation', {
        token,
        full_name: fullName,
        password,
      });
      setAuth(res.token, res.user);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.acceptInvitation.somethingWrong);
    } finally {
      setSubmitting(false);
    }
  }

  const stateBanner: Partial<Record<LoadState, { title: string; body: string }>> = {
    invalid: { title: t.acceptInvitation.invalidTitle, body: t.acceptInvitation.invalidBody },
    expired: { title: t.acceptInvitation.expiredTitle, body: t.acceptInvitation.expiredBody },
    revoked: { title: t.acceptInvitation.revokedTitle, body: t.acceptInvitation.revokedBody },
    accepted: { title: t.acceptInvitation.acceptedTitle, body: t.acceptInvitation.acceptedBody },
  };

  return (
    <div className="auth-page" dir={isRTL(pageLang) ? 'rtl' : 'ltr'} lang={pageLang}>
      <div className="auth-box">
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div
            style={{
              width: 56,
              height: 56,
              background: 'var(--amber-500)',
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 12px',
              color: '#fff',
            }}
          >
            <IconBuilding size={26} />
          </div>
          {state === 'ready' && companyName && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.acceptInvitation.invitedTo(companyName)}</div>}
        </div>

        {state === 'loading' && <div className="muted" style={{ textAlign: 'center' }}>{t.acceptInvitation.checking}</div>}

        {stateBanner[state] && (
          <div className="error-banner">
            <strong>{stateBanner[state]!.title}</strong>
            <div style={{ marginTop: 4 }}>{stateBanner[state]!.body}</div>
          </div>
        )}

        {state === 'ready' && (
          <>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label>{t.auth.email}</label>
                <input value={email} disabled />
              </div>
              <div className="field">
                <label>{t.acceptInvitation.fullNameLabel}</label>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoFocus />
              </div>
              <div className="field">
                <label>{t.acceptInvitation.passwordLabel}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    style={{ paddingLeft: 38 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    style={{
                      position: 'absolute',
                      left: 8,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: 'var(--muted)',
                      padding: 4,
                      display: 'flex',
                      cursor: 'pointer',
                    }}
                  >
                    <IconEye />
                  </button>
                </div>
              </div>
              <div className="field">
                <label>{t.acceptInvitation.confirmPasswordLabel}</label>
                <input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
              </div>
              <button className="btn" type="submit" disabled={submitting} style={{ width: '100%', justifyContent: 'center' }}>
                {submitting ? t.common.loading : t.acceptInvitation.submitBtn}
              </button>
            </form>
          </>
        )}

        <div className="switch">
          <Link to="/login">{t.auth.backToLogin}</Link>
        </div>
      </div>
    </div>
  );
}
