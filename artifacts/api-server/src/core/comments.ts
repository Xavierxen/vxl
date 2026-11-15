import { Elysia, t } from "elysia";
import { AuthError, COOKIE, guard, loadDb, sameSite, userFromToken } from "./auth";

// Comments on anime pages. Anyone can read; only signed-in people can post, reply (one level) and delete their own.
const MAX_TEXT = 1000;
const PAGE = 15;

type Row = Record<string, any>;
const shape = (r: Row) => ({
  id: r.id as number,
  parentId: (r.parentId as number | null) ?? null,
  text: r.body as string,
  episode: r.episode as string,
  createdAt: r.createdAt as number,
  username: r.username as string,
  avatarUrl: r.avatarUrl as string,
  themeColor: (r.themeColor as string) || "",
  own: Boolean(r.own),
});

const SELECT = `
  SELECT c.id::float8 AS id, c.parent_id::float8 AS "parentId", c.body, c.episode,
         (extract(epoch FROM c.created_at) * 1000)::float8 AS "createdAt",
         u.display_name AS username, u.avatar_url AS "avatarUrl", u.theme_color AS "themeColor",
         (c.user_id = $2) AS own
  FROM anime_comments c JOIN users u ON u.id = c.user_id`;

const animeIdOf = (raw: string) => {
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new AuthError("Anime not found.", 404);
  return Number(raw);
};
async function viewerId(cookie: Record<string, any>) {
  const user = await userFromToken(cookie[COOKIE].value as string | undefined).catch(() => null);
  return user?.id ?? 0;
}

export const commentRoutes = new Elysia({ prefix: "/comments" })
  // Newest top-level comments first, each with its replies (oldest first). ?before=<id> loads the next page.
  .get(
    "/:animeId",
    ({ params, query, cookie, set }) =>
      guard(set, async () => {
        const animeId = animeIdOf(params.animeId);
        const viewer = await viewerId(cookie);
        const { pool } = await loadDb();
        const before = Number(query.before);
        const paged = Number.isFinite(before) && before > 0;
        const top = await pool.query(
          `${SELECT} WHERE c.anime_id = $1 AND c.parent_id IS NULL ${paged ? "AND c.id < $3" : ""} ORDER BY c.id DESC LIMIT ${PAGE + 1}`,
          paged ? [animeId, viewer, Math.floor(before)] : [animeId, viewer],
        );
        const hasMore = top.rows.length > PAGE;
        const page = top.rows.slice(0, PAGE);
        const ids = page.map((r) => r.id);
        const replies = ids.length
          ? await pool.query(`${SELECT} WHERE c.anime_id = $1 AND c.parent_id = ANY($3::bigint[]) ORDER BY c.id ASC LIMIT 300`, [animeId, viewer, ids])
          : { rows: [] as Row[] };
        const total = await pool.query(`SELECT count(*)::int AS n FROM anime_comments WHERE anime_id = $1`, [animeId]);
        const byParent = new Map<number, ReturnType<typeof shape>[]>();
        for (const r of replies.rows) {
          const list = byParent.get(r.parentId) ?? [];
          list.push(shape(r));
          byParent.set(r.parentId, list);
        }
        return {
          success: true as const,
          total: total.rows[0].n as number,
          hasMore,
          comments: page.map((r) => ({ ...shape(r), replies: byParent.get(r.id) ?? [] })),
        };
      }),
    { query: t.Object({ before: t.Optional(t.String()) }) },
  )
  .post(
    "/:animeId",
    ({ params, body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await userFromToken(cookie[COOKIE].value as string | undefined);
        if (!user) throw new AuthError("Log in to comment.", 401);
        const animeId = animeIdOf(params.animeId);
        const text = body.text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (!text) throw new AuthError("Write something first.", 400);
        if (text.length > MAX_TEXT) throw new AuthError(`Comments can be up to ${MAX_TEXT} characters.`, 400);
        const episode = /^\d{1,5}(\.\d)?$/.test(body.episode ?? "") ? (body.episode as string) : "";
        const { pool } = await loadDb();
        const recent = await pool.query(`SELECT count(*)::int AS n FROM anime_comments WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [user.id]);
        if (recent.rows[0].n >= 8) throw new AuthError("You are commenting too fast. Wait a moment.", 429);
        let parentId: number | null = null;
        if (body.parentId) {
          const parent = await pool.query(`SELECT id::float8 AS id FROM anime_comments WHERE id = $1 AND anime_id = $2 AND parent_id IS NULL`, [Math.floor(body.parentId), animeId]);
          if (!parent.rowCount) throw new AuthError("That comment is gone, so it cannot be replied to.", 404);
          parentId = parent.rows[0].id;
        }
        const ins = await pool.query(`INSERT INTO anime_comments (anime_id, user_id, parent_id, episode, body) VALUES ($1,$2,$3,$4,$5) RETURNING id::float8 AS id`, [animeId, user.id, parentId, parentId ? "" : episode, text]);
        const row = await pool.query(`${SELECT} WHERE c.id = $1`, [ins.rows[0].id, user.id]);
        set.status = 201;
        return { success: true as const, comment: { ...shape(row.rows[0]), replies: [] } };
      }),
    { body: t.Object({ text: t.String({ maxLength: 4000 }), parentId: t.Optional(t.Number()), episode: t.Optional(t.String({ maxLength: 8 })) }) },
  )
  .delete("/:animeId/:id", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await userFromToken(cookie[COOKIE].value as string | undefined);
      if (!user) throw new AuthError("Log in first.", 401);
      const animeId = animeIdOf(params.animeId);
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) throw new AuthError("Comment not found.", 404);
      const { pool } = await loadDb();
      const gone = await pool.query(`DELETE FROM anime_comments WHERE id = $1 AND anime_id = $2 AND user_id = $3`, [id, animeId, user.id]);
      if (!gone.rowCount) throw new AuthError("You can only delete your own comments.", 403);
      return { success: true as const };
    }),
  );
