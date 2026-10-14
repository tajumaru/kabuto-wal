import { useState } from "react";
type Theme = "light" | "dark";
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("kabuto-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Storage may be unavailable. */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  return <button className="theme-toggle" type="button" aria-label={theme === "dark" ? "ライトモードに切り替える" : "ナイトモードに切り替える"} aria-pressed={theme === "dark"} onClick={() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem("kabuto-theme", next); } catch { /* Keep working without persistence. */ }
  }}>{theme === "dark" ? "☀ ライトモード" : "☾ ナイトモード"}</button>;
}
