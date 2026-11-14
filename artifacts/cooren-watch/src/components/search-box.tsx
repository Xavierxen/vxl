import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Search, X } from 'lucide-react';
import { metaLine, useAnimeSearch, useDebounced, type SearchCard } from '@/lib/search';

export function SearchBox() {
  const [, setLocation] = useLocation();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLFormElement>(null);
  const listId = useId();

  const query = useDebounced(value.trim(), 220);
  const { data, isFetching, isError } = useAnimeSearch(query, 1, 8);
  const typing = value.trim() !== query;

  const matches = (data?.results ?? []).slice(0, 6);
  const related = matches.length < 4 ? (data?.related ?? []).slice(0, 4 - matches.length + 2) : [];
  const items: SearchCard[] = [...matches, ...related];
  const showPanel = open && value.trim().length >= 2;

  useEffect(() => setActive(-1), [query]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const goAll = () => {
    const v = value.trim();
    if (!v) return;
    setOpen(false);
    setLocation(`/search?q=${encodeURIComponent(v)}`);
  };
  const goAnime = (a: SearchCard) => { setOpen(false); setValue(''); setLocation(`/anime/${a.id}`); };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (active >= 0 && items[active]) goAnime(items[active]);
    else goAll();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => (items.length ? (i + 1) % items.length : -1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (items.length ? (i <= 0 ? items.length - 1 : i - 1) : -1)); }
    else if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
  };

  const row = (a: SearchCard, i: number) => (
    <li key={a.id} role="option" aria-selected={active === i}>
      <button type="button" className="sb-item" data-active={active === i} onMouseEnter={() => setActive(i)} onClick={() => goAnime(a)} data-testid={`suggestion-${a.id}`}>
        {a.poster ? <img className="sb-thumb" src={a.poster} alt="" loading="lazy" /> : <span className="sb-thumb" />}
        <span className="sb-text"><span className="sb-title">{a.title}</span><span className="sb-sub">{metaLine(a)}</span></span>
      </button>
    </li>
  );

  return (
    <form ref={wrap} className="sb" role="search" onSubmit={onSubmit} data-testid="form-search">
      <Search size={16} aria-hidden="true" className="sb-icon" />
      <input
        value={value}
        onChange={e => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder="Search anime"
        aria-label="Search anime"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        autoComplete="off"
        data-testid="input-anime-search"
      />
      {(isFetching || typing) && value.trim().length >= 2 ? <Loader2 size={15} className="sb-spin" aria-hidden="true" /> :
        value ? <button type="button" className="sb-clear" aria-label="Clear search" onClick={() => { setValue(''); setOpen(false); }}><X size={15} /></button> : null}

      {showPanel && (
        <div className="sb-panel">
          <ul id={listId} role="listbox" aria-label="Search suggestions">
            {matches.length > 0 && <li role="presentation" className="sb-group">Matches</li>}
            {matches.map((a, i) => row(a, i))}
            {related.length > 0 && <li role="presentation" className="sb-group">{matches.length ? 'Related titles' : `Nothing exact for “${query}” — related titles`}</li>}
            {related.map((a, i) => row(a, matches.length + i))}
          </ul>
          {!items.length && !isFetching && !typing && (
            <div className="sb-empty">{isError ? 'Search is unavailable right now.' : `No results for “${query}”. Try fewer words or a different spelling.`}</div>
          )}
          {!items.length && (isFetching || typing) && <div className="sb-empty">Searching…</div>}
          {items.length > 0 && <button type="button" className="sb-foot" onClick={goAll}>See all results for “{value.trim()}”</button>}
        </div>
      )}
    </form>
  );
}
