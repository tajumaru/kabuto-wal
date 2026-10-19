import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Read-only inventory. No Service construction, dotenv, SDK, or network access.
export async function auditLegacyLabPlans(root: string) {
  const report = { root: path.resolve(root), status: "confirmed", legacy: [] as { planId: string; createdAt: string | null }[], modern: 0, invalid: 0, references: [] as { file: string; relation: "direct" | "indirect" }[], errors: [] as string[] };
  try { await readdir(root); } catch { return { ...report, status: "unconfirmed", modern: null }; }
  const resolved = await realpath(root);
  async function files(prefix: string): Promise<string[]> {
    const result: string[] = [];
    async function walk(key: string) {
      let entries;
      try { entries = await readdir(path.join(root, key), { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push(key); return; }
      for (const entry of entries) {
        const file = `${key}/${entry.name}`;
        if (entry.isSymbolicLink()) { report.errors.push(file); continue; }
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith(".json")) result.push(file);
      }
    }
    await walk(prefix); return result.sort();
  }
  async function read(file: string): Promise<unknown> {
    const absolute = await realpath(path.join(root, file)), relative = path.relative(resolved, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("outside audit root");
    return JSON.parse(await readFile(absolute, "utf8"));
  }
  const planFiles = (await files("research/lab/plans")).filter(f => /^research\/lab\/plans\/[a-f0-9]{64}\/original.json$/.test(f));
  for (const file of planFiles) {
    try {
      const p = await read(file) as Record<string, unknown>, id = file.split("/").at(-2)!;
      if (!p || p.planId !== id) { report.invalid++; continue; }
      if (!Object.hasOwn(p, "evaluationHashes")) report.legacy.push({ planId: id, createdAt: typeof p.createdAt === "string" ? p.createdAt : null });
      else if (p.evaluationHashes && typeof p.evaluationHashes === "object" && !Array.isArray(p.evaluationHashes)) report.modern++;
      else report.invalid++;
    } catch { report.invalid++; report.errors.push(file); }
  }
  const direct = new Set(report.legacy.map(p => p.planId)), linked = new Set(direct);
  if (direct.size) {
    const candidates: { file: string; text: string; row: unknown }[] = [];
    for (const prefix of ["research", "memories", "sync", "anchors", "predictions"]) for (const file of await files(prefix)) {
      if (planFiles.includes(file)) continue;
      try { const row = await read(file); candidates.push({ file, text: JSON.stringify(row), row }); } catch { report.errors.push(file); }
    }
    const seen = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of candidates) {
        if (seen.has(item.file) || ![...linked].some(id => item.text.includes(id))) continue;
        seen.add(item.file); changed = true;
        report.references.push({ file: item.file, relation: [...direct].some(id => item.text.includes(id)) ? "direct" : "indirect" });
        const visit = (row: unknown) => {
          if (!row || typeof row !== "object") return;
          for (const [key, value] of Object.entries(row)) {
            if (["planId", "runId", "reportId", "sessionId", "recordId", "researchManifestHash"].includes(key) && typeof value === "string" && /^[a-f0-9-]{32,64}$/.test(value)) linked.add(value);
            else if (value && typeof value === "object") visit(value);
          }
        };
        visit(item.row);
      }
    }
  }
  if (report.errors.length) report.status = "partial";
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const root of process.argv.slice(2)) console.log(JSON.stringify(await auditLegacyLabPlans(root)));
}
