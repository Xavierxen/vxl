import { Elysia, t } from "elysia";
import { AuthError, COOKIE, guard, loadDb, sameSite, userFromToken } from "./auth";
import { sniffMime } from "./profile";
import { env } from "./runtime";

// Global chat. Only signed-in people can read or write. Messages can carry text, one image, or one sticker.
// Real time is done by polling (GET /chat/messages?after=<id>), which works on serverless hosts such as Vercel.

const apiBase = () => env.BASE_PATH || "/api";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 500;
const IMAGE_MAX_BYTES = 1_400_000;
const STICKER_MAX_BYTES = 450_000;
const MAX_STICKERS = 60;
const MAX_FAVORITES = 200;

async function requireUser(cookie: Record<string, any>) {
  const user = await userFromToken(cookie[COOKIE].value as string | undefined);
  if (!user) throw new AuthError("Log in to use the chat.", 401);
  return user;
}

function decode(dataUrl: string, maxBytes: number) {
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new AuthError("Use a JPEG, PNG or WebP image.", 400);
  const buf = Buffer.from(match[1], "base64");
  const mime = sniffMime(buf);
  if (!mime) throw new AuthError("That file is not a valid JPEG, PNG or WebP image.", 400);
  if (buf.length > maxBytes) throw new AuthError("That image is too large. Try a smaller one.", 413);
  return { buf, mime };
}

const mediaUrl = (id: string) => `${apiBase()}/chat/media/${id}`;
const stickerUrl = (id: string) => `${apiBase()}/chat/stickers/${id}/image`;

const MESSAGE_SELECT = `
  SELECT m.id::float8 AS id, m.body, (extract(epoch FROM m.created_at) * 1000)::float8 AS "createdAt",
         u.display_name AS username, u.avatar_url AS "avatarUrl", (m.user_id = $1) AS own,
         m.image_id AS "imageId", m.sticker_id AS "stickerId", (f.user_id IS NOT NULL) AS "stickerFav"
  FROM chat_messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN sticker_favorites f ON f.sticker_id = m.sticker_id AND f.user_id = $1`;
// Skip rows whose image or sticker was removed and that have no text left.
const VISIBLE = `(m.body <> '' OR m.image_id IS NOT NULL OR m.sticker_id IS NOT NULL)`;

type Row = Record<string, any>;
const shapeMessage = (r: Row) => ({
  id: r.id as number,
  text: r.body as string,
  createdAt: r.createdAt as number,
  username: r.username as string,
  avatarUrl: r.avatarUrl as string,
  own: Boolean(r.own),
  imageUrl: r.imageId ? mediaUrl(r.imageId as string) : "",
  imageId: (r.imageId as string) || "",
  stickerId: (r.stickerId as string) || "",
  stickerUrl: r.stickerId ? stickerUrl(r.stickerId as string) : "",
  stickerFav: Boolean(r.stickerFav),
});

const shapeSticker = (r: Row) => ({ id: r.id as string, url: stickerUrl(r.id as string), favorited: Boolean(r.favorited), mine: Boolean(r.mine) });

const bytes = (row: Row) =>
  new Response(new Uint8Array(row.data as Buffer), {
    headers: { "content-type": row.mime as string, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });

export const chatRoutes = new Elysia({ prefix: "/chat" })
  .get(
    "/messages",
    ({ query, cookie, set }) =>
      guard(set, async () => {
        const user = await requireUser(cookie);
        const { pool } = await loadDb();
        const after = Number(query.after);
        const before = Number(query.before);
        const incremental = Number.isFinite(after) && after > 0;
        // Messages are kept forever: new ones come with ?after=<id>, older pages with ?before=<id> (50 at a time).
        const res = incremental
          ? await pool.query(`${MESSAGE_SELECT} WHERE m.id > $2 AND ${VISIBLE} ORDER BY m.id ASC LIMIT 100`, [user.id, Math.floor(after)])
          : Number.isFinite(before) && before > 0
            ? await pool.query(`${MESSAGE_SELECT} WHERE m.id < $2 AND ${VISIBLE} ORDER BY m.id DESC LIMIT 51`, [user.id, Math.floor(before)])
            : await pool.query(`${MESSAGE_SELECT} WHERE ${VISIBLE} ORDER BY m.id DESC LIMIT 51`, [user.id]);
        if (incremental) return { success: true as const, messages: res.rows.map(shapeMessage), hasMore: false };
        const hasMore = res.rows.length > 50;
        return { success: true as const, messages: res.rows.slice(0, 50).reverse().map(shapeMessage), hasMore };
      }),
    { query: t.Object({ after: t.Optional(t.String()), before: t.Optional(t.String()) }) },
  )
  .post(
    "/messages",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const text = (body.text ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        const imageId = body.imageId || null;
        const stickerId = body.stickerId || null;
        if (text.length > MAX_TEXT) throw new AuthError(`Messages can be up to ${MAX_TEXT} characters.`, 400);
        if (!text && !imageId && !stickerId) throw new AuthError("Write something or attach an image or sticker.", 400);
        if (imageId && stickerId) throw new AuthError("Send an image or a sticker, not both.", 400);
        if ((imageId && !UUID.test(imageId)) || (stickerId && !UUID.test(stickerId))) throw new AuthError("Invalid attachment.", 400);

        const { pool } = await loadDb();
        const recent = await pool.query(`SELECT count(*)::int AS n FROM chat_messages WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [user.id]);
        if (recent.rows[0].n >= 20) throw new AuthError("You are sending messages too fast. Wait a few seconds.", 429);
        if (imageId) {
          const own = await pool.query(`SELECT 1 FROM chat_images WHERE id = $1 AND user_id = $2`, [imageId, user.id]);
          if (!own.rowCount) throw new AuthError("That image upload expired. Attach it again.", 400);
        }
        if (stickerId) {
          const found = await pool.query(`SELECT 1 FROM stickers WHERE id = $1`, [stickerId]);
          if (!found.rowCount) throw new AuthError("That sticker no longer exists.", 404);
        }
        const inserted = await pool.query(`INSERT INTO chat_messages (user_id, body, image_id, sticker_id) VALUES ($1,$2,$3,$4) RETURNING id::float8 AS id`, [user.id, text, imageId, stickerId]);

        const row = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $2`, [user.id, inserted.rows[0].id]);
        set.status = 201;
        return { success: true as const, message: shapeMessage(row.rows[0]) };
      }),
    { body: t.Object({ text: t.Optional(t.String({ maxLength: 2000 })), imageId: t.Optional(t.String()), stickerId: t.Optional(t.String()) }) },
  )
  .delete("/messages/:id", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await requireUser(cookie);
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) throw new AuthError("Message not found.", 404);
      const { pool } = await loadDb();
      const gone = await pool.query(`DELETE FROM chat_messages WHERE id = $1 AND user_id = $2 RETURNING image_id`, [id, user.id]);
      if (!gone.rowCount) throw new AuthError("You can only delete your own messages.", 403);
      if (gone.rows[0].image_id) await pool.query(`DELETE FROM chat_images WHERE id = $1`, [gone.rows[0].image_id]);
      return { success: true as const };
    }),
  )
  // Chat images: uploaded first (already shrunk in the browser), then referenced by a message.
  .post(
    "/images",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const { buf, mime } = decode(body.dataUrl, IMAGE_MAX_BYTES);
        const { pool } = await loadDb();
        const recent = await pool.query(`SELECT count(*)::int AS n FROM chat_images WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [user.id]);
        if (recent.rows[0].n >= 10) throw new AuthError("Too many images. Wait a moment.", 429);
        const ins = await pool.query(`INSERT INTO chat_images (user_id, mime, data) VALUES ($1,$2,$3) RETURNING id`, [user.id, mime, buf]);
        return { success: true as const, id: ins.rows[0].id as string, url: mediaUrl(ins.rows[0].id) };
      }),
    { body: t.Object({ dataUrl: t.String({ maxLength: 2_000_000 }) }) },
  )
  .get("/media/:id", async ({ params }) => {
    if (!UUID.test(params.id)) return new Response("Not found", { status: 404 });
    try {
      const { pool } = await loadDb();
      const res = await pool.query(`SELECT mime, data FROM chat_images WHERE id = $1`, [params.id]);
      return res.rows[0] ? bytes(res.rows[0]) : new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("[chat-media]", err);
      return new Response("Unavailable", { status: 503 });
    }
  })
  // Stickers: made in the browser from any image, owned by their creator, usable by everyone, favorited per person.
  .get("/stickers", ({ cookie, set }) =>
    guard(set, async () => {
      const user = await requireUser(cookie);
      const { pool } = await loadDb();
      const [mine, favs] = await Promise.all([
        pool.query(
          `SELECT s.id, (f.user_id IS NOT NULL) AS favorited, true AS mine FROM stickers s
           LEFT JOIN sticker_favorites f ON f.sticker_id = s.id AND f.user_id = $1
           WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
          [user.id],
        ),
        pool.query(
          `SELECT s.id, true AS favorited, (s.user_id = $1) AS mine FROM sticker_favorites f
           JOIN stickers s ON s.id = f.sticker_id WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT ${MAX_FAVORITES}`,
          [user.id],
        ),
      ]);
      return { success: true as const, mine: mine.rows.map(shapeSticker), favorites: favs.rows.map(shapeSticker) };
    }),
  )
  .post(
    "/stickers",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const { buf, mime } = decode(body.dataUrl, STICKER_MAX_BYTES);
        const { pool } = await loadDb();
        const count = await pool.query(`SELECT count(*)::int AS n FROM stickers WHERE user_id = $1`, [user.id]);
        if (count.rows[0].n >= MAX_STICKERS) throw new AuthError(`You can have up to ${MAX_STICKERS} stickers. Delete one first.`, 400);
        const ins = await pool.query(`INSERT INTO stickers (user_id, mime, data) VALUES ($1,$2,$3) RETURNING id`, [user.id, mime, buf]);
        set.status = 201;
        return { success: true as const, sticker: shapeSticker({ id: ins.rows[0].id, favorited: false, mine: true }) };
      }),
    { body: t.Object({ dataUrl: t.String({ maxLength: 700_000 }) }) },
  )
  .get("/stickers/:id/image", async ({ params }) => {
    if (!UUID.test(params.id)) return new Response("Not found", { status: 404 });
    try {
      const { pool } = await loadDb();
      const res = await pool.query(`SELECT mime, data FROM stickers WHERE id = $1`, [params.id]);
      return res.rows[0] ? bytes(res.rows[0]) : new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("[chat-sticker]", err);
      return new Response("Unavailable", { status: 503 });
    }
  })
  .put("/stickers/:id/favorite", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await requireUser(cookie);
      if (!UUID.test(params.id)) throw new AuthError("Sticker not found.", 404);
      const { pool } = await loadDb();
      const n = await pool.query(`SELECT count(*)::int AS n FROM sticker_favorites WHERE user_id = $1`, [user.id]);
      if (n.rows[0].n >= MAX_FAVORITES) throw new AuthError(`You can favorite up to ${MAX_FAVORITES} stickers.`, 400);
      try {
        await pool.query(`INSERT INTO sticker_favorites (user_id, sticker_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, params.id]);
      } catch (err: any) {
        if (err?.code === "23503") throw new AuthError("That sticker no longer exists.", 404);
        throw err;
      }
      return { success: true as const };
    }),
  )
  .delete("/stickers/:id/favorite", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await requireUser(cookie);
      if (!UUID.test(params.id)) throw new AuthError("Sticker not found.", 404);
      const { pool } = await loadDb();
      await pool.query(`DELETE FROM sticker_favorites WHERE user_id = $1 AND sticker_id = $2`, [user.id, params.id]);
      return { success: true as const };
    }),
  )
  .delete("/stickers/:id", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await requireUser(cookie);
      if (!UUID.test(params.id)) throw new AuthError("Sticker not found.", 404);
      const { pool } = await loadDb();
      const gone = await pool.query(`DELETE FROM stickers WHERE id = $1 AND user_id = $2`, [params.id, user.id]);
      if (!gone.rowCount) throw new AuthError("You can only delete your own stickers.", 403);
      return { success: true as const };
    }),
  );
