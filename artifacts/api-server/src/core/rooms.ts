import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { AuthError, COOKIE, guard, loadDb, sameSite, userFromToken } from "./auth";

// Watch Together. A room stores one shared playback state: whether it is playing, the position at the moment of the
// last change (state_at, the database clock) and which episode. Everyone polls it about once a second and nudges
// their own player to match, so it works on serverless hosts. Everyone in the room can play, pause and skip.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_TEXT = 300;

type Row = Record<string, any>;

async function requireUser(cookie: Record<string, any>) {
  const user = await userFromToken(cookie[COOKIE].value as string | undefined);
  if (!user) throw new AuthError("Log in to watch together.", 401);
  return user;
}
function codeOf(raw: string) {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!CODE_RE.test(code)) throw new AuthError("That room code is not valid.", 404);
  return code;
}
function newCode() {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Per-instance guard against a client that spams state changes (the real limit is the 1 s polling anyway).
const stateHits = new Map<number, number[]>();
function limitState(userId: number) {
  const now = Date.now();
  const hits = (stateHits.get(userId) ?? []).filter((x) => now - x < 10_000);
  if (hits.length >= 40) throw new AuthError("Too many changes at once. Wait a moment.", 429);
  hits.push(now);
  stateHits.set(userId, hits);
}

const ROOM_SQL = `
  SELECT r.code, r.host_id AS "hostId", hu.display_name AS "hostName", r.anime_id AS "animeId", r.provider, r.audio,
         r.episode_id AS "episodeId", r.episode_number AS "episodeNumber", r.anime_title AS "animeTitle", r.poster,
         r.playing, r.position::float8 AS position, (extract(epoch FROM r.state_at) * 1000)::float8 AS "stateAt",
         r.version, (extract(epoch FROM now()) * 1000)::float8 AS now
  FROM watch_rooms r JOIN users hu ON hu.id = r.host_id WHERE r.code = $1`;

const MEMBERS_SQL = `
  SELECT u.id AS "userId", u.display_name AS username, u.avatar_url AS "avatarUrl",
         (m.last_seen > now() - interval '40 seconds') AS online, (r.host_id = m.user_id) AS host
  FROM watch_room_members m JOIN users u ON u.id = m.user_id JOIN watch_rooms r ON r.code = m.code
  WHERE m.code = $1 ORDER BY m.joined_at`;

const MSG_SELECT = `
  SELECT m.id::float8 AS id, m.body AS text, (extract(epoch FROM m.created_at) * 1000)::float8 AS "createdAt",
         u.display_name AS username, u.avatar_url AS "avatarUrl", (m.user_id = $2) AS own
  FROM watch_room_messages m JOIN users u ON u.id = m.user_id`;

const shapeRoom = (r: Row) => ({
  code: r.code as string, hostId: r.hostId as number, hostName: r.hostName as string, animeId: r.animeId as number,
  provider: r.provider as string, audio: r.audio as string, episodeId: r.episodeId as string, episodeNumber: r.episodeNumber as string,
  animeTitle: r.animeTitle as string, poster: r.poster as string, playing: Boolean(r.playing), position: Number(r.position),
  stateAt: Number(r.stateAt), version: Number(r.version),
});

const TOKEN_SQL = `
  SELECT r.version, r.host_id AS "hostId",
         COALESCE((SELECT max(m.id) FROM watch_room_messages m WHERE m.code = $1), 0)::float8 AS "lastMsg",
         (SELECT count(*) FROM watch_room_members x WHERE x.code = $1 AND x.last_seen > now() - interval '40 seconds')::int AS online,
         (SELECT count(*) FROM watch_room_members y WHERE y.code = $1)::int AS total
  FROM watch_rooms r WHERE r.code = $1`;

// If the owner has been gone for 90 s, the longest-standing member who is still here becomes the owner,
// so a room can never be stuck with nobody able to control it.
const PROMOTE_SQL = `
  UPDATE watch_rooms r SET host_id = n.user_id, version = r.version + 1
  FROM (SELECT m.user_id FROM watch_room_members m WHERE m.code = $1 AND m.last_seen > now() - interval '20 seconds' ORDER BY m.joined_at LIMIT 1) n
  WHERE r.code = $1
    AND NOT EXISTS (SELECT 1 FROM watch_room_members h WHERE h.code = r.code AND h.user_id = r.host_id AND h.last_seen > now() - interval '90 seconds')`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sigOf = (t: Row) => `${t.online}-${t.total}-${t.hostId}`;

type SnapOpts = { join?: boolean; after?: number; version?: number; sig?: string; waitMs?: number };

// With waitMs > 0 this is a "long poll": it answers at once when the room, the members or the chat changed since the
// caller's last answer (version / sig / after), and otherwise holds the request up to waitMs. That makes chat and
// playback changes arrive in well under a second without a WebSocket (which serverless hosts do not offer).
async function snapshot(code: string, userId: number, opts: SnapOpts) {
  const { pool } = await loadDb();
  const exists = await pool.query(`SELECT 1 FROM watch_rooms WHERE code = $1`, [code]);
  if (!exists.rowCount) throw new AuthError("This room no longer exists.", 404);
  if (opts.join) {
    await pool.query(`INSERT INTO watch_room_members (code, user_id) VALUES ($1, $2) ON CONFLICT (code, user_id) DO UPDATE SET last_seen = now()`, [code, userId]);
  } else {
    const upd = await pool.query(`UPDATE watch_room_members SET last_seen = now() WHERE code = $1 AND user_id = $2 RETURNING user_id`, [code, userId]);
    if (!upd.rowCount) throw new AuthError("You are not in this room. Join it first.", 403);
  }
  await pool.query(PROMOTE_SQL, [code]);
  await pool.query(`UPDATE watch_rooms SET last_active = now() WHERE code = $1`, [code]);

  const after = opts.after ?? 0;
  const waitMs = Math.max(0, Math.min(opts.waitMs ?? 0, 15_000));
  const deadline = Date.now() + waitMs;
  let token: Row;
  for (;;) {
    const t = await pool.query(TOKEN_SQL, [code]);
    if (!t.rowCount) throw new AuthError("This room no longer exists.", 404);
    token = t.rows[0];
    const changed = opts.version === undefined || opts.sig === undefined || Number(token.version) !== opts.version || sigOf(token) !== opts.sig || Number(token.lastMsg) > after;
    if (waitMs === 0 || changed || Date.now() >= deadline) break;
    await sleep(350);
  }

  const room = await pool.query(ROOM_SQL, [code]);
  if (!room.rowCount) throw new AuthError("This room no longer exists.", 404);
  const [members, msgs] = await Promise.all([
    pool.query(MEMBERS_SQL, [code]),
    opts.join || after <= 0
      ? pool.query(`${MSG_SELECT} WHERE m.code = $1 ORDER BY m.id DESC LIMIT 50`, [code, userId])
      : pool.query(`${MSG_SELECT} WHERE m.code = $1 AND m.id > $3 ORDER BY m.id ASC LIMIT 100`, [code, userId, after]),
  ]);
  const messages = opts.join || after <= 0 ? msgs.rows.reverse() : msgs.rows;
  const row = room.rows[0];
  return {
    success: true as const,
    now: Number(row.now),
    isHost: Number(row.hostId) === userId,
    sig: sigOf(token),
    room: shapeRoom(row),
    members: members.rows.map((m) => ({ userId: m.userId as number, username: m.username as string, avatarUrl: m.avatarUrl as string, online: Boolean(m.online), host: Boolean(m.host) })),
    messages: messages.map((m) => ({ id: Number(m.id), text: m.text as string, createdAt: Number(m.createdAt), username: m.username as string, avatarUrl: m.avatarUrl as string, own: Boolean(m.own) })),
  };
}

const episodeBody = t.Object({
  provider: t.String({ maxLength: 40 }),
  audio: t.String({ maxLength: 8 }),
  episodeId: t.String({ minLength: 1, maxLength: 300 }),
  episodeNumber: t.String({ maxLength: 12 }),
});

export const roomRoutes = new Elysia({ prefix: "/rooms" })
  // Create a room for the episode you are watching. Returns the invite code.
  .post(
    "/",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        if (body.audio !== "sub" && body.audio !== "dub") throw new AuthError("Invalid audio.", 400);
        const poster = /^https:\/\/\S{1,480}$/.test(body.poster ?? "") ? (body.poster as string) : "";
        const { pool } = await loadDb();
        await pool.query(`DELETE FROM watch_rooms WHERE last_active < now() - interval '12 hours'`).catch(() => undefined);
        const mine = await pool.query(`SELECT count(*)::int AS n FROM watch_rooms WHERE host_id = $1 AND last_active > now() - interval '2 hours'`, [user.id]);
        if (mine.rows[0].n >= 5) throw new AuthError("You already have 5 active rooms. Close one first.", 429);
        for (let attempt = 0; attempt < 6; attempt++) {
          const code = newCode();
          try {
            await pool.query(
              `INSERT INTO watch_rooms (code, host_id, anime_id, provider, audio, episode_id, episode_number, anime_title, poster) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [code, user.id, body.animeId, body.provider, body.audio, body.episodeId, body.episodeNumber ?? "", (body.animeTitle ?? "").slice(0, 200), poster],
            );
            await pool.query(`INSERT INTO watch_room_members (code, user_id) VALUES ($1, $2)`, [code, user.id]);
            set.status = 201;
            return { success: true as const, code };
          } catch (err: any) {
            if (err?.code !== "23505") throw err; // code already taken: try another
          }
        }
        throw new AuthError("Could not create a room. Try again.", 500);
      }),
    {
      body: t.Object({
        animeId: t.Integer({ minimum: 1 }),
        provider: t.String({ minLength: 1, maxLength: 40 }),
        audio: t.String({ maxLength: 8 }),
        episodeId: t.String({ minLength: 1, maxLength: 300 }),
        episodeNumber: t.Optional(t.String({ maxLength: 12 })),
        animeTitle: t.Optional(t.String({ maxLength: 200 })),
        poster: t.Optional(t.String({ maxLength: 500 })),
      }),
    },
  )
  .post("/:code/join", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await requireUser(cookie);
      return snapshot(codeOf(params.code), user.id, { join: true });
    }),
  )
  // The poll: room state, who is here and the newest chat messages. Pass v (last version), s (last sig) and wait
  // (seconds) to hold the request until something changes.
  .get(
    "/:code",
    ({ params, query, cookie, set }) =>
      guard(set, async () => {
        const user = await requireUser(cookie);
        const v = query.v !== undefined && query.v !== "" ? Number(query.v) : undefined;
        return snapshot(codeOf(params.code), user.id, {
          after: Number(query.after) || 0,
          version: v !== undefined && Number.isFinite(v) ? v : undefined,
          sig: query.s,
          waitMs: (Number(query.wait) || 0) * 1000,
        });
      }),
    { query: t.Object({ after: t.Optional(t.String()), beat: t.Optional(t.String()), v: t.Optional(t.String()), s: t.Optional(t.String()), wait: t.Optional(t.String()) }) },
  )
  // Play / pause / seek, or switch episode. The position is the player's time at the moment of the action.
  .post(
    "/:code/state",
    ({ params, body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const code = codeOf(params.code);
        limitState(user.id);
        const { pool } = await loadDb();
        const who = await pool.query(
          `SELECT r.host_id AS "hostId" FROM watch_rooms r JOIN watch_room_members m ON m.code = r.code AND m.user_id = $2 WHERE r.code = $1`,
          [code, user.id],
        );
        if (!who.rowCount) throw new AuthError("You are not in this room.", 403);
        if (Number(who.rows[0].hostId) !== user.id) throw new AuthError("Only the room owner can control playback.", 403);
        const position = Math.max(0, Math.min(Number.isFinite(body.position) ? body.position : 0, 100_000));
        const ep = body.episode;
        if (ep && ep.audio !== "sub" && ep.audio !== "dub") throw new AuthError("Invalid audio.", 400);
        const res = ep
          ? await pool.query(
              `UPDATE watch_rooms SET playing = $2, position = $3, provider = $4, audio = $5, episode_id = $6, episode_number = $7,
                 version = version + 1, state_at = now(), last_active = now() WHERE code = $1 RETURNING version`,
              [code, body.playing, position, ep.provider, ep.audio, ep.episodeId, ep.episodeNumber],
            )
          : await pool.query(
              `UPDATE watch_rooms SET playing = $2, position = $3, version = version + 1, state_at = now(), last_active = now() WHERE code = $1 RETURNING version`,
              [code, body.playing, position],
            );
        if (!res.rowCount) throw new AuthError("This room no longer exists.", 404);
        return { success: true as const, version: Number(res.rows[0].version) };
      }),
    { body: t.Object({ playing: t.Boolean(), position: t.Number(), episode: t.Optional(episodeBody) }) },
  )
  .post(
    "/:code/messages",
    ({ params, body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        const user = await requireUser(cookie);
        const code = codeOf(params.code);
        const text = body.text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (!text) throw new AuthError("Write something first.", 400);
        if (text.length > MAX_TEXT) throw new AuthError(`Messages can be up to ${MAX_TEXT} characters.`, 400);
        const { pool } = await loadDb();
        const mem = await pool.query(`SELECT 1 FROM watch_room_members WHERE code = $1 AND user_id = $2`, [code, user.id]);
        if (!mem.rowCount) throw new AuthError("You are not in this room.", 403);
        const recent = await pool.query(`SELECT count(*)::int AS n FROM watch_room_messages WHERE user_id = $1 AND created_at > now() - interval '1 minute'`, [user.id]);
        if (recent.rows[0].n >= 20) throw new AuthError("You are sending messages too fast.", 429);
        const ins = await pool.query(`INSERT INTO watch_room_messages (code, user_id, body) VALUES ($1,$2,$3) RETURNING id::float8 AS id`, [code, user.id, text]);
        await pool.query(`UPDATE watch_rooms SET last_active = now() WHERE code = $1`, [code]);
        const row = await pool.query(`${MSG_SELECT} WHERE m.code = $1 AND m.id = $3`, [code, user.id, ins.rows[0].id]); // every $n must appear in the SQL
        set.status = 201;
        const m = row.rows[0];
        return { success: true as const, message: { id: Number(m.id), text: m.text as string, createdAt: Number(m.createdAt), username: m.username as string, avatarUrl: m.avatarUrl as string, own: true } };
      }),
    { body: t.Object({ text: t.String({ maxLength: 2000 }) }) },
  )
  .post("/:code/leave", ({ params, cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const user = await requireUser(cookie);
      const code = codeOf(params.code);
      const { pool } = await loadDb();
      await pool.query(`DELETE FROM watch_room_members WHERE code = $1 AND user_id = $2`, [code, user.id]);
      // If the owner left, the longest-standing member takes over.
      await pool.query(
        `UPDATE watch_rooms SET host_id = (SELECT x.user_id FROM watch_room_members x WHERE x.code = $1 ORDER BY x.joined_at LIMIT 1), version = version + 1
         WHERE code = $1 AND host_id = $2 AND EXISTS (SELECT 1 FROM watch_room_members y WHERE y.code = $1)`,
        [code, user.id],
      );
      // An empty room is closed.
      await pool.query(`DELETE FROM watch_rooms WHERE code = $1 AND NOT EXISTS (SELECT 1 FROM watch_room_members WHERE code = $1)`, [code]);
      return { success: true as const };
    }),
  );
