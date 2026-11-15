import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Users } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { normalizeCode, roomCall, useDbInfo, type RoomState } from '@/lib/rooms';

/** /together: type a room code to join. */
export function TogetherPage() {
  const [, goTo] = useLocation();
  const { user, ready } = useAuth();
  const db = useDbInfo();
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); const c = normalizeCode(code); if (c.length === 6) goTo(`/room/${c}`); };
  return <main className="page-width together-page" data-testid="page-together">
    <div className="state-box together-box">
      <Users size={30} />
      <h1>Watch together</h1>
      <p>Watch the same episode at the same time as a friend: play, pause and skipping stay in sync, and there is a chat next to the video.</p>
      {db.local && <div className="notice error" role="status">This copy of the app uses its built-in database, which only exists on this PC, so rooms cannot be shared. Open File &gt; Settings and connect the online database, or use the website.</div>}
      {ready && !user && <p><Link href="/login?next=/together" className="btn">Log in</Link> <Link href="/signup" className="btn ghost">Sign up</Link><br /><small>You need an account to join or start a room.</small></p>}
      <form className="together-join" onSubmit={submit}>
        <input value={code} onChange={e => setCode(normalizeCode(e.target.value))} placeholder="ROOM CODE" maxLength={6} autoCapitalize="characters" spellCheck={false} aria-label="Room code" data-testid="input-room-code" />
        <button className="btn" type="submit" disabled={normalizeCode(code).length !== 6} data-testid="button-join-room">Join room</button>
      </form>
      <p className="together-start"><b>Start a room:</b> open any episode and press <b>Watch together</b>. You get a code and an invite link to send.</p>
    </div>
  </main>;
}

/** /room/ABC123: joins the room, then opens the episode it is watching. */
export function JoinRoomPage({ code }: { code: string }) {
  const [, goTo] = useLocation();
  const { user, ready } = useAuth();
  const clean = normalizeCode(code);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ready || !user) return;
    let live = true;
    roomCall<{ room: RoomState }>(`${clean}/join`, 'POST')
      .then(d => { if (live) goTo(`/watch/${d.room.animeId}/${encodeURIComponent(d.room.provider)}/${d.room.audio}/${encodeURIComponent(d.room.episodeId)}?room=${clean}`, { replace: true }); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not join the room.'); });
    return () => { live = false; };
  }, [ready, user, clean, goTo]);

  return <main className="page-width together-page" data-testid="page-join-room">
    <div className="state-box together-box">
      <Users size={30} />
      <h1>Room {clean}</h1>
      {!ready && <p>One moment…</p>}
      {ready && !user && <><p>Log in to join this watch party.</p><p><Link href={`/login?next=${encodeURIComponent(`/room/${clean}`)}`} className="btn">Log in</Link> <Link href="/signup" className="btn ghost">Sign up</Link></p></>}
      {ready && user && !error && <p>Joining…</p>}
      {error && <><div className="form-error" role="alert">{error}</div><p><Link href="/together" className="btn ghost">Try another code</Link></p></>}
    </div>
  </main>;
}
