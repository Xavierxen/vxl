import { Elysia, t } from "elysia";
import { AuthError, COOKIE, guard, loadDb, userFromToken } from "./auth";

function sameSite(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let host = "";
  try { host = new URL(origin).host; } catch { /* invalid */ }
  if (![request.headers.get("x-forwarded-host"), request.headers.get("host")].includes(host)) throw new AuthError("Request blocked.", 403);
}

// Watch history (with the playback position) and saved episodes, per account.

const episode = {
  animeId: t.Number(),
  episodeId: t.String({ maxLength: 300 }),
  provider: t.String({ maxLength: 60 }),
  audio: t.String({ maxLength: 10 }),
  episodeNumber: t.String({ maxLength: 40 }),
  animeTitle: t.String({ maxLength: 300 }),
  poster: t.String({ maxLength: 1000 }),
};

async function requireUser(cookie: Record<string, any>) {
  const user = await userFromToken(cookie[COOKIE].value as string | undefined);
  if (!user) throw new AuthError("Log in to sync your library.", 401);
  return user;
}

export const libraryRoutes = new Elysia({ prefix: "/me" })
  .get("/library", ({ cookie, set }) =>
    guard(set, async () => {
      const user = await requireUser(cookie);
      const { pool } = await loadDb();
      const [progress, saved] = await Promise.all([
        pool.query(
          `SELECT anime_id AS "animeId", episode_id AS "episodeId", provider, audio,
                  episode_number AS "episodeNumber", anime_title AS "animeTitle", poster,
                  position, duration, (extract(epoch FROM updated_at) * 1000)::float8 AS "updatedAt"
           FROM watch_progress WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
          [user.id],
        ),
        pool.query(
          `SELECT anime_id AS "animeId", episode_id AS "episodeId", provider, audio,
                  episode_number AS "episodeNumber", anime_title AS "animeTitle", poster,
                  (extract(epoch FROM created_at) * 1000)::float8 AS "updatedAt"
           FROM saved_episodes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300`,
          [user.id],
        ),
      ]);
      return { success: true as const, progress: progress.rows, saved: saved.rows };
    }),
  )
  .put(
    "/progress",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const { pool } = await loadDb();
        await pool.query(
          `INSERT INTO watch_progress
             (user_id, anime_id, episode_id, provider, audio, episode_number, anime_title, poster, position, duration, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11 / 1000.0))
           ON CONFLICT (user_id, anime_id, episode_id) DO UPDATE SET
             provider = EXCLUDED.provider, audio = EXCLUDED.audio, episode_number = EXCLUDED.episode_number,
             anime_title = EXCLUDED.anime_title, poster = EXCLUDED.poster,
             position = EXCLUDED.position, duration = EXCLUDED.duration, updated_at = EXCLUDED.updated_at
           WHERE watch_progress.updated_at <= EXCLUDED.updated_at`,
          [
            user.id, body.animeId, body.episodeId, body.provider, body.audio, body.episodeNumber,
            body.animeTitle, body.poster, Math.max(0, body.position), Math.max(0, body.duration),
            body.updatedAt ?? Date.now(),
          ],
        );
        return { success: true as const };
      }),
    { body: t.Object({ ...episode, position: t.Number(), duration: t.Number(), updatedAt: t.Optional(t.Number()) }) },
  )
  .put(
    "/saved",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const { pool } = await loadDb();
        await pool.query(
          `INSERT INTO saved_episodes
             (user_id, anime_id, episode_id, provider, audio, episode_number, anime_title, poster, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9 / 1000.0))
           ON CONFLICT (user_id, anime_id, episode_id) DO NOTHING`,
          [
            user.id, body.animeId, body.episodeId, body.provider, body.audio, body.episodeNumber,
            body.animeTitle, body.poster, body.updatedAt ?? Date.now(),
          ],
        );
        return { success: true as const };
      }),
    { body: t.Object({ ...episode, updatedAt: t.Optional(t.Number()) }) },
  )
  .post(
    "/saved/remove",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const { pool } = await loadDb();
        await pool.query(`DELETE FROM saved_episodes WHERE user_id = $1 AND anime_id = $2 AND episode_id = $3`, [
          user.id, body.animeId, body.episodeId,
        ]);
        return { success: true as const };
      }),
    { body: t.Object({ animeId: t.Number(), episodeId: t.String() }) },
  );
