import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Supabase is the database: SUPABASE_DB_URL wins when set. The other names are what hosting integrations
// create (Vercel Storage / Supabase integration / Neon), so an existing setup keeps working.
const connectionString =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.NEON_DATABASE_URL;

if (!connectionString) {
  throw new Error("SUPABASE_DB_URL (or DATABASE_URL) must be set. Paste your Supabase Postgres connection string.");
}

// node-postgres treats sslmode=require as "verify the certificate chain", and Supabase's pooler certificate is not
// in Node's trust store, which fails with "self-signed certificate in certificate chain". So the TLS options are
// taken out of the URL and set explicitly below (encrypted, certificate not pinned).
const cleaned = (() => {
  try {
    const u = new URL(connectionString);
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "supa"]) u.searchParams.delete(key);
    return { url: u.toString(), host: u.hostname };
  } catch {
    return { url: connectionString, host: "" };
  }
})();
const isLocal = /^(localhost|127\.0\.0\.1|helium)$|\.internal$/.test(cleaned.host);

export const pool = new Pool({
  connectionString: cleaned.url,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  // Serverless functions open many short-lived instances: keep the pool tiny there (Supabase's pooler does the rest).
  max: process.env.VERCEL ? 1 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
