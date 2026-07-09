/**
 * 라이트/다크 토글 — data-theme 속성 + localStorage + prefers-color-scheme.
 * 다크가 기본. 이모지 금지 → Lucide 아이콘.
 */
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "apphub-theme";
type Theme = "light" | "dark";

function resolveInitial(): Theme {
  try {
    const saved = localStorage.getItem(KEY) as Theme | null;
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* noop */
  }
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark"; // 기본
}

export function applyStoredTheme(): void {
  document.documentElement.setAttribute("data-theme", resolveInitial());
}

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    return attr === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* noop */
    }
  }, [theme]);

  return (
    <div className="toggle" role="group" aria-label="테마 전환">
      <button
        type="button"
        className={theme === "light" ? "active" : ""}
        aria-pressed={theme === "light"}
        aria-label="라이트 모드"
        onClick={() => setTheme("light")}
      >
        <Sun className="icon" size={15} strokeWidth={2} />
        라이트
      </button>
      <button
        type="button"
        className={theme === "dark" ? "active" : ""}
        aria-pressed={theme === "dark"}
        aria-label="다크 모드"
        onClick={() => setTheme("dark")}
      >
        <Moon className="icon" size={15} strokeWidth={2} />
        다크
      </button>
    </div>
  );
}
