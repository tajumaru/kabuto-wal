import { it, expect, vi } from "vitest";
import { publicResearchAddress, researchTarget, researchPost, researchSpecial4,researchSpecial6,type ResearchTransport } from "../apps/api/src/research-network";
import { ConfiguredResearchLlm } from "../apps/api/src/kabumaru-llm";
it("IANA特殊用途CIDRと境界をNode標準分類で検査する",()=>{
  for(const [network] of [...researchSpecial4,...researchSpecial6])expect(publicResearchAddress(network),network).toBe(false);
  for(const ip of ["192.31.196.255","192.52.193.1","192.175.48.1","2001:1ff:ffff::1","2620:4f:8000:ffff::1","3fff:fff:ffff::1","fe80::1%eth0","::ffff:8.8.8.8"])expect(publicResearchAddress(ip),ip).toBe(false);
  for(const ip of ["172.32.0.1","100.128.0.1","192.0.3.1","192.31.197.1","198.20.0.1","2001:200::1","2001:4860::8888","2606:4700::1111"])expect(publicResearchAddress(ip),ip).toBe(true);
});

it("allowlistは完全一致で、IP・localhost・特殊アドレスを拒否する", () => {
  for (const host of ["localhost","127.0.0.1","[::1]","10.0.0.1","169.254.169.254","other.example","api.example.evil"]) {
    expect(() => researchTarget(`https://${host}/`, ["api.example","localhost","127.0.0.1"])).toThrow();
  }
  for (const ip of ["::1","::ffff:127.0.0.1","fc00::1","fe80::1","10.0.0.1","172.16.1.1","192.168.1.1","169.254.169.254","100.64.0.1","0.0.0.0","2001:db8::1","2002:7f00:1::"]) expect(publicResearchAddress(ip)).toBe(false);
  expect(publicResearchAddress("8.8.8.8")).toBe(true);
  expect(publicResearchAddress("2606:4700::1111")).toBe(true);
});
it("DNS混在を拒否し、検証したIPだけにlookupを固定する", async () => {
  const url = researchTarget("https://api.example/v1", ["api.example"]);
  const transport = vi.fn<ResearchTransport>().mockResolvedValue("{}");
  await expect(researchPost(url,"","{}", async () => [{address:"127.0.0.1",family:4}],transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  const resolver = vi.fn().mockResolvedValueOnce([{address:"8.8.8.8",family:4}]).mockResolvedValue([{address:"127.0.0.1",family:4}]);
  transport.mockImplementation(async (_url, options) => {
    expect(options.agent).toBe(false); expect(options.servername).toBe("api.example");
    const callback = vi.fn();
    (options.lookup as (host: string, options: object, callback: (...args: unknown[]) => void) => void)("api.example",{},callback);
    expect(callback).toHaveBeenCalledWith(null,"8.8.8.8",4);
    return "{}";
  });
  await researchPost(url,"","{}",resolver,transport);
  expect(resolver).toHaveBeenCalledTimes(1);
  await expect(researchPost(url,"","{}",resolver,transport)).rejects.toThrow();
});
it("DNS時間・同時通信数を制限し、不正JSONと過大応答を拒否する", async () => {
  const url = researchTarget("https://api.example/",["api.example"]);
  const resolver = async () => [{address:"8.8.8.8",family:4}];
  const pending = () => new Promise<string>(() => {});
  const a = researchPost(url,"","",resolver,pending,20), b = researchPost(url,"","",resolver,pending,20);
  await expect(researchPost(url,"","",resolver,pending,20)).rejects.toThrow("同時");
  await expect(a).rejects.toThrow("時間"); await expect(b).rejects.toThrow("時間");
  await expect(researchPost(url,"","",() => new Promise(() => {}),pending,5)).rejects.toThrow("時間");
  vi.stubEnv("RESEARCH_LLM_ALLOWED_HOSTS","api.example");
  try {
    await expect(new ConfiguredResearchLlm(url.href,"",resolver,async () => "bad").generateExplanation([],"summary")).rejects.toThrow();
    await expect(new ConfiguredResearchLlm(url.href,"",resolver,async () => "x".repeat(200001)).generateExplanation([],"summary")).rejects.toThrow("上限");
  } finally { vi.unstubAllEnvs(); }
});
