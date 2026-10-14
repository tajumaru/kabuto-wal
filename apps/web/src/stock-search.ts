export type StockOption = {
  providerCode: string;
  displayCode: string;
  name: string;
};
export const normalizeSearch = (text: string) =>
  text.normalize("NFKC").toUpperCase().replace(/\s+/g, "");
export const displayStockCode = (code: string) =>
  /^[0-9A-Z]{4}0$/i.test(code) ? code.slice(0, 4) : code;
export function stockCodes(stock: StockOption) {
  const codes = [stock.providerCode, stock.displayCode];
  if (stock.providerCode.length === 5 && stock.providerCode.endsWith("0"))
    codes.push(stock.providerCode.slice(0, 4));
  return [...new Set(codes)];
}
export function searchStocks(stocks: StockOption[], query: string) {
  const term = normalizeSearch(query);
  return stocks
    .map((stock) => {
      const codes = stockCodes(stock).map(normalizeSearch),
        name = normalizeSearch(stock.name);
      const rank = !term
        ? 3
        : codes.includes(term)
          ? 0
          : codes.some((c) => c.startsWith(term))
            ? 1
            : name.includes(term)
              ? 2
              : 4;
      return { stock, rank };
    })
    .filter((item) => item.rank < 4)
    .sort((a, b) => a.rank - b.rank)
    .map((item) => item.stock);
}
export function stockLabel(stock: StockOption) {
  const code = displayStockCode(stock.displayCode || stock.providerCode);
  return `${code} ${stock.name}`;
}
