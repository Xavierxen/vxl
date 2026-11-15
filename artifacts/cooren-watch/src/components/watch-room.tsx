import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, Crown, LogOut, Send, Users } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
import type { RoomSession } from '@/lib/rooms';

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch { return false; }
}

/** The Watch Together card on the watch page: invite code / link, who is here, and the room chat. */
export function WatchRoomPanel({ code, session, onLeave }: { code: string; session: RoomSession; onLeave: () => void }) {
  const { snap, messages, error, blocked, sendMessage } = session;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [copied, setCopied] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const link = `${window.location.origin}/room/${code}`;
  const shareableLink = !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname); // a link to 127.0.0.1 only opens on your own PC
  const flash = (what: string) => { setCopied(what); setTimeout(() => setCopied(c => (c === what ? '' : c)), 1800); };

  useLayoutEffect(() => { const el = listRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages.length]);
  useEffect(() => { stick.current = true; }, [code]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setChatError('');
    try { await sendMessage(body); setText(''); stick.current = true; }
    catch (err) { setChatError(err instanceof Error ? err.message : 'Could not send.'); }
    finally { setSending(false); }
  };

  return <div className="room-card" data-testid="watch-room-panel">
    <div className="room-head"><Users size={16} /><b>Watch together</b>
      <button type="button" className="room-leave" onClick={onLeave} data-testid="button-leave-room"><LogOut size={14} /> Leave</button></div>

    <div className="room-code-row">
      <div><small>Room code</small><div className="room-code" data-testid="text-room-code">{code}</div></div>
      <div className="room-copy">
        <button type="button" className="btn ghost sm" onClick={async () => { if (await copy(code)) flash('code'); }}>{copied === 'code' ? <Check size={14} /> : <Copy size={14} />} {copied === 'code' ? 'Copied' : 'Copy code'}</button>
        {shareableLink && <button type="button" className="btn ghost sm" onClick={async () => { if (await copy(link)) flash('link'); }} data-testid="button-copy-link">{copied === 'link' ? <Check size={14} /> : <Copy size={14} />} {copied === 'link' ? 'Copied' : 'Copy invite link'}</button>}
      </div>
    </div>
    <p className={`room-role${session.isHost ? ' owner' : ''}`} data-testid="text-room-role">{!snap ? '' : session.isHost ? 'You are the room owner: only you can play, pause, skip and change the episode.' : `${session.hostName || 'The owner'} is the room owner and controls playback and episodes. You can chat and change your volume.`}</p>
    <p className="room-hint">{shareableLink ? 'Send the link or the code. ' : 'Send the code: your friend opens Watch Together and types it in. '}Playback stays in sync for everyone.</p>

    {error && <div className="form-error" role="alert">{error}</div>}
    {!snap && !error && <div className="room-loading">Joining…</div>}
    {blocked && <div className="room-blocked" role="status">Your browser blocked autoplay. Press play on the video to join in.</div>}

    {snap && <>
      <div className="room-members" aria-label="People in this room">
        {snap.members.map(m => <span key={m.userId} className={`room-member${m.online ? ' online' : ''}`} title={m.online ? 'Here now' : 'Away'}>
          <UserAvatar name={m.username} url={m.avatarUrl} size={22} />{m.username}{m.host && <Crown size={12} aria-label="host" />}</span>)}
      </div>
      <div className="room-chat">
        <div className="room-msgs" ref={listRef} onScroll={() => { const el = listRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} data-testid="room-messages">
          {!messages.length && <div className="room-empty">Say hi. Chat is just for this room.</div>}
          {messages.map(m => <div key={m.id} className={`room-msg${m.own ? ' own' : ''}`}><b>{m.username}</b><span>{m.text}</span></div>)}
        </div>
        {chatError && <div className="form-error" role="alert">{chatError}</div>}
        <form className="room-compose" onSubmit={send}>
          <input value={text} onChange={e => setText(e.target.value)} maxLength={300} placeholder="Message the room…" data-testid="room-input" />
          <button className="btn sm" type="submit" disabled={sending || !text.trim()} aria-label="Send" data-testid="room-send"><Send size={14} /></button>
        </form>
      </div>
    </>}
  </div>;
}
