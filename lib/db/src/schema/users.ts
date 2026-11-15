import { customType, integer, pgTable, primaryKey, serial, text, timestamp } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  /** Lowercased, used for login and uniqueness. */
  username: text("username").notNull().unique(),
  /** Username as the person typed it (keeps capitalisation). */
  displayName: text("display_name").notNull(),
  /** Lowercased. */
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /** Profile picture / banner: a Supabase Storage URL, or /api/profile-image/... when stored in the database. Empty = none. */
  avatarUrl: text("avatar_url").notNull().default(""),
  bannerUrl: text("banner_url").notNull().default(""),
  bio: text("bio").notNull().default(""),
  /** Profile theme colour as #rrggbb, or empty for the default orange. */
  themeColor: text("theme_color").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionsTable = pgTable("sessions", {
  /** SHA-256 of the session token stored in the cookie. */
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof usersTable.$inferSelect;

/** Fallback home for profile images when Supabase Storage is not configured (served by /api/profile-image). */
export const profileImagesTable = pgTable(
  "profile_images",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    data: bytea("data").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);
