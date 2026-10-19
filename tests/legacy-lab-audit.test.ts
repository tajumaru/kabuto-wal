import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { auditLegacyLabPlans } from "../scripts/audit-legacy-lab-plans";
it("旧形式と参照を読み取りだけで調査し、存在しない保存先を0件と扱わない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-audit-")), id="a".repeat(64), runId="b".repeat(64);
  try {
    const put=async(file:string,row:unknown)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),JSON.stringify(row));};
    const file=`research/lab/plans/${id}/original.json`;
    await put(file,{planId:id,createdAt:"2025-01-01T00:00:00Z"});
    await put(`research/lab/runs/${runId}/checkpoint.json`,{planId:id,runId});
    await put("memories/memory.json",{runId});
    const before=await readFile(path.join(root,file),"utf8"),report=await auditLegacyLabPlans(root);
    expect(report.legacy).toEqual([{planId:id,createdAt:"2025-01-01T00:00:00Z"}]);
    expect(report.references).toHaveLength(2);
    expect(await readFile(path.join(root,file),"utf8")).toBe(before);
    expect((await auditLegacyLabPlans(path.join(root,"missing"))).status).toBe("unconfirmed");
  } finally {await rm(root,{recursive:true,force:true});}
});
