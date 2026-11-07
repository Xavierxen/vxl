import { useEffect, useRef, useState } from 'react';
import { Link, useRoute } from 'wouter';
import { Bookmark, Calendar, Camera, Check, Palette, Pencil, Play, Trash2, X } from 'lucide-react';
import { useAuth, type User } from '@/lib/auth';
import { fileToDataUrl, type ImageKind } from '@/lib/image';
import { UserAvatar } from '@/components/user-avatar';
import { DEFAULT_THEME, THEME_PRESETS, themeVars } from '@/lib/theme';

type Profile = { username: string; avatarUrl: string; bannerUrl: string; bio: string; themeColor: string; createdAt: string; watched: number; saved: number };

async function api<T = { user?: User; profile?: Profile }>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || (res.status === 413 ? 'That image is too large.' : 'Something went wrong. Please try again.'));
  return data as T;
}

const joinedLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export default function ProfilePage() {
  const [, params] = useRoute('/u/:username');
  const name = params?.username ?? '';
  const { user, setUser } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [editingBio, setEditingBio] = useState(false);
  const [bio, setBio] = useState('');
  const [busy, setBusy] = useState<'' | ImageKind | 'bio'>('');
  const [error, setError] = useState('');
  const [themeOpen, setThemeOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setState('loading'); setProfile(null); setEditingBio(false); setThemeOpen(false); setError('');
    api<{ profile: Profile }>(`users/${encodeURIComponent(name)}`)
      .then(d => { if (live) { setProfile(d.profile); setState('ready'); } })
      .catch(e => { if (live) setState(e instanceof Error && /not found/i.test(e.message) ? 'missing' : 'error'); });
    return () => { live = false; };
  }, [name]);

  useEffect(() => { document.title = profile ? `${profile.username} — kanime` : 'kanime — Watch anime'; return () => { document.title = 'kanime — Watch anime'; }; }, [profile]);

  if (state === 'loading') return <main className="page-width profile"><div className="profile-banner skeleton" /><div className="profile-body"><div className="skeleton profile-avatar-skel" /></div></main>;
  if (state !== 'ready' || !profile) return <main className="page-width profile"><div className="state-box"><h3>{state === 'missing' ? 'No one here' : 'Could not load this profile'}</h3><p>{state === 'missing' ? `There is no user called “${name}”.` : 'Try again in a moment.'}</p><Link href="/" className="btn">Back home</Link></div></main>;

  const own = !!user && user.username.toLowerCase() === profile.username.toLowerCase();
  const applyUser = (u: User) => { setUser(u); setProfile(p => p && { ...p, avatarUrl: u.avatarUrl, bannerUrl: u.bannerUrl, bio: u.bio, themeColor: u.themeColor }); };

  const upload = async (kind: ImageKind, file?: File) => {
    if (!file) return;
    setError(''); setBusy(kind);
    try { const dataUrl = await fileToDataUrl(file, kind); applyUser((await api<{ user: User }>('me/profile/image', 'POST', { kind, dataUrl })).user); }
    catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(''); }
  };
  const remove = async (kind: ImageKind) => {
    setError(''); setBusy(kind);
    try { applyUser((await api<{ user: User }>('me/profile/image/remove', 'POST', { kind })).user); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove it.'); }
    finally { setBusy(''); }
  };
  // Colour changes preview instantly (site-wide for the owner) and are saved a moment after the last change.
  const pickColor = (color: string) => {
    setDraft(color);
    if (user) setUser({ ...user, themeColor: color });
    setProfile(p => p && { ...p, themeColor: color });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { applyUser((await api<{ user: User }>('me/profile', 'PUT', { themeColor: color })).user); setError(''); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not save the colour.'); }
    }, color ? 450 : 0);
  };
  const saveBio = async () => {
    setError(''); setBusy('bio');
    try { applyUser((await api<{ user: User }>('me/profile', 'PUT', { bio })).user); setEditingBio(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(''); }
  };

  return <main className="page-width profile" style={themeVars(profile.themeColor)} data-testid="page-profile">
    <div className={`profile-banner${profile.bannerUrl ? '' : ' empty'}`} style={profile.bannerUrl ? { backgroundImage: `url("${profile.bannerUrl}")` } : undefined} data-testid="img-banner">
      {own && <div className="banner-actions">
        <button type="button" className="chip-btn" onClick={() => bannerInput.current?.click()} disabled={busy === 'banner'} data-testid="button-change-banner"><Camera size={14} /> {busy === 'banner' ? 'Uploading…' : profile.bannerUrl ? 'Change banner' : 'Add banner'}</button>
        {profile.bannerUrl && <button type="button" className="chip-btn" onClick={() => remove('banner')} disabled={busy === 'banner'} aria-label="Remove banner" title="Remove banner"><Trash2 size={14} /></button>}
      </div>}
    </div>
    <div className="profile-body">
      <div className="profile-avatar-wrap">
        <UserAvatar name={profile.username} url={profile.avatarUrl} size={112} className="profile-avatar" />
        {own && <button type="button" className="avatar-edit" onClick={() => avatarInput.current?.click()} disabled={busy === 'avatar'} aria-label="Change profile picture" title="Change profile picture" data-testid="button-change-avatar"><Camera size={18} /></button>}
      </div>
      <div className="profile-main">
        <h1 data-testid="text-profile-name">{profile.username}</h1>
        <div className="profile-meta">
          <span title={new Date(profile.createdAt).toLocaleString()} data-testid="text-joined"><Calendar size={14} /> Joined {joinedLabel(profile.createdAt)}</span>
          <span><Play size={14} /> {profile.watched} watched</span>
          <span><Bookmark size={14} /> {profile.saved} saved</span>
        </div>
        {editingBio
          ? <div className="bio-edit">
              <textarea value={bio} maxLength={160} rows={3} onChange={e => setBio(e.target.value)} placeholder="Tell people what you watch…" autoFocus data-testid="input-bio" />
              <div className="bio-edit-row"><small>{bio.length}/160</small><span><button type="button" className="btn ghost sm" onClick={() => setEditingBio(false)}><X size={14} /> Cancel</button> <button type="button" className="btn sm" onClick={saveBio} disabled={busy === 'bio'} data-testid="button-save-bio"><Check size={14} /> {busy === 'bio' ? 'Saving…' : 'Save'}</button></span></div>
            </div>
          : <p className={`profile-bio${profile.bio ? '' : ' muted'}`} data-testid="text-bio">{profile.bio || (own ? 'Add a short bio.' : 'No bio yet.')}</p>}
        {own && !editingBio && <div className="profile-actions">
          <button type="button" className="btn ghost sm" onClick={() => { setBio(profile.bio); setEditingBio(true); }} data-testid="button-edit-bio"><Pencil size={14} /> Edit bio</button>
          {profile.avatarUrl && <button type="button" className="btn ghost sm" onClick={() => remove('avatar')} disabled={busy === 'avatar'}><Trash2 size={14} /> Remove picture</button>}
          <button type="button" className="btn ghost sm" onClick={() => { setDraft(profile.themeColor || DEFAULT_THEME); setThemeOpen(o => !o); }} aria-expanded={themeOpen} data-testid="button-theme"><Palette size={14} /> Theme colour</button>
        </div>}
        {own && themeOpen && <div className="theme-panel" data-testid="theme-panel">
          <div className="theme-swatches" role="group" aria-label="Theme colour">
            {THEME_PRESETS.map(c => <button key={c} type="button" className={`swatch${(profile.themeColor || DEFAULT_THEME).toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} onClick={() => pickColor(c === DEFAULT_THEME ? '' : c)} aria-label={`Use ${c}`} title={c} />)}
            <label className="swatch custom" title="Pick any colour"><input type="color" value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : DEFAULT_THEME} onChange={e => pickColor(e.target.value)} aria-label="Custom colour" data-testid="input-theme-color" /><Palette size={14} /></label>
          </div>
          <p className="theme-note">Your colour is used for buttons and highlights across the whole site while you are signed in. Others see it on your profile.</p>
          {profile.themeColor && <button type="button" className="btn ghost sm" onClick={() => pickColor('')}>Reset to default</button>}
        </div>}
        {error && <div className="form-error" role="alert" data-testid="text-profile-error">{error}</div>}
      </div>
    </div>
    <input ref={avatarInput} type="file" accept="image/*" hidden onChange={e => { void upload('avatar', e.target.files?.[0]); e.target.value = ''; }} />
    <input ref={bannerInput} type="file" accept="image/*" hidden onChange={e => { void upload('banner', e.target.files?.[0]); e.target.value = ''; }} />
  </main>;
}
