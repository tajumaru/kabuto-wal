import { useId, useState } from "react";
import { searchStocks, stockLabel, type StockOption } from "./stock-search";
export function StockPicker({
  stocks,
  value,
  onChange,
  loading = false,
}: {
  stocks: StockOption[];
  value: string;
  onChange: (code: string) => void;
  loading?: boolean;
}) {
  const listId = useId(),
    [draft, setDraft] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const selected = stocks.find((s) => s.providerCode === value),
    query = draft ?? (selected ? stockLabel(selected) : ""),
    matches = searchStocks(stocks, draft ?? ""),
    visible = matches.slice(0, 10);
  const choose = (stock: StockOption) => {
    onChange(stock.providerCode);
    setDraft(null);
    setOpen(false);
    setActive(0);
  };
  return (
    <div className="stock-picker">
      <label htmlFor={listId + "-input"}>証券コード・銘柄名で検索</label>
      <input
        id={listId + "-input"}
        role="combobox"
        aria-label="銘柄"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && visible[active] ? listId + "-" + active : undefined
        }
        autoComplete="off"
        placeholder="例：7203 / 130A / 銘柄名"
        value={query}
        disabled={loading}
        onFocus={() => {
          setOpen(true);
          setDraft("");
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          if (value) setDraft(null);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange("");
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, visible.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && open && visible[active]) {
            e.preventDefault();
            choose(visible[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="stock-picker-results">
          <ul id={listId} role="listbox" aria-label="銘柄の検索候補">
            {visible.map((stock, i) => (
              <li key={stock.providerCode} role="presentation">
                <button
                  id={listId + "-" + i}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(stock)}
                >
                  {stockLabel(stock)}
                </button>
              </li>
            ))}
          </ul>
          <p role="status">
            {loading
              ? "銘柄一覧を読み込み中…"
              : matches.length === 0
                ? "該当する銘柄がありません。コードや銘柄名を確認してください。"
                : matches.length > 10
                  ? `${matches.length}件中10件を表示。入力を追加して絞り込めます。`
                  : `${matches.length}件。候補をクリック、またはEnterで選択。`}
          </p>
        </div>
      )}
      {!open && (
        <small>
          {selected
            ? `選択中：${stockLabel(selected)}`
            : loading
              ? "銘柄一覧を読み込み中…"
              : "証券コードや銘柄名を入力して候補を選んでください。"}
        </small>
      )}
    </div>
  );
}
