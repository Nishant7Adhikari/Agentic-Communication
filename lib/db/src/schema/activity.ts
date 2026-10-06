import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const activityLogsTable = pgTable(
  "agent_activity_logs",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    agentName: text("agent_name").notNull().default(""),
    title: text("title").notNull().default(""),
    taskDescription: text("task_description").notNull(),
    shortDescription: text("short_description"),
    detailedDescription: text("detailed_description").notNull().default(""),
    targetFiles: jsonb("target_files").$type<string[]>().notNull(),
    plannedScope: text("planned_scope"),
    filesTouched: jsonb("files_touched").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    changeNotes: text("change_notes"),
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
