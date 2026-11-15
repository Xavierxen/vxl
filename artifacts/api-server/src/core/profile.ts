import { Elysia, t } from "elysia";
import { AuthError, COOKIE, guard, loadDb, publicUser, sameSite, userFromToken } from "./auth";
import { env } from "./runtime";

// Profiles: bio, profile picture and banner. The join date is the account's created_at.
//
// Images are stored in Supabase Storage (public bucket) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set,
// and otherwise in the database itself (profile_images) and served from /api/profile-image. Either way the user
// row only keeps a URL.

const BUCKET = "profile-media";
const KINDS = ["avatar", "banner"] as const;
type Kind = (typeof KINDS)[number];
const MAX_BYTES: Record<Kind, number> = { avatar: 600_000, banner: 1_500_000 };
const MIME_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const supabaseUrl = () => (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = () => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || "";
const storageReady = () => Boolean(supabaseUrl() && serviceKey());
const apiBase = () => env.BASE_PATH || "/api";

const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

// Check the real bytes, not the claimed type: only JPEG, PNG and WebP pass.
export function sniffMime(buf: Buffer): string | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function decodeImage(dataUrl: string, kind: Kind) {
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new AuthError("Use a JPEG, PNG or WebP image.", 400);
  const buf = Buffer.from(match[1], "base64");
  const mime = sniffMime(buf);
  if (!mime) throw new AuthError("That file is not a valid JPEG, PNG or WebP image.", 400);
  if (buf.length > MAX_BYTES[kind]) throw new AuthError("That image is too large. Try a smaller one.", 413);
  return { buf, mime };
}

async function storageRequest(path: string, init: RequestInit) {
  const key = serviceKey();
  return fetch(`${supabaseUrl()}/storage/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, apikey: key, ...(init.headers as Record<string, string> | undefined) },
  });
}

let bucketReady: Promise<void> | null = null;
function ensureBucket() {
  return (bucketReady ??= (async () => {
    const res = await storageRequest("bucket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 2_000_000, allowed_mime_types: Object.keys(MIME_EXT) }),
    });
    // 200 = created; 400/409 = it already exists.
    if (!res.ok && res.status !== 400 && res.status !== 409) throw new Error(`Supabase Storage bucket setup failed (${res.status}).`);
  })().catch((err) => {
    bucketReady = null;
    throw err;
  }));
}

const publicStorageUrl = (path: string) => `${supabaseUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
const storagePathOf = (url: string) => (url.startsWith(publicStorageUrl("")) ? url.slice(publicStorageUrl("").length) : null);

async function removeStored(url: string) {
  const path = storagePathOf(url);
  if (!path || !storageReady()) return;
  await storageRequest(`object/${BUCKET}/${path}`, { method: "DELETE" }).catch(() => undefined);
}

async function requireUser(cookie: Record<string, any>) {
  const user = await userFromToken(cookie[COOKIE].value as string | undefined);
  if (!user) throw new AuthError("Log in first.", 401);
  return user;
}

const column = (kind: Kind) => (kind === "avatar" ? "avatar_url" : "banner_url");

export const profileRoutes = new Elysia()
  // Anyone can view a profile: name, pictures, bio, join date and two counts. No email.
  .get("/users/:username", ({ params, set }) =>
    guard(set, async () => {
      const name = params.username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(name)) throw new AuthError("User not found.", 404);
      const { pool } = await loadDb();
      const found = await pool.query(
        `SELECT id, display_name AS "displayName", avatar_url AS "avatarUrl", banner_url AS "bannerUrl", bio, theme_color AS "themeColor",
                created_at AS "createdAt" FROM users WHERE username = $1`,
        [name],
      );
      const row = found.rows[0];
      if (!row) throw new AuthError("User not found.", 404);
      const stats = await pool.query(
        `SELECT (SELECT count(*)::int FROM watch_progress WHERE user_id = $1) AS watched,
                (SELECT count(*)::int FROM saved_episodes WHERE user_id = $1) AS saved`,
        [row.id],
      );
      return {
        success: true as const,
        profile: {
          username: row.displayName as string,
          avatarUrl: row.avatarUrl as string,
          bannerUrl: row.bannerUrl as string,
          bio: row.bio as string,
          themeColor: row.themeColor as string,
          createdAt: (row.createdAt as Date).toISOString(),
          watched: stats.rows[0].watched as number,
          saved: stats.rows[0].saved as number,
        },
      };
    }),
  )
  .put(
    "/me/profile",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const { pool } = await loadDb();
        let bio = user.bio ?? "";
        let themeColor = user.themeColor ?? "";
        if (body.bio !== undefined) {
          bio = body.bio.replace(/\s+/g, " ").trim().slice(0, 160);
          await pool.query(`UPDATE users SET bio = $1 WHERE id = $2`, [bio, user.id]);
        }
        if (body.themeColor !== undefined) {
          // "#rrggbb" or empty (back to the default). Anything else is rejected so it can never end up in CSS.
          if (body.themeColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(body.themeColor)) throw new AuthError("Pick a valid colour.", 400);
          themeColor = body.themeColor.toLowerCase();
          await pool.query(`UPDATE users SET theme_color = $1 WHERE id = $2`, [themeColor, user.id]);
        }
        return { success: true as const, user: publicUser({ ...user, bio, themeColor }) };
      }),
    { body: t.Object({ bio: t.Optional(t.String({ maxLength: 1000 })), themeColor: t.Optional(t.String({ maxLength: 7 })) }) },
  )
  .post(
    "/me/profile/image",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        if (!isKind(body.kind)) throw new AuthError("Unknown image type.", 400);
        const kind = body.kind;
        const { buf, mime } = decodeImage(body.dataUrl, kind);
        const { pool } = await loadDb();
        const previous: string = (kind === "avatar" ? user.avatarUrl : user.bannerUrl) ?? "";

        let url: string;
        if (storageReady()) {
          await ensureBucket();
          const path = `users/${user.id}/${kind}-${Date.now()}.${MIME_EXT[mime]}`;
          const res = await storageRequest(`object/${BUCKET}/${path}`, {
            method: "POST",
            headers: { "content-type": mime, "x-upsert": "true", "cache-control": "max-age=31536000" },
            body: buf,
          });
          if (!res.ok) throw new Error(`Supabase Storage upload failed (${res.status}): ${await res.text().catch(() => "")}`);
          url = publicStorageUrl(path);
        } else {
          await pool.query(
            `INSERT INTO profile_images (user_id, kind, mime, data, updated_at) VALUES ($1,$2,$3,$4,now())
             ON CONFLICT (user_id, kind) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`,
            [user.id, kind, mime, buf],
          );
          url = `${apiBase()}/profile-image/${user.id}/${kind}?v=${Date.now()}`;
        }
        await pool.query(`UPDATE users SET ${column(kind)} = $1 WHERE id = $2`, [url, user.id]);
        if (previous && previous !== url) void removeStored(previous);
        return { success: true as const, user: publicUser({ ...user, avatarUrl: kind === "avatar" ? url : user.avatarUrl, bannerUrl: kind === "banner" ? url : user.bannerUrl }) };
      }),
    { body: t.Object({ kind: t.String(), dataUrl: t.String({ maxLength: 3_000_000 }) }) },
  )
  .post(
    "/me/profile/image/remove",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        if (!isKind(body.kind)) throw new AuthError("Unknown image type.", 400);
        const kind = body.kind;
        const { pool } = await loadDb();
        const previous: string = (kind === "avatar" ? user.avatarUrl : user.bannerUrl) ?? "";
        await pool.query(`UPDATE users SET ${column(kind)} = '' WHERE id = $1`, [user.id]);
        await pool.query(`DELETE FROM profile_images WHERE user_id = $1 AND kind = $2`, [user.id, kind]);
        if (previous) void removeStored(previous);
        return { success: true as const, user: publicUser({ ...user, avatarUrl: kind === "avatar" ? "" : user.avatarUrl, bannerUrl: kind === "banner" ? "" : user.bannerUrl }) };
      }),
    { body: t.Object({ kind: t.String() }) },
  )
  // Only used when images live in the database. The ?v= in the URL changes on every upload, so it can be cached hard.
  .get("/profile-image/:userId/:kind", async ({ params }) => {
    const id = Number(params.userId);
    if (!Number.isInteger(id) || !isKind(params.kind)) return new Response("Not found", { status: 404 });
    try {
      const { pool } = await loadDb();
      const res = await pool.query(`SELECT mime, data FROM profile_images WHERE user_id = $1 AND kind = $2`, [id, params.kind]);
      const row = res.rows[0];
      if (!row) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(row.data as Buffer), {
        headers: {
          "content-type": row.mime as string,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (err) {
      console.error("[profile-image]", err);
      return new Response("Unavailable", { status: 503 });
    }
  });
