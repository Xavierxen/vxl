import type { IncomingMessage, ServerResponse } from "node:http";
import app from "./app";

// Vercel Node function entry: adapts (req, res) to the Web-standard fetch handler that Elysia exposes.

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const path = req.url || "/";
  const method = req.method || "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }

  let response: Response;
  try {
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    response = await app.fetch(new Request(`${proto}://${req.headers.host}${path}`, { method, headers, body }));
  } catch (err) {
    console.error("[vercel] request failed", err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: false, error: "Internal server error" }));
    return;
  }

  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie?.() ?? [];
  // fetch() has already decoded compressed upstream bodies, so never forward the old encoding headers.
  const drop = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding", "content-encoding"]);
  const decoded = response.headers.has("content-encoding");
  response.headers.forEach((value, key) => {
    if (drop.has(key) || (decoded && key === "content-length")) return;
    res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader("set-cookie", cookies);

  // Public catalog data is identical for everyone: let Vercel's CDN absorb repeat hits
  // (AniList rate-limits at ~90 requests/min and there is no Redis cache on Vercel).
  if (path.startsWith("/api/auth") || path.startsWith("/api/me/")) {
    res.setHeader("cache-control", "no-store");
  } else if (
    method === "GET" &&
    response.status === 200 &&
    path.startsWith("/api/meta/") &&
    !cookies.length &&
    !response.headers.has("cache-control")
  ) {
    res.setHeader("cache-control", "public, s-maxage=600, stale-while-revalidate=3600");
  }

  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => undefined));
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve));
  }
  res.end();
}
