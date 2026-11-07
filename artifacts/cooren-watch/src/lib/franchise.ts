import { useQuery } from '@tanstack/react-query';

export type SeasonEntry = { id: number; title: string; titleRomaji: string; poster: string; format: string; status: string; episodes: number | null; year: number | null; kind: 'season' | 'other'; number: number | null; current: boolean };
export type Seasons = { seasonCount: number; entries: SeasonEntry[] };
export type Span = { start: number; end: number };
export type SkipTimes = { intro: Span | null; outro: Span | null; recap: Span | null; source: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(body?.error || `Request failed (${res.status})`);
  return body.data as T;
}

/** Every season (and movie / OVA) of the franchise this anime belongs to, in watching order. */
export function useSeasons(id: number) {
  return useQuery({ queryKey: ['seasons', id], queryFn: () => getJson<Seasons>(`/api/meta/anilist/anime/${id}/seasons`), enabled: id > 0, staleTime: 6 * 3600_000, retry: 1 });
}

/** Intro / ending / recap timestamps for one episode (empty when nobody has submitted them). */
export function useSkipTimes(id: number, episode?: number | string) {
  const ep = Number(episode);
  return useQuery({ queryKey: ['skip', id, Math.floor(ep)], queryFn: () => getJson<SkipTimes>(`/api/meta/anilist/anime/${id}/skip/${Math.floor(ep)}`), enabled: id > 0 && Number.isFinite(ep) && ep >= 1, staleTime: 12 * 3600_000, retry: 0 });
}
