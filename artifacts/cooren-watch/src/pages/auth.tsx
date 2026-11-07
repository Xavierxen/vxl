import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { AlertCircle, Bookmark, Check, Eye, EyeOff, History, MonitorSmartphone, Play } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const USERNAME_OK = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// 0 to 4: length, mixed case, a digit, a symbol. Purely a hint; the server only requires 8+ characters.
function strength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return pw.length < 8 ? Math.min(s, 1) : s;
}
const STRENGTH_LABEL = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];

export default function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const isSignup = mode === 'signup';
  const { login, signup } = useAuth();
  const [, setLocation] = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dbReady, setDbReady] = useState(true);
  const [dbReason, setDbReason] = useState('');

  useEffect(() => {
    fetch('/api/auth/status').then(r => r.json()).then(d => { setDbReady(d.database !== false); setDbReason(d.reason || ''); }).catch(() => undefined);
  }, []);
  // Switching between the two pages keeps the component mounted: start clean.
  useEffect(() => { setError(''); setTouched({}); setConfirm(''); setShow(false); }, [mode]);
  useEffect(() => { document.title = `${isSignup ? 'Sign up' : 'Log in'} — kanime`; return () => { document.title = 'kanime — Watch anime'; }; }, [isSignup]);

  const score = useMemo(() => strength(password), [password]);
  const problems = {
    username: !USERNAME_OK.test(username) ? '3–20 characters: letters, numbers or underscores.' : '',
    email: !EMAIL_OK.test(email.trim()) ? 'Enter a valid email address.' : '',
    password: password.length < 8 ? 'At least 8 characters.' : '',
    confirm: confirm !== password ? 'Passwords do not match.' : '',
  };
  const touch = (k: string) => setTouched(t => ({ ...t, [k]: true }));
  const shown = (k: keyof typeof problems) => (touched[k] ? problems[k] : '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!dbReady) return setError('Accounts are not available on this site yet.');
    if (isSignup) {
      setTouched({ username: true, email: true, password: true, confirm: true });
      const first = problems.username || problems.email || problems.password || problems.confirm;
      if (first) return setError(first);
    }
    else if (!identifier.trim() || !password) return setError('Enter your username or email and your password.');
    setBusy(true);
    try {
      if (isSignup) await signup(username.trim(), email.trim(), password);
      else await login(identifier.trim(), password);
      setLocation('/');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(err instanceof TypeError ? 'Cannot reach the server. Check your connection and try again.' : msg || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const Hint = ({ k }: { k: keyof typeof problems }) => shown(k) ? <small className="field-error" role="alert"><AlertCircle size={12} /> {shown(k)}</small> : null;

  return (
    <main className="auth-wrap">
      <aside className="auth-side">
        <img className="auth-logo" src="/kanime-logo.png" alt="kanime" width="1400" height="383" />
        <h2>{isSignup ? 'Watch more. Lose nothing.' : 'Pick up where you left off.'}</h2>
        <ul>
          <li><History size={18} /><span><b>Continue watching</b>Your last episodes, one click away.</span></li>
          <li><Play size={18} /><span><b>Resume at the second</b>Playback position is saved automatically.</span></li>
          <li><Bookmark size={18} /><span><b>Saved episodes</b>Bookmark anything to watch later.</span></li>
          <li><MonitorSmartphone size={18} /><span><b>Every device</b>Phone, tablet and computer stay in sync.</span></li>
        </ul>
      </aside>
      <form className="auth-card" onSubmit={submit} noValidate data-testid={`form-${mode}`}>
        <div className="auth-tabs" role="tablist" aria-label="Account">
          <Link href="/login" role="tab" aria-selected={!isSignup} className={!isSignup ? 'on' : ''} data-testid="tab-login">Log in</Link>
          <Link href="/signup" role="tab" aria-selected={isSignup} className={isSignup ? 'on' : ''} data-testid="tab-signup">Sign up</Link>
        </div>
        <h1>{isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-lead">{isSignup ? 'Free, takes ten seconds. No email verification.' : 'Log in to see your library and profile.'}</p>
        {!dbReady && <div className="notice error" role="status">Accounts are temporarily unavailable on this site. You can still watch: your library is saved on this device.{dbReason && <><br /><small>{dbReason}</small></>}</div>}

        {isSignup ? <>
          <label className="field"><span>Username</span>
            <input value={username} onChange={e => setUsername(e.target.value)} onBlur={() => touch('username')} autoComplete="username" maxLength={20} autoFocus spellCheck={false} aria-invalid={!!shown('username')} data-testid="input-username" />
            <Hint k="username" />
          </label>
          <label className="field"><span>Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} onBlur={() => touch('email')} autoComplete="email" aria-invalid={!!shown('email')} data-testid="input-email" />
            <Hint k="email" />
          </label>
        </> :
          <label className="field"><span>Username or email</span>
            <input value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="username" autoFocus spellCheck={false} required data-testid="input-identifier" />
          </label>}

        <label className="field"><span>Password</span>
          <div className="field-pw">
            <input type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} onBlur={() => touch('password')} autoComplete={isSignup ? 'new-password' : 'current-password'} aria-invalid={!!shown('password')} required data-testid="input-password" />
            <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
          {isSignup && <>
            <div className="pw-meter" aria-hidden="true">{[1, 2, 3, 4].map(n => <i key={n} className={score >= n ? `on s${score}` : ''} />)}</div>
            <small className="pw-label">{password ? STRENGTH_LABEL[score] : 'At least 8 characters.'}</small>
            <Hint k="password" />
          </>}
        </label>

        {isSignup && <label className="field"><span>Confirm password</span>
          <div className="field-pw">
            <input type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} onBlur={() => touch('confirm')} autoComplete="new-password" aria-invalid={!!shown('confirm')} data-testid="input-confirm" />
            {confirm && confirm === password && <span className="pw-ok" aria-hidden="true"><Check size={16} /></span>}
          </div>
          <Hint k="confirm" />
        </label>}

        {error && <div className="form-error" role="alert" data-testid="text-auth-error">{error}</div>}
        <button className="btn wide" type="submit" disabled={busy || !dbReady} data-testid="button-auth-submit">{busy ? 'Please wait…' : isSignup ? 'Create account' : 'Log in'}</button>

        <p className="auth-switch">
          {isSignup ? <>Already have an account? <Link href="/login">Log in</Link></> : <>New here? <Link href="/signup">Create an account</Link></>}
        </p>
      </form>
    </main>
  );
}
