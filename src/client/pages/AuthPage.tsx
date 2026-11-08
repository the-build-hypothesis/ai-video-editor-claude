import { useState } from 'react';
import { api } from '../api';
import { useEditor } from '../store';
import { navigate } from '../main';

export function AuthPage({ bootError }: { bootError?: string | null }) {
  const user = useEditor((s) => s.user);
  const [mode, setMode] = useState<'login' | 'register'>(user?.isGuest ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(bootError ? `Could not reach the server: ${bootError}` : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.register(email, password);
      useEditor.getState().setUser(r.user);
      // Return to the deep link the user opened (e.g. /project/…), otherwise the dashboard.
      navigate(location.pathname.startsWith('/project/') || location.pathname === '/admin' ? location.pathname : '/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.guest();
      useEditor.getState().setUser(r.user);
      // Return to the deep link the user opened (e.g. /project/…), otherwise the dashboard.
      navigate(location.pathname.startsWith('/project/') || location.pathname === '/admin' ? location.pathname : '/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden>▶</span> FrameForge
        </div>
        <p className="muted">Browser-based video editor with AI captions and natural-language editing.</p>
        <div className="seg" role="tablist" aria-label="Account mode">
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Create account
          </button>
        </div>
        {user?.isGuest && mode === 'register' && <p className="note">You're editing as a guest. Creating an account keeps your current projects and media.</p>}
        <form onSubmit={submit} className="stack">
          <label className="field">
            <span className="field-label">Email</span>
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === 'register' && <span className="hint">At least 8 characters.</span>}
          </label>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {!user && (
          <>
            <div className="divider">or</div>
            <button className="btn btn-block" onClick={guest} disabled={busy}>
              Continue as guest
            </button>
            <p className="hint">Guest projects are stored for {7} days and are tied to this browser's session. Create an account to keep them.</p>
          </>
        )}
        {user && (
          <button className="btn btn-ghost btn-block" onClick={() => navigate('/')}>
            Back to projects
          </button>
        )}
      </div>
    </main>
  );
}
