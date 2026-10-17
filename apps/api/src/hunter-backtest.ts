import { z } from "zod";
import type { Service } from "./service";
import type { Calendar } from "../../../packages/core/index";
import { HUNTER_METHOD } from "../../../packages/core/hunter-schema";
import { HunterJobs } from "./hunter-jobs";
import { hunterId, recordHunterForecast } from "./hunter-journal";

// Explicit local-only chronological replay. Every step freezes its own known-data cutoff.
export async function walkForwardHunter(service: Service, raw: unknown) {
  const input = z.object({ from: z.string().date(), to: z.string().date(), step: z.number().int().min(1).max(250).default(20) }).strict().parse(raw);
  if (input.from > input.to) throw Error("期間が逆順です");
  const calendar = await service.store.read<Calendar>("market/calendar.json", []);
  const days = calendar.filter(d => d.open && d.date >= input.from && d.date <= input.to).map(d => d.date).sort().filter((_,i) => i%input.step === 0);
  if (days.length > 250) throw Error("walk-forwardは1回250時点までです");
  const id = hunterId([service.mode, input, HUNTER_METHOD, "walk-forward-v1"]), key = `market/hunter/backtests/${id}.json`;
  const engine = new HunterJobs(service);
  const old = await service.store.read<{ steps: { asOf: string; jobId: string; records: number; excluded: number; error?: string }[] }>(key, { steps: [] });
  for (const asOf of days) {
    if (old.steps.some(s => s.asOf === asOf && !s.error)) continue;
    let jobId = "", records = 0, excluded = 0, error: string | undefined;
    try {
      const prior = calendar.filter(d => d.open && d.date <= asOf).map(d => d.date).sort().slice(-1250)[0] ?? asOf;
      const job = await engine.create({ kind: "scan", asOf, from: prior, cutoff: `${asOf}T14:59:59.999Z` }); jobId = job.id;
      await engine.run(job.id);
      for (const row of (await engine.rows(job.id)).filter(r => r.candidate)) {
        try { records += (await recordHunterForecast(service, { jobId: job.id, code: row.code, recordingMode: "walk-forward" })).records.length; }
        catch { excluded++; }
      }
    } catch (e) { error = e instanceof Error ? e.message : "時点の解析に失敗しました"; }
    old.steps = old.steps.filter(s => s.asOf !== asOf);
    old.steps.push({ asOf, jobId, records, excluded, ...(error ? { error } : {}) });
    await service.store.lock(() => service.store.write(key, { schemaVersion: 1, methodVersion: HUNTER_METHOD, id, mode: service.mode, input, steps: old.steps }));
  }
  return { id, steps: old.steps };
}
