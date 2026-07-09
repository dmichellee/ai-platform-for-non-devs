/**
 * 관리자 콘솔 — 탭 6개(전체 현황·플랫폼 설정·컴퓨팅 프리셋·권한 템플릿·사용자·인프라 현황).
 * 관리자 화면은 기술 용어 허용(용어 사전 예외). radius 8(엄격).
 * 탭 전환은 ?tab= 쿼리로 관리(딥링크·QA 편의).
 */
import { LayoutDashboard, LogOut } from "lucide-react";
import { ThemeToggle } from "../../components/ThemeToggle.js";
import { BrandMark } from "../../components/common.js";
import { navigate, useRoute } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { getCachedConfig } from "../../lib/config.js";
import { AdminOverview } from "./AdminOverview.js";
import { AdminSettingsTab } from "./AdminSettings.js";
import { AdminPresets } from "./AdminPresets.js";
import { AdminPermTemplates } from "./AdminPermTemplates.js";
import { AdminUsers } from "./AdminUsers.js";
import { AdminInfra } from "./AdminInfra.js";

const TABS = [
  { key: "overview", label: "전체 현황" },
  { key: "settings", label: "플랫폼 설정" },
  { key: "presets", label: "컴퓨팅 프리셋" },
  { key: "permissions", label: "권한 템플릿" },
  { key: "users", label: "사용자" },
  { key: "infra", label: "인프라 현황" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function AdminShell(): JSX.Element {
  const route = useRoute();
  const { logout } = useAuth();
  const cfg = getCachedConfig();
  const tab = (route.query.get("tab") as TabKey) || "overview";

  const go = (t: TabKey): void => navigate(`/admin?tab=${t}`);

  return (
    <div className="wrap">
      <div className="admin-shell">
        <div className="admin-bar">
          <span className="title">
            <BrandMark size={22} />
            AppHub Admin
          </span>
          <span className="breadcrumb">
            관리 / {TABS.find((t) => t.key === tab)?.label ?? "전체 현황"}
          </span>
          <div className="spacer" />
          <span className="mono">stage: {cfg?.stage ?? "local"}</span>
          <ThemeToggle />
          <button type="button" className="row-act" aria-label="로그아웃" onClick={logout}>
            <LogOut size={16} className="icon" />
          </button>
        </div>

        <div className="admin-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tab ${tab === t.key ? "active" : ""}`}
              onClick={() => go(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="admin-body">
          {tab === "overview" && <AdminOverview />}
          {tab === "settings" && <AdminSettingsTab />}
          {tab === "presets" && <AdminPresets />}
          {tab === "permissions" && <AdminPermTemplates />}
          {tab === "users" && <AdminUsers />}
          {tab === "infra" && <AdminInfra />}
        </div>
      </div>

      <div className="row mt4" style={{ justifyContent: "center", gap: 12 }}>
        <button
          type="button"
          className="topbar-link"
          onClick={() => navigate("/")}
        >
          <span className="row" style={{ gap: 6 }}>
            <LayoutDashboard size={15} className="icon" />
            사용자 화면으로
          </span>
        </button>
      </div>
    </div>
  );
}
