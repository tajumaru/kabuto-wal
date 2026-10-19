/** Bounded fanout shared by scout accuracy only. Preserve input order and await
 * every task in the batch before propagating failures (no stray writes). */
export async function scoutAccuracyBatch<T,R>(values:readonly T[],fn:(value:T)=>Promise<R>):Promise<R[]>{
 const out:R[]=[];
 for(let i=0;i<values.length;i+=16){
  const results=await Promise.allSettled(values.slice(i,i+16).map(fn));
  const failure=results.find(r=>r.status==="rejected");
  if(failure?.status==="rejected")throw failure.reason;
  for(const result of results)if(result.status==="fulfilled")out.push(result.value);
 }
 return out;
}
