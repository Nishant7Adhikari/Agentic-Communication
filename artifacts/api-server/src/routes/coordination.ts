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
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "complete", "success", "failed", "blocked", "done"]);

function utcDayBounds(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Paths cannot contain '..' segments");
  }
  if (segments.length === 0) {
    throw new Error("Each target path must name a file or directory");
  }
  return segments.join("/");
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath))];
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function apiLock(lock: typeof pathLocksTable.$inferSelect) {
  return {
    id: lock.id,
    path: lock.path,
    agent_id: lock.agentId,
    acquired_at: lock.acquiredAt,
    expires_at: lock.expiresAt,
  };
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

// Step 1: Submit Initial Plan
router.post("/v1/plan", async (req, res): Promise<void> => {
  const parsed = SubmitInitialPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

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
});

// Step 3: Submit Closing Statement
router.post("/v1/close", async (req, res): Promise<void> => {
  const parsed = SubmitClosingStatementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

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

  // Fallback: create completed log entry if no prior plan record found
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
});

router.post("/v1/log", async (req, res): Promise<void> => {
  const parsed = CreateActivityLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

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
});

router.get("/v1/log/today", async (_req, res): Promise<void> => {
  const { start, end } = utcDayBounds();
  const entries = await db
    .select()
    .from(activityLogsTable)
    .where(and(gte(activityLogsTable.createdAt, start), lt(activityLogsTable.createdAt, end)))
    .orderBy(desc(activityLogsTable.createdAt));

  res.json(GetTodayActivityResponse.parse(entries.map(formatActivityLog)));
});

router.get("/v1/locks", async (_req, res): Promise<void> => {
  const now = new Date();
  await db.delete(pathLocksTable).where(lte(pathLocksTable.expiresAt, now));
  const locks = await db
    .select()
    .from(pathLocksTable)
    .where(gt(pathLocksTable.expiresAt, now))
    .orderBy(asc(pathLocksTable.expiresAt));

  res.json(GetActiveLocksResponse.parse(locks.map(apiLock)));
});

router.post("/v1/locks/acquire", async (req, res): Promise<void> => {
  const parsed = AcquireLocksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let requestedPaths: string[];
  try {
    requestedPaths = normalizePaths(parsed.data.target_files);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid target path" });
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const outcome = await db.transaction(async (tx) => {
    // Serialize lock decisions across server instances as well as requests.
    await tx.execute(sql`LOCK TABLE agent_path_locks IN EXCLUSIVE MODE`);
    await tx.delete(pathLocksTable).where(lte(pathLocksTable.expiresAt, now));

    const active = await tx
      .select()
      .from(pathLocksTable)
      .where(gt(pathLocksTable.expiresAt, now));

    const conflicts = requestedPaths.flatMap((requestedPath) =>
      active
        .filter((lock) => lock.agentId !== parsed.data.agent_id && pathsOverlap(requestedPath, lock.path))
        .map((lock) => ({
          requested_path: requestedPath,
          locked_path: lock.path,
          agent_id: lock.agentId,
          expires_at: lock.expiresAt,
        })),
    );

    if (conflicts.length > 0) {
      const attemptId = randomUUID();
      await tx.insert(lockConflictsTable).values(
        conflicts.map((conflict) => ({
          attemptId,
          requestingAgentId: parsed.data.agent_id,
          requestedPath: conflict.requested_path,
          lockedPath: conflict.locked_path,
          lockingAgentId: conflict.agent_id,
          expiresAt: conflict.expires_at,
        })),
      );
      return { granted: false as const, conflicts };
    }

    const locks = await tx
      .insert(pathLocksTable)
      .values(
        requestedPaths.map((path) => ({
          path,
          agentId: parsed.data.agent_id,
          acquiredAt: now,
          expiresAt,
        })),
      )
      .onConflictDoUpdate({
        target: pathLocksTable.path,
        set: { agentId: parsed.data.agent_id, acquiredAt: now, expiresAt },
      })
      .returning();

    return { granted: true as const, locks: locks.map(apiLock) };
  });

  if (!outcome.granted) {
    const conflictResponse: LockConflictResult = outcome;
    res.status(409).json(conflictResponse);
    return;
  }
  res.status(200).json(AcquireLocksResponse.parse(outcome));
});

router.post("/v1/locks/release", async (req, res): Promise<void> => {
  const parsed = ReleaseLocksBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let requestedPaths: string[] | undefined;
  try {
    requestedPaths =
      parsed.data.target_files === undefined
        ? undefined
        : normalizePaths(parsed.data.target_files);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid target path" });
    return;
  }

  const conditions = [eq(pathLocksTable.agentId, parsed.data.agent_id)];
  if (requestedPaths) {
    conditions.push(inArray(pathLocksTable.path, requestedPaths));
  }

  const released = await db
    .delete(pathLocksTable)
    .where(and(...conditions))
    .returning({ path: pathLocksTable.path });

  res.json(
    ReleaseLocksResponse.parse({
      released_count: released.length,
      released_paths: released.map((lock) => lock.path),
    }),
  );
});

router.get("/v1/dashboard", async (_req, res): Promise<void> => {
  const now = new Date();
  const { start, end } = utcDayBounds(now);
  await db.delete(pathLocksTable).where(lte(pathLocksTable.expiresAt, now));

  const [activity, locks, conflictCount] = await Promise.all([
    db
      .select({
        agentId: activityLogsTable.agentId,
        status: activityLogsTable.status,
        createdAt: activityLogsTable.createdAt,
      })
      .from(activityLogsTable)
      .where(and(gte(activityLogsTable.createdAt, start), lt(activityLogsTable.createdAt, end)))
      .orderBy(desc(activityLogsTable.createdAt)),
    db.select({ agentId: pathLocksTable.agentId }).from(pathLocksTable).where(gt(pathLocksTable.expiresAt, now)),
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
  const activeAgents = new Set(locks.map((lock) => lock.agentId));
  for (const [agentId, status] of latestStatusByAgent) {
    if (!TERMINAL_STATUSES.has(status)) {
      activeAgents.add(agentId);
    }
  }

  res.json(
    GetDashboardSummaryResponse.parse({
      active_agents: activeAgents.size,
      active_locks: locks.length,
      conflicts_today: conflictCount[0]?.count ?? 0,
      activity_today: activity.length,
    }),
  );
});

export default router;
