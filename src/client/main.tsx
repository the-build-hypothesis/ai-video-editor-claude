import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './styles.css';
import { api } from './api';
import { useEditor } from './store';
import { AuthPage } from './pages/AuthPage';
import { Dashboard } from './pages/Dashboard';
import { EditorPage } from './pages/EditorPage';
import { AdminPage } from './pages/AdminPage';
import { Toasts, DialogHost } from './components/ui';

export function navigate(path: string) {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  window.dispatchEvent(new Event('ff:navigate'));
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    window.addEventListener('ff:navigate', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('ff:navigate', on);
    };
  }, []);
  return path;
}

function App() {
  const path = usePath();
  const user = useEditor((s) => s.user);
  const authChecked = useEditor((s) => s.authChecked);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    api
      .me()
      .then((r) => useEditor.getState().setUser(r.user))
      .catch((e) => {
        setBootError(e.message);
        useEditor.getState().setUser(null);
      });
  }, []);

  let page: React.ReactNode;
  if (!authChecked) page = <div className="center-screen"><div className="spinner" aria-label="Loading" /></div>;
  else if (!user || path === '/login') page = <AuthPage bootError={bootError} />;
  else if (path.startsWith('/project/')) page = <EditorPage key={path} projectId={decodeURIComponent(path.slice('/project/'.length))} />;
  else if (path === '/admin') page = <AdminPage />;
  else page = <Dashboard />;

  return (
    <>
      {page}
      <Toasts />
      <DialogHost />
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
