import { it, expect } from "vitest";
import { searchStocks } from "../apps/web/src/stock-search";
const stocks = [
  { providerCode: "72030", displayCode: "72030", name: "架空 自動車" },
  { providerCode: "130A0", displayCode: "130A0", name: "架空技術" },
  { providerCode: "72031", displayCode: "72031", name: "別種類株" },
];
it("4桁・5桁・英数字・全角コードをマスターから解決する", () => {
  for (const query of ["7203", "72030", "７２０３"])
    expect(searchStocks(stocks, query)[0].providerCode).toBe("72030");
  for (const query of ["130a", "１３０Ａ", "130A0"])
    expect(searchStocks(stocks, query)[0].providerCode).toBe("130A0");
  expect(searchStocks(stocks, "72031")[0].providerCode).toBe("72031");
  expect(searchStocks(stocks, "9999")).toEqual([]);
});
it("銘柄名・空白を正規化して検索する", () => {
  expect(searchStocks(stocks, "架空自動車")[0].providerCode).toBe("72030");
  expect(searchStocks(stocks, "技術")[0].providerCode).toBe("130A0");
});
