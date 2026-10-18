import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { agentEventSchema } from "../../../packages/core/kabumaru-agent-events";
export function AgentExecutionTimeline({
  id,
  running,
  request,
}: {
  id: string;
  running: boolean;
  request: (url: string, body?: unknown) => Promise<unknown>;
}) {
  const [page, setPage] = useState(1),
    query = useQuery({
      queryKey: ["agent-timeline", id, page],
      queryFn: async () =>
        z
          .object({ records: z.array(agentEventSchema), total: z.number() })
          .parse(
            await request(
              `/research/agent/sessions/${id}/timeline?page=${page}`,
            ),
          ),
      refetchInterval: running ? 2000 : false,
    });
  return (
    <section className="card">
      <h2>実行タイムライン</h2>
      {query.isLoading && <p role="status">監査履歴を読み込み中…</p>}
      {query.error && (
        <p role="alert">履歴を確認できません。{query.error.message}</p>
      )}
      <ol className="agent-timeline" tabIndex={0} aria-label="研究の実行履歴">
        {query.data?.records.map((e) => (
          <li key={e.eventId}>
            <p>
              {e.createdAt} · {e.stepId ?? e.status ?? e.kind}
            </p>
            <p>{e.reason}</p>
            {e.kind === "step-completed" && (
              <p>結果：{String(e.details.resultStatus ?? "")}</p>
            )}
          </li>
        ))}
      </ol>
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
        前の履歴
      </button>
      <span>{page}ページ</span>
      <button
        disabled={page * 20 >= (query.data?.total ?? 0)}
        onClick={() => setPage(page + 1)}
      >
        次の履歴
      </button>
    </section>
  );
}
