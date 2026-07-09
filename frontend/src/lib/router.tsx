/**
 * 경량 해시 라우터 — 외부 의존성 없이 #/경로 를 다룬다. 테스트에서 window.location.hash 로 제어 가능.
 * 경로 목록(최종 QA 참고):
 *   #/login
 *   #/                      (내 앱 대시보드)
 *   #/apps/new              (앱 생성 마법사)
 *   #/apps/:appId           (앱 상세)
 *   #/apps/:appId/deployments/:deploymentId  (배포 상세)
 *   #/connections           (레포 연결 관리)
 *   #/admin                 (관리자 — 탭 내부 전환: ?tab=)
 */
import { useCallback, useEffect, useState } from "react";

export interface Route {
  path: string; // "/apps/a1b2c3d4"
  segments: string[]; // ["apps","a1b2c3d4"]
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart || "/";
  const segments = path.split("/").filter(Boolean);
  return { path, segments, query: new URLSearchParams(queryPart ?? "") };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function navigate(to: string): void {
  const target = to.startsWith("#") ? to : `#${to}`;
  if (window.location.hash === target) {
    // 동일 경로 재이동 시에도 리스너가 반응하도록 강제 이벤트
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

export function useNavigate(): (to: string) => void {
  return useCallback((to: string) => navigate(to), []);
}
