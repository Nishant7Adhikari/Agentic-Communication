import { createInsertSchema } from "drizzle-zod";
import { index, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const pathLocksTable = pgTable(
  "agent_path_locks",
  {
    id: serial("id").primaryKey(),
    path: text("path").notNull(),
    agentId: text("agent_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_path_locks_path_unique").on(table.path),
    index("agent_path_locks_expires_at_idx").on(table.expiresAt),
    index("agent_path_locks_agent_id_idx").on(table.agentId),
  ],
);

export const insertPathLockSchema = createInsertSchema(pathLocksTable).omit({ id: true });

export type InsertPathLock = typeof pathLocksTable.$inferInsert;
export type PathLock = typeof pathLocksTable.$inferSelect;
