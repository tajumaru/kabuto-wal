import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  labMethodSchema,
  labPeriodSchema,
} from "../../../packages/core/hunter-experiment-schema";
const list = <T extends z.ZodType>(schema: T) =>
  z.object({ records: z.array(schema), total: z.number() });
const planSchema = z.object({
  planId: z.string(),
  validation: labPeriodSchema,
  test: labPeriodSchema,
});
const split = (s: string) => s.split(/[\s,]+/).filter(Boolean);
function toggle(raw: string, id: string) {
  const ids = new Set(split(raw));
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return [...ids].join("\n");
}
export function AgentSavedInputs({
  request,
  folds,
  methods,
  onFolds,
  onMethods,
}: {
  request: (url: string) => Promise<unknown>;
  folds: string;
  methods: string;
  onFolds: (v: string) => void;
  onMethods: (v: string) => void;
}) {
  const [page, setPage] = useState(1),
    plans = useQuery({
      queryKey: ["agent-saved-plans", page],
      queryFn: async () =>
        list(planSchema).parse(
          await request(`/research/lab/plans?page=${page}&pageSize=20`),
        ),
    }),
    ways = useQuery({
      queryKey: ["agent-saved-methods", page],
      queryFn: async () =>
        list(labMethodSchema).parse(
          await request(`/research/lab/methods?page=${page}&pageSize=20`),
        ),
    });
  return (
    <div className="agent-saved-inputs">
      <h3>保存済みの設定から選ぶ</h3>
      <p>
        期間計画 {split(folds).length}/5件、判定ルール {split(methods).length}
        /5件を選択中。計画の順序・共通Test・使用可能なデータは提案時に確認します。
      </p>
      {plans.isPending || ways.isPending ? (
        <p role="status">保存済みの設定を読み込み中…</p>
      ) : null}
      {plans.error || ways.error ? (
        <p role="alert">
          保存済みの設定を読み込めません。
          <button
            onClick={() => {
              void plans.refetch();
              void ways.refetch();
            }}
          >
            設定を再読込
          </button>
        </p>
      ) : null}
      <fieldset className="agent-mode">
        <legend>比較する期間計画を2〜5件選択</legend>
        {plans.data?.total === 0 && (
          <p>期間計画がありません。AI研究所で先に保存してください。</p>
        )}
        {plans.data?.records.map((p) => (
          <label key={p.planId}>
            <input
              type="checkbox"
              checked={split(folds).includes(p.planId)}
              disabled={
                !split(folds).includes(p.planId) && split(folds).length >= 5
              }
              onChange={() => onFolds(toggle(folds, p.planId))}
            />
            <span>
              検証 {p.validation.from}〜{p.validation.to}
              <small>
                最終Test {p.test.from}〜{p.test.to} ／ {p.planId.slice(0, 8)}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="agent-mode">
        <legend>比較する判定ルールを1〜5件選択</legend>
        {ways.data?.total === 0 && (
          <p>判定ルールがありません。AI研究所で先に保存してください。</p>
        )}
        {ways.data?.records.map((m) => (
          <label key={m.experimentId}>
            <input
              type="checkbox"
              checked={split(methods).includes(m.experimentId)}
              disabled={
                !split(methods).includes(m.experimentId) &&
                split(methods).length >= 5
              }
              onChange={() => onMethods(toggle(methods, m.experimentId))}
            />
            <span>
              {m.name}
              <small>
                {m.hypothesis} ／ {m.experimentId.slice(0, 8)}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
        前の設定
      </button>
      <span>{page}ページ</span>
      <button
        disabled={
          page * 20 >= Math.max(plans.data?.total ?? 0, ways.data?.total ?? 0)
        }
        onClick={() => setPage(page + 1)}
      >
        次の設定
      </button>
    </div>
  );
}
