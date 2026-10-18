import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { createCohort } from "../apps/api/src/hunter-cohort";
import {
  createCohortJob,
  runCohortJob,
  controlCohortJob,
  cohortJobProgress,
} from "../apps/api/src/hunter-cohort-jobs";
import { demoBars } from "../fixtures/demo";
it("評価ジョブは同じ締切・calendarで中断再開し、期限前は価格を取得しない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cohort-job-")),
    s = new Service(root, "demo", false),
    now = new Date("2026-08-10T10:00:00.000Z");
  try {
    await s.init();
    await s.store.write("prices/72030/fixture.json", demoBars("72030"));
    const engine = new HunterJobs(s, () => now),
      j = await engine.create({
        asOf: "2026-08-10",
        cutoff: "2026-08-10T09:00:00.000Z",
      });
    await engine.run(j.id);
    const c = await createCohort(s, { jobId: j.id }, now),
      job = await createCohortJob(s, c.cohortId, now),
      history = vi.spyOn(s, "history");
    expect(
      (
        await createCohortJob(
          s,
          c.cohortId,
          new Date("2026-08-11T10:00:00.000Z"),
        )
      ).runId,
    ).toBe(job.runId);
    expect((await runCohortJob(s, job.runId, 0)).status).toBe("paused");
    await controlCohortJob(s, job.runId, "resume");
    expect((await runCohortJob(s, job.runId)).status).toBe("completed");
    expect(history).not.toHaveBeenCalled();
    const progress = await cohortJobProgress(s, job.runId);
    expect(progress.completedSymbols).toBe(4);
    expect(progress.pending).toBe(3);
    expect(progress.excluded).toBe(9);
    history.mockRestore();
    const next = await createCohortJob(
      s,
      c.cohortId,
      new Date("2026-10-17T00:00:00.000Z"),
    );
    await s.store.write("market/calendar.json", []);
    await expect(runCohortJob(s, next.runId)).rejects.toThrow("calendar");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("1・5・20営業日の価格再構成を銘柄ごとに共有する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cohort-shared-")),
    s = new Service(root, "demo", false);
  try {
    await s.init();
    await s.store.write("prices/72030/fixture.json", demoBars("72030"));
    const engine = new HunterJobs(s),
      j = await engine.create({
        asOf: "2026-08-10",
        cutoff: "2026-08-10T09:00:00.000Z",
      });
    await engine.run(j.id);
    const c = await createCohort(s, { jobId: j.id }),
      job = await createCohortJob(s, c.cohortId),
      history = vi.spyOn(s, "history");
    await runCohortJob(s, job.runId);
    expect((await cohortJobProgress(s, job.runId)).evaluated).toBe(3);
    expect(history).toHaveBeenCalledTimes(1);
    history.mockRestore();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
