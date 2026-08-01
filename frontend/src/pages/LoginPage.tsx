import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
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

// Same endpoint RegisterPage's Google button uses — see backend/src/controllers/auth.controller.ts.
interface GoogleStartResponse {
  success: boolean;
  exists: boolean;
  user?: AuthUser;
  token?: string;
  signup_token?: string;
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const lang = useLangStore((s) => s.lang);
  const toggleLang = useLangStore((s) => s.toggle);
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const expired = searchParams.get('expired') === '1';

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

  async function handleGoogleSuccess(credentialResponse: CredentialResponse) {
    if (!credentialResponse.credential) return;
    setError(null);
    setLoading(true);
    try {
      const res = await post<GoogleStartResponse>('/auth/google', { id_token: credentialResponse.credential });
      if (res.exists) {
        setAuth(res.token!, res.user!);
        navigate('/dashboard');
        return;
      }
      // No account yet — hand the verified identity off to the signup wizard so it can
      // skip straight to collecting profile/company info instead of asking for a password.
      navigate('/register', {
        state: {
          googleSignupToken: res.signup_token!,
          email: res.email ?? '',
          firstName: res.first_name ?? '',
          lastName: res.last_name ?? '',
        },
      });
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
        {!error && expired && <div className="error-banner">{t.auth.sessionExpired}</div>}
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
        <div className="auth-divider">{t.auth.orDivider}</div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <GoogleLogin
            onSuccess={handleGoogleSuccess}
            onError={() => setError(t.auth.somethingWrong)}
            text="continue_with"
            shape="pill"
            theme="outline"
            width="320"
          />
        </div>
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
