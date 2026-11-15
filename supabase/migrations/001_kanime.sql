-- kanime schema for Supabase. Optional: the server creates all of this by itself the first time it runs.
-- Run it in the Supabase SQL Editor if you would rather set the tables up by hand.

create table if not exists users (
  id serial primary key,
  username text not null unique,
  display_name text not null,
  email text not null unique,
  password_hash text not null,
  avatar_url text not null default '',
  banner_url text not null default '',
  bio text not null default '',
  created_at timestamptz not null default now()
);
alter table users add column if not exists avatar_url text not null default '';
alter table users add column if not exists banner_url text not null default '';
alter table users add column if not exists bio text not null default '';

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

-- Used for profile pictures / banners when Supabase Storage is not configured.
create table if not exists profile_images (
  user_id integer not null references users(id) on delete cascade,
  kind text not null,
  mime text not null,
  data bytea not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

-- Supabase publishes every table in "public" through its REST API. Row level security with no policies blocks
-- that completely; the kanime server connects as the database owner and is not affected.
alter table users enable row level security;
alter table sessions enable row level security;
alter table watch_progress enable row level security;
alter table saved_episodes enable row level security;
alter table profile_images enable row level security;
