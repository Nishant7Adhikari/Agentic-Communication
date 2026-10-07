import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gt, gte, inArray, lte, lt, sql } from "drizzle-orm";
import {
  AcquireLocksBody,
  AcquireLocksResponse,
  CreateActivityLogBody,
  CreateActivityLogResponse,
  GetActiveLocksResponse,
  GetDashboardSummaryResponse,
  GetTodayActivityResponse,
  ReleaseLocksBody,
  ReleaseLocksResponse,
  SubmitInitialPlanBody,
  SubmitInitialPlanResponse,
  SubmitClosingStatementBody,
  SubmitClosingStatementResponse,
} from "@workspace/api-zod";
import type { LockConflictResult } from "@workspace/api-zod";
import {
  activityLogsTable,
  db,
  lockConflictsTable,
  pathLocksTable,
} from "@workspace/db";

const router: IRouter = Router();
const TERMINAL_STATUSES = new Set(["completed", "complete", "success", "failed", "blocked", "done"]);

function utcDayBounds(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function formatActivityLog(entry: typeof activityLogsTable.$inferSelect) {
  return {
    id: entry.id,
    agent_id: entry.agentId,
    agent_name: entry.agentName || entry.agentId,
    title: entry.title || entry.taskDescription || "Untitled task",
    task_description: entry.taskDescription || entry.title || "",
    short_description: entry.shortDescription,
    detailed_description: entry.detailedDescription || entry.initialPlanning || "",
    initial_planning: entry.initialPlanning,
    planned_scope: entry.plannedScope,
    target_files: entry.targetFiles ?? [],
    closing_statement: entry.closingStatement,
    unexpected_changes: entry.unexpectedChanges,
    files_touched: entry.filesTouched ?? [],
    change_notes: entry.changeNotes,
    status: entry.status,
    created_at: entry.createdAt,
    closed_at: entry.closedAt,
  };
}

// ─── Step 1: Read Today's Log ─────────────────────────────────────────────────
router.get("/v1/log/today", async (_req, res): Promise<void> => {
  try {
    const { start, end } = utcDayBounds();
    const entries = await db
      .select()
      .from(activityLogsTable)
      .where(and(gte(activityLogsTable.createdAt, start), lt(activityLogsTable.createdAt, end)))
      .orderBy(desc(activityLogsTable.createdAt));

    res.json(GetTodayActivityResponse.parse(entries.map(formatActivityLog)));
  } catch (err) {
    console.error("[GET /v1/log/today ERROR]", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Failed to fetch today's log", detail: message });
  }
});

// ─── Step 2: Submit Initial Plan ─────────────────────────────────────────────
router.post("/v1/plan", async (req, res): Promise<void> => {
  const parsed = SubmitInitialPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const { agent_id, agent_name, title, initial_planning, planned_scope, target_files } = parsed.data;

    const [entry] = await db
      .insert(activityLogsTable)
      .values({
        agentId: agent_id,
        agentName: agent_name?.trim() || agent_id,
        title: title.trim(),
        taskDescription: initial_planning.trim(),
        detailedDescription: initial_planning.trim(),
        initialPlanning: initial_planning.trim(),
        plannedScope: planned_scope.trim(),
        targetFiles: target_files ?? [],
        status: "in_progress",
      })
      .returning();

    res.status(201).json(SubmitInitialPlanResponse.parse(formatActivityLog(entry)));
  } catch (err) {
    console.error("[POST /v1/plan ERROR]", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Failed to submit plan", detail: message });
  }
});

// ─── Step 3: Submit Closing Statement ────────────────────────────────────────
router.post("/v1/close", async (req, res): Promise<void> => {
  const parsed = SubmitClosingStatementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const { agent_id, log_id, closing_statement, unexpected_changes, files_touched, change_notes } = parsed.data;
    const now = new Date();

    // Find target log entry
    let existingEntry: typeof activityLogsTable.$inferSelect | undefined;
    if (log_id) {
      const found = await db
        .select()
        .from(activityLogsTable)
        .where(and(eq(activityLogsTable.id, log_id), eq(activityLogsTable.agentId, agent_id)))
        .limit(1);
      existingEntry = found[0];
    } else {
      // Find latest in-progress entry for this agent
      const found = await db
        .select()
        .from(activityLogsTable)
        .where(and(eq(activityLogsTable.agentId, agent_id), eq(activityLogsTable.status, "in_progress")))
        .orderBy(desc(activityLogsTable.createdAt))
        .limit(1);
      existingEntry = found[0];
    }

    if (existingEntry) {
      const [updated] = await db
        .update(activityLogsTable)
        .set({
          closingStatement: closing_statement.trim(),
          unexpectedChanges: unexpected_changes?.trim() || existingEntry.unexpectedChanges,
          filesTouched: files_touched ?? existingEntry.filesTouched,
          changeNotes: change_notes?.trim() || existingEntry.changeNotes,
          status: "completed",
          closedAt: now,
        })
        .where(eq(activityLogsTable.id, existingEntry.id))
        .returning();

      res.status(200).json(SubmitClosingStatementResponse.parse(formatActivityLog(updated)));
      return;
    }

    // Fallback: create completed log if no prior plan found
    const [newEntry] = await db
      .insert(activityLogsTable)
      .values({
        agentId: agent_id,
        agentName: agent_id,
        title: "Completed work",
        taskDescription: closing_statement.trim(),
        detailedDescription: closing_statement.trim(),
        closingStatement: closing_statement.trim(),
        unexpectedChanges: unexpected_changes?.trim() || null,
        filesTouched: files_touched ?? [],
        changeNotes: change_notes?.trim() || null,
        status: "completed",
        closedAt: now,
      })
      .returning();

    res.status(200).json(SubmitClosingStatementResponse.parse(formatActivityLog(newEntry)));
  } catch (err) {
    console.error("[POST /v1/close ERROR]", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Failed to submit closing statement", detail: message });
  }
});

// ─── Legacy: Generic activity log (kept for compatibility) ───────────────────
router.post("/v1/log", async (req, res): Promise<void> => {
  const parsed = CreateActivityLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const title = parsed.data.title?.trim() || parsed.data.task_description?.trim() || "Untitled activity";
    const detailedDescription =
      parsed.data.detailed_description?.trim() ||
      parsed.data.initial_planning?.trim() ||
      parsed.data.closing_statement?.trim() ||
      parsed.data.task_description?.trim() ||
      parsed.data.short_description?.trim() ||
      title;

    const [entry] = await db
      .insert(activityLogsTable)
      .values({
        agentId: parsed.data.agent_id,
        agentName: parsed.data.agent_name?.trim() || parsed.data.agent_id,
        title,
        taskDescription: parsed.data.task_description?.trim() || title,
        shortDescription: parsed.data.short_description?.trim() || null,
        detailedDescription,
        initialPlanning: parsed.data.initial_planning?.trim() || null,
        plannedScope: parsed.data.planned_scope?.trim() || null,
        targetFiles: parsed.data.target_files ?? [],
        closingStatement: parsed.data.closing_statement?.trim() || null,
        unexpectedChanges: parsed.data.unexpected_changes?.trim() || null,
        filesTouched: parsed.data.files_touched ?? [],
        changeNotes: parsed.data.change_notes?.trim() || null,
        status: parsed.data.status,
        closedAt: TERMINAL_STATUSES.has(parsed.data.status.toLowerCase()) ? new Date() : null,
      })
      .returning();

    res.status(201).json(CreateActivityLogResponse.parse(formatActivityLog(entry)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Failed to create log", detail: message });
  }
});

// ─── Dashboard ───────────────────────────────────────────────────────────────
router.get("/v1/dashboard", async (_req, res): Promise<void> => {
  try {
    const now = new Date();
    const { start, end } = utcDayBounds(now);

    const [activity, conflictCount] = await Promise.all([
      db
        .select({
          agentId: activityLogsTable.agentId,
          status: activityLogsTable.status,
          createdAt: activityLogsTable.createdAt,
        })
        .from(activityLogsTable)
        .where(and(gte(activityLogsTable.createdAt, start), lt(activityLogsTable.createdAt, end)))
        .orderBy(desc(activityLogsTable.createdAt)),
      db
        .select({ count: sql<number>`count(distinct ${lockConflictsTable.attemptId})::int` })
        .from(lockConflictsTable)
        .where(and(gte(lockConflictsTable.createdAt, start), lt(lockConflictsTable.createdAt, end))),
    ]);

    const latestStatusByAgent = new Map<string, string>();
    for (const row of activity) {
      if (!latestStatusByAgent.has(row.agentId)) {
        latestStatusByAgent.set(row.agentId, row.status.toLowerCase());
      }
    }

    const activeAgents = new Set<string>();
    for (const [agentId, status] of latestStatusByAgent) {
      if (!TERMINAL_STATUSES.has(status)) {
        activeAgents.add(agentId);
      }
    }

    res.json(
      GetDashboardSummaryResponse.parse({
        active_agents: activeAgents.size,
        active_locks: 0,
        conflicts_today: conflictCount[0]?.count ?? 0,
        activity_today: activity.length,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Failed to fetch dashboard", detail: message });
  }
});

export default router;
