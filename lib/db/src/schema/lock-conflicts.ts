import { index, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const lockConflictsTable = pgTable(
  "agent_lock_conflicts",
  {
    id: serial("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    requestingAgentId: text("requesting_agent_id").notNull(),
    requestedPath: text("requested_path").notNull(),
    lockedPath: text("locked_path").notNull(),
    lockingAgentId: text("locking_agent_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_lock_conflicts_created_at_idx").on(table.createdAt),
    index("agent_lock_conflicts_attempt_id_idx").on(table.attemptId),
  ],
);

export type LockConflict = typeof lockConflictsTable.$inferSelect;
