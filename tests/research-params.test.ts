import { expect, it } from "vitest";
import { readResearchParams } from "../apps/web/src/research-params";

it("URLを唯一の状態として読み、実在しない日付やコードを拒否する", () => {
  expect(readResearchParams(new URLSearchParams("code=72030&asOf=2026-10-09"))).toMatchObject({ code: "72030", date: "2026-10-09", invalid: false });
  expect(readResearchParams(new URLSearchParams("code=../bad&asOf=2026-02-30"))).toMatchObject({ code: "", date: "", invalid: true });
  expect(readResearchParams(new URLSearchParams("asOf=2024-02-29"))).toMatchObject({ date: "2024-02-29", invalid: false });
});
