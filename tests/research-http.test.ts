import { EventEmitter } from "node:events";
import { it,expect,vi,afterEach } from "vitest";
import { request } from "node:https";
import { pinnedResearchTransport } from "../apps/api/src/research-network";
vi.mock("node:https",()=>({request:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
function response(status:number,chunks:Buffer[]) {
  const res=Object.assign(new EventEmitter(),{statusCode:status,destroy:vi.fn((e?:Error)=>{if(e)res.emit("error",e);})});
  const req=Object.assign(new EventEmitter(),{end:()=>{queueMicrotask(()=>{const callback=vi.mocked(request).mock.calls.at(-1)![2] as (r:unknown)=>void;callback(res);if(status===200){chunks.forEach(c=>res.emit("data",c));res.emit("end");}});}});
  vi.mocked(request).mockReturnValue(req as unknown as ReturnType<typeof request>);
  return res;
}
it("redirectは追従せず、HTTPエラーを拒否する",async()=>{
  response(302,[]);
  await expect(pinnedResearchTransport(new URL("https://api.example"),{autoSelectFamily:false},"{}")).rejects.toThrow("応答");
  expect(request).toHaveBeenCalledTimes(1);
});
it("応答はストリーム受信中に上限を適用する",async()=>{
  const res=response(200,[Buffer.alloc(150000),Buffer.alloc(50001)]);
  await expect(pinnedResearchTransport(new URL("https://api.example"),{autoSelectFamily:false},"{}")).rejects.toThrow("上限");
  expect(res.destroy).toHaveBeenCalled();
});
