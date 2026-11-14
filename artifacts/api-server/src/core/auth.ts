import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { NODE_ENV } from "./config";
import { env } from "./runtime";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export const COOKIE = NODE_ENV === "production" ? "__Host-cooren_session" : "cooren_session";
const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const databaseUrl = () =>
  env.SUPABASE_DB_URL || env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || env.POSTGRES_URL_NON_POOLING || env.NEON_DATABASE_URL;

// The DB package throws on import when DATABASE_URL is missing, so load it lazily.
// The rest of the API keeps working without a database; only /auth returns 503.
let dbModule: Promise<typeof import("@workspace/db")> | null = null;
const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    username text NOT NULL UNIQUE,
    display_name text NOT NULL,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url text NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_color text NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS profile_images (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    mime text NOT NULL,
    data bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id text PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS watch_progress (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anime_id integer NOT NULL,
    episode_id text NOT NULL,
    provider text NOT NULL,
    audio text NOT NULL,
    episode_number text NOT NULL DEFAULT '',
    anime_title text NOT NULL DEFAULT '',
    poster text NOT NULL DEFAULT '',
    position real NOT NULL DEFAULT 0,
    duration real NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, anime_id, episode_id)
  );
  CREATE TABLE IF NOT EXISTS saved_episodes (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anime_id integer NOT NULL,
    episode_id text NOT NULL,
    provider text NOT NULL,
    audio text NOT NULL,
    episode_number text NOT NULL DEFAULT '',
    anime_title text NOT NULL DEFAULT '',
    poster text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, anime_id, episode_id)
  );
  -- Global chat: images and stickers live in the database (random uuid ids, so their URLs cannot be guessed).
  CREATE TABLE IF NOT EXISTS chat_images (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime text NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS stickers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime text NOT NULL,
    data bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS stickers_user_idx ON stickers (user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS sticker_favorites (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id uuid NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, sticker_id)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id bigserial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body text NOT NULL DEFAULT '',
    image_id uuid REFERENCES chat_images(id) ON DELETE SET NULL,
    sticker_id uuid REFERENCES stickers(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages (created_at DESC);
  -- Comments on anime pages (anime_id is the AniList id). parent_id makes a reply; replies are one level deep.
  CREATE TABLE IF NOT EXISTS anime_comments (
    id bigserial PRIMARY KEY,
    anime_id integer NOT NULL,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id bigint REFERENCES anime_comments(id) ON DELETE CASCADE,
    episode text NOT NULL DEFAULT '',
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS anime_comments_anime_idx ON anime_comments (anime_id, parent_id, id DESC);
  -- Supabase exposes every table in "public" through its REST API. Row level security with no policies shuts that
  -- door: only this server (the database owner role) can read or write.
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE watch_progress ENABLE ROW LEVEL SECURITY;
  ALTER TABLE saved_episodes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE profile_images ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_images ENABLE ROW LEVEL SECURITY;
  ALTER TABLE stickers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sticker_favorites ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE anime_comments ENABLE ROW LEVEL SECURITY;
`;

// Tables are created on first use (IF NOT EXISTS), so a fresh database works without a manual migration.
export function loadDb() {
  if (!databaseUrl()) {
    throw new AuthError("Accounts are not set up yet. The site owner needs to connect a database.", 503);
  }
  process.env.SUPABASE_DB_URL ||= databaseUrl(); // the db package reads the connection string from the environment
  return (dbModule ??= import("@workspace/db")
    .then(async (m) => {
      // Several serverless instances can start at once; the lock makes them take turns instead of colliding
      // on "CREATE TABLE IF NOT EXISTS". The xact variant also works through Supabase's transaction pooler.
      const client = await m.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(727274)");
        await client.query(CREATE_TABLES);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return m;
    })
    .catch((err) => {
      dbModule = null; // retry on the next request
      throw err;
    }));
}

// Stored as scrypt$N$r$p$salt$key so the cost can be raised later without breaking old hashes.
async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 96 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// In-memory limits (per server instance): 30 requests / 10 min per IP, and a 15 minute lock after 6 wrong passwords
// for the same account + IP. Together with the slow password hash this makes guessing impractical.
const attempts = new Map<string, { count: number; resetAt: number }>();
const failures = new Map<string, { count: number; lockedUntil: number }>();
const clientIp = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

function throttle(request: Request) {
  const ip = clientIp(request);
  const now = Date.now();
  if (attempts.size > 5000) attempts.clear();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) return void attempts.set(ip, { count: 1, resetAt: now + 10 * 60_000 });
  if (++entry.count > 30) throw new AuthError("Too many attempts. Please wait a few minutes.", 429);
}
function lockCheck(key: string) {
  const f = failures.get(key);
  if (f && f.lockedUntil > Date.now()) throw new AuthError("Too many wrong passwords. Try again in 15 minutes.", 429);
}
function recordFailure(key: string) {
  if (failures.size > 5000) failures.clear();
  const f = failures.get(key) ?? { count: 0, lockedUntil: 0 };
  f.count = f.lockedUntil && f.lockedUntil < Date.now() ? 1 : f.count + 1;
  if (f.count >= 6) { f.lockedUntil = Date.now() + 15 * 60_000; f.count = 0; }
  failures.set(key, f);
}

// CSRF defence on top of SameSite=Lax: a browser request that carries an Origin must come from our own site.
export function sameSite(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let host = "";
  try { host = new URL(origin).host; } catch { /* invalid */ }
  const allowed = [request.headers.get("x-forwarded-host"), request.headers.get("host")].filter(Boolean);
  if (!host || !allowed.includes(host)) throw new AuthError("Request blocked.", 403);
}

// Turns a raw connection error into a short, safe hint for the site owner (never includes the connection string).
export function diagnoseDb(err: unknown) {
  const e = err as { code?: string; message?: string } | undefined;
  const msg = `${e?.code ?? ""} ${e?.message ?? ""}`;
  const url = databaseUrl() ?? "";
  const direct = /@db\.[a-z0-9]+\.supabase\.co/i.test(url);
  if (/ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED/.test(msg)) {
    return direct
      ? "The database host cannot be reached. The direct Supabase host (db.xxxx.supabase.co) is IPv6-only; paste the Connection pooler string (…pooler.supabase.com) instead."
      : "The database host cannot be reached. Check the host and port in the connection string.";
  }
  if (/Tenant or user not found|28P01|password authentication failed/i.test(msg)) {
    return "The database refused the login. Check the password, and that the pooler user is postgres.<project-ref>.";
  }
  if (/SSL|certificate/i.test(msg)) return "The secure connection to the database failed.";
  if (/ECONNRESET|terminat|timeout/i.test(msg)) return "The database connection timed out. Try again in a moment.";
  return "The database returned an error. Check the server logs.";
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type UserRow = {
  id: number;
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  bio?: string | null;
  themeColor?: string | null;
  createdAt?: Date | null;
};

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.displayName,
    email: u.email,
    avatarUrl: u.avatarUrl ?? "",
    bannerUrl: u.bannerUrl ?? "",
    bio: u.bio ?? "",
    themeColor: u.themeColor ?? "",
    createdAt: u.createdAt ? u.createdAt.toISOString() : null,
  };
}

async function startSession(userId: number, cookie: Record<string, any>) {
  const { db, sessionsTable } = await loadDb();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessionsTable).values({ id: sha256(token), userId, expiresAt });
  cookie[COOKIE].set({
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
    secure: NODE_ENV === "production",
  });
}

export async function userFromToken(token?: string) {
  if (!token) return null;
  const { db, sessionsTable, usersTable } = await loadDb();
  const [row] = await db
    .select({
      id: usersTable.id,
      displayName: usersTable.displayName,
      email: usersTable.email,
      avatarUrl: usersTable.avatarUrl,
      bannerUrl: usersTable.bannerUrl,
      bio: usersTable.bio,
      themeColor: usersTable.themeColor,
      createdAt: usersTable.createdAt,
      expiresAt: sessionsTable.expiresAt,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(eq(sessionsTable.id, sha256(token)))
    .limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function guard<T>(set: { status?: number | string; headers?: any }, fn: () => Promise<T>) {
  set.headers = { ...(set.headers ?? {}), "cache-control": "no-store" };
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError) {
      set.status = err.status;
      return { success: false as const, error: err.message };
    }
    console.error("[auth]", err);
    const code = String((err as { code?: string })?.code ?? "");
    if (/^(E[A-Z]+|28P01|3D000|57P0\d|08\w+)$/.test(code) || /Tenant or user not found/i.test(String((err as Error)?.message))) {
      set.status = 503; // database unreachable / refused: say why instead of a bare "something went wrong"
      return { success: false as const, error: `Accounts are unavailable right now. ${diagnoseDb(err)}` };
    }
    set.status = 500;
    return { success: false as const, error: "Something went wrong. Please try again." };
  }
}

export const authRoutes = new Elysia({ prefix: "/auth" })
  .post(
    "/signup",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        throttle(request);
        const username = body.username.trim();
        const email = body.email.trim().toLowerCase();
        if (!USERNAME_RE.test(username)) {
          throw new AuthError("Username must be 3–20 characters: letters, numbers or underscores.", 400);
        }
        if (!EMAIL_RE.test(email)) throw new AuthError("Enter a valid email address.", 400);
        if (body.password.length < 8) throw new AuthError("Password must be at least 8 characters.", 400);
        if (body.password.length > 200) throw new AuthError("Password is too long.", 400);

        const { db, usersTable } = await loadDb();
        const taken = await db
          .select({ username: usersTable.username, email: usersTable.email })
          .from(usersTable)
          .where(or(eq(usersTable.username, username.toLowerCase()), eq(usersTable.email, email)))
          .limit(2);
        if (taken.some((u) => u.username === username.toLowerCase())) {
          throw new AuthError("That username is already taken.", 409);
        }
        if (taken.length) throw new AuthError("An account with that email already exists.", 409);

        let user;
        try {
          [user] = await db
            .insert(usersTable)
            .values({
              username: username.toLowerCase(),
              displayName: username,
              email,
              passwordHash: await hashPassword(body.password),
            })
            .returning();
        } catch (err: any) {
          if (err?.code === "23505") throw new AuthError("That username or email is already in use.", 409);
          throw err;
        }
        await startSession(user.id, cookie);
        set.status = 201;
        return { success: true as const, user: publicUser(user) };
      }),
    { body: t.Object({ username: t.String(), email: t.String(), password: t.String() }) },
  )
  .post(
    "/login",
    ({ body, cookie, set, request }) =>
      guard(set, async () => {
        sameSite(request);
        throttle(request);
        const id = body.identifier.trim().toLowerCase();
        const lockKey = `${id}|${clientIp(request)}`;
        lockCheck(lockKey);
        const { db, usersTable } = await loadDb();
        const [user] = await db
          .select()
          .from(usersTable)
          .where(or(eq(usersTable.username, id), eq(usersTable.email, id)))
          .limit(1);
        // Same message for unknown user and wrong password.
        const ok = user ? await verifyPassword(body.password, user.passwordHash) : false;
        if (!user || !ok) {
          recordFailure(lockKey);
          throw new AuthError("Wrong username/email or password.", 401);
        }
        failures.delete(lockKey);
        await startSession(user.id, cookie);
        return { success: true as const, user: publicUser(user) };
      }),
    { body: t.Object({ identifier: t.String(), password: t.String() }) },
  )
  // Real check: connects and runs a query, so the login page can say what is wrong instead of failing later.
  .get("/status", async ({ set }) => {
    set.headers = { ...(set.headers ?? {}), "cache-control": "no-store" };
    if (!databaseUrl()) return { success: true as const, database: false, reason: "No database is connected yet." };
    try {
      const { pool } = await loadDb();
      await pool.query("SELECT 1");
      return { success: true as const, database: true };
    } catch (err) {
      console.error("[auth/status]", err);
      return { success: true as const, database: false, reason: diagnoseDb(err) };
    }
  })
  .get("/me", ({ cookie, set }) =>
    guard(set, async () => {
      const user = await userFromToken(cookie[COOKIE].value as string | undefined);
      return { success: true as const, user: user ? publicUser(user) : null };
    }),
  )
  .post("/logout", ({ cookie, set, request }) =>
    guard(set, async () => {
      sameSite(request);
      const token = cookie[COOKIE].value as string | undefined;
      if (token) {
        const { db, sessionsTable } = await loadDb();
        await db.delete(sessionsTable).where(eq(sessionsTable.id, sha256(token)));
      }
      cookie[COOKIE].remove();
      return { success: true as const };
    }),
  );
