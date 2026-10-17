import { it,expect } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Service } from "../apps/api/src/service";
import { HunterJobs } from "../apps/api/src/hunter-jobs";
import { createCohort } from "../apps/api/src/hunter-cohort";
import { evaluateCohort } from "../apps/api/src/hunter-cohort-evaluation";
import { createNotebook,readNotebook,notebookBase } from "../apps/api/src/kabumaru-notebook";
import { notebookInsights } from "../apps/api/src/kabumaru-notebook-insights";
import { demoBars } from "../fixtures/demo";

it("ノートをコホート・評価原本へ照合し、派生要約の破損と後日の評価から原本を保護する",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"kabumaru-notebook-")),s=new Service(root,"demo",false),asOf="2026-08-10";
  try{
    await s.init();await s.store.write("prices/72030/fixture.json",demoBars("72030"));
    const engine=new HunterJobs(s,()=>new Date(`${asOf}T10:00:00.000Z`)),job=await engine.create({asOf,cutoff:`${asOf}T09:00:00.000Z`});await engine.run(job.id);
    const cohort=await createCohort(s,{jobId:job.id},new Date(`${asOf}T10:00:00.000Z`));
    await evaluateCohort(s,cohort.cohortId,new Date("2026-10-16T00:00:00.000Z"));
    const note=await createNotebook(s,{theme:"false-rebound",cohortIds:[cohort.cohortId],hypothesis:"未検証の仮説"},new Date("2026-10-16T01:00:00.000Z"));
    expect(await readNotebook(s,note.notebookId)).toEqual(note);
    expect(notebookInsights(note).statements.every(s=>s.sampleCount===0||s.evidenceIds.length>0)).toBe(true);
    await s.store.write(`${notebookBase(note.notebookId)}/summary.json`,{corrupt:true});
    expect(notebookInsights(await readNotebook(s,note.notebookId))).toEqual(notebookInsights(note));
    const unknown=await createNotebook(s,{theme:"dejavu-similarity",cohortIds:[cohort.cohortId]});expect(unknown.report.groups).toHaveLength(0);expect(notebookInsights(unknown).statements[0].text).toContain("判断できません");
    await evaluateCohort(s,cohort.cohortId,new Date("2026-10-17T00:00:00.000Z"));expect(await readNotebook(s,note.notebookId)).toEqual(note);
    await s.store.write(`${notebookBase(note.notebookId)}/original.json`,{...note,hypothesis:"改変"});await expect(readNotebook(s,note.notebookId)).rejects.toThrow("識別");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5});}
});
