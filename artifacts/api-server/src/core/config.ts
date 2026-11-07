import { env } from "./runtime";

const port = parseInt(env.PORT ?? "", 10);

export const PORT = Number.isNaN(port) ? 3000 : port;
export const NODE_ENV = env.NODE_ENV || "development";
export const LOG_LEVEL = (env.LOG_LEVEL || "info").toLowerCase();
const replitDomain = env.REPLIT_DOMAINS?.split(",")[0]?.trim();
// On Vercel, build proxy/stream URLs from the deployment host (set SERVER_ORIGIN for a custom domain).
// Relative ("/api/proxy/...") so stream links always use the same domain the visitor is on
// (production domain, custom domain or preview), with no CORS or deployment-protection surprises.
const defaultServerOrigin = replitDomain
  ? `https://${replitDomain}`
  : env.VERCEL
    ? ""
    : `http://localhost:${PORT}`;
const configuredServerOrigin = (env.SERVER_ORIGIN || defaultServerOrigin).replace(/\/+$/, "");
export const SERVER_ORIGIN = configuredServerOrigin.endsWith("/api")
  ? configuredServerOrigin
  : `${configuredServerOrigin}/api`;

export const CORS_ORIGIN = env.CORS_ORIGIN || "*";
export const CORS_CREDENTIALS = env.CORS_CREDENTIALS === "true";

export function validateConfig() {
  if (PORT <= 0 || PORT > 65_535) throw new Error(`Invalid PORT: ${env.PORT}`);
}
