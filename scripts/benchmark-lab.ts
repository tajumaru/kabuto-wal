import { mkdtemp, rm, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { createCohort } from "../apps/api/src/hunter-cohort";
import {
  createCohortJob,
  runCohortJob,
} from "../apps/api/src/hunter-cohort-jobs";
import { demoBars, master } from "../fixtures/demo";
const root = await mkdtemp(path.join(os.tmpdir(), "lab-benchmark-")),
  modulePath = path.resolve("apps/api/src/benchmark-lab-baseline.ts"),
  originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("External requests forbidden in lab benchmark");
};
try {
  const baseline = "a2768e3",
    source = execFileSync(
      "git",
      ["show", `${baseline}:apps/api/src/hunter-cohort-evaluation.ts`],
      { encoding: "utf8" },
    );
  await writeFile(modulePath, source);
  const old = await import(pathToFileURL(modulePath).href),
    seed = new Service(path.join(root, "seed"), "demo", false);
  await seed.init();
  for (const m of master)
    await seed.store.write(
      `prices/${m.providerCode}/fixture.json`,
      demoBars(m.providerCode),
    );
  const engine = new HunterJobs(seed),
    job = await engine.create({
      asOf: "2026-08-10",
      cutoff: "2026-08-10T09:00:00.000Z",
    });
  await engine.run(job.id);
  const cohort = await createCohort(seed, { jobId: job.id }),
    samples: {
      oldMs: number;
      newMs: number;
      oldReconstructions: number;
      newReconstructions: number;
    }[] = [];
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const row = {
      oldMs: 0,
      newMs: 0,
      oldReconstructions: 0,
      newReconstructions: 0,
    };
    for (const variant of ["old", "new"] as const) {
      const dir = path.join(root, `${variant}-${i}`);
      await cp(seed.store.root, dir, { recursive: true });
      const s = new Service(dir, "demo", false),
        history = s.history.bind(s);
      let calls = 0;
      s.history = async (code) => {
        calls++;
        return history(code);
      };
      const start = performance.now();
      if (variant === "old") await old.evaluateCohort(s, cohort.cohortId, now);
      else {
        const j = await createCohortJob(s, cohort.cohortId, now);
        await runCohortJob(s, j.runId);
      }
      row[`${variant}Ms`] = +(performance.now() - start).toFixed(2);
      row[`${variant}Reconstructions`] = calls;
    }
    samples.push(row);
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[1],
    oldMedianMs = median(samples.map((r) => r.oldMs)),
    newMedianMs = median(samples.map((r) => r.newMs)),
    report = {
      baseline,
      mode: "demo fixture; no external network",
      symbols: cohort.memberCount,
      horizons: [1, 5, 20],
      samples,
      oldMedianMs,
      newMedianMs,
      changePercent: +((newMedianMs / oldMedianMs - 1) * 100).toFixed(2),
      notes: [
        "同一の一時JSON保存先複製を利用。旧同期全評価と、新ジョブ作成から完了までを比較。",
        "4銘柄fixture。全市場の実市場性能・メモリ使用量・本番API時間の測定ではありません。",
        "新方式にはcheckpoint・lease・カレンダー原本保存の負荷を含みます。",
      ],
    };
  await writeFile(
    "docs/lab-evaluation-performance.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  globalThis.fetch = originalFetch;
  await rm(modulePath, { force: true });
  await rm(root, { recursive: true, force: true });
}
