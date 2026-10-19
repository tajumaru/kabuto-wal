import { it,expect,vi } from "vitest";
import { mkdtemp,rm,unlink,writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Service } from "../apps/api/src/service";
import { scoutFixture } from "../fixtures/bottom-scout";
import { scoutChat } from "../apps/api/src/bottom-scout-chat";
import { readScoutForecast,forecastBase } from "../apps/api/src/bottom-scout-forecast";
import { readScoutReport } from "../apps/api/src/bottom-scout";
import { scoutOutcome,currentScoutSeries } from "../apps/api/src/bottom-scout-journal";
import { demoBars } from "../fixtures/demo";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";
import { summarizeAccuracy,accuracyMetrics } from "../packages/core/scout-accuracy";
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
it("評価待ち・不能を分母から除外し、TOP3/5/10と同一ペアの市場超過を集計する",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"forecast-score-")),s=new Service(root,"demo",false),network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("forbidden"));vi.stubEnv("SCOUT_BENCHMARK_CODE","99990");
  try{
    const f=await scoutFixture(s,6);await scoutChat(s,"底打ち候補を10銘柄",undefined,f.now);
    const seed=await s.history(f.master[0].providerCode);
    await s.store.write("prices/99990/fixture.json",seed.map((b,i)=>({...b,providerCode:"99990",seriesId:"benchmark",revisionId:`benchmark-${i}`,adjClose:b.sessionDate>f.asOf?84:b.adjClose,adjLow:b.sessionDate>f.asOf?83:b.adjLow})));
    for(const [i,m] of f.master.entries()){
      const bars=await s.history(m.providerCode);
      if(i===1)await s.store.write(`prices/${m.providerCode}/fixture.json`,bars.map(b=>b.sessionDate>f.asOf?{...b,adjClose:80,adjLow:79,revisionId:`fall-${b.sessionDate}`}:b));
      if(i===2)await s.store.write(`prices/${m.providerCode}/fixture.json`,bars.filter(b=>b.sessionDate!==f.dates[324]));
    }
    const pending=await scoutAccuracy(s,{},f.now);expect(pending.groups.every(g=>g.evaluated===0&&g.pending===6&&g.hitRate===null)).toBe(true);expect(pending.predictions.every(p=>p.reflection?.outcomes.every(r=>r.similarSuccesses.length===0&&r.text.includes("評価待ち")))).toBe(true);
    const now=new Date(`${f.dates[345]}T12:00:00.000Z`),a=await scoutAccuracy(s,{},now),g=a.groups.find(g=>g.horizon===5)!;
    expect(g).toMatchObject({total:6,evaluated:5,pending:0,unavailable:1,hits:4,misses:1,benchmarkPairs:5,outperformanceRate:.8});expect(g.hitRate).toBe(.8);
    expect(a.top.find(g=>g.horizon===5&&g.top===3)?.hitRate).toBe(.5);
    expect(a.top.find(g=>g.horizon===5&&g.top===5)?.hitRate).toBe(.75);
    expect(a.top.find(g=>g.horizon===5&&g.top===10)?.evaluated).toBe(5);
    expect(g.meanExcessReturn).toBeCloseTo(g.pairedPredictionMean!);expect(g.benchmarkMean).toBe(0);
    expect(a.predictions[0].referencePrice).toBe(84);expect(a.conditions.some(c=>c.failures>0)).toBe(true);
    expect(a.predictions[1].reflection?.outcomes.every(r=>r.text.includes("不的中")&&r.similarSuccesses.length>0)).toBe(true);
    for(const p of a.predictions)for(const reflection of p.reflection!.outcomes){expect(reflection.evidenceIds).toContain(p.forecastId);for(const link of reflection.similarSuccesses)expect(a.predictions.some(p=>p.forecastId===link.forecastId&&p.evidence.code===link.code&&p.results.some(r=>r.horizon===reflection.horizon&&r.status==="evaluated"&&r.actualReturn!>0))).toBe(true);}
    const duplicates=[structuredClone(a.predictions[0]),structuredClone(a.predictions[0])];duplicates[1].forecastId="f".repeat(64);duplicates[1].predictedAt="2025-11-17T00:00:00.000Z";
    expect(summarizeAccuracy(duplicates).groups[0].evaluated).toBe(1);expect(duplicates[1].included).toBe(false);
    const mixed=structuredClone([a.predictions[0],a.predictions[3]]);mixed[1].results.forEach(r=>r.benchmarkCode="88880");expect(accuracyMetrics(mixed,5).meanExcessReturn).toBeNull();
    const count=(await s.store.files("research/scout/evaluations")).length;
    await scoutAccuracy(s,{},new Date(`${f.dates[346]}T12:00:00.000Z`));expect((await s.store.files("research/scout/evaluations")).length).toBe(count);
    expect((await scoutAccuracy(s,{recordingMode:"research"},now)).totalReports).toBe(0);
    await s.store.write("prices/99990/fixture.json",[]);
    expect((await scoutAccuracy(s,{},now)).groups.every(g=>g.benchmarkPairs===0&&g.meanExcessReturn===null)).toBe(true);
    await s.store.write("market/calendar.json",f.dates.map(date=>({date,open:date!==f.dates[320]})));
    expect((await scoutAccuracy(s,{},now)).groups.every(g=>g.evaluated===0&&g.unavailable===6&&g.hitRate===null)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  }finally{network.mockRestore();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
it("保存系列の同順位矛盾を隠さず、過去の分析へ予測証拠を後付けしない",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"forecast-legacy-")),s=new Service(root,"demo",false);
 try{
   const f=await scoutFixture(s,2);await scoutChat(s,"底打ち候補を探して",undefined,f.now);
   const files=await s.store.files(forecastBase("demo","live"));await unlink(path.join(root,files[0]));
   await scoutChat(s,"底打ち候補を探して",undefined,f.now);expect(await s.store.files(forecastBase("demo","live"))).toHaveLength(0);
   const bars=await s.history(f.master[0].providerCode),b=bars[324];await s.store.write(`prices/${b.providerCode}/duplicate.json`,[{...b,revisionId:"contradiction",adjClose:b.adjClose!+1}]);
   await expect(currentScoutSeries(s,b.providerCode,new Date(`${f.dates[345]}T12:00:00Z`))).rejects.toThrow("矛盾");
   const atDecision=bars[319];await s.store.write(`prices/${b.providerCode}/duplicate.json`,[{...atDecision,revisionId:"decision-conflict",adjClose:atDecision.adjClose!+1}]);
   const result=await scoutChat(s,"底打ち候補を探して",undefined,f.now);
   expect(result.scout.rows.every(r=>r.code!==b.providerCode)).toBe(true);expect(result.scout.scope?.analyzable).toBe(1);
   await s.store.write(`prices/${b.providerCode}/fixture.json`,[...bars].reverse());
   await expect(currentScoutSeries(s,b.providerCode,new Date(`${f.dates[345]}T12:00:00Z`))).rejects.toThrow("矛盾");
 }finally{await rm(root,{recursive:true,force:true});}
});
it("評価IDだけを書き換えた破損原本も成功として再利用しない",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"forecast-corrupt-")),s=new Service(root,"demo",false);
 try{
   const f=await scoutFixture(s,1);await scoutChat(s,"底打ち候補を探して",undefined,f.now);const now=new Date(`${f.dates[345]}T12:00:00Z`);
   await scoutAccuracy(s,{},now);const file=(await s.store.files("research/scout/evaluations"))[0],row=await s.store.read(file);
   await writeFile(path.join(root,file),JSON.stringify({...row,evaluationId:"0".repeat(64)}));
   await expect(scoutAccuracy(s,{},now)).rejects.toThrow("hash");
 }finally{await rm(root,{recursive:true,force:true});}
});
it("答え合わせは固定上位10候補だけの系列を読み、通常評価の非候補を含む範囲は変えない",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"forecast-bounded-")),s=new Service(root,"demo",false);vi.stubEnv("SCOUT_BENCHMARK_CODE","");
 try{
   const f=await scoutFixture(s,20);await scoutChat(s,"底打ち候補を探して",undefined,f.now);
   const history=vi.spyOn(s,"history"),a=await scoutAccuracy(s,{},new Date(`${f.dates[345]}T12:00:00Z`));
   expect(a.predictions).toHaveLength(10);expect(new Set(history.mock.calls.map(c=>c[0])).size).toBe(10);expect(a.groups.every(g=>g.total===10)).toBe(true);history.mockRestore();
 }finally{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
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
