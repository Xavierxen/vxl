import { fetchWithRetry, queryAniList } from "../lib/helpers";
import { Logger } from "../../../../core/logger";

type Span = { start: number; end: number };
export type SkipTimes = { intro: Span | null; outro: Span | null; recap: Span | null; source: string };

// Intro / ending / recap timestamps from AniSkip (community data keyed by MAL id + episode number).
export async function scrapeSkipTimes(anilistId: number, episode: number): Promise<SkipTimes> {
  const empty: SkipTimes = { intro: null, outro: null, recap: null, source: "" };
  const ep = Math.floor(episode);
  if (!Number.isFinite(ep) || ep < 1) return empty;

  const data = await queryAniList(`query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }`, { id: anilistId });
  const malId = Number(data?.Media?.idMal);
  if (!malId) return empty;

  const types = ["op", "ed", "mixed-op", "mixed-ed", "recap"].map((t) => `types=${t}`).join("&");
  try {
    const res = await fetchWithRetry(`https://api.aniskip.com/v2/skip-times/${malId}/${ep}?${types}&episodeLength=0`, { headers: { Accept: "application/json" } }, 2, 6_000);
    if (!res.ok) return empty; // 404 simply means "nobody has submitted times for this episode"
    const body = (await res.json().catch(() => null)) as { found?: boolean; results?: { skipType?: string; interval?: { startTime?: number; endTime?: number } }[] } | null;
    const out = { ...empty, source: "aniskip" };
    for (const r of body?.results ?? []) {
      const start = Number(r.interval?.startTime), end = Number(r.interval?.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3) continue;
      const span = { start, end };
      if ((r.skipType === "op" || r.skipType === "mixed-op") && !out.intro) out.intro = span;
      else if ((r.skipType === "ed" || r.skipType === "mixed-ed") && !out.outro) out.outro = span;
      else if (r.skipType === "recap" && !out.recap) out.recap = span;
    }
    return out;
  } catch (err) {
    Logger.warn(`[skip] AniSkip lookup failed for MAL ${malId} ep ${ep}: ${(err as Error).message}`);
    return empty;
  }
}
