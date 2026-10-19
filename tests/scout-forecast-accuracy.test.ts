import { it,expect } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { scoutFixture } from "../fixtures/bottom-scout";
import { scoutChat } from "../apps/api/src/bottom-scout-chat";
import { readScoutForecast,forecastBase } from "../apps/api/src/bottom-scout-forecast";
import { readScoutReport } from "../apps/api/src/bottom-scout";
it("予測時点の順位・価格・根拠hash・営業日期限を固定し、未来の改訂で原本を変更しない",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"forecast-fixed-")),s=new Service(root,"demo",false);
  try{
    const f=await scoutFixture(s,2),event=await scoutChat(s,"底打ち候補を探して",undefined,f.now),files=await s.store.files(forecastBase("demo","live"));
    expect(files).toHaveLength(1);
    const {forecast:p,report}=await readScoutForecast(s,files[0]),before=JSON.stringify(p),original=JSON.stringify(report);
    expect(p.rows.map(r=>r.rank)).toEqual([1,2]);expect(p.rows[0].referencePrice).toBe(84);
    expect(p.targets).toEqual({"5":f.dates[324],"10":f.dates[329],"20":f.dates[339]});
    expect(report.rows.every(r=>r.inputRevisionIds.every(id=>Number(id.split("-").at(-1))<=319))).toBe(true);
    for(const m of f.master){const bars=await s.history(m.providerCode);await s.store.write(`prices/${m.providerCode}/fixture.json`,bars.map(b=>b.sessionDate>f.asOf?{...b,adjClose:9999,revisionId:"future-correction",availableAt:"2026-01-01T00:00:00.000Z"}:b));}
    expect((await scoutChat(s,"底打ち候補を探して",undefined,f.now)).scout.reportId).toBe(event.scout.reportId);
    expect(JSON.stringify((await readScoutForecast(s,files[0])).forecast)).toBe(before);
    expect(JSON.stringify(await readScoutReport(s,report.reportId))).toBe(original);
    expect(await s.store.files(forecastBase("demo","live"))).toHaveLength(1);
  }finally{await rm(root,{recursive:true,force:true});}
});
