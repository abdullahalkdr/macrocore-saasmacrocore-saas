import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useT } from '../i18n';
import { IconBuilding, IconEye } from '../components/Icon';

export default function ResetPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(t.auth.passwordsDontMatch);
      return;
    }
    setLoading(true);
    try {
      await post('/auth/reset-password', { token, new_password: newPassword });
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
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
          <h1 style={{ marginBottom: 2 }}>{t.auth.resetPasswordTitle}</h1>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.auth.resetPasswordSubtitle}</div>
        </div>

        {!token ? (
          <div className="error-banner">{t.auth.resetLinkInvalid}</div>
        ) : done ? (
          <div className="success-banner">{t.auth.resetSuccess}</div>
        ) : (
          <>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label>{t.auth.newPasswordLabel}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    style={{ paddingLeft: 38 }}
                    autoFocus
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
                <label>{t.auth.confirmPasswordLabel}</label>
                <input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
              </div>
              <button className="btn" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
                {loading ? t.common.loading : t.auth.resetPasswordBtn}
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
