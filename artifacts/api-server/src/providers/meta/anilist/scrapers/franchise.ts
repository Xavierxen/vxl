import { AniListError, queryAniList } from "../lib/helpers";

// Walks PREQUEL / SEQUEL links outward from one AniList entry to find the whole franchise in watching order.
// One request per "layer" of the walk (AniList lets us fetch many ids at once), so this stays cheap.
const FRANCHISE_QUERY = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      format
      status
      episodes
      seasonYear
      startDate { year month day }
      title { romaji english }
      coverImage { large }
      relations { edges { relationType(version: 2) node { id type } } }
    }
  }
}`;

const MAIN_FORMATS = new Set(["TV", "TV_SHORT"]);
const MAX_ENTRIES = 40;
const MAX_LAYERS = 12;

type Media = {
  id: number;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  title?: { romaji?: string | null; english?: string | null };
  coverImage?: { large?: string | null };
  relations?: { edges?: { relationType?: string; node?: { id: number; type?: string } }[] };
};

const dateKey = (m: Media) => {
  const d = m.startDate;
  return d?.year ? d.year * 10000 + (d.month || 1) * 100 + (d.day || 1) : Number.MAX_SAFE_INTEGER;
};

export async function scrapeFranchise(rootId: number) {
  const found = new Map<number, Media>();
  let frontier = [rootId];
  for (let layer = 0; layer < MAX_LAYERS && frontier.length && found.size < MAX_ENTRIES; layer++) {
    const data = await queryAniList(FRANCHISE_QUERY, { ids: frontier });
    const rows: Media[] = data?.Page?.media ?? [];
    if (layer === 0 && !rows.length) throw new AniListError("Anime not found", 404);
    const next = new Set<number>();
    for (const m of rows) {
      if (found.has(m.id)) continue;
      found.set(m.id, m);
      for (const edge of m.relations?.edges ?? []) {
        const id = edge.node?.id;
        if ((edge.relationType === "PREQUEL" || edge.relationType === "SEQUEL") && edge.node?.type === "ANIME" && id && !found.has(id)) next.add(id);
      }
    }
    frontier = [...next].slice(0, MAX_ENTRIES - found.size);
  }

  const all = [...found.values()].sort((a, b) => dateKey(a) - dateKey(b) || a.id - b.id);
  // Normally seasons are the TV entries. Some franchises are released as ONA only; then those count as seasons.
  const hasTv = all.some((m) => MAIN_FORMATS.has(m.format ?? ""));
  const isSeason = (m: Media) => (hasTv ? MAIN_FORMATS.has(m.format ?? "") : m.format === "ONA" || MAIN_FORMATS.has(m.format ?? ""));
  let seasonNo = 0;
  const entries = all.map((m) => {
    const season = isSeason(m);
    return {
      id: m.id,
      title: m.title?.english || m.title?.romaji || "Untitled",
      titleRomaji: m.title?.romaji || "",
      poster: m.coverImage?.large || "",
      format: m.format || "",
      status: m.status || "",
      episodes: m.episodes ?? null,
      year: m.seasonYear ?? m.startDate?.year ?? null,
      kind: season ? ("season" as const) : ("other" as const),
      number: season ? ++seasonNo : null,
      current: m.id === rootId,
    };
  });
  return { seasonCount: seasonNo, entries };
}
