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
    taskDescription: text("task_description").notNull().default(""),
    shortDescription: text("short_description"),
    detailedDescription: text("detailed_description").notNull().default(""),
    initialPlanning: text("initial_planning"),
    plannedScope: text("planned_scope"),
    targetFiles: jsonb("target_files").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    closingStatement: text("closing_statement"),
    unexpectedChanges: text("unexpected_changes"),
    filesTouched: jsonb("files_touched").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    changeNotes: text("change_notes"),
    status: text("status").notNull().default("in_progress"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_activity_logs_created_at_idx").on(table.createdAt),
    index("agent_activity_logs_agent_id_idx").on(table.agentId),
    index("agent_activity_logs_status_idx").on(table.status),
  ],
);

export const insertActivityLogSchema = createInsertSchema(activityLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertActivityLog = typeof activityLogsTable.$inferInsert;
export type ActivityLog = typeof activityLogsTable.$inferSelect;
