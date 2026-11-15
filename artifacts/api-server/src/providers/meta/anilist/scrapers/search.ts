import { descriptionOf, formatStatus, presentMedia, queryAniList } from "../lib/helpers";
import { RELATED_QUERY, SEARCH_QUERY } from "../lib/queries";

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

function toCard(media: any) {
  return {
    id: media.id,
    ...presentMedia(media),
    type: media.format || "TV",
    format: media.format || "TV",
    status: formatStatus(media.status),
    description: descriptionOf(media).slice(0, 320),
    genres: media.genres ?? [],
    episodes: media.episodes,
    averageScore: media.averageScore,
    season: media.season,
    seasonYear: media.seasonYear,
    color: media.coverImage?.color || "",
  };
}

// How well does any title/synonym match what was typed? AniList's SEARCH_MATCH is
// fuzzy, so we re-order on top of it: exact > prefix > contains > word overlap.
function relevance(media: any, query: string, tokens: string[]) {
  const names = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms ?? [])]
    .filter(Boolean)
    .map(normalize);
  let best = 0;
  for (const name of names) {
    let score = 0;
    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 85;
    else if (name.includes(query)) score = 70;
    else if (tokens.length) {
      const words = new Set(name.split(" "));
      const hits = tokens.filter((t) => words.has(t) || name.includes(t)).length;
      score = (hits / tokens.length) * 55;
    }
    best = Math.max(best, score);
  }
  return best + Math.log10((media.popularity ?? 0) + 10) * 2;
}

export async function scrapeSearch(query: string, page = 1, perPage = 20) {
  const q = normalize(query);
  const tokens = q.split(" ").filter((t) => t.length > 1);

  const [main, related] = await Promise.all([
    queryAniList(SEARCH_QUERY, { search: query, page, perPage }),
    page === 1 ? queryAniList(RELATED_QUERY, { search: query }).catch(() => null) : null,
  ]);

  const media: any[] = main.Page?.media ?? [];
  const ranked = [...media].sort((a, b) => relevance(b, q, tokens) - relevance(a, q, tokens));
  const results = ranked.map(toCard);
  const seen = new Set<number>(results.map((r) => r.id));

  const extra: any[] = [];
  const add = (m: any) => {
    if (m?.id && !seen.has(m.id)) {
      seen.add(m.id);
      extra.push(toCard(m));
    }
  };

  // 1) Recommendations of the best match.
  for (const node of related?.Media?.recommendations?.nodes ?? []) add(node?.mediaRecommendation);

  // 2) Few hits for a multi-word query: also try the individual words.
  if (page === 1 && results.length < 4 && tokens.length > 1) {
    const words = [...tokens].sort((a, b) => b.length - a.length).filter((t) => t.length > 2).slice(0, 2);
    for (const word of words) {
      const part = await queryAniList(SEARCH_QUERY, { search: word, page: 1, perPage: 8 }).catch(() => null);
      for (const m of part?.Page?.media ?? []) add(m);
    }
  }

  return {
    pageInfo: main.Page?.pageInfo,
    results,
    related: extra.slice(0, 12),
  };
}
