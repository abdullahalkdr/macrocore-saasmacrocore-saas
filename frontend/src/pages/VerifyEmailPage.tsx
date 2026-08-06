import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useT } from '../i18n';
import { IconBuilding } from '../components/Icon';

// Public route — reachable from an email link whether or not the browser opening it has
// an active session. If it does (the common case: same browser they registered in), we
// patch the cached user locally so the "verify your email" banner disappears right away
// without needing a re-login (see authStore.updateUser).
export default function VerifyEmailPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const updateUser = useAuthStore((s) => s.updateUser);
  const isLoggedIn = useAuthStore((s) => !!s.token);

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError(t.auth.verifyLinkInvalid);
      return;
    }
    post('/auth/verify-email', { token })
      .then(() => {
        setStatus('success');
        updateUser({ email_verified: true });
      })
      .catch((err) => {
        setStatus('error');
        setError(err instanceof ApiError ? err.message : t.auth.somethingWrong);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
          <h1 style={{ marginBottom: 2 }}>{t.auth.verifyEmailTitle}</h1>
        </div>

        {status === 'loading' && <div className="muted" style={{ textAlign: 'center' }}>{t.common.loading}</div>}
        {status === 'success' && <div className="success-banner">{t.auth.verifyEmailSuccess}</div>}
        {status === 'error' && <div className="error-banner">{error}</div>}

        <div className="switch">
          <Link to={isLoggedIn ? '/dashboard' : '/login'}>{isLoggedIn ? t.auth.goToDashboard : t.auth.backToLogin}</Link>
        </div>
      </div>
    </div>
  );
}
