import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { Link } from 'wouter';
import { ArrowDown, ImagePlus, Send, Smile, Star, Sticker as StickerIcon, Trash2, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { fileToChatImage, makeSticker } from '@/lib/image';
import { UserAvatar } from '@/components/user-avatar';

type Msg = { id: number; text: string; createdAt: number; username: string; avatarUrl: string; own: boolean; imageUrl: string; imageId: string; stickerId: string; stickerUrl: string; stickerFav: boolean };
type StickerItem = { id: string; url: string; favorited: boolean; mine: boolean };

async function api<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/chat/${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || (res.status === 413 ? 'That image is too large.' : 'Something went wrong. Please try again.'));
  return data as T;
}

const timeLabel = (ms: number) => {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${t}`;
};

export default function ChatPage() {
  const { user, ready } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ file: File; preview: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false); // making a sticker
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<'favorites' | 'mine'>('favorites');
  const [stickers, setStickers] = useState<{ mine: StickerItem[]; favorites: StickerItem[] }>({ mine: [], favorites: [] });
  const [stickersLoaded, setStickersLoaded] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const stickerInput = useRef<HTMLInputElement>(null);
  const uid = user?.id ?? null;

  const merge = useCallback((incoming: Msg[]) => {
    if (!incoming.length) return;
    lastId.current = Math.max(lastId.current, ...incoming.map(m => m.id));
    setMessages(prev => {
      const seen = new Set(prev.map(m => m.id));
      const next = [...prev, ...incoming.filter(m => !seen.has(m.id))];
      return next;
    });
  }, []);

  // First load, then poll every few seconds (faster while you are typing or just sent something).
  useEffect(() => {
    if (!ready || uid === null) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    setState('loading'); setMessages([]); lastId.current = 0;
    const tick = async (first: boolean) => {
      try {
        const d = await api<{ messages: Msg[]; hasMore: boolean }>(first ? 'messages' : `messages?after=${lastId.current}`);
        if (!live) return;
        if (first) { setMessages(d.messages); setHasMore(d.hasMore); lastId.current = d.messages.reduce((a, m) => Math.max(a, m.id), 0); setState('ready'); } else merge(d.messages);
      } catch (e) {
        if (!live) return;
        if (first) { setError(e instanceof Error ? e.message : 'Could not load the chat.'); setState('error'); }
      }
      if (live) timer = setTimeout(() => tick(false), document.hidden ? 10_000 : 2_500);
    };
    void tick(true);
    return () => { live = false; clearTimeout(timer); };
  }, [ready, uid, merge]);

  // Keep the view pinned to the newest message unless you scrolled up to read.
  useLayoutEffect(() => { const el = listRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages, state]);
  const onScroll = () => { const el = listRef.current; if (!el) return; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90; stick.current = near; setAtBottom(near); };
  const jump = () => { const el = listRef.current; if (el) { stick.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } };

  // Older history: fetched 50 at a time and put above what is on screen without moving your place in the list.
  const loadOlder = async () => {
    const first = messages[0]; const el = listRef.current;
    if (!first || !el || loadingOlder) return;
    setLoadingOlder(true);
    const prevHeight = el.scrollHeight, prevTop = el.scrollTop;
    try {
      const d = await api<{ messages: Msg[]; hasMore: boolean }>(`messages?before=${first.id}`);
      stick.current = false;
      setMessages(prev => [...d.messages.filter(m => !prev.some(p => p.id === m.id)), ...prev]);
      setHasMore(d.hasMore);
      requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = prevTop + (listRef.current.scrollHeight - prevHeight); });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load older messages.'); }
    finally { setLoadingOlder(false); }
  };

  const loadStickers = useCallback(async () => {
    try { const d = await api<{ mine: StickerItem[]; favorites: StickerItem[] }>('stickers'); setStickers({ mine: d.mine, favorites: d.favorites }); setStickersLoaded(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load stickers.'); }
  }, []);
  useEffect(() => { if (panel) void loadStickers(); }, [panel, loadStickers]);
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.preview); }, [pending]);

  const attach = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Choose an image file (JPEG, PNG or WebP).');
    setError(''); setPending({ file, preview: URL.createObjectURL(file) });
  };
  const onPaste = (e: ClipboardEvent) => { const f = [...e.clipboardData.files].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); attach(f); } };

  const post = async (payload: { text?: string; imageId?: string; stickerId?: string }) => {
    const d = await api<{ message: Msg }>('messages', 'POST', payload);
    stick.current = true; merge([d.message]);
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending || busy) return;
    const body = text.trim();
    if (!body && !pending) return;
    setError(''); setSending(true);
    try {
      let imageId: string | undefined;
      if (pending) imageId = (await api<{ id: string }>('images', 'POST', { dataUrl: await fileToChatImage(pending.file) })).id;
      await post({ text: body || undefined, imageId });
      setText(''); setPending(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send.'); }
    finally { setSending(false); }
  };

  const sendSticker = async (s: StickerItem) => {
    if (sending) return;
    setError(''); setSending(true); setPanel(false);
    try { await post({ stickerId: s.id }); } catch (err) { setError(err instanceof Error ? err.message : 'Could not send.'); }
    finally { setSending(false); }
  };

  const createSticker = async (source: Blob | Promise<Blob>) => {
    setError(''); setBusy(true);
    try {
      const dataUrl = await makeSticker(await source);
      await api('stickers', 'POST', { dataUrl });
      await loadStickers(); setTab('mine'); setPanel(true); setPending(null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not make the sticker.'); }
    finally { setBusy(false); }
  };

  const setFavorite = async (stickerId: string, on: boolean) => {
    setError('');
    setMessages(prev => prev.map(m => m.stickerId === stickerId ? { ...m, stickerFav: on } : m));
    try { await api(`stickers/${stickerId}/favorite`, on ? 'PUT' : 'DELETE'); if (panel) void loadStickers(); }
    catch (err) { setMessages(prev => prev.map(m => m.stickerId === stickerId ? { ...m, stickerFav: !on } : m)); setError(err instanceof Error ? err.message : 'Could not update favorites.'); }
  };
  const removeSticker = async (s: StickerItem) => {
    try { await api(`stickers/${s.id}`, 'DELETE'); await loadStickers(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete the sticker.'); }
  };
  const removeMessage = async (m: Msg) => {
    try { await api(`messages/${m.id}`, 'DELETE'); setMessages(prev => prev.filter(x => x.id !== m.id)); } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete.'); }
  };

  if (!ready) return <main className="page-width chat-page"><div className="skeleton" style={{ height: 420 }} /></main>;
  if (!user) return <main className="page-width chat-page"><div className="state-box"><h3>Log in to join the chat</h3><p>The global chat is for signed-in members. It takes ten seconds to make an account.</p><div className="chat-cta"><Link href="/login" className="btn" data-testid="chat-login">Log in</Link><Link href="/signup" className="btn ghost">Sign up</Link></div></div></main>;

  const list = tab === 'favorites' ? stickers.favorites : stickers.mine;
  return <main className="page-width chat-page" data-testid="page-chat">
    <div className="chat-head"><h1>Global chat</h1><span className="chat-sub">Everyone signed in, in one room. Every message is kept, so you can scroll back through the whole history.</span></div>
    <div className="chat-box">
      <div className="chat-list" ref={listRef} onScroll={onScroll} data-testid="chat-list">
        {state === 'loading' && <div className="chat-empty">Loading…</div>}
        {state === 'error' && <div className="chat-empty">{error || 'Could not load the chat.'}</div>}
        {state === 'ready' && hasMore && <button type="button" className="chat-older" onClick={loadOlder} disabled={loadingOlder} data-testid="button-older">{loadingOlder ? 'Loading…' : 'Load older messages'}</button>}
        {state === 'ready' && !messages.length && <div className="chat-empty">No messages yet. Say hi!</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = !!prev && prev.username === m.username && m.createdAt - prev.createdAt < 5 * 60_000;
          return <div className={`chat-msg${grouped ? ' grouped' : ''}${m.own ? ' own' : ''}`} key={m.id} data-testid={`chat-msg-${m.id}`}>
            <div className="chat-avatar">{!grouped && <Link href={`/u/${m.username}`}><UserAvatar name={m.username} url={m.avatarUrl} size={36} /></Link>}</div>
            <div className="chat-main">
              {!grouped && <div className="chat-meta"><Link href={`/u/${m.username}`} className="chat-name">{m.username}</Link><time>{timeLabel(m.createdAt)}</time></div>}
              {m.text && <p className="chat-text">{m.text}</p>}
              {m.imageUrl && <a href={m.imageUrl} target="_blank" rel="noreferrer" className="chat-img-link"><img className="chat-img" src={m.imageUrl} alt="Shared image" loading="lazy" onLoad={() => { const el = listRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }} /></a>}
              {m.stickerUrl && <img className="chat-sticker" src={m.stickerUrl} alt="Sticker" loading="lazy" onLoad={() => { const el = listRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }} />}
              <div className="chat-actions">
                {m.stickerId && <button type="button" onClick={() => setFavorite(m.stickerId, !m.stickerFav)} className={m.stickerFav ? 'on' : ''} title={m.stickerFav ? 'Remove from favorites' : 'Add to favorites'} aria-label={m.stickerFav ? 'Remove sticker from favorites' : 'Favorite sticker'} data-testid={`fav-${m.id}`}><Star size={14} fill={m.stickerFav ? 'currentColor' : 'none'} /></button>}
                {m.imageUrl && <button type="button" disabled={busy} onClick={() => createSticker(fetch(m.imageUrl).then(r => r.blob()))} title="Make a sticker from this image" data-testid={`make-sticker-${m.id}`}><StickerIcon size={14} /> Make sticker</button>}
                {m.own && <button type="button" onClick={() => removeMessage(m)} title="Delete message" aria-label="Delete message"><Trash2 size={14} /></button>}
              </div>
            </div>
          </div>;
        })}
      </div>
      {!atBottom && <button type="button" className="chat-jump" onClick={jump} aria-label="Jump to latest"><ArrowDown size={16} /></button>}

      {panel && <div className="sticker-panel" data-testid="sticker-panel">
        <div className="sticker-tabs">
          <button type="button" className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}><Star size={13} /> Favorites</button>
          <button type="button" className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>My stickers</button>
          <span className="grow" />
          <button type="button" className="sticker-new" disabled={busy} onClick={() => stickerInput.current?.click()} data-testid="button-new-sticker"><ImagePlus size={14} /> {busy ? 'Making…' : 'Image → sticker'}</button>
          <button type="button" className="sticker-x" onClick={() => setPanel(false)} aria-label="Close stickers"><X size={16} /></button>
        </div>
        <div className="sticker-grid">
          {!stickersLoaded && <div className="chat-empty">Loading…</div>}
          {stickersLoaded && !list.length && <div className="chat-empty">{tab === 'favorites' ? 'No favorites yet. Tap the star under any sticker in the chat, or make your own.' : 'You have no stickers yet. Use “Image → sticker” to turn a picture into one.'}</div>}
          {list.map(s => <div className="sticker-cell" key={s.id}>
            <button type="button" className="sticker-pick" onClick={() => sendSticker(s)} aria-label="Send sticker"><img src={s.url} alt="Sticker" loading="lazy" /></button>
            <button type="button" className={`sticker-fav${s.favorited ? ' on' : ''}`} onClick={async () => { await setFavorite(s.id, !s.favorited); await loadStickers(); }} aria-label={s.favorited ? 'Unfavorite' : 'Favorite'}><Star size={12} fill={s.favorited ? 'currentColor' : 'none'} /></button>
            {s.mine && <button type="button" className="sticker-del" onClick={() => removeSticker(s)} aria-label="Delete sticker"><Trash2 size={12} /></button>}
          </div>)}
        </div>
      </div>}

      {pending && <div className="chat-pending">
        <img src={pending.preview} alt="Attached" />
        <div className="chat-pending-actions">
          <span>Ready to send</span>
          <button type="button" className="btn ghost sm" disabled={busy || sending} onClick={() => createSticker(pending.file)} data-testid="button-pending-sticker"><StickerIcon size={14} /> {busy ? 'Making…' : 'Make it a sticker instead'}</button>
        </div>
        <button type="button" className="icon-btn" onClick={() => setPending(null)} aria-label="Remove attachment"><X size={16} /></button>
      </div>}
      {error && state === 'ready' && <div className="form-error chat-error" role="alert" data-testid="chat-error">{error}</div>}
      <form className="chat-compose" onSubmit={send}>
        <button type="button" className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach an image" title="Attach an image" data-testid="button-attach"><ImagePlus size={19} /></button>
        <button type="button" className={`icon-btn${panel ? ' active' : ''}`} onClick={() => setPanel(p => !p)} aria-label="Stickers" title="Stickers" data-testid="button-stickers"><Smile size={19} /></button>
        <textarea value={text} rows={1} maxLength={500} placeholder="Message everyone…" onChange={e => setText(e.target.value)} onPaste={onPaste}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} data-testid="chat-input" />
        <button className="btn sm" type="submit" disabled={sending || busy || (!text.trim() && !pending)} aria-label="Send" data-testid="chat-send"><Send size={15} /> <span className="send-label">Send</span></button>
      </form>
    </div>
    <input ref={fileInput} type="file" accept="image/*" hidden onChange={e => { attach(e.target.files?.[0]); e.target.value = ''; }} />
    <input ref={stickerInput} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void createSticker(f); }} />
  </main>;
}
