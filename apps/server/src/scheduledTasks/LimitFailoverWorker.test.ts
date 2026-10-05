import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  FAILOVER_SETTLE_MS,
  FAILOVER_UNKNOWN_RESET_BACKOFF_MS,
  FAILOVER_WINDOW_MS,
  failoverTasksToStart,
  type LimitedThread,
} from "./LimitFailoverWorker.ts";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const project = ProjectId.make("project-1");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function task(input: {
  readonly id: string;
  readonly instanceId: ProviderInstanceId;
  readonly lastRunAgoMs?: number;
  readonly enabled?: boolean;
  readonly lastRunStatus?: ScheduledTask["lastRunStatus"];
}): ScheduledTask {
  return {
    id: ScheduledTaskId.make(input.id),
    title: input.id,
    prompt: "Manage the project.",
    enabled: input.enabled ?? true,
    schedule: { type: "interval", everyMs: 10_800_000 },
    projectId: project,
    threadId: null,
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: input.instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt:
      input.lastRunAgoMs === undefined
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(NOW - input.lastRunAgoMs)),
    lastRunStatus: input.lastRunStatus ?? "succeeded",
    lastRunError: null,
    runCount: 1,
  } as ScheduledTask;
}

function stop(input: {
  readonly instanceId: ProviderInstanceId;
  readonly agoMs: number;
  readonly resetInMs?: number;
  readonly projectId?: ProjectId;
}): LimitedThread {
  return {
    projectId: input.projectId ?? project,
    providerInstanceId: input.instanceId,
    failedAtMs: NOW - input.agoMs,
    resetAtMs: input.resetInMs === undefined ? null : NOW + input.resetInMs,
  };
}

const start = (tasks: ReadonlyArray<ScheduledTask>, limitedThreads: ReadonlyArray<LimitedThread>) =>
  failoverTasksToStart({ tasks, limitedThreads, nowMs: NOW });

describe("failoverTasksToStart", () => {
  const managerA = task({ id: "manager-a", instanceId: codex, lastRunAgoMs: 3_600_000 });
  const managerB = task({ id: "manager-b", instanceId: claude, lastRunAgoMs: 3_600_000 });

  it("starts the task on the other provider once the stop has settled", () => {
    assert.deepStrictEqual(
      start([managerA, managerB], [stop({ instanceId: codex, agoMs: FAILOVER_SETTLE_MS })]),
      [managerB.id],
    );
    assert.deepStrictEqual(
      start(
        [managerA, managerB],
        [stop({ instanceId: claude, agoMs: 60_000, resetInMs: 900_000 })],
      ),
      [managerA.id],
    );
  });

  it("waits for a burst of stops to settle", () => {
    assert.deepStrictEqual(
      start([managerA, managerB], [stop({ instanceId: codex, agoMs: FAILOVER_SETTLE_MS - 1 })]),
      [],
    );
  });

  it("answers a stop once: a run started after it consumes it", () => {
    const ranSince = task({ id: "manager-b", instanceId: claude, lastRunAgoMs: 10_000 });
    assert.deepStrictEqual(start([ranSince], [stop({ instanceId: codex, agoMs: 60_000 })]), []);
  });

  it("does not start a task whose own provider is still out", () => {
    // Both providers are out: neither manager is started until one resets.
    assert.deepStrictEqual(
      start(
        [managerA, managerB],
        [
          stop({ instanceId: codex, agoMs: 60_000 }),
          stop({ instanceId: claude, agoMs: 60_000, resetInMs: 900_000 }),
        ],
      ),
      [],
    );
    // A stop without a reset time blocks its provider for the backoff only.
    assert.deepStrictEqual(
      start(
        [managerA],
        [
          stop({ instanceId: codex, agoMs: FAILOVER_UNKNOWN_RESET_BACKOFF_MS + 1 }),
          stop({ instanceId: claude, agoMs: 60_000, resetInMs: 900_000 }),
        ],
      ),
      [managerA.id],
    );
  });

  it("starts the waiting task once its provider's reset has passed", () => {
    assert.deepStrictEqual(
      start(
        [managerB],
        [
          stop({ instanceId: codex, agoMs: 60_000 }),
          stop({ instanceId: claude, agoMs: 7_200_000, resetInMs: -1_000 }),
        ],
      ),
      [managerB.id],
    );
  });

  it("ignores disabled and running tasks, other projects, and stale stops", () => {
    const codexStop = stop({ instanceId: codex, agoMs: 60_000 });
    assert.deepStrictEqual(
      start([task({ id: "off", instanceId: claude, enabled: false })], [codexStop]),
      [],
    );
    assert.deepStrictEqual(
      start([task({ id: "busy", instanceId: claude, lastRunStatus: "running" })], [codexStop]),
      [],
    );
    assert.deepStrictEqual(
      start(
        [managerB],
        [stop({ instanceId: codex, agoMs: 60_000, projectId: ProjectId.make("project-2") })],
      ),
      [],
    );
    assert.deepStrictEqual(
      start(
        [task({ id: "never-ran", instanceId: claude })],
        [stop({ instanceId: codex, agoMs: FAILOVER_WINDOW_MS + 1 })],
      ),
      [],
    );
  });
});
