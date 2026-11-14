-- kanime: run this once in Supabase → SQL Editor → New query → Run.
-- (The server also creates these automatically on first use; running it yourself just makes it explicit.)

create table if not exists users (
  id serial primary key,
  username text not null unique,
  display_name text not null,
  email text not null unique,
  password_hash text not null,
  avatar_url text not null default '',
  banner_url text not null default '',
  bio text not null default '',
  theme_color text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists profile_images (
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  mime text not null,
  data bytea not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create table if not exists sessions (
  id text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists watch_progress (
  user_id integer not null references users(id) on delete cascade,
  anime_id integer not null,
  episode_id text not null,
  provider text not null,
  audio text not null,
  episode_number text not null default '',
  anime_title text not null default '',
  poster text not null default '',
  position real not null default 0,
  duration real not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id, episode_id)
);

create table if not exists saved_episodes (
  user_id integer not null references users(id) on delete cascade,
  anime_id integer not null,
  episode_id text not null,
  provider text not null,
  audio text not null,
  episode_number text not null default '',
  anime_title text not null default '',
  poster text not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, anime_id, episode_id)
);

-- Supabase exposes "public" tables over its REST API. RLS on with no policies = only this server can touch them.
alter table users enable row level security;
alter table sessions enable row level security;
alter table watch_progress enable row level security;
alter table saved_episodes enable row level security;
alter table profile_images enable row level security;

-- Global chat (v13)
create table if not exists chat_images (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references users(id) on delete cascade,
  mime text not null, data bytea not null,
  created_at timestamptz not null default now()
);
create table if not exists stickers (
  id uuid primary key default gen_random_uuid(),
  user_id integer not null references users(id) on delete cascade,
  mime text not null, data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists stickers_user_idx on stickers (user_id, created_at desc);
create table if not exists sticker_favorites (
  user_id integer not null references users(id) on delete cascade,
  sticker_id uuid not null references stickers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, sticker_id)
);
create table if not exists chat_messages (
  id bigserial primary key,
  user_id integer not null references users(id) on delete cascade,
  body text not null default '',
  image_id uuid references chat_images(id) on delete set null,
  sticker_id uuid references stickers(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_created_idx on chat_messages (created_at desc);
alter table chat_images enable row level security;
alter table stickers enable row level security;
alter table sticker_favorites enable row level security;
alter table chat_messages enable row level security;

-- If your users table already exists (older version), add the theme colour column:
alter table users add column if not exists theme_color text not null default '';

-- Anime comments (v15)
create table if not exists anime_comments (
  id bigserial primary key,
  anime_id integer not null,
  user_id integer not null references users(id) on delete cascade,
  parent_id bigint references anime_comments(id) on delete cascade,
  episode text not null default '',
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists anime_comments_anime_idx on anime_comments (anime_id, parent_id, id desc);
alter table anime_comments enable row level security;
