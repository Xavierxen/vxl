import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { getAnimeEpisodes, getGetAnimeEpisodesQueryKey } from '@workspace/api-client-react';
import type { AnimeEpisodeIndex } from '@workspace/api-client-react';

// Every episode source that can run without a headless browser (mkissa needs one, so it is left out).
export const EPISODE_PROVIDERS = ['reanime', 'anikoto', 'animegg', '2dhive', 'animenosub', 'anizone', 'aniwaves', 'anibd', 'senshi', 'kaa', 'animeonsen'];

function hasEpisodes(entry: unknown) {
  const eps = (entry as { episodes?: Record<string, unknown> } | undefined)?.episodes;
  return !!eps && Object.values(eps).some(list => Array.isArray(list) && list.length > 0);
}

/**
 * Asks every source at the same time and merges whatever answers.
 * One blocked or slow source no longer hides the others, and failures are reported per source.
 */
export function useEpisodeSources(id: number, enabled: boolean) {
  const results = useQueries({
    queries: EPISODE_PROVIDERS.map(provider => ({
      queryKey: getGetAnimeEpisodesQueryKey(provider, id, { map: false }),
      queryFn: ({ signal }: { signal?: AbortSignal }) => getAnimeEpisodes(provider, id, { map: false }, { signal }),
      enabled: enabled && id > 0,
      staleTime: 5 * 60_000,
      retry: 0,
    })),
  });

  const key = results.map(r => `${r.status}:${r.dataUpdatedAt}`).join('|');
  return useMemo(() => {
    const index: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    results.forEach((r, i) => {
      const provider = EPISODE_PROVIDERS[i];
      const entry = (r.data as Record<string, unknown> | undefined)?.[provider];
      if (hasEpisodes(entry)) index[provider] = entry;
      else if (r.isError) errors[provider] = r.error instanceof Error ? r.error.message : 'Request failed';
      else if (r.data) {
        const top = (r.data as { error?: unknown }).error;
        const nested = (entry as { error?: unknown } | undefined)?.error;
        errors[provider] = String(nested || top || 'No episodes returned');
      }
    });
    const pending = results.some(r => r.isPending && r.fetchStatus !== 'idle');
    return { index: index as unknown as AnimeEpisodeIndex, errors, pending, refetch: () => results.forEach(r => void r.refetch()) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
