import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { loadConfig } from "./lib/config.js";
import { applyStoredTheme } from "./components/ThemeToggle.js";
import "./styles/tokens.css";
import "./styles/app.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root 엘리먼트를 찾을 수 없습니다.");
}

// 첫 페인트 전 테마 적용(FOUC 방지) + 런타임 설정 주입(config.json → 없으면 목 모드).
applyStoredTheme();

void loadConfig().then((config) => {
  createRoot(rootEl).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
});
