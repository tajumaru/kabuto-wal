import { it,expect } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { scoutFixture } from "../fixtures/bottom-scout";
import { scoutChat } from "../apps/api/src/bottom-scout-chat";
import { readScoutForecast,forecastBase } from "../apps/api/src/bottom-scout-forecast";
import { readScoutReport } from "../apps/api/src/bottom-scout";
import { scoutOutcome } from "../apps/api/src/bottom-scout-journal";
import { demoBars } from "../fixtures/demo";
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
it("市場営業日・期限・決定的revision・ドローダウン・再下落を同じ評価経路で扱う",()=>{
  const calendar=Array.from({length:50},(_,i)=>{const d=new Date(Date.UTC(2026,0,5+i)),date=d.toISOString().slice(0,10);return {date,open:![0,6].includes(d.getUTCDay())&&date!=="2026-01-12"};}),dates=calendar.filter(d=>d.open).map(d=>d.date);
  const bars=dates.map((date,i)=>{const close=i===0?100:i===1?110:i===2?90:105;return {...demoBars("72030")[0],sessionDate:date,adjClose:close,adjLow:close-1,availableAt:`${date}T09:00:00.000Z`,revisionId:`test-${i}`,seriesId:"one-series"};});
  const now=new Date("2026-03-01T00:00:00Z"),result=scoutOutcome(bars,dates[0],5,calendar,now);
  expect(result.status).toBe("evaluated");expect(result.target).toBe("2026-01-13");expect(result.actualReturn).toBeCloseTo(.05);expect(result.maxRise).toBeCloseTo(.1);expect(result.maxDrawdown).toBeCloseTo(90/110-1);expect(result.relapse).toBe(true);
  const corrected={...bars[5],adjClose:106,availableAt:"2026-01-14T00:00:00Z",revisionId:"latest"},future={...corrected,adjClose:999,availableAt:"2026-04-01T00:00:00Z",revisionId:"future"};
  const path=[...bars,corrected,future];expect(scoutOutcome(path,dates[0],5,calendar,now)).toEqual(scoutOutcome([...path].reverse(),dates[0],5,calendar,now));expect(scoutOutcome(path,dates[0],5,calendar,now).targetPrice).toBe(106);
  expect(scoutOutcome([...path,{...corrected,adjClose:107}],dates[0],5,calendar,now).status).toBe("unavailable");
  expect(scoutOutcome(bars.filter((_,i)=>i!==2),dates[0],5,calendar,now).status).toBe("unavailable");
  expect(scoutOutcome(bars.map((b,i)=>i===5?{...b,seriesId:"other"}:b),dates[0],5,calendar,now).status).toBe("unavailable");
  expect(scoutOutcome(bars,dates[0],5,calendar,new Date("2026-01-13T08:00:00Z")).status).toBe("pending");
  expect(scoutOutcome(bars.map(b=>({...b,adjClose:b.adjClose!/2,adjLow:b.adjLow!/2})),dates[0],5,calendar,now).actualReturn).toBeCloseTo(result.actualReturn!);
});
