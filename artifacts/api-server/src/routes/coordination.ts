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

router.post("/v1/log", async (req, res): Promise<void> => {
  const parsed = CreateActivityLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [entry] = await db
    .insert(activityLogsTable)
    .values({
      agentId: parsed.data.agent_id,
      taskDescription: parsed.data.task_description,
      targetFiles: parsed.data.target_files,
      status: parsed.data.status,
    })
    .returning();

  res.status(201).json(
    CreateActivityLogResponse.parse({
      id: entry.id,
      agent_id: entry.agentId,
      task_description: entry.taskDescription,
      target_files: entry.targetFiles,
      status: entry.status,
      created_at: entry.createdAt,
    }),
  );
});

router.get("/v1/log/today", async (_req, res): Promise<void> => {
  const { start, end } = utcDayBounds();
  const entries = await db
    .select()
    .from(activityLogsTable)
    .where(and(gte(activityLogsTable.createdAt, start), lt(activityLogsTable.createdAt, end)))
    .orderBy(desc(activityLogsTable.createdAt));

  res.json(
    GetTodayActivityResponse.parse(
      entries.map((entry) => ({
        id: entry.id,
        agent_id: entry.agentId,
        task_description: entry.taskDescription,
        target_files: entry.targetFiles,
        status: entry.status,
        created_at: entry.createdAt,
      })),
    ),
  );
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
