import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';

export type LibEntry = {
  animeId: number;
  episodeId: string;
  provider: string;
  audio: string;
  episodeNumber: string;
  animeTitle: string;
  poster: string;
  position?: number;
  duration?: number;
  updatedAt: number;
};
type Store = { progress: LibEntry[]; saved: LibEntry[] };

const keyOf = (e: { animeId: number; episodeId: string }) => `${e.animeId}|${e.episodeId}`;
const storageKey = (uid: number | null) => `kanime:library:v1:${uid ?? 'guest'}`;
const legacyKey = (uid: number | null) => `cooren:library:v1:${uid ?? 'guest'}`; // saved lists from before the rename

function readStore(uid: number | null): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(uid)) || localStorage.getItem(legacyKey(uid)) || 'null');
    if (raw && Array.isArray(raw.progress) && Array.isArray(raw.saved)) return raw;
  } catch { /* private mode / corrupt data */ }
  return { progress: [], saved: [] };
}
function writeStore(uid: number | null, store: Store) {
  try { localStorage.setItem(storageKey(uid), JSON.stringify(store)); } catch { /* storage full or blocked */ }
}
function merge(a: LibEntry[], b: LibEntry[]) {
  const map = new Map<string, LibEntry>();
  for (const e of [...a, ...b]) {
    const k = keyOf(e);
    const prev = map.get(k);
    if (!prev || e.updatedAt >= prev.updatedAt) map.set(k, e);
  }
  return [...map.values()].sort((x, y) => y.updatedAt - x.updatedAt);
}
function send(method: string, path: string, body: unknown) {
  return fetch(`/api/me/${path}`, {
    method, credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => undefined);
}

export function formatTime(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export const watchUrl = (e: Pick<LibEntry, 'animeId' | 'provider' | 'audio' | 'episodeId'>) =>
  `/watch/${e.animeId}/${encodeURIComponent(e.provider)}/${e.audio}/${encodeURIComponent(e.episodeId)}`;

type Meta = Omit<LibEntry, 'position' | 'duration' | 'updatedAt'>;
type LibraryValue = {
  ready: boolean;
  syncing: boolean; // true when entries are stored on the account, false when only in this browser
  continueWatching: LibEntry[];
  saved: LibEntry[];
  progressFor: (animeId: number, episodeId: string) => LibEntry | undefined;
  lastFor: (animeId: number) => LibEntry | undefined;
  isSaved: (animeId: number, episodeId: string) => boolean;
  report: (meta: Meta, position: number, duration: number, force?: boolean) => void;
  toggleSaved: (meta: Meta) => void;
};
const LibraryContext = createContext<LibraryValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { user, ready: authReady } = useAuth();
  const uid = user?.id ?? null;
  const [store, setStore] = useState<Store>({ progress: [], saved: [] });
  const [ready, setReady] = useState(false);
  const ref = useRef({ store, uid });
  ref.current = { store, uid };
  const lastSent = useRef(new Map<string, number>());

  const commit = useCallback((next: Store) => {
    ref.current = { ...ref.current, store: next };
    setStore(next);
    writeStore(ref.current.uid, next);
  }, []);

  // Load on start and whenever the account changes.
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setReady(false);
    const local = readStore(uid);
    ref.current = { store: local, uid };
    setStore(local);
    if (uid === null) { setReady(true); return; }

    (async () => {
      const guest = readStore(null);
      try {
        const res = await fetch('/api/me/library', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error('offline');
        const next: Store = {
          progress: merge(data.progress, [...local.progress, ...guest.progress]),
          saved: merge(data.saved, [...local.saved, ...guest.saved]),
        };
        if (cancelled) return;
        commit(next);
        // Push anything the server has not seen yet (offline progress and what was saved as a guest).
        const known = new Set<string>(data.progress.map(keyOf));
        const knownSaved = new Set<string>(data.saved.map(keyOf));
        next.progress.filter(e => !known.has(keyOf(e)) || (e.position ?? 0) > 0).slice(0, 30)
          .forEach(e => void send('PUT', 'progress', { ...e, position: e.position ?? 0, duration: e.duration ?? 0 }));
        next.saved.filter(e => !knownSaved.has(keyOf(e))).slice(0, 100).forEach(e => void send('PUT', 'saved', e));
        if (guest.progress.length || guest.saved.length) writeStore(null, { progress: [], saved: [] });
      } catch { /* keep the local copy */ }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [authReady, uid, commit]);

  const report = useCallback((meta: Meta, position: number, duration: number, force = false) => {
    const { store: s, uid: u } = ref.current;
    const k = keyOf(meta);
    const entry: LibEntry = { ...meta, position: Math.floor(position) || 0, duration: Math.floor(duration) || 0, updatedAt: Date.now() };
    commit({ ...s, progress: merge([entry], s.progress.filter(e => keyOf(e) !== k)) });
    if (u === null) return;
    const now = Date.now();
    if (force || now - (lastSent.current.get(k) ?? 0) >= 15_000) {
      lastSent.current.set(k, now);
      void send('PUT', 'progress', entry);
    }
  }, [commit]);

  const toggleSaved = useCallback((meta: Meta) => {
    const { store: s, uid: u } = ref.current;
    const k = keyOf(meta);
    if (s.saved.some(e => keyOf(e) === k)) {
      commit({ ...s, saved: s.saved.filter(e => keyOf(e) !== k) });
      if (u !== null) void send('POST', 'saved/remove', { animeId: meta.animeId, episodeId: meta.episodeId });
    } else {
      const entry: LibEntry = { ...meta, updatedAt: Date.now() };
      commit({ ...s, saved: [entry, ...s.saved] });
      if (u !== null) void send('PUT', 'saved', entry);
    }
  }, [commit]);

  const value = useMemo<LibraryValue>(() => {
    const seen = new Set<number>();
    const continueWatching = store.progress.filter(e => {
      const finished = (e.duration ?? 0) > 0 && (e.position ?? 0) / (e.duration ?? 1) > 0.95;
      if (finished || seen.has(e.animeId)) return false;
      seen.add(e.animeId);
      return true;
    });
    return {
      ready, syncing: uid !== null, continueWatching, saved: store.saved,
      progressFor: (a, ep) => ref.current.store.progress.find(e => e.animeId === a && e.episodeId === ep),
      lastFor: a => ref.current.store.progress.find(e => e.animeId === a),
      isSaved: (a, ep) => store.saved.some(e => e.animeId === a && e.episodeId === ep),
      report, toggleSaved,
    };
  }, [store, ready, uid, report, toggleSaved]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside LibraryProvider');
  return ctx;
}
