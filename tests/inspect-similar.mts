import "dotenv/config";
import { Service } from "../apps/api/src/service";
import { searchDejavu } from "../apps/api/src/dejavu";
try {
  const results=await Promise.all([searchDejavu(new Service(),"94320"),searchDejavu(new Service(),"94320")]);
  console.log(JSON.stringify({concurrentSearches:results.length,examples:results.map(r=>r.examples.length)}));
} catch(e){console.log(JSON.stringify({error:e instanceof Error?e.message:"unknown"}));process.exitCode=1;}
