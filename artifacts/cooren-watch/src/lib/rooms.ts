import { useEffect, useRef, useState } from 'react';
import { HttpError, RoomSync, type EpisodeRef, type Member, type RoomMsg, type RoomState, type Snapshot, type VideoLike } from '@/lib/room-sync';

export type { Member, RoomMsg, RoomState, Snapshot, EpisodeRef };
export { roomKey } from '@/lib/room-sync';

export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

/** Calls /api/rooms/<path>. An empty path means the collection itself (create a room). */
export async function roomCall<T = Record<string, unknown>>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/rooms${path ? `/${path}` : ''}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new HttpError(data.error || 'Something went wrong. Please try again.', res.status);
  return data as T;
}
const transport = { call: roomCall };

/** Is this copy using the built-in (per-PC) database? Rooms need a database that everyone shares. */
export function useDbInfo() {
  const [info, setInfo] = useState<{ local: boolean; ready: boolean }>({ local: false, ready: false });
  useEffect(() => {
    let live = true;
    fetch('/api/auth/status').then(r => r.json()).then(d => { if (live) setInfo({ local: d.local === true, ready: true }); }).catch(() => { if (live) setInfo({ local: false, ready: true }); });
    return () => { live = false; };
  }, []);
  return info;
}

const sameMembers = (a: Member[], b: Member[]) => a.length === b.length && a.every((m, i) => m.userId === b[i].userId && m.online === b[i].online && m.host === b[i].host);

type Options = {
  code: string | null;
  video: HTMLVideoElement | null;
  localKey: string;
  getLocalEpisode: () => EpisodeRef;
  onFollow: (room: RoomState) => void;
};

/** Joins a room and keeps the given video in sync with it (see room-sync.ts for how). */
export function useRoomSession(o: Options) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<RoomMsg[]>([]);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const syncRef = useRef<RoomSync | null>(null);
  const optsRef = useRef(o);
  optsRef.current = o;

  useEffect(() => {
    if (!o.code) return;
    setSnap(null); setMessages([]); setError(''); setBlocked(false);
    const sync = new RoomSync(o.code, transport, {
      onSnapshot: s => setSnap(prev => (prev && prev.room.version === s.room.version && prev.isHost === s.isHost && sameMembers(prev.members, s.members) ? prev : s)),
      onMessages: ms => setMessages(prev => [...prev, ...ms.filter(m => !prev.some(p => p.id === m.id))].slice(-300)),
      onError: setError,
      onBlocked: setBlocked,
      onFollow: r => optsRef.current.onFollow(r),
      getLocalEpisode: () => optsRef.current.getLocalEpisode(),
      autoplayOnEpisodeChange: () => { try { return sessionStorage.getItem('kanime:autoplay') === '1'; } catch { return false; } },
    });
    syncRef.current = sync;
    sync.setLocalKey(optsRef.current.localKey);
    sync.start();
    if (optsRef.current.video) sync.attachVideo(optsRef.current.video as unknown as VideoLike);
    return () => { sync.stop(); syncRef.current = null; };
  }, [o.code]);
  useEffect(() => { syncRef.current?.setLocalKey(o.localKey); }, [o.localKey]);
  useEffect(() => { syncRef.current?.attachVideo(o.video as unknown as VideoLike | null); }, [o.video]);

  const sendMessage = async (text: string) => {
    const m = await syncRef.current?.sendMessage(text);
    if (m) setMessages(prev => (prev.some(p => p.id === m.id) ? prev : [...prev, m]));
  };
  const leave = async () => { await syncRef.current?.leave(); };
  const isHost = !!snap?.isHost;
  const hostName = snap?.room.hostName ?? '';
  return { snap, messages, error, blocked, joined: !!snap, isHost, hostName, sendMessage, leave };
}
export type RoomSession = ReturnType<typeof useRoomSession>;
