import { applyTheme } from '@/lib/theme';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type User = { id: number; username: string; email: string; avatarUrl: string; bannerUrl: string; bio: string; themeColor: string; createdAt: string | null };

type AuthContextValue = {
  user: User | null;
  ready: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  signup: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`/api/auth/${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || (res.status === 422 ? 'Please fill in every field.' : 'Something went wrong. Please try again.'));
  }
  return data as { success: true; user?: User | null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { applyTheme(user?.themeColor); }, [user?.themeColor]); // the signed-in person's colour applies site-wide

  useEffect(() => {
    call('me')
      .then(d => setUser(d.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const d = await call('login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
    setUser(d.user ?? null);
  }, []);
  const signup = useCallback(async (username: string, email: string, password: string) => {
    const d = await call('signup', { method: 'POST', body: JSON.stringify({ username, email, password }) });
    setUser(d.user ?? null);
  }, []);
  const logout = useCallback(async () => {
    await call('logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, ready, login, signup, logout, setUser }), [user, ready, login, signup, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
