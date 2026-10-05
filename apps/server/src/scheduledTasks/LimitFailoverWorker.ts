import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ScheduledTask,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

export const FAILOVER_SWEEP_INTERVAL_MS = 30_000;
/** Stops that land together are answered by one run instead of one each. */
export const FAILOVER_SETTLE_MS = 30_000;
/** A stop older than this is history, not a reason to start work now. */
export const FAILOVER_WINDOW_MS = 6 * 60 * 60_000;
/** How long a provider is treated as exhausted when it reported no reset time. */
export const FAILOVER_UNKNOWN_RESET_BACKOFF_MS = 60 * 60_000;

export interface LimitedThread {
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly failedAtMs: number;
  readonly resetAtMs: number | null;
}

/** A thread whose latest run stopped on a usage limit and has not been continued since. */
export function limitedThread(thread: OrchestrationV2ThreadShell): LimitedThread | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.lineage.relationshipToParent === "subagent"
  )
    return null;
  const resetAtMs = thread.usageLimitResetAt == null ? NaN : Date.parse(thread.usageLimitResetAt);
  return {
    projectId: thread.projectId,
    providerInstanceId: thread.providerInstanceId,
    failedAtMs: DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt),
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
  };
}

/**
 * Scheduled tasks to start because another provider in their project ran out.
 * A task's own last run is the watermark, so each stop is answered once and
 * the decision survives a restart without extra state.
 */
export function failoverTasksToStart(input: {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly limitedThreads: ReadonlyArray<LimitedThread>;
  readonly nowMs: number;
}): ReadonlyArray<ScheduledTaskId> {
  const exhaustedUntil = new Map<ProviderInstanceId, number>();
  for (const thread of input.limitedThreads) {
    const until = thread.resetAtMs ?? thread.failedAtMs + FAILOVER_UNKNOWN_RESET_BACKOFF_MS;
    exhaustedUntil.set(
      thread.providerInstanceId,
      Math.max(exhaustedUntil.get(thread.providerInstanceId) ?? 0, until),
    );
  }
  return input.tasks.flatMap((task) => {
    if (!task.enabled || task.lastRunStatus === "running") return [];
    const instanceId = task.modelSelection.instanceId;
    // Starting a task on a provider that is itself out would only fail again.
    if ((exhaustedUntil.get(instanceId) ?? 0) > input.nowMs) return [];
    const sinceMs = Date.parse(task.lastRunAt ?? task.createdAt);
    const pending = input.limitedThreads.filter(
      (thread) =>
        thread.projectId === task.projectId &&
        thread.providerInstanceId !== instanceId &&
        thread.failedAtMs > sinceMs &&
        thread.failedAtMs > input.nowMs - FAILOVER_WINDOW_MS,
    );
    if (pending.length === 0) return [];
    const oldestMs = Math.min(...pending.map((thread) => thread.failedAtMs));
    return oldestMs <= input.nowMs - FAILOVER_SETTLE_MS ? [task.id] : [];
  });
}

const makeSweep = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const lastSweepMs = yield* Ref.make(0);
  return Effect.fn("LimitFailoverWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    if (!preferences.limitFailoverScheduledTasks) return;
    // The shell snapshot reads every active thread, so it runs less often
    // than the shared scheduler ticks.
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (nowMs - (yield* Ref.get(lastSweepMs)) < FAILOVER_SWEEP_INTERVAL_MS) return;
    yield* Ref.set(lastSweepMs, nowMs);
    const { tasks } = yield* scheduledTasks.list();
    if (!tasks.some((task) => task.enabled)) return;
    const snapshot = yield* threads.getShellSnapshot();
    const due = failoverTasksToStart({
      tasks,
      limitedThreads: snapshot.threads.flatMap((thread) => limitedThread(thread) ?? []),
      nowMs,
    });
    for (const id of due) {
      yield* Effect.logInfo("Starting scheduled task after a provider usage limit", {
        taskId: id,
      });
      yield* scheduledTasks
        .runNow({ id })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("scheduled-tasks.limit-failover.run-failed", { taskId: id, cause }),
          ),
        );
    }
  });
});

// Due work is derived from persisted thread failures and task run times, so
// restarts need no timer restoration.
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("limit-failover", sweep());
  }),
);
