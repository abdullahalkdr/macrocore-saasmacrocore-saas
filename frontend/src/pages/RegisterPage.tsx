import { FormEvent, KeyboardEvent, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { post, ApiError } from '../api/client';
import { useAuthStore, AuthUser, AuthCompany } from '../store/authStore';
import { useLangStore } from '../store/langStore';
import { useT } from '../i18n';
import { IconBuilding, IconTrash } from '../components/Icon';

interface RegisterResponse {
  success: boolean;
  user: AuthUser;
  company: AuthCompany;
  token: string;
  invited_users: { email: string; temp_password: string }[];
  message: string;
}

// Response shape of POST /auth/google — see backend/src/controllers/auth.controller.ts.
interface GoogleStartResponse {
  success: boolean;
  exists: boolean;
  // Present when exists = true (account already had a company — log straight in)
  user?: AuthUser;
  token?: string;
  // Present when exists = false (new Google account — finish the wizard, then
  // POST /auth/register with this token instead of email/password)
  signup_token?: string;
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
}

// LoginPage forwards here (via navigate state) when someone tries "Continue with
// Google" on /login but has no account yet — same signup_token, so the wizard just
// picks up where LoginPage's Google button left off.
interface GoogleHandoffState {
  googleSignupToken: string;
  email: string;
  firstName: string;
  lastName: string;
}

const INDUSTRIES_AR = [
  'كشك طعام',
  'مطعم أو مقهى',
  'محل ملابس / بوتيك',
  'مشروع منزلي',
  'تجزئة عامة',
  'مواد بناء وتشييد',
  'خدمات إدارية ودعم',
  'أخرى',
];
const INDUSTRIES_EN = [
  'Food kiosk',
  'Restaurant / cafe',
  'Clothing shop / boutique',
  'Home business',
  'General retail',
  'Construction & building materials',
  'Admin services & support',
  'Other',
];

const EMPLOYEE_COUNT_RANGES = ['1', '2-5', '6-10', '11-20', '21-50', '51-100', '100+'];

const COUNTRIES: { code: string; ar: string; en: string }[] = [
  { code: 'KW', ar: 'الكويت', en: 'Kuwait' },
  { code: 'SA', ar: 'المملكة العربية السعودية', en: 'Saudi Arabia' },
  { code: 'AE', ar: 'الإمارات العربية المتحدة', en: 'United Arab Emirates' },
  { code: 'QA', ar: 'قطر', en: 'Qatar' },
  { code: 'BH', ar: 'البحرين', en: 'Bahrain' },
  { code: 'OM', ar: 'عُمان', en: 'Oman' },
  { code: 'EG', ar: 'مصر', en: 'Egypt' },
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const t = useT();
  const lang = useLangStore((s) => s.lang);

  // Arriving here via LoginPage's Google button (new-account case) — skip straight to
  // step 2 with the identity Google already gave us, no password needed.
  const googleHandoff = location.state as GoogleHandoffState | null;

  const [step, setStep] = useState(googleHandoff ? 2 : 1);
  const [googleSignupToken, setGoogleSignupToken] = useState<string | null>(googleHandoff?.googleSignupToken ?? null);

  // Step 1
  const [email, setEmail] = useState(googleHandoff?.email ?? '');
  const [password, setPassword] = useState('');
  // Step 2
  const [firstName, setFirstName] = useState(googleHandoff?.firstName ?? '');
  const [lastName, setLastName] = useState(googleHandoff?.lastName ?? '');
  const [jobTitle, setJobTitle] = useState('');
  const [phone, setPhone] = useState('');
  // Step 3
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [employeeCount, setEmployeeCount] = useState('');
  const [country, setCountry] = useState('KW');
  const [inviteInput, setInviteInput] = useState('');
  const [invites, setInvites] = useState<string[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [invitedResults, setInvitedResults] = useState<{ email: string; temp_password: string }[] | null>(null);

  const industries = lang === 'en' ? INDUSTRIES_EN : INDUSTRIES_AR;

  function addInviteFromInput() {
    const value = inviteInput.trim().replace(/,$/, '');
    if (!value) return;
    if (invites.length >= 2) return;
    if (/^\S+@\S+\.\S+$/.test(value) && !invites.includes(value)) {
      setInvites([...invites, value]);
    }
    setInviteInput('');
  }

  function handleInviteKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Tab' || e.key === ',' || e.key === 'Enter') {
      if (inviteInput.trim()) {
        e.preventDefault();
        addInviteFromInput();
      }
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
      setGoogleSignupToken(res.signup_token!);
      setEmail(res.email ?? '');
      setFirstName(res.first_name ?? '');
      setLastName(res.last_name ?? '');
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.auth.somethingWrong);
    } finally {
      setLoading(false);
    }
  }

  function handleStep1Submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError(t.auth.somethingWrong);
      return;
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError(t.auth.passwordHint);
      return;
    }
    setStep(2);
  }

  function handleStep2Submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStep(3);
  }

  async function handleStep3Submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await post<RegisterResponse>('/auth/register', {
        ...(googleSignupToken ? { google_signup_token: googleSignupToken } : { email, password }),
        company_name: companyName,
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        job_title: jobTitle || undefined,
        phone: phone || undefined,
        industry: industry || undefined,
        employee_count_range: employeeCount || undefined,
        country,
        invite_emails: invites.length > 0 ? invites : undefined,
      });
      setAuth(res.token, res.user, res.company);
      if (res.invited_users?.length > 0) {
        setInvitedResults(res.invited_users);
      } else {
        navigate('/dashboard');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.auth.somethingWrong);
    } finally {
      setLoading(false);
    }
  }

  const boxWide = step >= 2;

  if (invitedResults) {
    return (
      <div className="auth-page">
        <div className={`auth-box auth-box-wide`}>
          <h1>{t.auth.inviteResultsTitle}</h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -6, marginBottom: 16 }}>{t.auth.inviteResultsHint}</p>
          {invitedResults.map((r) => (
            <div className="temp-cred-row" key={r.email}>
              <span>{r.email}</span>
              <span>
                {t.auth.tempPasswordLabel}: <code>{r.temp_password}</code>
              </span>
            </div>
          ))}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} onClick={() => navigate('/dashboard')}>
            {t.auth.goToDashboard}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className={`auth-box ${boxWide ? 'auth-box-wide' : ''}`}>
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
          {step > 1 && <div className="auth-step-label">{t.auth.stepOf(step - 1, 2)}</div>}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {step === 1 && (
          <>
            <h1 style={{ textAlign: 'center' }}>{t.auth.step1Title}</h1>
            <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 18 }}>{t.auth.step1Subtitle}</div>
            <form onSubmit={handleStep1Submit}>
              <div className="field">
                <label>{t.auth.email}</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <div className="field">
                <label>{t.auth.passwordHint}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
                {t.auth.continueBtn}
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
              {t.auth.hasAccount} <Link to="/login">{t.auth.loginLink}</Link>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 style={{ textAlign: 'center' }}>{t.auth.step2Title}</h1>
            <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 18 }}>{t.auth.step2Subtitle}</div>
            {googleSignupToken && (
              <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 12 }}>
                {t.auth.googleConnectedAs(email)}
              </div>
            )}
            <form onSubmit={handleStep2Submit}>
              <div className="field-grid">
                <div className="field">
                  <label>{t.auth.firstName}</label>
                  <input value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoFocus />
                </div>
                <div className="field">
                  <label>{t.auth.lastName}</label>
                  <input value={lastName} onChange={(e) => setLastName(e.target.value)} required />
                </div>
              </div>
              <div className="field">
                <label>{t.auth.roleLabel}</label>
                <select value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} required>
                  <option value="" disabled>
                    {t.auth.rolePlaceholder}
                  </option>
                  <option value={t.auth.roleOwner}>{t.auth.roleOwner}</option>
                  <option value={t.auth.roleOps}>{t.auth.roleOps}</option>
                  <option value={t.auth.roleAccountant}>{t.auth.roleAccountant}</option>
                  <option value={t.auth.roleEmployee}>{t.auth.roleEmployee}</option>
                  <option value={t.auth.roleOther}>{t.auth.roleOther}</option>
                </select>
              </div>
              <div className="field">
                <label>{t.auth.phoneLabel}</label>
                <input type="tel" placeholder="+965 5xxxxxxx" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => {
                    // Going back out of the Google flow means starting over with
                    // email/password instead — the signup token is single-use context
                    // for this attempt, not something to carry back to step 1.
                    if (googleSignupToken) setGoogleSignupToken(null);
                    setStep(1);
                  }}
                >
                  {t.auth.backBtn}
                </button>
                <button className="btn btn-primary" type="submit" style={{ flex: 1, justifyContent: 'center' }}>
                  {t.auth.continueBtn}
                </button>
              </div>
            </form>
          </>
        )}

        {step === 3 && (
          <>
            <h1 style={{ textAlign: 'center' }}>{t.auth.step3Title}</h1>
            <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginBottom: 18 }}>{t.auth.step3Subtitle}</div>
            <form onSubmit={handleStep3Submit}>
              <div className="field">
                <label>{t.auth.businessNameLabel}</label>
                <input
                  placeholder={t.auth.businessNamePlaceholder}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="field-grid">
                <div className="field">
                  <label>{t.auth.industryLabel}</label>
                  <select value={industry} onChange={(e) => setIndustry(e.target.value)} required>
                    <option value="" disabled>
                      {t.auth.rolePlaceholder}
                    </option>
                    {industries.map((ind) => (
                      <option key={ind} value={ind}>
                        {ind}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t.auth.employeeCountLabel}</label>
                  <select value={employeeCount} onChange={(e) => setEmployeeCount(e.target.value)} required>
                    <option value="" disabled>
                      {t.auth.rolePlaceholder}
                    </option>
                    {EMPLOYEE_COUNT_RANGES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label>{t.auth.countryLabel}</label>
                <select value={country} onChange={(e) => setCountry(e.target.value)}>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {lang === 'en' ? c.en : c.ar} ({c.code})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>{t.auth.inviteLabel}</label>
                {invites.map((email) => (
                  <div className="invite-row" key={email}>
                    <span>{email}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setInvites(invites.filter((i) => i !== email))}
                    >
                      <IconTrash />
                    </button>
                  </div>
                ))}
                {invites.length < 2 && (
                  <input
                    type="email"
                    placeholder="name@example.com"
                    value={inviteInput}
                    onChange={(e) => setInviteInput(e.target.value)}
                    onKeyDown={handleInviteKeyDown}
                    onBlur={addInviteFromInput}
                  />
                )}
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{t.auth.inviteHint}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-secondary" type="button" onClick={() => setStep(2)}>
                  {t.auth.backBtn}
                </button>
                <button className="btn btn-primary" type="submit" disabled={loading} style={{ flex: 1, justifyContent: 'center' }}>
                  {loading ? t.common.loading : t.auth.createBusinessBtn}
                </button>
              </div>
            </form>
            <div className="switch" style={{ fontSize: 11 }}>
              {/* Terms/Privacy pages live on the marketing site (macrocore.io), not this app — cross-domain link, not a router Link. */}
              {t.auth.legalNotePrefix}{' '}
              <a href="https://macrocore.io/terms" target="_blank" rel="noreferrer">
                {t.auth.termsLink}
              </a>{' '}
              {t.auth.legalNoteAnd}{' '}
              <a href="https://macrocore.io/privacy" target="_blank" rel="noreferrer">
                {t.auth.privacyLink}
              </a>{' '}
              {t.auth.legalNoteSuffix}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
