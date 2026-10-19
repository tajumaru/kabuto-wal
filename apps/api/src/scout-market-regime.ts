import type { Bar,Calendar } from "../../../packages/core/index";
import { cohortPricePath } from "./hunter-cohort-evaluation";
import { hash } from "../../../packages/integrations/adjusted-series";

/** A saved, explicitly designated market index only; a stock is not a market regime. */
export function scoutMarketRegime(bars:Bar[],calendar:Calendar,asOf:string,cutoff:string,benchmarkCode:string|null){
 const evidence={methodVersion:"market-regime-v1" as const,benchmarkCode,cutoff,inputHash:null as string|null,revisionIds:[] as string[],reason:"市場指標の保存済み75営業日系列が不足しています"};
 const dates=calendar.filter(d=>d.open&&d.date<=asOf).sort((a,b)=>a.date.localeCompare(b.date)).slice(-75);
 if(!benchmarkCode||dates.length!==75||dates.at(-1)?.date!==asOf)return {regime:"unknown" as const,regimeEvidence:evidence};
 const path=cohortPricePath(bars,dates[0].date,asOf,calendar,cutoff);
 if(!path||path.length!==75||path.some(b=>b.providerCode!==benchmarkCode))return {regime:"unknown" as const,regimeEvidence:evidence};
 const prices=path.map(b=>b.adjClose!),sma75=prices.reduce((a,b)=>a+b,0)/75,sma25=prices.slice(-25).reduce((a,b)=>a+b,0)/25,last=prices.at(-1)!;
 const regime=last>sma75*1.02&&sma25>sma75?"up":last<sma75*.98&&sma25<sma75?"down":"flat";
 return {regime,regimeEvidence:{...evidence,inputHash:hash(path),revisionIds:path.map(b=>b.revisionId),reason:"予測時点の取得締切以前の市場指標のみ。75日平均±2%と25日平均で分類（後付けの派生診断、予測原本は不変）"}};
}
