import { z } from "zod";
import { useSearchParams } from "react-router-dom";

const codeSchema = z.string().regex(/^[A-Z0-9]{4,5}$/);
export function readResearchParams(params: URLSearchParams) {
  const code = codeSchema.safeParse(params.get("code"));
  const date = z.string().date().safeParse(params.get("asOf"));
  const compare = codeSchema.safeParse(params.get("compareCode"));
  return {
    code: code.success ? code.data : "",
    date: date.success ? date.data : "",
    compare: compare.success ? compare.data : "",
    invalid: ["code", "asOf", "compareCode"].some((key) => {
      const value = params.get(key);
      return !!value && !(key === "asOf" ? z.string().date() : codeSchema).safeParse(value).success;
    }),
  };
}
export function useResearchParams() {
  const [params, setParams] = useSearchParams();
  return {
    ...readResearchParams(params),
    update: (key: "code" | "asOf" | "compareCode", value: string) =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      }),
  };
}
