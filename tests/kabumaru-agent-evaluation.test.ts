import { it,expect } from "vitest";
import { classifyAgentOutcome } from "../packages/core/kabumaru-agent-report-schema";
it("標本不足・不振・期間逆転・一貫した観測を誇張せず4分類する",()=>{expect(classifyAgentOutcome(false,.1,.1,true,.1)).toBe("insufficient-data");expect(classifyAgentOutcome(true,-.01,-.03,false,null)).toBe("not-supported");expect(classifyAgentOutcome(true,.1,.02,false,null)).toBe("insufficient-data");expect(classifyAgentOutcome(true,.1,-.01,true,.1)).toBe("mixed");expect(classifyAgentOutcome(true,.1,.02,true,-.1)).toBe("mixed");expect(classifyAgentOutcome(true,.1,.02,true,.01)).toBe("supported");});
