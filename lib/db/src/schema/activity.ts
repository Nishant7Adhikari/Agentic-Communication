import { createInsertSchema } from "drizzle-zod";
import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const activityLogsTable = pgTable(
  "agent_activity_logs",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    taskDescription: text("task_description").notNull(),
    targetFiles: jsonb("target_files").$type<string[]>().notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_activity_logs_created_at_idx").on(table.createdAt),
    index("agent_activity_logs_agent_id_idx").on(table.agentId),
  ],
);

export const insertActivityLogSchema = createInsertSchema(activityLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertActivityLog = typeof activityLogsTable.$inferInsert;
export type ActivityLog = typeof activityLogsTable.$inferSelect;
