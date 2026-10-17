import { it,expect } from "vitest";
import { temporalPartition } from "../apps/api/src/hunter-experiment-temporal";
import { labPlanInputSchema } from "../packages/core/hunter-experiment-schema";
import type { CohortManifest } from "../packages/core/hunter-cohort-schema";
const p=labPlanInputSchema.parse({cohortIds:["a".repeat(64),"b".repeat(64),"c".repeat(64)],training:{from:"2020-01-01",to:"2020-03-31"},validation:{from:"2020-04-01",to:"2020-06-30"},test:{from:"2020-07-01",to:"2020-09-30"},embargoSessions:2});
const calendar=Array.from({length:270},(_,i)=>({date:new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10),open:true}));
const cohort=(asOf:string,target:string,cutoff=`${asOf}T14:59:59.999Z`)=>({asOf,cutoff,targets:{"20":target}} as CohortManifest);
it("時系列分離・purge・embargo・後日取得の特徴量を検証する",()=>{expect(temporalPartition(cohort("2020-02-01","2020-02-21"),p,calendar).partition).toBe("training");expect(temporalPartition(cohort("2020-03-20","2020-04-10"),p,calendar).partition).toBe("purged");expect(temporalPartition(cohort("2020-04-01","2020-04-21"),p,calendar).reason).toBe("embargo");expect(temporalPartition(cohort("2020-04-04","2020-04-24"),p,calendar).partition).toBe("validation");expect(temporalPartition(cohort("2020-07-04","2020-07-24","2020-07-05T00:00:00.000Z"),p,calendar).reason).toBe("features-not-known-at-decision");expect(temporalPartition(cohort("2020-09-20","2020-10-10"),p,calendar).partition).toBe("purged");});
it("重複・逆順期間や任意のプロパティを拒否する",()=>{expect(labPlanInputSchema.safeParse({...p,test:p.training}).success).toBe(false);expect(labPlanInputSchema.safeParse({...p,execute:"shell"}).success).toBe(false);});
