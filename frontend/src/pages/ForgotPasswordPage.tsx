import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { IconBuilding } from '../components/Icon';

export default function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Backend always responds the same way whether or not the email exists — see
      // forgotPassword() in auth.controller.ts. We just show that generic message.
      await post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.auth.somethingWrong);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
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
          <h1 style={{ marginBottom: 2 }}>{t.auth.forgotPasswordTitle}</h1>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.auth.forgotPasswordSubtitle}</div>
        </div>

        {sent ? (
          <div className="success-banner">{t.auth.resetLinkSentGeneric}</div>
        ) : (
          <>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label>{t.auth.email}</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <button className="btn" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
                {loading ? t.common.loading : t.auth.sendResetLink}
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
