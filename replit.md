# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- DB schema (users, sessions): `lib/db/src/schema/users.ts`
- Auth API (`/api/auth/*`): `artifacts/api-server/src/core/auth.ts`
- Search (ranking + related titles): `artifacts/api-server/src/providers/meta/anilist/scrapers/search.ts`
- Library (watch progress + saved episodes): `artifacts/api-server/src/core/library.ts`, `artifacts/cooren-watch/src/lib/library.tsx`
- Frontend theme: `artifacts/cooren-watch/src/index.css`; auth state `src/lib/auth.tsx`; search box `src/components/search-box.tsx`

## Architecture decisions

- Accounts: username + email + password, no email verification. Passwords hashed with scrypt; sessions are random tokens in an httpOnly cookie (only the SHA-256 is stored).
- `/api/auth/*` returns 503 if `DATABASE_URL` is unset; the rest of the API still works.
- After pulling these changes run `pnpm --filter @workspace/db run push` once to create the tables.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
