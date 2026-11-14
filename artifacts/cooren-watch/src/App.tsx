import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, useRoute, useSearch } from 'wouter';
import Hls from 'hls.js';
import {
  getGetAnimeDetailQueryKey, getGetAnimeEpisodesQueryKey,
  getGetAnimeWatchSourcesQueryKey,
  useGetAnimeHome, useGetAnimeDetail, useGetAnimeEpisodes,
  useGetAnimeWatchSources,
} from '@workspace/api-client-react';
import type { AnimeCard, AnimeDetail, AnimeEpisode, AnimeEpisodeIndex, AnimeProviderEpisodeData, AnimeStream } from '@workspace/api-client-react';
import { ArrowLeft, ArrowRight, Bookmark, Film, LogOut, MessageCircle, Play, Search, SkipForward } from 'lucide-react';
import NotFound from '@/pages/not-found';
import AuthPage from '@/pages/auth';
import { SearchBox } from '@/components/search-box';
import { AuthProvider, useAuth } from '@/lib/auth';
import { metaLine, useAnimeSearch, type SearchCard } from '@/lib/search';
import { useEpisodeSources } from '@/lib/episodes';
import ProfilePage from '@/pages/profile';
import ChatPage from '@/pages/chat';
import { useSeasons, useSkipTimes, type SkipTimes } from '@/lib/franchise';
import { Comments } from '@/components/comments';
import { SeasonSwitcher } from '@/components/season-switcher';
import { UserAvatar } from '@/components/user-avatar';
import { LibraryProvider, formatTime, useLibrary, watchUrl, type LibEntry } from '@/lib/library';

const queryClient = new QueryClient();
const HOME_QUERY = ['anime-home'] as const;

function titleFor(anime: AnimeCard) { return anime.title || 'Untitled series'; }
function coverFor(anime?: AnimeCard) { return anime?.poster || anime?.banner || ''; }
function sectionsOf(data?: AnimeCard[]) { return data || []; }
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function providerEntries(index?: AnimeEpisodeIndex) {
  if (!index) return [];
  return Object.entries(index).filter(([key, value]) =>
    !['page', 'type', 'mappings', 'error'].includes(key) &&
    !!value && typeof value === 'object' && !!asRecord(value).episodes,
  ).map(([key, value]) => [key, asRecord(value) as AnimeProviderEpisodeData] as const);
}
const readAudioPref = (): 'sub' | 'dub' => { try { return localStorage.getItem('kanime:audio') === 'dub' ? 'dub' : 'sub'; } catch { return 'sub'; } };
const saveAudioPref = (a: 'sub' | 'dub') => { try { localStorage.setItem('kanime:audio', a); } catch { /* storage blocked */ } };
function animeEpisodes(entry: AnimeProviderEpisodeData | undefined, audio: 'sub' | 'dub') {
  const list = entry?.episodes?.[audio];
  return Array.isArray(list) ? list : [];
}
function episodeKey(ep: AnimeEpisode, provider?: string) {
  const id = ep.id?.split('/').filter(Boolean).pop();
  if (id) return id;
  const number = String(ep.number ?? '');
  return provider && number ? `${provider}-${number}` : number;
}
function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'The service could not complete this request. Please try again.';
}
function safeDescription(text?: string) { return (text || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

function Header() {
  const { user, ready, logout } = useAuth();
  const [, setLocation] = useLocation();
  // Press "/" anywhere to jump to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || t?.isContentEditable) return;
      const box = document.querySelector<HTMLInputElement>('.sb input');
      if (box) { e.preventDefault(); box.focus(); box.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <header className="topbar">
    <Link href="/" className="brand" data-testid="link-kanime-home"><img className="brand-logo" src="/kanime-logo.png" alt="kanime" width="1400" height="383" /></Link>
    <SearchBox />
    <div className="account">
      <Link href="/library" className="link-quiet nav-library" data-testid="link-library">Library</Link>
      <Link href="/chat" className="link-quiet nav-chat" data-testid="link-chat" aria-label="Chat"><MessageCircle size={16} /><span>Chat</span></Link>
      {!ready ? null : user ? <>
        <Link href={`/u/${user.username}`} className="account-name" title="Your profile" data-testid="text-username"><UserAvatar name={user.username} url={user.avatarUrl} size={30} /><span className="account-name-text">{user.username}</span></Link>
        <button className="icon-btn" onClick={async () => { await logout(); setLocation('/'); }} aria-label="Log out" title="Log out" data-testid="button-logout"><LogOut size={17} /></button>
      </> : <>
        <Link href="/login" className="btn ghost sm" data-testid="link-login">Log in</Link>
        <Link href="/signup" className="btn sm" data-testid="link-signup">Sign up</Link>
      </>}
    </div>
  </header>;
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="app-shell"><Header />{children}<footer className="page-width footer"><img className="footer-logo" src="/kanime-logo.png" alt="kanime" width="1400" height="383" /><span>Metadata from AniList</span></footer></div>;
}

function LoadingCards({ count = 6 }: { count?: number }) {
  return <div className="anime-grid" aria-label="Loading anime catalog">{Array.from({ length: count }, (_, index) => <div className="sk-card" key={index}><div className="skeleton" /><div className="line skeleton" /></div>)}</div>;
}

function Row({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const update = () => { const el = ref.current; if (el) setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 }); };
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(update);
  const go = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return <div className="row">
    {!edge.start && <button type="button" className="row-btn left" onClick={() => go(-1)} aria-label="Scroll left"><ArrowLeft size={18} /></button>}
    <div className="row-track" ref={ref} onScroll={update}>{children}</div>
    {!edge.end && <button type="button" className="row-btn right" onClick={() => go(1)} aria-label="Scroll right"><ArrowRight size={18} /></button>}
  </div>;
}

function AnimeCardView({ anime, rank }: { anime: AnimeCard; rank?: number }) {
  return <Link href={`/anime/${anime.id}`} className="anime-card" data-testid={`card-anime-${anime.id}`}>
    <div className="poster-wrap">
      {coverFor(anime) && <img src={coverFor(anime)} alt={`${titleFor(anime)} poster`} loading="lazy" data-testid={`img-anime-poster-${anime.id}`} />}
      {rank !== undefined && <span className="poster-number">#{String(rank).padStart(2, '0')}</span>}
      {anime.averageScore != null && <span className="poster-score">★ {(anime.averageScore / 10).toFixed(1)}</span>}
      <span className="poster-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
    </div>
    <h3 data-testid={`text-anime-title-${anime.id}`}>{titleFor(anime)}</h3>
    <div className="card-meta"><span>{anime.type || 'ANIME'}</span>{anime.seasonYear && <span>{anime.seasonYear}</span>}{anime.episode && <span>EP {anime.episode}</span>}</div>
  </Link>;
}

function AnimeSection({ title, overline, items, loading, error }: { title: string; overline: string; items: AnimeCard[]; loading?: boolean; error?: unknown }) {
  return <section className="section">
    <div className="section-heading"><div><div className="overline">{overline}</div><h2>{title}</h2></div></div>
    {loading ? <LoadingCards /> : error ? <div className="state-box"><h3>Collection unavailable</h3><p>{getErrorMessage(error)}</p></div> : items.length ? <Row>{items.map((anime, i) => <AnimeCardView key={anime.id} anime={anime} rank={i + 1} />)}</Row> : <div className="state-box"><h3>No titles in this collection</h3></div>}
  </section>;
}

function LibraryCard({ entry, saved }: { entry: LibEntry; saved?: boolean }) {
  const pct = entry.duration ? Math.min(100, Math.round(((entry.position ?? 0) / entry.duration) * 100)) : 0;
  return <Link href={watchUrl(entry)} className="anime-card" data-testid={`card-library-${entry.animeId}-${entry.episodeId}`}>
    <div className="poster-wrap">
      {entry.poster && <img src={entry.poster} alt={`${entry.animeTitle} poster`} loading="lazy" />}
      <span className="poster-number">EP {entry.episodeNumber || '?'} · {entry.audio.toUpperCase()}</span>
      <span className="poster-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
      {!saved && pct > 0 && <i className="ep-progress" style={{ width: `${pct}%` }} />}
    </div>
    <h3>{entry.animeTitle || 'Untitled series'}</h3>
    <div className="card-meta"><span>{saved ? 'Saved' : (entry.position ?? 0) > 5 ? `Resume at ${formatTime(entry.position)}` : 'Start episode'}</span></div>
  </Link>;
}

function LibrarySections({ all = false }: { all?: boolean }) {
  const lib = useLibrary();
  const { user } = useAuth();
  const cont = all ? lib.continueWatching : lib.continueWatching.slice(0, 12);
  const saved = all ? lib.saved : lib.saved.slice(0, 12);
  if (!cont.length && !saved.length) return all
    ? <div className="state-box"><Bookmark size={22} /><h3>Nothing here yet</h3><p>Start an episode and it will show up under Continue watching. Use the bookmark button on the player to save episodes.</p></div>
    : null;
  const more = (total: number, shown: number) => !all && total > shown ? <Link href="/library" className="text-link">See all {total}</Link> : null;
  return <>
    {cont.length > 0 && <section className="section"><div className="section-heading"><div><div className="overline">Continue</div><h2>Continue watching</h2></div>{more(lib.continueWatching.length, cont.length)}</div>
      {all ? <div className="anime-grid">{cont.map(e => <LibraryCard key={`${e.animeId}|${e.episodeId}`} entry={e} />)}</div> : <Row>{cont.map(e => <LibraryCard key={`${e.animeId}|${e.episodeId}`} entry={e} />)}</Row>}</section>}
    {saved.length > 0 && <section className="section"><div className="section-heading"><div><div className="overline">Bookmarks</div><h2>Saved episodes</h2></div>{more(lib.saved.length, saved.length)}</div>
      {all ? <div className="anime-grid">{saved.map(e => <LibraryCard key={`${e.animeId}|${e.episodeId}`} entry={e} saved />)}</div> : <Row>{saved.map(e => <LibraryCard key={`${e.animeId}|${e.episodeId}`} entry={e} saved />)}</Row>}</section>}
    {!user && <p className="lib-hint">Stored in this browser only. <Link href="/signup">Create an account</Link> to keep it on every device.</p>}
  </>;
}

function LibraryPage() {
  return <Shell><main className="page-width"><div className="search-head"><h1>Library</h1></div><LibrarySections all /></main></Shell>;
}

function Hero({ items }: { items: AnimeCard[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const t = setInterval(() => setI(v => (v + 1) % items.length), 8000);
    return () => clearInterval(t);
  }, [paused, items.length]);
  const a = items[i % items.length];
  return <section className="page-width hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <div className="hero-bg" key={a.id} style={{ backgroundImage: `url("${a.banner || a.poster}")` }} />
        <div className="hero-copy" key={a.id}><div className="eyebrow">Featured{a.season ? ` · ${a.season}` : ''}</div><h1 className="display" data-testid="text-featured-title">{titleFor(a)}</h1><p>{safeDescription(a.description)}</p><div className="hero-actions"><Link href={`/anime/${a.id}`} className="btn" data-testid={`link-featured-details-${a.id}`}><Play size={15} fill="currentColor" /> Watch now</Link><span className="hero-count">{a.type || 'SERIES'}{a.episodes ? ` · ${a.episodes} EPISODES` : ''}</span></div></div>
    {items.length > 1 && <div className="hero-dots">{items.map((it, n) => <button type="button" key={it.id} className={n === i ? 'on' : ''} onClick={() => setI(n)} aria-label={`Show ${titleFor(it)}`} />)}</div>}
  </section>;
}

function GuestBanner() {
  const { user, ready } = useAuth();
  if (!ready || user) return null;
  return <section className="cta" data-testid="banner-signup">
    <div><h2>Keep your place on every device</h2><p>Create a free account to save Continue watching, bookmarked episodes and exactly where you stopped.</p></div>
    <div className="cta-actions"><Link href="/signup" className="btn" data-testid="link-cta-signup">Create free account</Link><Link href="/login" className="btn ghost" data-testid="link-cta-login">Log in</Link></div>
  </section>;
}

function HomePage() {
  const { data, isLoading, error, refetch } = useGetAnimeHome({ query: { queryKey: HOME_QUERY } });
  const payload = data?.success ? data.data : undefined;
  const spotlight = payload?.spotlight?.[0] || payload?.['popular-anime']?.[0] || payload?.['seasonal-anime']?.[0];
  const heroItems = (payload?.spotlight?.length ? payload.spotlight : sectionsOf(payload?.['popular-anime'])).filter(a => a.banner || a.poster).slice(0, 5);
  const collections: [string, string, AnimeCard[]][] = [
    ['Popular anime', 'Popular', sectionsOf(payload?.['popular-anime'])],
    ['In season', 'This season', sectionsOf(payload?.['seasonal-anime'])],
    ['Recently added', 'New', sectionsOf(payload?.['recently-added'])],
    ['All-time favorites', 'Top rated', sectionsOf(payload?.['anime-of-all-time'])],
  ];
  return <Shell>
    {isLoading ? <div className="page-width" style={{ paddingTop: 26 }}><div className="skeleton" style={{ height: 480 }} /><div style={{ paddingTop: 34 }}><LoadingCards /></div></div> : error || data?.success === false ? <main className="page-width" style={{ paddingTop: 38 }}><div className="state-box error-color"><Film size={22} /><h3>Couldn't load the catalog</h3><p>{error ? getErrorMessage(error) : 'The catalog service returned an error.'}</p><button className="btn" onClick={() => refetch()} data-testid="button-home-retry">Try again</button></div></main> : <>
      {heroItems.length > 0 && <Hero items={heroItems} />}
      <main className="page-width">
        <GuestBanner />
        <LibrarySections />
        {!spotlight && <div className="section"><div className="state-box"><h3>No featured title</h3><p>Browse the collections below.</p></div></div>}
        {collections.map(([title, overline, items]) => <AnimeSection key={title} title={title} overline={overline} items={items} />)}
        {!collections.some(c => c[2].length) && <div className="state-box"><h3>Nothing to show</h3><p>The catalog returned no titles.</p></div>}
      </main>
    </>}
  </Shell>;
}

function BestMatch({ anime }: { anime: SearchCard }) {
  return <Link href={`/anime/${anime.id}`} className="best" data-testid={`card-best-${anime.id}`}>
    {anime.poster && <img src={anime.poster} alt={`${anime.title} poster`} />}
    <div>
      <div className="overline">Best match</div>
      <h2>{anime.title}</h2>
      <div className="card-meta"><span>{metaLine(anime)}</span>{anime.episodes ? <span>{anime.episodes} eps</span> : null}{anime.status ? <span>{anime.status}</span> : null}</div>
      {anime.genres?.length ? <div className="chips">{anime.genres.slice(0, 4).map(g => <span className="chip" key={g}>{g}</span>)}</div> : null}
      {anime.description && <p>{anime.description}</p>}
    </div>
  </Link>;
}

function SearchPage() {
  const [, setLocation] = useLocation();
  const current = (new URLSearchParams(useSearch()).get('q') || '').trim();
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [current]);
  const search = useAnimeSearch(current, page, 24);
  const results = search.data?.results ?? [];
  const related = search.data?.related ?? [];
  const hasNext = Boolean(search.data?.pageInfo?.hasNextPage);
  const [best, rest] = page === 1 && results.length ? [results[0], results.slice(1)] : [undefined, results];
  return <Shell><main className="page-width">
    <div className="search-head"><h1>{current ? <>Results for “{current}”</> : 'Search'}</h1></div>
    {current.length > 0 && current.length < 2 ? <div className="state-box"><h3>Keep typing</h3><p>Enter at least two characters.</p></div> :
    !current ? <div className="state-box"><Search size={22} /><h3>Search for an anime</h3><p>Use the search bar above. Matches and related titles appear as you type.</p></div> :
      search.isLoading ? <LoadingCards count={8} /> : search.isError ? <div className="state-box error-color"><h3>Search failed</h3><p>{getErrorMessage(search.error)}</p><button className="btn" onClick={() => search.refetch()} data-testid="button-search-retry">Retry</button></div> :
      <>
        {!results.length && <div className="state-box"><h3>No exact matches for “{current}”</h3><p>{related.length ? 'These related titles might be what you are looking for.' : 'Try fewer words or a different spelling.'}</p>{!related.length && <button className="btn" onClick={() => setLocation('/')} data-testid="button-back-discover">Back to home</button>}</div>}
        {best && <BestMatch anime={best} />}
        {rest.length > 0 && <div className="anime-grid" style={{ marginTop: 22 }}>{rest.map(anime => <AnimeCardView key={anime.id} anime={anime} />)}</div>}
        {(page > 1 || hasNext) && <div className="pager"><button className="square-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)} aria-label="Previous page" data-testid="button-search-previous"><ArrowLeft size={17} /></button><span>Page {page}</span><button className="square-btn" disabled={!hasNext} onClick={() => setPage(p => p + 1)} aria-label="Next page" data-testid="button-search-next"><ArrowRight size={17} /></button></div>}
        {page === 1 && related.length > 0 && <section className="section"><div className="section-heading"><div><div className="overline">Related</div><h2>{results.length ? 'You might also like' : 'Related titles'}</h2></div></div><div className="anime-grid">{related.map(anime => <AnimeCardView key={anime.id} anime={anime} />)}</div></section>}
      </>}
  </main></Shell>;
}

function DetailPage() {
  const [, params] = useRoute('/anime/:id');
  const id = Number(params?.id || 0);
  const detailQuery = useGetAnimeDetail(id, { query: { queryKey: getGetAnimeDetailQueryKey(id), enabled: Number.isFinite(id) && id > 0 } });
  const detail = detailQuery.data?.success ? detailQuery.data.data : undefined;
  const sources = useEpisodeSources(id, !!detail);
  const lib = useLibrary();
  const seasons = useSeasons(id);
  const providers = useMemo(() => providerEntries(sources.index), [sources.index]);
  const [chosenProvider, setSelectedProvider] = useState(''); // only set when the person picks a source themselves
  const [audioPref, setAudioPref] = useState<'sub' | 'dub'>(readAudioPref);
  const chooseAudio = (a: 'sub' | 'dub') => { setAudioPref(a); saveAudioPref(a); };
  // reanime is the default source (the one that plays); another source is used only if reanime has nothing or it is picked by hand.
  const selectedProvider = providers.some(([key]) => key === chosenProvider) ? chosenProvider : (providers.find(([key]) => key === 'reanime') ?? providers[0])?.[0] ?? '';
  if (detailQuery.isLoading) return <Shell><main className="page-width" style={{ paddingTop: 30 }}><div className="skeleton" style={{ height: 360 }} /><div style={{ paddingTop: 28 }}><LoadingCards /></div></main></Shell>;
  if (detailQuery.error || detailQuery.data?.success === false || !detail) return <Shell><main className="page-width" style={{ padding: '70px 0' }}><div className="state-box error-color"><Film size={24} /><h3>Series details unavailable</h3><p>{detailQuery.error ? getErrorMessage(detailQuery.error) : 'The metadata service did not return this anime.'}</p><Link href="/" className="btn" data-testid="link-return-home">Return to discovery</Link></div></main></Shell>;
  const provider = providers.find(([key]) => key === selectedProvider)?.[1];
  const subCount = animeEpisodes(provider, 'sub').length, dubCount = animeEpisodes(provider, 'dub').length;
  // If this source only has the other language, show that one instead of an empty list.
  const audio: 'sub' | 'dub' = audioPref === 'dub' && !dubCount && subCount ? 'sub' : audioPref === 'sub' && !subCount && dubCount ? 'dub' : audioPref;
  const episodes = animeEpisodes(provider, audio);
  const title = detail.titleRomaji || detail.title || 'Anime details';
  return <Shell>
    <section className="detail-hero" style={{ '--hero-image': `url("${detail.banner || detail.poster}")` } as CSSProperties}>
      <div className="page-width detail-content">
        {detail.poster && <img className="detail-poster" src={detail.poster} alt={`${title} poster`} data-testid="img-detail-poster" />}
        <div><div className="eyebrow">AniList #{detail.id}</div><h1 className="detail-title" data-testid="text-detail-title">{title}</h1>{detail.titleNative && <div className="detail-native">{detail.titleNative}</div>}
          <p className="detail-desc" data-testid="text-detail-description">{safeDescription(detail.description) || 'No synopsis was included in the live metadata response.'}</p>
          <div className="chips">{(detail.genres || []).map(genre => <span className="chip" key={genre}>{genre}</span>)}</div>
          <div className="detail-meta"><span>{detail.type || 'ANIME'}</span><span>{detail.status || 'STATUS UNKNOWN'}</span><span>{detail.totalEpisodes || detail.episodes || '—'} EPS</span>{detail.duration && <span>{detail.duration} MIN</span>}{detail.averageScore != null && <span>SCORE {(detail.averageScore / 10).toFixed(1)}</span>}{seasons.data && (() => { const cur = seasons.data.entries.find(e => e.current); const n = seasons.data.seasonCount; const label = cur?.kind === 'season' ? `SEASON ${cur.number} OF ${n}` : `${(cur?.format || 'SPECIAL').replace('_', ' ')} · ${n} ${n === 1 ? 'SEASON' : 'SEASONS'}`; return <a href="#seasons" className="seasons-chip" data-testid="text-season-count">{label}</a>; })()}</div>
          {lib.lastFor(detail.id) && <div className="hero-actions" style={{ marginTop: 18 }}><Link className="btn" href={watchUrl(lib.lastFor(detail.id)!)} data-testid="link-resume"><Play size={15} fill="currentColor" /> Resume EP {lib.lastFor(detail.id)!.episodeNumber || ''}{(lib.lastFor(detail.id)!.position ?? 0) > 5 ? ` · ${formatTime(lib.lastFor(detail.id)!.position)}` : ''}</Link></div>}
        </div>
      </div>
    </section>
    <div className="page-width"><SeasonSwitcher id={id} /></div>
    <main className="page-width content-layout">
      <section className="episodes-panel">
        <div className="panel-top"><div><h2 className="panel-title">Episodes</h2></div>
          <div className="toggle-set" role="group" aria-label="Audio language"><button className={audio === 'sub' ? 'selected' : ''} onClick={() => chooseAudio('sub')} disabled={!subCount} aria-pressed={audio === 'sub'} title={subCount ? `${subCount} subbed episodes` : 'No subbed episodes from this source'} data-testid="button-audio-sub">Sub{subCount ? <small className="toggle-count">{subCount}</small> : null}</button><button className={audio === 'dub' ? 'selected' : ''} onClick={() => chooseAudio('dub')} disabled={!dubCount} aria-pressed={audio === 'dub'} title={dubCount ? `${dubCount} dubbed episodes` : 'No dubbed episodes from this source'} data-testid="button-audio-dub">Dub{dubCount ? <small className="toggle-count">{dubCount}</small> : null}</button></div>
          {providers.length > 1 && <select className="provider-select" value={selectedProvider} onChange={e => setSelectedProvider(e.target.value)} aria-label="Episode source" data-testid="select-episode-provider">{providers.map(([key]) => <option key={key} value={key}>{key}</option>)}</select>}
        </div>
        {sources.pending && !providers.length ? <div className="episodes-grid">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} style={{ height: 72 }} />)}</div> :
          !providers.length ? <div className="state-box"><h3>No episode sources found</h3><p>None of the {Object.keys(sources.errors).length || 'available'} sources returned episodes for this series.</p>
            <button className="btn" onClick={() => sources.refetch()} data-testid="button-episodes-retry">Try again</button>
            {Object.keys(sources.errors).length > 0 && <details className="source-errors"><summary>Why?</summary><ul>{Object.entries(sources.errors).map(([name, msg]) => <li key={name}><strong>{name}</strong>: {msg}</li>)}</ul></details>}</div> :
          !episodes.length ? <div className="state-box"><h3>No {audio === 'sub' ? 'subtitled' : 'dubbed'} episodes available</h3><p>This provider has not returned any episodes in this audio format.</p></div> :
          <div className="episodes-grid">{episodes.map((ep, index) => {
            const epId = episodeKey(ep, selectedProvider) || `${selectedProvider}-${ep.number ?? index + 1}`;
            const prog = lib.progressFor(detail.id, epId);
            const pct = prog?.duration ? Math.min(100, Math.round(((prog.position ?? 0) / prog.duration) * 100)) : 0;
            return <Link key={epId || index} className={`episode-btn${prog ? ' seen' : ''}`} href={`/watch/${detail.id}/${encodeURIComponent(selectedProvider)}/${audio}/${encodeURIComponent(epId)}`} data-testid={`link-episode-${ep.number ?? index + 1}`}>
              <strong>EP {String(ep.number ?? index + 1).padStart(2, '0')}{lib.isSaved(detail.id, epId) && <Bookmark size={12} fill="currentColor" className="saved-mark" />}</strong><span>{ep.title || 'Episode'}</span>{pct > 0 && <i className="ep-progress" style={{ width: `${pct}%` }} />}
            </Link>;
          })}</div>}
      </section>
      <aside className="side-panel"><h3>Details</h3><div className="info-row"><span>Studio</span><span>{detail.studios?.filter(s => s.isAnimationStudio).map(s => s.name).filter(Boolean).join(', ') || detail.studios?.map(s => s.name).filter(Boolean).join(', ') || 'Not listed'}</span></div><div className="info-row"><span>Season</span><span>{[detail.season, detail.seasonYear].filter(Boolean).join(' ') || 'Not listed'}</span></div><div className="info-row"><span>Episode count</span><span>{detail.totalEpisodes ?? detail.episodes ?? 'Not listed'}</span></div>{detail.trailer?.site && detail.trailer?.id && <div style={{ marginTop: 20 }}><a className="btn ghost" href={detail.trailer.site.toLowerCase() === 'youtube' ? `https://www.youtube.com/watch?v=${detail.trailer.id}` : detail.trailer.id} target="_blank" rel="noreferrer" data-testid="link-watch-trailer"><Play size={14} /> Watch trailer</a></div>}
    </aside>
    </main>
    {seasons.data && seasons.data.entries.length > 0 && <section className="page-width section" id="seasons" data-testid="section-seasons">
      <div className="section-heading"><div><div className="overline">{seasons.data.seasonCount} {seasons.data.seasonCount === 1 ? 'season' : 'seasons'}</div><h2>Seasons &amp; related</h2></div></div>
      {seasons.data.entries.length === 1 && <p className="season-note">This is the only season so far. New seasons and movies will appear here when they are announced.</p>}
      {(['season', 'other'] as const).map(kind => { const list = seasons.data!.entries.filter(e => e.kind === kind); return list.length ? <div key={kind}>
        {kind === 'other' && seasons.data!.seasonCount > 0 && <div className="overline" style={{ margin: '22px 0 10px' }}>Movies, OVAs &amp; specials</div>}
        <div className="season-row">{list.map(e => <Link key={e.id} href={`/anime/${e.id}`} className={`season-card${e.current ? ' current' : ''}`} aria-current={e.current ? 'page' : undefined} data-testid={`link-season-${e.id}`}>
          {e.poster ? <img src={e.poster} alt="" loading="lazy" /> : <div className="season-ph" />}
          <div className="season-info"><b>{e.kind === 'season' ? `Season ${e.number}` : (e.format || 'Special').replace('_', ' ')}</b><span>{e.title}</span><small>{[e.year, e.episodes ? `${e.episodes} eps` : e.status === 'NOT_YET_RELEASED' ? 'Upcoming' : ''].filter(Boolean).join(' · ')}</small></div>
          {e.current && <em>You are here</em>}
        </Link>)}</div></div> : null; })}
    </section>}
    <div className="page-width"><Comments animeId={id} /></div>
    {detail.recommendations?.length ? <section className="page-width section"><div className="section-heading"><div><div className="overline">Recommended</div><h2>More like this</h2></div></div><div className="anime-grid">{detail.recommendations.map(anime => <AnimeCardView key={anime.id} anime={anime} />)}</div></section> : null}
  </Shell>;
}

const PREFERRED_SERVERS = /^(?:hd-?1|vidstream-?[12])$/i;
// Lower plays first: Vidstream-1, Vidstream-2, HD-1, then anything else (embed pages last).
function serverRank(stream: { server?: string; type?: string }) {
  const name = (stream.server || '').toLowerCase().replace('-', '');
  const known = ['vidstream1', 'vidstream2', 'hd1'].indexOf(name);
  return (known >= 0 ? known : 3) * 2 + Number(stream.type === 'embed'); // same server: real media before its embed page
}

// Some sources ("type: embed") are not a video file but the provider's own player page.
// Feeding that URL to <video> always ends in "Format error", so it is shown in a frame instead.
function EmbedFrame({ url, server }: { url: string; server?: string }) {
  return <div className="player-frame"><iframe key={url} src={url} title={`${server || 'Embedded'} player`} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen data-testid="embed-player" /></div>;
}

const MEDIA_ERROR_NAMES = ['', 'playback aborted', 'network error while loading', 'media could not be decoded', 'format or source not supported'];
const START_TIMEOUT_MS = 30_000;

function describeMediaError(video: HTMLVideoElement) {
  const err = video.error;
  if (!err) return 'unknown media error';
  return `MediaError ${err.code} (${MEDIA_ERROR_NAMES[err.code] || 'unknown'})${err.message ? `: ${err.message}` : ''}`;
}

type PlayerStream = AnimeStream | { url?: string; proxiedUrl?: string; type?: string; server?: string };

function Player({ stream, startAt = 0, skip, skipLoaded = false, autoSkipIntro = false, autoSkipOutro = false, onTime, onFail, onEnded, onNext }: { stream?: PlayerStream; skip?: SkipTimes; skipLoaded?: boolean; autoSkipIntro?: boolean; autoSkipOutro?: boolean; startAt?: number; onTime?: (position: number, duration: number, force: boolean) => void; onFail?: (reason: string, detail?: string) => void; onEnded?: () => void; onNext?: () => void }) {
  const source = stream?.proxiedUrl || stream?.url || '';
  const videoRef = useRef<HTMLVideoElement>(null);
  const startRef = useRef(startAt); startRef.current = startAt;
  const cbRef = useRef(onTime); cbRef.current = onTime;
  const failRef = useRef(onFail); failRef.current = onFail;
  const endRef = useRef(onEnded); endRef.current = onEnded;
  const nextRef = useRef(onNext); nextRef.current = onNext;
  // Skip intro / recap / ending. Times come from the community database (AniSkip); when an episode has none,
  // a plain "Skip 85s" button covers the usual intro length during the first minutes.
  const skipRef = useRef({ skip, skipLoaded, autoSkipIntro, autoSkipOutro }); skipRef.current = { skip, skipLoaded, autoSkipIntro, autoSkipOutro };
  const [seg, setSeg] = useState<'' | 'intro' | 'recap' | 'outro' | 'fallback'>('');
  const doneRef = useRef<Record<string, boolean>>({});
  const jump = useRef<() => void>(() => undefined);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    doneRef.current = {};
    const within = (t: number, s?: { start: number; end: number } | null) => !!s && t >= s.start - 0.3 && t < s.end - 1;
    const current = (t: number): typeof seg => {
      const { skip: k, skipLoaded: loaded } = skipRef.current;
      if (within(t, k?.intro)) return 'intro';
      if (within(t, k?.recap)) return 'recap';
      if (within(t, k?.outro)) return 'outro';
      if (loaded && !k?.intro && t > 10 && t < 240) return 'fallback';
      return '';
    };
    const goTo = (kind: typeof seg) => {
      const k = skipRef.current.skip;
      if (kind === 'intro' && k?.intro) video.currentTime = k.intro.end;
      else if (kind === 'recap' && k?.recap) video.currentTime = k.recap.end;
      else if (kind === 'fallback') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 85);
      else if (kind === 'outro' && k?.outro) { if (nextRef.current) nextRef.current(); else video.currentTime = Math.max(0, Math.min(video.duration || k.outro.end, k.outro.end)); }
    };
    jump.current = () => { const kind = current(video.currentTime); if (kind) goTo(kind); };
    const tick = () => {
      const kind = current(video.currentTime);
      setSeg(prev => (prev === kind ? prev : kind));
      const { autoSkipIntro: ai, autoSkipOutro: ao } = skipRef.current;
      // Each segment is skipped automatically once, so rewinding into it lets you watch it if you want.
      if ((kind === 'intro' || kind === 'recap') && ai && !doneRef.current[kind]) { doneRef.current[kind] = true; goTo(kind); }
      else if (kind === 'outro' && ao && !doneRef.current.outro && !video.paused) { doneRef.current.outro = true; goTo('outro'); }
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (t && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable))) return;
      if (e.key.toLowerCase() === 's') jump.current();
    };
    video.addEventListener('timeupdate', tick);
    window.addEventListener('keydown', onKey);
    return () => { video.removeEventListener('timeupdate', tick); window.removeEventListener('keydown', onKey); };
  }, [source]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    let hls: Hls | undefined, failed = false, started = false, lastIssue = '';
    let netRetries = 0, mediaRetries = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const recent: string[] = [];
    const codecInfo = () => {
      const level = hls?.levels?.[Math.max(hls.currentLevel, 0)];
      return level ? `codecs ${[level.videoCodec, level.audioCodec].filter(Boolean).join(' + ') || 'unknown'}${level.height ? ` ${level.height}p` : ''}` : '';
    };
    const fail = (reason: string, detail = lastIssue) => {
      if (failed) return;
      failed = true;
      clearTimeout(watchdog);
      const full = [detail, codecInfo(), recent.length ? `earlier: ${recent.join(' | ')}` : ''].filter(Boolean).join(' ; ');
      console.warn('[player] giving up:', reason, full);
      failRef.current?.(reason, full);
    };
    const markStarted = () => { started = true; clearTimeout(watchdog); };
    // The stream "playlist" url may be proxied (".../m3u8-proxy?url=…"), so look at the type too.
    const isHls = /\.m3u8(?:$|[?#])|m3u8-proxy/i.test(source) || /hls|m3u8/i.test(stream?.type || '');
    // hls.js can usually recover from a decode glitch (bad segment, codec switch) by re-attaching.
    // Returns false once the retries are used up.
    const recoverMedia = (why: string) => {
      if (!hls || mediaRetries >= 3) return false;
      mediaRetries++;
      lastIssue = why;
      console.warn(`[player] media error, recovery attempt ${mediaRetries}:`, why);
      if (mediaRetries === 2) hls.swapAudioCodec();
      // A rendition the browser cannot decode (codec/profile) fails every retry; try another one.
      if (mediaRetries === 3 && hls.levels.length > 1) hls.currentLevel = (Math.max(hls.currentLevel, 0) + 1) % hls.levels.length;
      hls.recoverMediaError();
      return true;
    };
    // The old code treated the first <video> error as final, which stopped hls.js from recovering.
    const onVideoError = () => {
      const why = describeMediaError(video);
      lastIssue = why;
      if (hls) { if (!recoverMedia(why)) fail('The browser could not play this video.', why); return; }
      fail('The browser could not play this video.', why);
    };
    video.addEventListener('error', onVideoError);
    for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'playing'] as const) video.addEventListener(name, markStarted);
    watchdog = setTimeout(() => { if (!started) fail(`The stream did not start within ${START_TIMEOUT_MS / 1000} seconds.`); }, START_TIMEOUT_MS);

    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 60 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const code = data.response?.code;
        const desc = `${data.type}/${data.details}${code ? ` HTTP ${code}` : ''}${data.reason ? ` - ${data.reason}` : ''}${data.error?.message ? ` - ${data.error.message}` : ''}`;
        console.warn(data.fatal ? '[player] fatal hls error:' : '[player] hls warning:', desc);
        lastIssue = desc;
        if (recent.length < 6 && !recent.includes(data.details)) recent.push(data.details);
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const manifest = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
          if (!manifest && netRetries < 3) {
            const delay = 700 * ++netRetries;
            const t = setTimeout(() => { timers.delete(t); if (!failed) hls?.startLoad(); }, delay);
            timers.add(t);
            return;
          }
          fail(code ? `The video server answered HTTP ${code}. It may be blocking this host.` : 'The video server did not respond. It may be blocking this host.', desc);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (recoverMedia(desc)) return;
          fail(`Playback error (${data.details}).`, desc);
        } else fail(`Playback error (${data.details}).`, desc);
        hls?.destroy();
      });
      hls.loadSource(source);
      hls.attachMedia(video);
    } else if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) video.src = source;
    else fail('This browser cannot play this stream format.');

    // Remember where we are: resume on load, save every 5 s, and when pausing / leaving.
    let last = 0, resumed = false;
    const emit = (force: boolean) => { if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime > 0) cbRef.current?.(video.currentTime, video.duration, force); };
    const onMeta = () => {
      const at = startRef.current;
      if (!resumed && at > 3 && Number.isFinite(video.duration) && at < video.duration - 10) video.currentTime = at;
      resumed = true;
      // Arrived through "autoplay next": start straight away (the browser may still block it, which is fine).
      try { if (sessionStorage.getItem('kanime:autoplay') === '1') { sessionStorage.removeItem('kanime:autoplay'); void video.play().catch(() => undefined); } } catch { /* storage blocked */ }
    };
    const onFinished = () => { onPause(); endRef.current?.(); };
    // Keyboard: K / Space play-pause, J / L back / forward 10 s, F fullscreen, M mute, N next episode.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (t && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable))) return;
      const k = e.key.toLowerCase();
      if (k === 'k' || (k === ' ' && t === document.body)) { e.preventDefault(); if (video.paused) void video.play().catch(() => undefined); else video.pause(); }
      else if (k === 'j') video.currentTime = Math.max(0, video.currentTime - 10);
      else if (k === 'l') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
      else if (k === 'm') video.muted = !video.muted;
      else if (k === 'f') { if (document.fullscreenElement) void document.exitFullscreen(); else void video.parentElement?.requestFullscreen?.(); }
      else if (k === 'n') nextRef.current?.();
    };
    const onTick = () => { const now = Date.now(); if (now - last >= 5000) { last = now; emit(false); } };
    const onPause = () => emit(true);
    const onHide = () => { if (document.visibilityState === 'hidden') emit(true); };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('timeupdate', onTick);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onFinished);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onPause);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      emit(true);
      failed = true;
      clearTimeout(watchdog);
      timers.forEach(clearTimeout);
      video.removeEventListener('error', onVideoError);
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'playing'] as const) video.removeEventListener(name, markStarted);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('timeupdate', onTick);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onFinished);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onPause);
      document.removeEventListener('visibilitychange', onHide);
      hls?.destroy(); video.removeAttribute('src'); video.load();
    };
  }, [source, stream?.type]);
  if (!source) return <div className="player-frame"><div className="player-empty"><div className="symbol"><Film size={22} /></div><h2>Playback source unavailable</h2><p>The provider did not return a playable URL for this episode. </p></div></div>;
  const SEG_LABEL = { intro: 'Skip intro', recap: 'Skip recap', outro: nextRef.current ? 'Next episode' : 'Skip ending', fallback: 'Skip 85s', '': '' } as const;
  return <div className="player-frame"><video ref={videoRef} controls playsInline data-testid="video-player" aria-label="Anime episode video" />
    {seg && <button type="button" className="skip-btn" onClick={() => jump.current()} title="Shortcut: S" data-testid="button-skip"><SkipForward size={16} /> {SEG_LABEL[seg]}</button>}</div>;
}

function WatchPage() {
  const [, params] = useRoute('/watch/:id/:provider/:audio/:episode');
  const id = Number(params?.id || 0);
  const provider = params?.provider || '';
  const audio = params?.audio === 'dub' ? 'dub' : 'sub';
  const episodeId = params?.episode || '';
  const [selectedStreamIndex, setSelectedStreamIndex] = useState(0);
  const lib = useLibrary();
  const [playError, setPlayError] = useState('');
  const [failLog, setFailLog] = useState<string[]>([]);
  const [retryKey, setRetryKey] = useState(0);
  const [autoNext, setAutoNext] = useState(() => { try { return localStorage.getItem('kanime:autonext') !== '0'; } catch { return true; } });
  const toggleAutoNext = () => setAutoNext(on => { try { localStorage.setItem('kanime:autonext', on ? '0' : '1'); } catch { /* ignore */ } return !on; });
  const flag = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
  const [autoIntro, setAutoIntro] = useState(() => flag('kanime:autoskipintro', true));
  const [autoOutro, setAutoOutro] = useState(() => flag('kanime:autoskipoutro', false));
  const toggleFlag = (key: string, set: (fn: (v: boolean) => boolean) => void) => set(v => { try { localStorage.setItem(key, v ? '0' : '1'); } catch { /* ignore */ } return !v; });
  const [, goTo] = useLocation();
  useEffect(() => { setSelectedStreamIndex(0); setPlayError(''); setFailLog([]); timeRef.current = 0; }, [episodeId, provider, audio]);
  const sourcesQuery = useGetAnimeWatchSources(provider, id, audio, episodeId, { query: { queryKey: getGetAnimeWatchSourcesQueryKey(provider, id, audio, episodeId), enabled: !!provider && !!episodeId && id > 0 } });
  const detailQuery = useGetAnimeDetail(id, { query: { queryKey: getGetAnimeDetailQueryKey(id), enabled: id > 0 } });
  const episodesQuery = useGetAnimeEpisodes(provider, id, { map: false }, { query: { queryKey: getGetAnimeEpisodesQueryKey(provider, id, { map: false }), enabled: !!provider && id > 0 } });
  const detail = detailQuery.data?.success ? detailQuery.data.data : undefined;
  const index = episodesQuery.data;
  const providerEpisodes = asRecord(index?.[provider]) as AnimeProviderEpisodeData | undefined;
  const episodes = animeEpisodes(providerEpisodes, audio);
  const currentPosition = episodes.findIndex(ep => episodeKey(ep, provider) === episodeId || String(ep.number) === episodeId);
  const currentEp = episodes[currentPosition];
  const response = sourcesQuery.data;
  const streams = response?.streams || [];
  // Only the servers that work are offered: Vidstream-1 / Vidstream-2 first (auto-selected when present),
  // HD-1 as the fallback. If a provider has none of those names, its full list is kept so playback never goes empty.
  const preferred = streams.filter(s => (s.proxiedUrl || s.url) && PREFERRED_SERVERS.test(s.server || ''));
  const available = (preferred.length ? preferred : streams.filter(s => s.proxiedUrl || s.url))
    .sort((a, b) => serverRank(a) - serverRank(b));
  const mainStream = available[selectedStreamIndex] || (response?.proxiedUrl || response?.stream_url ? { proxiedUrl: response.proxiedUrl || response.stream_url, server: response.server, type: 'hls' } : undefined);
  const skipQuery = useSkipTimes(id, currentEp?.number);
  const title = detail?.titleRomaji || detail?.title || 'Anime episode';
  const meta = useMemo(() => ({ animeId: id, episodeId, provider, audio, episodeNumber: String(currentEp?.number ?? ''), animeTitle: detail ? title : '', poster: detail?.poster || '' }), [id, episodeId, provider, audio, currentEp?.number, detail, title]);
  // Updated in an effect so the previous episode's player can still save its final position while unmounting.
  const metaRef = useRef(meta);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  const startAt = useMemo(() => { const t = Number(new URLSearchParams(window.location.search).get('t')); return t > 0 ? t : lib.progressFor(id, episodeId)?.position ?? 0; }, [id, episodeId, lib.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const streamUrl = mainStream?.proxiedUrl || mainStream?.url || '';
  useEffect(() => { // shows up under "Continue watching" as soon as playback starts
    if (!lib.ready || !detail || !streamUrl) return;
    const prior = lib.progressFor(id, episodeId);
    lib.report(meta, prior?.position ?? 0, prior?.duration ?? 0, true);
  }, [lib.ready, detail?.id, streamUrl, episodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = lib.isSaved(id, episodeId);
  useEffect(() => { setPlayError(''); }, [streamUrl]);
  useEffect(() => { document.querySelector('.ep-row.current')?.scrollIntoView({ block: 'nearest' }); }, [episodeId, episodes.length]);
  const makeWatchUrl = (ep: AnimeEpisode) => `/watch/${id}/${encodeURIComponent(provider)}/${audio}/${encodeURIComponent(episodeKey(ep, provider) || `${provider}-${ep.number ?? ''}`)}`;
  const nextEpisode = currentPosition >= 0 && currentPosition < episodes.length - 1 ? episodes[currentPosition + 1] : undefined;
  // Sub and dub have their own episode ids, so switching finds the same episode number in the other list
  // and carries your playback position over (?t=seconds).
  const timeRef = useRef(0);
  const counterpart = (target: 'sub' | 'dub') => {
    const list = animeEpisodes(providerEpisodes, target);
    if (!currentEp) return undefined;
    return currentEp.number != null ? list.find(e => String(e.number) === String(currentEp.number)) : list[currentPosition];
  };
  const switchAudio = (target: 'sub' | 'dub') => {
    const ep = counterpart(target);
    if (!ep || target === audio) return;
    saveAudioPref(target);
    const at = Math.floor(timeRef.current);
    try { sessionStorage.setItem('kanime:autoplay', '1'); } catch { /* ignore */ }
    goTo(`/watch/${id}/${encodeURIComponent(provider)}/${target}/${encodeURIComponent(episodeKey(ep, provider) || `${provider}-${ep.number ?? ''}`)}${at > 5 ? `?t=${at}` : ''}`);
  };
  const goNext = () => { if (!nextEpisode) return; try { sessionStorage.setItem('kanime:autoplay', '1'); } catch { /* ignore */ } goTo(makeWatchUrl(nextEpisode)); };
  return <Shell><main className="page-width">
    <div className="watch-head"><div><div className="eyebrow">Now playing · {audio}</div><h1 data-testid="text-watch-title">{title} <span className="accent">· EP {currentEp?.number ?? episodeId}</span></h1></div><div className="watch-head-actions">
      <div className="toggle-set" role="group" aria-label="Audio language" data-testid="watch-audio-toggle">
        {(['sub', 'dub'] as const).map(a => { const ep = a === audio ? currentEp : counterpart(a); return <button key={a} type="button" className={audio === a ? 'selected' : ''} onClick={() => switchAudio(a)} disabled={!ep} aria-pressed={audio === a} title={ep ? (a === audio ? `Watching ${a === 'sub' ? 'subbed' : 'dubbed'}` : `Switch to ${a === 'sub' ? 'subbed' : 'dubbed'} (keeps your place)`) : `No ${a === 'sub' ? 'subbed' : 'dubbed'} version of this episode from ${provider || 'this source'}`} data-testid={`watch-audio-${a}`}>{a === 'sub' ? 'Sub' : 'Dub'}</button>; })}
      </div>
      <Link href={`/anime/${id}`} className="text-link" data-testid="link-watch-back">Series details</Link></div></div>
    <SeasonSwitcher id={id} />
    <div className="watch-layout">
      <section>
        {sourcesQuery.isLoading ? <div className="player-frame"><div className="player-empty"><div className="skeleton" style={{ width: 54, height: 54, margin: '0 auto 16px' }} /><h2>Finding a source</h2><p>Checking the provider for an available stream…</p></div></div> :
          sourcesQuery.error ? <div className="player-frame"><div className="player-empty"><div className="symbol"><Film size={22} /></div><h2>Could not resolve this episode</h2><p>{getErrorMessage(sourcesQuery.error)}</p><button className="btn" onClick={() => sourcesQuery.refetch()} data-testid="button-watch-retry">Try again</button></div></div> :
          response?.error ? <div className="player-frame"><div className="player-empty"><div className="symbol"><Film size={22} /></div><h2>Source unavailable</h2><p>{response.error}</p></div></div> :
          !mainStream ? <Player /> : mainStream.type === 'embed' ? <EmbedFrame url={mainStream.proxiedUrl || mainStream.url || ''} server={mainStream.server} /> : <Player key={`${mainStream.proxiedUrl || mainStream.url}:${retryKey}`} stream={mainStream} startAt={startAt} skip={skipQuery.data} skipLoaded={skipQuery.isSuccess || skipQuery.isError} autoSkipIntro={autoIntro} autoSkipOutro={autoOutro} onFail={(reason, detail) => {
            setFailLog(log => [...log, `${mainStream.server || `Source ${selectedStreamIndex + 1}`}: ${reason}${detail ? ` [${detail}]` : ''}`]);
            if (selectedStreamIndex < available.length - 1) setSelectedStreamIndex(i => i + 1); else setPlayError(reason);
          }} onEnded={() => { if (autoNext) goNext(); }} onNext={goNext} onTime={(pos, dur, force) => { timeRef.current = pos; if (lib.ready && metaRef.current.animeTitle) lib.report(metaRef.current, pos, dur, force); }} />}
        {playError && <div className="notice error" role="alert">{playError} Try another source from the list{streamUrl ? <>, or <a href={streamUrl} target="_blank" rel="noreferrer">open the stream directly</a></> : null}.
          <div className="notice-actions"><button type="button" className="btn ghost" onClick={() => { setPlayError(''); setFailLog([]); setSelectedStreamIndex(0); setRetryKey(k => k + 1); }} data-testid="button-player-retry">Retry playback</button>{provider === 'reanime' && currentEp?.number != null && <a className="text-link" href={`/api/debug/stream/${id}/${audio}/${currentEp.number}`} target="_blank" rel="noreferrer" data-testid="link-player-diagnostics">Run server diagnostics</a>}</div>
          {failLog.length > 0 && <details className="source-errors" open><summary>Technical details</summary><ul>{failLog.map((line, i) => <li key={i}>{line}</li>)}</ul></details>}</div>}
        <div className="watch-head bordered"><div><div className="overline">Episode</div><div style={{ fontSize: 14, marginTop: 6 }}>{currentEp?.title || `Episode ${currentEp?.number ?? episodeId}`}</div></div><div className="watch-nav">
          <button type="button" className={`pill-toggle${autoNext ? ' on' : ''}`} onClick={toggleAutoNext} aria-pressed={autoNext} title="Play the next episode automatically (N = next now)" data-testid="button-autoplay-next"><span className="pill-dot" aria-hidden="true" />Autoplay next</button>
          <button type="button" className={`pill-toggle${autoIntro ? ' on' : ''}`} onClick={() => toggleFlag('kanime:autoskipintro', setAutoIntro)} aria-pressed={autoIntro} title="Skip openings and recaps automatically (S = skip now)" data-testid="button-autoskip-intro"><span className="pill-dot" aria-hidden="true" />Auto-skip intro</button>
          <button type="button" className={`pill-toggle${autoOutro ? ' on' : ''}`} onClick={() => toggleFlag('kanime:autoskipoutro', setAutoOutro)} aria-pressed={autoOutro} title="Skip the ending credits automatically" data-testid="button-autoskip-outro"><span className="pill-dot" aria-hidden="true" />Auto-skip ending</button>
          <button type="button" className="square-btn" disabled={!detail} onClick={() => lib.toggleSaved(meta)} aria-label={saved ? 'Remove from saved episodes' : 'Save episode'} title={saved ? 'Saved' : 'Save episode'} data-testid="button-save-episode"><Bookmark size={17} fill={saved ? 'currentColor' : 'none'} /></button>
          {currentPosition > 0 && <Link className="square-btn" href={makeWatchUrl(episodes[currentPosition - 1])} aria-label="Previous episode" data-testid="link-previous-episode"><ArrowLeft size={17} /></Link>}
          {currentPosition >= 0 && currentPosition < episodes.length - 1 && <Link className="square-btn" href={makeWatchUrl(episodes[currentPosition + 1])} aria-label="Next episode" data-testid="link-next-episode"><ArrowRight size={17} /></Link>}
        </div></div>
        {episodesQuery.isError && <div className="notice">Episode navigation is unavailable: {getErrorMessage(episodesQuery.error)}</div>}
      </section>
      <aside className="watch-side"><div className="source-card"><h3>Sources</h3>
        {sourcesQuery.isLoading ? <div className="skeleton" style={{ height: 70 }} /> : sourcesQuery.error ? <div className="state-box"><p>Source details could not be loaded.</p></div> : response?.error ? <div className="notice">{response.error}</div> :
          <><div className="info-row"><span>Provider</span><span>{provider}</span></div><div className="info-row"><span>Audio</span><span>{audio.toUpperCase()}</span></div><div className="info-row"><span>Server</span><span>{mainStream?.server || response?.server || 'Not specified'}</span></div>
            {available.length > 0 ? <><div className="overline" style={{ margin: '17px 0 7px' }}>Available streams</div>{available.map((stream, i) => <button type="button" className={`source-button ${i === selectedStreamIndex ? 'selected' : ''}`} onClick={() => setSelectedStreamIndex(i)} key={`${stream.server}-${i}`} data-testid={`button-source-stream-${i}`}><strong>{stream.server || `Source ${i + 1}`}</strong><small>{stream.type || 'Media stream'}{stream.proxiedUrl ? ' · proxied' : ''}</small></button>)}</> : <div className="state-box" style={{ marginTop: 14 }}><p>The provider responded without a playable stream.</p></div>}
          </>}
      </div>
      {episodes.length > 0 && <div className="source-card"><h3>Episodes</h3><div className="ep-list">{episodes.map((ep, i) => {
        const epId = episodeKey(ep, provider) || `${provider}-${ep.number ?? i + 1}`;
        const prog = lib.progressFor(id, epId);
        const pct = prog?.duration ? Math.min(100, Math.round(((prog.position ?? 0) / prog.duration) * 100)) : 0;
        return <Link key={epId} href={makeWatchUrl(ep)} className={`ep-row${i === currentPosition ? ' current' : ''}`} data-testid={`link-ep-row-${ep.number ?? i + 1}`}>
          <b>{String(ep.number ?? i + 1).padStart(2, '0')}</b><span>{ep.title || `Episode ${ep.number ?? i + 1}`}</span>{lib.isSaved(id, epId) && <Bookmark size={12} fill="currentColor" className="saved-mark" />}{pct > 0 && <i className="ep-progress" style={{ width: `${pct}%` }} />}
        </Link>;
      })}</div></div>}
      </aside>
    </div>
    <Comments animeId={id} episode={currentEp?.number} />
  </main></Shell>;
}

function Router() {
  return <Switch>
    <Route path="/" component={HomePage} />
    <Route path="/search" component={SearchPage} />
    <Route path="/library" component={LibraryPage} />
    <Route path="/login">{() => <Shell><AuthPage mode="login" /></Shell>}</Route>
    <Route path="/signup">{() => <Shell><AuthPage mode="signup" /></Shell>}</Route>
    <Route path="/chat">{() => <Shell><ChatPage /></Shell>}</Route>
    <Route path="/u/:username">{() => <Shell><ProfilePage /></Shell>}</Route>
    <Route path="/anime/:id" component={DetailPage} />
    <Route path="/watch/:id/:provider/:audio/:episode" component={WatchPage} />
    <Route component={NotFound} />
  </Switch>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AuthProvider><LibraryProvider><Router /></LibraryProvider></AuthProvider></QueryClientProvider>;
}

export default App;
