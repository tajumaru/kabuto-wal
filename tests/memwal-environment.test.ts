import { afterEach, expect, it, vi } from "vitest";
import { memwalBinding, memwalEnvironment } from "../packages/integrations/memwal-config";
import { verifyDeletedMemory } from "../apps/api/src/memory-delete";

afterEach(() => vi.unstubAllEnvs());
it("Mainnet既定値を共有し、Testnet・staging混在を拒否する", () => {
  for (const name of ["MEMWAL_NETWORK", "MEMWAL_SERVER_URL", "MEMWAL_SUI_ENDPOINT"]) vi.stubEnv(name, "");
  expect(memwalEnvironment()).toMatchObject({ network: "mainnet", serverUrl: "https://relayer.memory.walrus.xyz" });
  vi.stubEnv("MEMWAL_SERVER_URL", "https://relayer-staging.memory.walrus.xyz");
  expect(memwalEnvironment).toThrow("Mainnet");
  vi.stubEnv("MEMWAL_SERVER_URL", ""); vi.stubEnv("MEMWAL_SUI_ENDPOINT", "https://fullnode.testnet.sui.io");
  expect(memwalEnvironment).toThrow("Mainnet");
});
it("アカウント変更を検出し、鍵はbindingに含めない", () => {
  vi.stubEnv("MEMWAL_NETWORK", "mainnet");
  const before = memwalBinding();
  vi.stubEnv("MEMWAL_DELEGATE_KEY", "secret-rotation");
  expect(memwalBinding()).toBe(before);
  vi.stubEnv("MEMWAL_ACCOUNT_ID", "0x999");
  expect(memwalBinding()).not.toBe(before);
});
it("元の名前空間で再検索し、対象blob残存・照合不能を成功扱いしない", async () => {
  const recall = vi.fn().mockResolvedValue({ results: [{ blob_id: "target", text: "x", distance: 0 }] });
  const provider = { recall, remember: vi.fn(), waitForRememberJob: vi.fn() };
  const memory = { text: "unique query", namespace: "stock-memory:v1:profile" };
  await expect(verifyDeletedMemory(provider, memory, "target")).rejects.toThrow("検索に残っている");
  recall.mockResolvedValue({ results: [{ text: "x", distance: 0 }] });
  await expect(verifyDeletedMemory(provider, memory, "target")).rejects.toThrow("照合できません");
  recall.mockResolvedValue({ results: [{ blob_id: "other", text: "x", distance: 0 }] });
  await expect(verifyDeletedMemory(provider, memory, "target")).resolves.toMatchObject({ state: "absent" });
  expect(recall).toHaveBeenLastCalledWith({ query: "unique query", namespace: "stock-memory:v1:profile", limit: 50 });
});
