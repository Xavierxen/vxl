import { SERVER_ORIGIN } from "../../../../core/config";
import { Logger } from "../../../../core/logger";
import { proxyUrl } from "../../../../core/proxy";
import { UA, upstreamError, withStatus } from "../core/http.js";
import { readLeadIn, unwrapBody } from "./segment-unwrap.js";

const HEADERS = { Referer: "https://flixcloud.cc/" };
const HOSTS = ["flixcloud.cc", "rundowncdn.top", "stronghole.site"];
const ROUTE = "/hls/flixcloud";
const TIMEOUT = 90_000;
const MAX_REDIRECTS = 3;
const MiB = 1024 * 1024;
const PLAYLIST_LIMIT = 5 * MiB;
const SEGMENT_LIMIT = 50 * MiB;
const CORS = { "Access-Control-Allow-Origin": "*" };
const PLAYLIST_TAG = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT)\b/;
const SEGMENT_TAG = /^#EXT-X-(?:MAP|PART|PRELOAD-HINT)\b/;

function trusted(url) {
  return (
    url.protocol === "https:" &&
    HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  );
}

function routeUrl(basePath, file, params) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== null && value !== undefined) query.set(name, String(value));
  return `${SERVER_ORIGIN}${basePath}${ROUTE}/${file}?${query}`;
}

export function flixcloudHlsUrl(stream, basePath = "") {
  return routeUrl(basePath, "playlist.m3u8", {
    url: stream.url,
    key: stream.playlistKey,
    audio: stream.audioTrack,
  });
}

function target(params) {
  let url;
  try {
    url = new URL(params.get("url") ?? "");
  } catch {
    throw withStatus(new Error("Invalid url"), 400);
  }
  if (!trusted(url)) throw withStatus(new Error("Forbidden url"), 403);
  return url;
}

async function upstream(url, signal, hop = 0) {
  if (!trusted(url)) throw withStatus(new Error(`Flixcloud redirected off-network: ${url}`), 502);
  const response = await fetch(url, {
    headers: { "User-Agent": UA, ...HEADERS },
    redirect: "manual",
    signal,
  });
  const location =
    response.status >= 300 && response.status < 400 && response.headers.get("location");
  if (!location || hop >= MAX_REDIRECTS) return response;
  void response.body?.cancel();
  return upstream(new URL(location, url), signal, hop + 1);
}

function capped(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel();
    throw withStatus(new Error("Flixcloud response too large"), 413);
  }
  return response;
}

async function timed(task, clientSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const signal = clientSignal
    ? AbortSignal.any([clientSignal, controller.signal])
    : controller.signal;
  try {
    return await task(signal);
  } catch (error) {
    if (error?.status) throw error;
    throw withStatus(new Error(`Flixcloud request failed: ${error?.message ?? error}`), 502);
  } finally {
    clearTimeout(timer);
  }
}

function decodePlaylist(text, key) {
  if (text.startsWith("#EXTM3U") || !key?.length) return text;
  const bytes = Buffer.from(text.trim(), "base64");
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length];
  const plain = bytes.toString("utf8");
  return plain.startsWith("#EXTM3U") ? plain : text;
}

function absolute(uri, base) {
  try {
    const url = new URL(uri, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function audioGroup(tag) {
  if (!tag.startsWith("#EXT-X-MEDIA:") || !/[:,]TYPE=AUDIO(?:,|$)/.test(tag)) return null;
  return tag.match(/GROUP-ID="([^"]*)"/)?.[1] ?? "";
}

function flag(tag, name, selected) {
  const value = selected ? "YES" : "NO";
  const pattern = new RegExp(`([:,])${name}=[A-Z]+`);
  if (pattern.test(tag)) return tag.replace(pattern, `$1${name}=${value}`);
  return selected ? `${tag},${name}=${value}` : tag;
}

function audioSelector(lines, audio) {
  if (!Number.isInteger(audio) || audio < 0) return (tag) => tag;
  const sizes = new Map();
  for (const line of lines) {
    const group = audioGroup(line.trim());
    if (group !== null) sizes.set(group, (sizes.get(group) ?? 0) + 1);
  }
  const seen = new Map();
  return (tag) => {
    const group = audioGroup(tag);
    if (group === null || audio >= sizes.get(group)) return tag;
    const index = seen.get(group) ?? 0;
    seen.set(group, index + 1);
    return flag(flag(tag, "DEFAULT", index === audio), "AUTOSELECT", index === audio);
  };
}

function rewritePlaylist(playlist, base, { key, audio, basePath }) {
  const lines = playlist.split(/\r?\n/);
  const master = playlist.includes("#EXT-X-STREAM-INF");
  const selectAudio = audioSelector(lines, audio);
  const link = (uri, kind) => {
    const url = absolute(uri, base);
    if (!url) return uri;
    if (kind === "file") return proxyUrl(url.href, HEADERS, "file");
    const nested = kind === "playlist";
    if (!trusted(url)) return proxyUrl(url.href, HEADERS, nested ? "hls" : "segment");
    return nested
      ? routeUrl(basePath, "playlist.m3u8", { url: url.href, key })
      : routeUrl(basePath, "segment.ts", { url: url.href });
  };
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith("#")) return link(trimmed, master ? "playlist" : "segment");
      const tag = selectAudio(trimmed);
      const kind = PLAYLIST_TAG.test(tag) ? "playlist" : SEGMENT_TAG.test(tag) ? "segment" : "file";
      return tag.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${link(uri, kind)}"`);
    })
    .join("\n");
}

async function servePlaylist(params, basePath, clientSignal) {
  const url = target(params);
  const key = params.get("key") || null;
  const audio = params.has("audio") ? Number(params.get("audio")) : null;
  const { response, text } = await timed(async (signal) => {
    const response = capped(await upstream(url, signal), PLAYLIST_LIMIT);
    return { response, text: await response.text() };
  }, clientSignal);
  if (!response.ok)
    throw withStatus(
      upstreamError(`Flixcloud playlist HTTP ${response.status}`, text, response.status),
      502,
    );
  const playlist = decodePlaylist(text, key && Buffer.from(key, "base64url"));
  if (!playlist.startsWith("#EXTM3U")) {
    Logger.warn(`[anivexa] Flixcloud playlist could not be decoded: ${url.pathname}`);
    throw withStatus(upstreamError("Flixcloud playlist could not be decoded", text), 502);
  }
  return new Response(
    rewritePlaylist(playlist, response.url || url.href, { key, audio, basePath }),
    {
      headers: {
        ...CORS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
      },
    },
  );
}

async function serveSegment(params, clientSignal) {
  const url = target(params);
  const { response, reader, lead } = await timed(async (signal) => {
    const response = await upstream(url, signal);
    if (!response.ok || !response.body) {
      void response.body?.cancel();
      throw withStatus(new Error(`Flixcloud segment HTTP ${response.status}`), 502);
    }
    const reader = capped(response, SEGMENT_LIMIT).body.getReader();
    return { response, reader, lead: await readLeadIn(reader) };
  }, clientSignal);
  if (!lead.found && lead.skip > 0)
    Logger.warn(`[anivexa] Flixcloud segment layout not recognised, using legacy unwrap: ${url.pathname}`);
  const headers = new Headers({
    ...CORS,
    "Content-Type": "video/mp2t",
    "Cache-Control": "public, max-age=86400",
    "X-Segment-Unwrap": `skip=${lead.skip};masked=${lead.masked ? 1 : 0};found=${lead.found ? 1 : 0}`,
  });
  const length = Number(response.headers.get("content-length"));
  if (length > lead.skip && !response.headers.has("content-encoding"))
    headers.set("Content-Length", String(length - lead.skip));
  return new Response(unwrapBody(reader, lead), { headers });
}

export function flixcloudHls(file, { url, basePath = "", request }) {
  return file === "segment.ts"
    ? serveSegment(url.searchParams, request?.signal)
    : servePlaylist(url.searchParams, basePath, request?.signal);
}
