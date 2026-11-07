# Deploying kanime (Vercel + Supabase)

## 1. Supabase (database, accounts, profile pictures)
1. Create a free project at supabase.com.
2. **SQL Editor → New query**, paste `supabase/schema.sql`, **Run** (optional: the server creates the tables itself on first use).
3. **Project Settings → Database → Connection string → Connection pooler (Transaction, port 6543)**. Copy it and put your database password in.
   Use the pooler string, not the direct `db.xxxx.supabase.co` one: that host is IPv6-only and Vercel cannot reach it.
4. For profile pictures and banners in Supabase Storage: **Project Settings → API**, copy the *Project URL* and the *service_role* key.
   (Skip this and images are stored in the database instead. Both work.)

## 2. Vercel
1. **New Project → import the repo.** Framework Preset: Other. Node.js 22.x. Build/install commands come from `vercel.json`.
2. **Settings → Environment Variables** (see `.env.example`):
   - `SUPABASE_DB_URL` – the pooler string from step 1.3 (required)
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` – for Storage (optional)
   - `SERVER_ORIGIN` – only with a custom domain
3. **Deploy**, then open `https://your-site/api/auth/status`. It should answer `{"success":true,"database":true}`.
   If it says `database: false`, the `reason` field says what is wrong (wrong host, wrong password, unreachable).

## Global chat
`/chat` is one room for everyone who is signed in (logged-out visitors are asked to log in; they cannot read or write).
- Text up to 500 characters, one image per message (shrunk to 1280 px in the browser), or one sticker.
- **Stickers:** attach an image and press *Make it a sticker instead*, or use the sticker button → *Image → sticker*, or press *Make sticker* under any image in the chat.
  Stickers get a white outline and rounded corners. Anyone can send any sticker; tap the star under a sticker in the chat to add it to your **Favorites** tab.
  Each person can keep 60 stickers and 200 favorites.
- Updates arrive by polling every ~2.5 s (no WebSocket needed, so it works on Vercel). Everything is kept forever; the page loads the latest 50 and has a *Load older messages* button.
- Images and stickers live in your Supabase database (a few hundred KB each at most). Because nothing is deleted, watch your database size in Supabase (free plan: 500 MB). Animated GIFs are saved as a still frame.
- There is no moderator tool yet: people can delete their own messages only.

## Comments
Every anime page (and every watch page) has a **Comments** section. Anyone can read; signed-in people can post (up to 1000 characters), reply one level deep, and delete their own comments. Comments posted from a watch page carry an `EP n` tag. Names show in the commenter's theme colour. Posting is limited to 8 comments a minute per person. There is no moderator tool yet.

## Seasons, skip intro and theme colour
- Every anime page shows "Season 2 of 4" in its info row, a row of season buttons (the one you are on is highlighted) above the episodes, and a "Seasons & related" section listing every season plus movies/OVAs in watching order (from AniList prequel/sequel links). The same season buttons appear on the watch page. A show with one season says so.
- The player shows a **Skip intro** / **Skip recap** / **Next episode (ending)** button when the episode has timestamps (community data from AniSkip). **Auto-skip intro** is on by default; **Auto-skip ending** is off. Press **S** to skip. With no timestamps a **Skip 85s** button appears in the first minutes.
- **Theme colour:** on your profile press *Theme colour*. It recolours buttons and highlights across the site while you are signed in, and others see it on your profile.

## Accounts, pictures and banners
- Sign up / log in at `/signup` and `/login`. Your profile is `/u/<username>`: click the camera on the avatar or banner to upload; edit your bio there.
- Images are shrunk in the browser (avatar 320×320, banner 1500×500) before upload; only JPEG, PNG and WebP are accepted and the bytes are checked on the server.

## If episode sources say "not found" on Vercel
Some anime sites block Vercel's datacenter IPs. Run the same API where it worked (your Replit deployment, Railway, Fly.io, a VPS)
and let Vercel serve only the website: set `API_ORIGIN=https://your-api-host` in Vercel's environment variables and redeploy.
Vercel then proxies every `/api/*` request there (cookies and login keep working because the browser still talks to one domain).
The API host needs `DATABASE_URL` too.

## Library (continue watching, saved episodes, playback position)
Stored per account in Postgres (`watch_progress`, `saved_episodes`, created automatically). Guests are stored in the browser
and merged into the account on first login.

## How it is built
`pnpm run build:vercel` runs `artifacts/api-server/build-vercel.mjs`, which writes `.vercel/output`:
the Vite frontend as static files, and the Elysia API as one serverless function served at `/api/*`.

## Limits on Vercel
- Sources that need a real headless browser (Chrome via Puppeteer) cannot run on Vercel: the allmanga manga source, the mkissa anime source and the browser-based embed extractor. Everything else (AniList browse/search, most anime sources, accounts) works.
- Functions time out after 60 s on the Hobby plan, and video proxying counts against bandwidth. For heavy streaming traffic a long-running host (Railway, Fly.io, a VPS) fits better.
- Catalog responses are cached at Vercel's edge for 10 minutes to stay under AniList's rate limit.

## Where account data lives and how it is protected
- Accounts, watch history and saved episodes are rows in your Postgres database. Nothing is stored in JSON files or in the repository.
- Passwords are never stored: only a salted scrypt hash (N=32768) is kept. Login sessions are random 256-bit tokens; only their SHA-256 is stored.
- The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and uses the `__Host-` prefix in production. Account responses are `no-store`.
- Wrong-password lockout (6 tries / 15 min), per-IP request limits, same-site origin checks on every write, and security headers (HSTS, nosniff, frame deny).
- Keep your database connection string only in Vercel's environment variables, never in the code.

## If a video says "The browser could not play this video"
The player now retries by itself (hls.js media recovery, then the next stream, with a 30 s start timeout) and the red notice
lists the exact reason under **Technical details**. For reanime episodes the notice also has **Run server diagnostics**
(`/api/debug/stream/<anilistId>/<sub|dub>/<episode>`), which shows which step fails on your host: resolving the stream,
the playlist, or the first video segment. A segment response carries an `X-Segment-Unwrap` header showing how it was read.
