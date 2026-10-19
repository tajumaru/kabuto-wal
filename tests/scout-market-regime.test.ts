import { it,expect } from "vitest";
import { demoBars } from "../fixtures/demo";
import { scoutMarketRegime } from "../apps/api/src/scout-market-regime";
it("市場環境は予測時点で既知の同一系列だけで分類し、未来・欠損・矛盾は使用しない",()=>{
 const bars=Array.from({length:80},(_,i)=>{const date=new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10);return {...demoBars("99990")[0],providerCode:"99990",sessionDate:date,availableAt:`${date}T09:00:00.000Z`,adjClose:100+i,revisionId:`r${i}`,seriesId:"market"};});
 const calendar=bars.map(b=>({date:b.sessionDate,open:true})),asOf=bars[74].sessionDate,cutoff=`${asOf}T10:00:00.000Z`;
 const classify=(rows=bars)=>scoutMarketRegime(rows,calendar,asOf,cutoff,"99990");
 expect(classify().regime).toBe("up");expect(classify([...bars].reverse())).toEqual(classify());
 const future={...bars[74],revisionId:"future",adjClose:1,availableAt:"2026-01-01T00:00:00Z"};
 expect(classify([...bars,future])).toEqual(classify());
 expect(classify(bars.map((b,i)=>({...b,adjClose:200-i}))).regime).toBe("down");
 expect(classify(bars.map(b=>({...b,adjClose:100}))).regime).toBe("flat");
 expect(classify(bars.filter((_,i)=>i!==5)).regime).toBe("unknown");
 expect(classify([...bars,{...bars[74],adjClose:1}]).regime).toBe("unknown");
 expect(scoutMarketRegime(bars,calendar,asOf,cutoff,null).regime).toBe("unknown");
 expect(classify().regimeEvidence.revisionIds).toHaveLength(75);
 expect(classify().regimeEvidence.revisionIds).not.toContain("future");
});
