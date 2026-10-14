import type { Service } from "./service";
import {
  marketNotices,
  notice,
  type AssistantNotice,
} from "../../../packages/core/assistant";
export async function collectNotices(service: Service) {
  const master = await service.store.read("market/master.json", []),
    watch = await service.store.read("settings/watchlist.json");
  const nameOf = (code: string) =>
    master.find((m: any) => m.providerCode === code)?.name || code;
  const additions: AssistantNotice[] = [];
  for (const code of watch.codes)
    additions.push(
      ...marketNotices(
        code,
        nameOf(code),
        await service.history(code),
        service.mode,
      ),
    );
  const snapshot = await service.store.read("assistant/watch-state.json", null);
  if (snapshot) {
    for (const code of [
      ...new Set<string>([...snapshot.codes, ...watch.codes]),
    ]) {
      const added =
          !snapshot.codes.includes(code) && watch.codes.includes(code),
        removed = snapshot.codes.includes(code) && !watch.codes.includes(code);
      if (!added && !removed) continue;
      const bars = await service.history(code);
      additions.push(
        notice({
          kind: added ? "watch_added" : "watch_removed",
          pose: "discover",
          providerCode: code,
          name: nameOf(code),
          dataAsOf:
            bars.at(-1)?.sessionDate ||
            new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
          observedAt: new Date().toISOString(),
          mode: service.mode,
          source: "local-watchlist",
          title: `${nameOf(code)}を監視${added ? "に追加した" : "から外した"}よ`,
          text: `証券コード${code}。ウォッチリストの変更を記録したよ。${bars.at(-1) ? `株価の基準日は${bars.at(-1)!.sessionDate}。` : "株価は未取得です。"}`,
          metrics: {
            watchCount: watch.codes.length,
            watchRevision: snapshot.revision,
          },
          evidenceIds: [watch.recordId],
          href: added ? `/stocks/${code}` : "/",
        }),
      );
    }
  }
  if (
    !snapshot ||
    JSON.stringify(snapshot.codes) !== JSON.stringify(watch.codes)
  )
    await service.store.write("assistant/watch-state.json", {
      codes: watch.codes,
      revision: Date.now().toString(),
    });
  for (const p of await service.predictions()) {
    const evaluation = p.evaluations.at(-1);
    if (!evaluation) continue;
    additions.push(
      notice({
        kind: "evaluation",
        pose: evaluation.directionMatch ? "happy" : "warning",
        providerCode: p.providerCode,
        name: nameOf(p.providerCode),
        dataAsOf: p.targetSessionDate,
        observedAt: evaluation.createdAt,
        mode: p.mode,
        source: p.source,
        title: `${nameOf(p.providerCode)}の予測を検証したよ`,
        text: `${p.dataAsOf}基準、${p.horizonSessions}営業日先（${p.targetSessionDate}）の実績リターン${(evaluation.actualReturn * 100).toFixed(2)}%、予測${(p.predictedReturn * 100).toFixed(2)}%。3区分方向は${evaluation.directionMatch ? "一致" : "不一致"}。的中や利益を保証するものではないよ。`,
        metrics: {
          actualReturn: evaluation.actualReturn,
          predictedReturn: p.predictedReturn,
          error: evaluation.returnError,
          brier: evaluation.brier,
          horizon: p.horizonSessions,
        },
        evidenceIds: [
          p.predictionId,
          evaluation.recordId,
          ...evaluation.revisionIds,
        ],
        href: "/predictions",
      }),
    );
  }
  for (const n of additions)
    if (!(await service.store.read(`notifications/${n.recordId}.json`, null)))
      await service.store.write(`notifications/${n.recordId}.json`, n, true);
  return {
    mode: service.mode,
    notices: (await service.store.all<AssistantNotice>("notifications"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 40),
    thresholds: { dailyChange: 0.05, volumeRatio: 2, volumeWindow: 20 },
    memoryConfigured: !!process.env.MEMWAL_ACCOUNT_ID,
    note: "取得済み日足とローカル予測・監視履歴による検出。リアルタイム監視ではありません。",
  };
}
export async function recordSimilar(
  service: Service,
  code: string,
  result: any,
  date: string,
  compareCode = code,
) {
  if (!date || !result.examples.length) return;
  const title = `${result.examples.length}件の類似相場を見つけたよ`;
  const text = `基準日${date}、証券コード${code}、比較候補${compareCode}。20営業日窓の数値検索で${result.candidateCount}件を走査し、非重複候補${result.sampleCount}件から上位${result.examples.length}件を選択。最も近い期間は${result.examples[0].start}〜${result.examples[0].end}、距離${result.examples[0].distance.toFixed(3)}。距離は上昇確率ではありません。`;
  const n = notice({
    kind: "similar",
    pose: "discover",
    providerCode: code,
    name: code,
    dataAsOf: date,
    observedAt: new Date().toISOString(),
    mode: service.mode,
    source: "local-numeric",
    title,
    text,
    metrics: {
      candidateCount: result.candidateCount,
      sampleCount: result.sampleCount,
      distance: result.examples[0].distance,
    },
    evidenceIds: result.examples.map((e: any) => e.id),
    href: `/similar?code=${code}`,
  });
  if (await service.store.read(`notifications/${n.recordId}.json`, null))
    return;
  await service.store.write(`notifications/${n.recordId}.json`, n, true);
  await service.addMemory(text, "market_analysis", code);
}
