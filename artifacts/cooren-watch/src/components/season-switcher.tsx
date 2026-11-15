import { Link } from 'wouter';
import { useSeasons } from '@/lib/franchise';

/** A row of season buttons for the franchise, with the one you are on highlighted. Each opens that season's page. */
export function SeasonSwitcher({ id }: { id: number }) {
  const { data, isLoading } = useSeasons(id);
  if (isLoading) return <div className="season-bar"><div className="skeleton" style={{ height: 38, width: 260 }} /></div>;
  if (!data || !data.entries.length) return null;
  const seasons = data.entries.filter(e => e.kind === 'season');
  const others = data.entries.filter(e => e.kind === 'other');
  const here = data.entries.find(e => e.current);
  return <nav className="season-bar" aria-label="Seasons" data-testid="season-switcher">
    <span className="season-bar-label">{seasons.length === 1 ? '1 season' : `${seasons.length} seasons`}</span>
    <div className="season-pills">
      {seasons.map(e => <Link key={e.id} href={`/anime/${e.id}`} className={`season-pill${e.current ? ' on' : ''}`} aria-current={e.current ? 'page' : undefined} title={`${e.title}${e.episodes ? ` · ${e.episodes} episodes` : ''}`} data-testid={`pill-season-${e.number}`}>Season {e.number}</Link>)}
      {here?.kind === 'other' && <span className="season-pill on" aria-current="page">{(here.format || 'Special').replace('_', ' ')}</span>}
      {others.length > 0 && <a href="#seasons" className="season-pill more">+{others.length} movie/special{others.length > 1 ? 's' : ''}</a>}
    </div>
  </nav>;
}
