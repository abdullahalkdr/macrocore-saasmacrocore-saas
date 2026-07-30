import { FormEvent, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useAuthStore, AuthUser } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useT } from '../i18n';
import { IconBuilding, IconEye } from '../components/Icon';

interface LoginResponse {
  success: boolean;
  user: AuthUser;
  token: string;
  trial_days_remaining: number | null;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const lang = useLangStore((s) => s.lang);
  const toggleLang = useLangStore((s) => s.toggle);
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await post<LoginResponse>('/auth/login', { email, password });
      setAuth(res.token, res.user);
      navigate('/dashboard');
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
          <h1 style={{ marginBottom: 2 }}>{t.brand}</h1>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.auth.loginSubtitle}</div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>{t.auth.email}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>{t.auth.password}</label>
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
          <button className="btn" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
            {loading ? t.common.loading : t.auth.loginBtn}
          </button>
        </form>
        <div className="switch">
          {t.auth.noAccount} <Link to="/register">{t.auth.registerLink}</Link>
        </div>
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button
            type="button"
            onClick={toggleLang}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer' }}
          >
            {lang === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
      </div>
    </div>
  );
}
