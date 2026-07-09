/**
 * AppHub SPA 루트 — 라우팅 + 인증 게이팅 + 그룹 기반(admin/user) 화면 분기.
 * 이모지 금지, 모든 아이콘 Lucide. 라이트/다크 토글은 ThemeToggle이 담당.
 *
 * 경로:
 *   #/login, #/, #/apps/new, #/apps/:id, #/apps/:id/deployments/:depId,
 *   #/connections, #/kiro-setup, #/admin(?tab=)
 */
import { AuthProvider, useAuth } from "./auth/AuthContext.js";
import { ApiProvider } from "./lib/ApiProvider.js";
import type { RuntimeConfig } from "./lib/config.js";
import { navigate, useRoute } from "./lib/router.js";
import { Skeleton } from "./components/common.js";
import { Login } from "./screens/Login.js";
import { Dashboard } from "./screens/user/Dashboard.js";
import { CreateWizard } from "./screens/user/CreateWizard.js";
import { AppDetail } from "./screens/user/AppDetail.js";
import { DeploymentDetail } from "./screens/user/DeploymentDetail.js";
import { Connections } from "./screens/user/Connections.js";
import { KiroSetup } from "./screens/user/KiroSetup.js";
import { AdminShell } from "./screens/admin/AdminShell.js";

export default function App({ config }: { config: RuntimeConfig }): JSX.Element {
  return (
    <AuthProvider config={config}>
      <AuthedApp config={config} />
    </AuthProvider>
  );
}

function AuthedApp({ config }: { config: RuntimeConfig }): JSX.Element {
  const { session, ready, isAdmin, getToken } = useAuth();

  if (!ready) {
    return (
      <div className="wrap" style={{ paddingTop: 80 }}>
        <Skeleton height={80} count={3} />
      </div>
    );
  }

  if (!session) {
    return <Login />;
  }

  return (
    <ApiProvider config={config} getToken={getToken}>
      <Router isAdmin={isAdmin} />
    </ApiProvider>
  );
}

function Router({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const route = useRoute();
  const seg = route.segments;

  // 관리자 경로 보호 — user 그룹이 /admin 접근 시 대시보드로.
  if (seg[0] === "admin") {
    if (!isAdmin) {
      navigate("/");
      return <Dashboard />;
    }
    return <AdminShell />;
  }

  if (seg[0] === "connections") return <Connections />;

  // Kiro 설정 다운로드 — 로그인한 모든 사용자(user/admin) 공통.
  if (seg[0] === "kiro-setup") return <KiroSetup />;

  if (seg[0] === "apps") {
    if (seg[1] === "new") return <CreateWizard />;
    if (seg[1] && seg[2] === "deployments" && seg[3]) {
      return <DeploymentDetail appId={seg[1]} deploymentId={decodeURIComponent(seg[3])} />;
    }
    if (seg[1]) return <AppDetail appId={seg[1]} />;
  }

  // 기본: 내 앱 대시보드
  return <Dashboard />;
}
