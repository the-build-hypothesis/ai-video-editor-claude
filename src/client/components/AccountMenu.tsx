import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useEditor } from '../store';
import { navigate } from '../main';
import { Icon, Modal } from './ui';

export function AccountMenu() {
  const user = useEditor((s) => s.user);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', on);
    return () => window.removeEventListener('mousedown', on);
  }, [open]);
  if (!user) return null;
  const logout = async () => {
    await useEditor.getState().saveNow();
    await api.logout().catch(() => {});
    useEditor.getState().setUser(null);
    navigate('/login');
  };
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="account-menu">
        <Icon name="user" /> {user.isGuest ? 'Guest' : user.email}
      </button>
      {open && (
        <div className="menu" role="menu">
          {user.isGuest && (
            <button role="menuitem" onClick={() => navigate('/login')}>
              Create account / sign in
            </button>
          )}
          {user.isAdmin && (
            <button role="menuitem" onClick={() => navigate('/admin')}>
              Admin dashboard
            </button>
          )}
          <button role="menuitem" onClick={() => navigate('/')}>
            All projects
          </button>
          <button role="menuitem" onClick={logout}>
            {user.isGuest ? 'End guest session' : 'Sign out'}
          </button>
          <button role="menuitem" className="danger" onClick={() => { setOpen(false); setDeleting(true); }}>
            Delete account & data…
          </button>
        </div>
      )}
      {deleting && <DeleteAccountDialog isGuest={user.isGuest} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function DeleteAccountDialog({ isGuest, onClose }: { isGuest: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      useEditor.getState().closeProject();
      useEditor.getState().setUser(null);
      navigate('/login');
      useEditor.getState().toast('success', 'Your account and all its data were deleted.');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete account and all data" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p>This permanently deletes {isGuest ? 'this guest session' : 'your account'} and all of its projects, uploaded media, exports and revision history. This cannot be undone.</p>
        {!isGuest && (
          <label className="field">
            <span className="field-label">Password</span>
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">Type DELETE to confirm</span>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="delete-confirm" />
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" disabled={busy || confirm !== 'DELETE'} data-testid="delete-account">
            {busy ? 'Deleting…' : 'Delete everything'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
