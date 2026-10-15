import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { MemWal } from "@mysten-incubation/memwal";
import { memwalEnvironment } from "../packages/integrations/memwal-config";
import { verifyMemwalAccount } from "../packages/integrations/sui";
import { memoryResetClient } from "../packages/integrations/memwal-reset";

// Read-only diagnostic: no remember, forget, restore, prepare or submit calls.
async function audit() {
  const environment = memwalEnvironment();
  console.log(JSON.stringify({ environment, delegateConfigured: !!process.env.MEMWAL_DELEGATE_KEY }));
  const configResponse = await fetch(new URL("/config", environment.serverUrl), { signal: AbortSignal.timeout(20000) });
  if (!configResponse.ok) throw Error("RELAYER_CONFIG_UNAVAILABLE");
  const config = await configResponse.json();
  if (config.network !== environment.network || config.packageId !== environment.packageId)
    throw Error("RELAYER_ENVIRONMENT_MISMATCH");
  console.log(JSON.stringify({ relayerNetwork: config.network, packageMatches: true, securityDeleteEnabled: config.securityDeleteEnabled }));
  await verifyMemwalAccount();
  await memoryResetClient().identity();
  console.log("Mainnet account owner/active/delegate and signed relayer identity: PASS");
  const sdk = MemWal.create({ key: process.env.MEMWAL_DELEGATE_KEY!, accountId: environment.accountId!, serverUrl: environment.serverUrl, namespace: "kabutowal:v1:profile" });
  try {
    console.log(JSON.stringify({ compatibility: await sdk.compatibility() }));
    const root = process.env.DATA_DIR || "./data/personal";
    const files = await readdir(path.join(root, "sync"));
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const sync = JSON.parse(await readFile(path.join(root, "sync", file), "utf8"));
      if (!sync.blobId || !sync.jobId) continue;
      const memory = JSON.parse(await readFile(path.join(root, "memories", file), "utf8"));
      let namespace = sync.namespace || memory.namespace;
      let jobMatches: boolean | null = null;
      let jobDetails: unknown;
      try {
        const job = await sdk.waitForRememberJob(sync.jobId, { timeoutMs: 10000 });
        namespace = job.namespace;
        jobMatches = job.blob_id === sync.blobId && job.owner === environment.owner && job.namespace === namespace;
        jobDetails = { blobMatches: job.blob_id === sync.blobId, ownerReported: !!job.owner, ownerMatches: job.owner === environment.owner, namespace: job.namespace };
      } catch { /* Old job receipts may have expired. Recall is checked independently. */ }
      let hits;
      try { hits = await sdk.recall({ query: memory.text, namespace, limit: 50 }); }
      catch { console.log(JSON.stringify({ recordId: memory.recordId, jobMatches, jobDetails, recall: "failed" })); process.exitCode = 1; continue; }
      console.log(JSON.stringify({ recordId: memory.recordId, status: sync.status, jobMatches, jobDetails, namespace,
        foundInSearch: hits.results.some((hit) => hit.blob_id === sync.blobId), resultCount: hits.results.length }));
    }
  } finally { sdk.destroy(); }
}

audit().catch(() => { console.error("MemWal read-only audit FAILED (credentials and response bodies suppressed)."); process.exitCode = 1; });
