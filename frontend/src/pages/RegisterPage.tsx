import { FormEvent, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { post, ApiError } from '../api/client';
import { useAuthStore, AuthUser, AuthCompany } from '../store/authStore';
import { useT } from '../i18n';
import { IconBuilding } from '../components/Icon';

interface RegisterResponse {
  success: boolean;
  user: AuthUser;
  company: AuthCompany;
  token: string;
  message: string;
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await post<RegisterResponse>('/auth/register', {
        email,
        password,
        company_name: companyName,
        full_name: fullName || undefined,
      });
      setAuth(res.token, res.user, res.company);
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
          <h1 style={{ marginBottom: 2 }}>{t.auth.registerTitle}</h1>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.auth.registerSubtitle}</div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>{t.auth.companyName}</label>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>{t.auth.yourNameOptional}</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="field">
            <label>{t.auth.email}</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label>{t.auth.passwordHint}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
            {loading ? t.common.loading : t.auth.startTrial}
          </button>
        </form>
        <div className="switch">
          {t.auth.hasAccount} <Link to="/login">{t.auth.loginLink}</Link>
        </div>
      </div>
    </div>
  );
}
