import { it,expect } from "vitest";
import { validateAgentFolds } from "../packages/core/kabumaru-agent-walk-forward";
const fold=(year:number)=>({training:{from:"2018-01-01",to:`${year-1}-12-31`},validation:{from:`${year}-01-01`,to:`${year}-12-31`},test:{from:"2026-01-01",to:"2026-12-31"}});
it("複数foldの時系列・非重複Validation・共通Testを固定する",()=>{expect(()=>validateAgentFolds([fold(2020),fold(2021),fold(2022)])).not.toThrow();expect(()=>validateAgentFolds([fold(2021),fold(2020)])).toThrow("独立性");expect(()=>validateAgentFolds([fold(2020),fold(2020)])).toThrow("独立性");expect(()=>validateAgentFolds([fold(2020),{...fold(2021),test:{from:"2025-01-01",to:"2025-12-31"}}])).toThrow("共通");expect(()=>validateAgentFolds([{...fold(2020),training:{from:"2018-01-01",to:"2020-02-01"}}])).toThrow("時系列");});
