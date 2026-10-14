import { createHash } from "node:crypto";
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("非有限数");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object")
    return (
      "{" +
      Object.keys(value as object)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  throw Error("JSON値ではありません");
}
// UTF-8 canonical JSON followed by exactly 32 random bytes; no text encoding of salt.
export function commitment(value: unknown, salt: Uint8Array) {
  if (salt.length !== 32) throw Error("saltは32バイト");
  return createHash("sha256")
    .update(canonical(value), "utf8")
    .update(salt)
    .digest("hex");
}
