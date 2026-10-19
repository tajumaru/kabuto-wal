import path from "node:path";
import os from "node:os";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Service } from "../apps/api/src/service";
import { cachedScoutAccuracy } from "../apps/api/src/scout-accuracy-cache";

/** Test-only child process; accepts only the temporary scale fixture roots. */
export async function scoutAccuracyProcess(root:string,action:string){
 const resolved=path.resolve(root);
 if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith("scout-bench-"))throw Error("not a synthetic fixture");
 const s=new Service(resolved,"demo",false);
 if(action==="manual")await writeFile(s.store.path("probe.json"),'{"n":2}');
 else if(action!=="read")throw Error("unknown fixture action");
 return cachedScoutAccuracy(s,"process-probe",new Date("2025-01-01T00:00:00Z"),view=>view.store.read("probe.json"));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 globalThis.fetch=async()=>{throw Error("fixture forbids network");};
 process.stdout.write(JSON.stringify(await scoutAccuracyProcess(process.argv[2],process.argv[3])));
}
