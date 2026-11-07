import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useEditor } from '../store';
import { navigate } from '../main';
import { Icon } from './ui';

export function AccountMenu() {
  const user = useEditor((s) => s.user);
  const [open, setOpen] = useState(false);
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
        </div>
      )}
    </div>
  );
}
