/** Bounded fanout shared by scout accuracy only. Preserve input order and await
 * every task in the batch before propagating failures (no stray writes). */
export async function scoutAccuracyBatch<T,R>(values:readonly T[],fn:(value:T)=>Promise<R>):Promise<R[]>{
 const out:R[]=new Array(values.length),state:{next:number;failure?:{index:number;error:unknown}}={next:0};
 const recordFailure=(index:number,error:unknown)=>{if(!state.failure||index<state.failure.index)state.failure={index,error};};
 // A slow directory tree must not stall every other reader at a batch boundary.
 // Keep 16 workers, preserve result order and drain in-flight work on failure.
 await Promise.all(Array.from({length:Math.min(16,values.length)},async()=>{
  while(!state.failure){
   const i=state.next++;if(i>=values.length)return;
   try{out[i]=await fn(values[i]);}
   catch(error){recordFailure(i,error);return;}
  }
 }));
 if(state.failure)throw state.failure.error;
 return out;
}
