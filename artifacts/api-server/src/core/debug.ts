import { Elysia } from "elysia";
import { watch as reanimeWatch } from "../providers/anime/anivexa/providers/reanime.js";

// Open  /api/debug/stream/<anilistId>/<sub|dub>/<episode>  (e.g. /api/debug/stream/21/sub/1)
// to see exactly which step of the reanime playback chain fails on this host.
const abs = (origin: string, url: string) => (url.startsWith("/") ? origin + url : url);

async function probe(url: string, init: RequestInit = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, type: res.headers.get("content-type"), bytes: buf.length, ms: Date.now() - started, head: new TextDecoder().decode(buf.slice(0, 160)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message, ms: Date.now() - started };
  }
}

export const debugRoutes = new Elysia({ prefix: "/debug" }).get("/stream/:id/:audio/:episode", async ({ params, request }) => {
  const origin = new URL(request.url).origin;
  const steps: Record<string, unknown>[] = [];
  const out = { host: origin, vercel: Boolean(process.env.VERCEL), node: process.version, steps };
  let data: any;
  try {
    data = await reanimeWatch(Number(params.id), params.audio === "dub" ? "dub" : "sub", Number(params.episode), { basePath: "/anime/anivexa" });
    steps.push({ step: "1 resolve stream (reanime + flixcloud)", ok: true, server: data.server, streamUrl: data.stream_url, proxiedUrl: data.proxiedUrl });
  } catch (e: any) {
    steps.push({ step: "1 resolve stream (reanime + flixcloud)", ok: false, error: e.message, upstreamStatus: e.upstreamStatus, body: String(e.rawBody ?? "").slice(0, 300) });
    return out;
  }
  const playlist = await probe(abs(origin, data.proxiedUrl));
  steps.push({ step: "2 playlist through our proxy", ...playlist });
  if (!playlist.ok) return out;
  const text = await (await fetch(abs(origin, data.proxiedUrl))).text();
  const first = text.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  if (!first) return out;
  const inner = abs(origin, first);
  const second = await probe(inner);
  steps.push({ step: "3 next playlist or first segment", url: inner.slice(0, 200), ...second });
  if (second.ok && String(second.head).startsWith("#EXTM3U")) {
    const t2 = await (await fetch(inner)).text();
    const seg = t2.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
    if (seg) steps.push({ step: "4 first video segment", url: abs(origin, seg).slice(0, 200), ...(await probe(abs(origin, seg), { headers: { range: "bytes=0-65535" } })) });
  }
  return out;
});
