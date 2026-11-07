import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { CornerDownRight, MessageSquare, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from '@/components/user-avatar';

type Comment = { id: number; parentId: number | null; text: string; episode: string; createdAt: number; username: string; avatarUrl: string; themeColor: string; own: boolean; replies?: Comment[] };
type Page = { comments: Comment[]; total: number; hasMore: boolean };

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/comments/${path}`, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data as T;
}

const ago = (ms: number) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function Composer({ placeholder, busyLabel = 'Posting…', onSubmit, onCancel, autoFocus }: { placeholder: string; busyLabel?: string; onSubmit: (text: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true); setError('');
    try { await onSubmit(text.trim()); setText(''); } catch (err) { setError(err instanceof Error ? err.message : 'Could not post.'); } finally { setBusy(false); }
  };
  return <form className="cm-compose" onSubmit={submit}>
    <textarea value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} maxLength={1000} rows={2} autoFocus={autoFocus}
      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} data-testid="comment-input" />
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="cm-compose-row"><small>{text.length}/1000 · Ctrl+Enter to post</small><span className="grow" />
      {onCancel && <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="btn sm" disabled={busy || !text.trim()} data-testid="comment-submit">{busy ? busyLabel : 'Post'}</button></div>
  </form>;
}

function Item({ c, own, canReply, onDelete, replying, setReplying, reply }: { c: Comment; own: boolean; canReply: boolean; onDelete: (c: Comment) => void; replying?: boolean; setReplying?: (v: boolean) => void; reply?: (text: string) => Promise<void> }) {
  return <div className="cm-item" data-testid={`comment-${c.id}`}>
    <Link href={`/u/${c.username}`} className="cm-avatar"><UserAvatar name={c.username} url={c.avatarUrl} size={c.parentId ? 28 : 38} /></Link>
    <div className="cm-body">
      <div className="cm-meta"><Link href={`/u/${c.username}`} className="cm-name" style={{ color: /^#[0-9a-f]{6}$/i.test(c.themeColor) ? c.themeColor : undefined }}>{c.username}</Link>{c.episode && <span className="cm-ep">EP {c.episode}</span>}<time>{ago(c.createdAt)}</time></div>
      <p className="cm-text">{c.text}</p>
      <div className="cm-actions">
        {canReply && !c.parentId && <button type="button" onClick={() => setReplying?.(!replying)}><CornerDownRight size={13} /> Reply</button>}
        {own && <button type="button" onClick={() => onDelete(c)} aria-label="Delete comment"><Trash2 size={13} /> Delete</button>}
      </div>
      {replying && reply && <Composer placeholder={`Reply to ${c.username}…`} autoFocus onSubmit={async t => { await reply(t); setReplying?.(false); }} onCancel={() => setReplying?.(false)} />}
    </div>
  </div>;
}

/** Comments for one anime. Reading is open to everyone; posting needs an account. `episode` tags comments made from the watch page. */
export function Comments({ animeId, episode }: { animeId: number; episode?: number | string }) {
  const { user } = useAuth();
  const [items, setItems] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [error, setError] = useState('');
  const uid = user?.id ?? 0;

  const load = useCallback(async () => {
    try {
      const d = await call<Page>(`${animeId}`);
      setItems(d.comments); setTotal(d.total); setHasMore(d.hasMore); setState('ready');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load comments.'); setState('error'); }
  }, [animeId]);
  useEffect(() => { setState('loading'); void load(); }, [load, uid]);

  const more = async () => {
    const last = items[items.length - 1]; if (!last || loadingMore) return;
    setLoadingMore(true);
    try { const d = await call<Page>(`${animeId}?before=${last.id}`); setItems(prev => [...prev, ...d.comments.filter(c => !prev.some(p => p.id === c.id))]); setHasMore(d.hasMore); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load more.'); } finally { setLoadingMore(false); }
  };
  const post = async (text: string) => {
    const d = await call<{ comment: Comment }>(`${animeId}`, 'POST', { text, episode: episode != null ? String(episode) : undefined });
    setItems(prev => [d.comment, ...prev]); setTotal(n => n + 1);
  };
  const postReply = (parent: Comment) => async (text: string) => {
    const d = await call<{ comment: Comment }>(`${animeId}`, 'POST', { text, parentId: parent.id });
    setItems(prev => prev.map(c => c.id === parent.id ? { ...c, replies: [...(c.replies ?? []), d.comment] } : c)); setTotal(n => n + 1);
  };
  const remove = async (c: Comment) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await call(`${animeId}/${c.id}`, 'DELETE');
      if (c.parentId) setItems(prev => prev.map(p => p.id === c.parentId ? { ...p, replies: (p.replies ?? []).filter(r => r.id !== c.id) } : p));
      else setItems(prev => prev.filter(p => p.id !== c.id));
      setTotal(n => Math.max(0, n - 1 - (c.replies?.length ?? 0)));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete.'); }
  };

  return <section className="comments" id="comments" data-testid="section-comments">
    <div className="section-heading"><div><div className="overline">Discussion</div><h2><MessageSquare size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Comments{state === 'ready' ? ` (${total})` : ''}</h2></div></div>
    {user ? <div className="cm-top"><UserAvatar name={user.username} url={user.avatarUrl} size={38} /><Composer placeholder={episode != null ? `Comment on episode ${episode}…` : 'Share your thoughts about this anime…'} onSubmit={post} /></div>
      : <div className="cm-login"><span>Log in to join the discussion.</span><Link href="/login" className="btn sm">Log in</Link><Link href="/signup" className="btn ghost sm">Sign up</Link></div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {state === 'loading' && <div className="skeleton" style={{ height: 90, marginTop: 14 }} />}
    {state === 'error' && <div className="cm-empty">Comments could not be loaded right now.</div>}
    {state === 'ready' && !items.length && <div className="cm-empty">No comments yet. Be the first!</div>}
    <div className="cm-list">
      {items.map(c => <div className="cm-thread" key={c.id}>
        <Item c={c} own={c.own} canReply={!!user} onDelete={remove} replying={replyTo === c.id} setReplying={v => setReplyTo(v ? c.id : null)} reply={postReply(c)} />
        {!!c.replies?.length && <div className="cm-replies">{c.replies.map(r => <Item key={r.id} c={r} own={r.own} canReply={false} onDelete={remove} />)}</div>}
      </div>)}
    </div>
    {hasMore && <button type="button" className="chat-older" onClick={more} disabled={loadingMore} data-testid="button-more-comments">{loadingMore ? 'Loading…' : 'Show more comments'}</button>}
  </section>;
}
