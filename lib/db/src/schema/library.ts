import { integer, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Where each person stopped in each episode. */
export const watchProgressTable = pgTable(
  "watch_progress",
  {
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    animeId: integer("anime_id").notNull(),
    episodeId: text("episode_id").notNull(),
    provider: text("provider").notNull(),
    audio: text("audio").notNull(),
    episodeNumber: text("episode_number").notNull().default(""),
    animeTitle: text("anime_title").notNull().default(""),
    poster: text("poster").notNull().default(""),
    position: real("position").notNull().default(0),
    duration: real("duration").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.animeId, t.episodeId] })],
);

/** Episodes a person bookmarked. */
export const savedEpisodesTable = pgTable(
  "saved_episodes",
  {
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    animeId: integer("anime_id").notNull(),
    episodeId: text("episode_id").notNull(),
    provider: text("provider").notNull(),
    audio: text("audio").notNull(),
    episodeNumber: text("episode_number").notNull().default(""),
    animeTitle: text("anime_title").notNull().default(""),
    poster: text("poster").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.animeId, t.episodeId] })],
);
