import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), wait: vi.fn(), getTransaction: vi.fn(), getObject: vi.fn(),
}));
vi.mock("@mysten/dapp-kit-react", () => ({
  createDAppKit: () => ({ signAndExecuteTransaction: mocks.execute }),
  DAppKitProvider: () => null, useDAppKit: vi.fn(), useCurrentAccount: vi.fn(),
}));
vi.mock("@mysten/dapp-kit-react/ui", () => ({ ConnectButton: () => null }));
vi.mock("@mysten/sui/grpc", () => ({
  SuiGrpcClient: class {
    core = { waitForTransaction: mocks.wait, getTransaction: mocks.getTransaction, getObject: mocks.getObject };
  },
}));
const digest = "fixture-digest";
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  request = vi.fn(async (url: string) => {
    if (url === "/api/wallet-config") return Response.json({ network: "testnet", endpoint: "https://rpc.example" });
    if (url.endsWith("/anchor")) return Response.json({ packageId: "0x1", registryId: "0x2", hash: "ab".repeat(32), generatedAt: 1, targetSessionDate: "2026-10-19" });
    if (url.endsWith("/receipt")) return Response.json({ status: "anchored" });
    throw Error("Unexpected request");
  });
  vi.stubGlobal("fetch", request);
  mocks.execute.mockResolvedValue({ Transaction: { digest } });
  mocks.wait.mockResolvedValue({ Transaction: { digest } });
  mocks.getTransaction.mockResolvedValue({ Transaction: { effects: { changedObjects: [{ objectId: "0x3" }] } } });
  mocks.getObject.mockResolvedValue({ object: { objectId: "0x3", type: "0x1::prediction_commitment::PredictionReceipt" } });
});
afterEach(() => vi.unstubAllGlobals());

it("RPCの確認待ちが完了するまで結果・receiptを読み書きしない", async () => {
  let release!: () => void;
  mocks.wait.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const { anchorPrediction } = await import("../apps/web/src/wallet");
  const pending = anchorPrediction("prediction");
  await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledWith({ digest }));
  expect(mocks.getTransaction).not.toHaveBeenCalled();
  expect(mocks.getObject).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([url]) => url.endsWith("/receipt"))).toBe(false);
  release();
  await expect(pending).resolves.toEqual({ status: "anchored" });
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.getTransaction).toHaveBeenCalledWith({ digest, include: { effects: true } });
  expect(request).toHaveBeenLastCalledWith("/api/predictions/prediction/receipt", expect.objectContaining({ body: JSON.stringify({ receiptId: "0x3", txDigest: digest }) }));
});

it("確認待ち失敗時はdigestを案内し、自動再送やreceipt保存をしない", async () => {
  mocks.wait.mockRejectedValue(Error("timeout"));
  const { anchorPrediction } = await import("../apps/web/src/wallet");
  await expect(anchorPrediction("prediction")).rejects.toThrow("再送せずtxDigestを確認してください：" + digest);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.getTransaction).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([url]) => url.endsWith("/receipt"))).toBe(false);
});

it("ウォレットが失敗を返した取引は確認待ちに進まない", async () => {
  mocks.execute.mockResolvedValue({ FailedTransaction: { status: { error: { message: "Move abort" } } } });
  const { anchorPrediction } = await import("../apps/web/src/wallet");
  await expect(anchorPrediction("prediction")).rejects.toThrow("Move abort");
  expect(mocks.wait).not.toHaveBeenCalled();
});

it("RPCで失敗が確認された場合もreceiptを成功保存しない", async () => {
  mocks.getTransaction.mockResolvedValue({ FailedTransaction: { status: { error: { message: "RPC failure" } } } });
  const { anchorPrediction } = await import("../apps/web/src/wallet");
  await expect(anchorPrediction("prediction")).rejects.toThrow("RPC failure");
  expect(mocks.getObject).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([url]) => url.endsWith("/receipt"))).toBe(false);
});
