import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AnimeCard } from '@workspace/api-client-react';

export type SearchCard = AnimeCard & { genres?: string[] };
export type SearchPayload = {
  pageInfo?: { hasNextPage?: boolean; total?: number };
  results: SearchCard[];
  related: SearchCard[];
};

export async function fetchSearch(query: string, page: number, perPage: number, signal?: AbortSignal): Promise<SearchPayload> {
  const res = await fetch(`/api/meta/anilist/search/${encodeURIComponent(query)}?page=${page}&perPage=${perPage}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(body?.error || 'Search is unavailable right now.');
  return { pageInfo: body.data?.pageInfo, results: body.data?.results ?? [], related: body.data?.related ?? [] };
}

export function useAnimeSearch(query: string, page = 1, perPage = 24) {
  return useQuery({
    queryKey: ['anime-search', query.toLowerCase(), page, perPage],
    queryFn: ({ signal }) => fetchSearch(query, page, perPage, signal),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useDebounced<T>(value: T, delay = 220) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}

export function metaLine(a: SearchCard) {
  return [a.type, a.seasonYear, a.averageScore != null ? `★ ${(a.averageScore / 10).toFixed(1)}` : null].filter(Boolean).join(' · ');
}
