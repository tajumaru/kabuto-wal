import { it, expect, vi } from "vitest";
import { singleResearch } from "../apps/api/src/kabumaru-research-cache";
import { Service } from "../apps/api/src/service";
import type { ResearchResult } from "../packages/core/kabumaru-research-schema";

it("同一研究を一度だけ実行し、失敗後は再実行でき、返却を分離する", async () => {
  const service = new Service("unused","demo",false);
  let resolve!: (v: ResearchResult) => void;
  const build = vi.fn(() => new Promise<ResearchResult>(r => {resolve=r;}));
  const a=singleResearch(service,"same",build), b=singleResearch(service,"same",build);
  resolve({ warnings:[] } as unknown as ResearchResult);
  const results = await Promise.all([a,b]); expect(build).toHaveBeenCalledTimes(1);
  results[0].warnings.push("mutated"); expect(results[1].warnings).toEqual([]);
  await expect(singleResearch(service,"error",async()=>{throw Error("fixture");})).rejects.toThrow("fixture");
  expect(await singleResearch(service,"error",async()=>results[1])).toEqual(results[1]);
});
