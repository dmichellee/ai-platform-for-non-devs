/**
 * 공통 소품 — 상단 바, 모달, 스켈레톤, 빈 상태, 토글 스위치, 에러 배너.
 * 이모지 금지 → 전부 Lucide.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Info,
  LayoutGrid,
  LogOut,
  Plug,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { ThemeToggle } from "./ThemeToggle.js";
import { useNavigate, useRoute } from "../lib/router.js";
import { useAuth } from "../auth/AuthContext.js";
import type { ApiError } from "../lib/api.js";
import { errorFallbackMessage } from "../lib/labels.js";

export function BrandMark({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <span
      className="mark"
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: size / 3.3 }}
    >
      <LayoutGrid size={Math.round(size * 0.56)} strokeWidth={2} />
    </span>
  );
}

/** 사용자 화면 상단 바 (로고 · 메뉴 · 앱 개수 · 테마 · 로그아웃) */
export function TopBar({
  userInitial,
  appCount,
  quota,
  onLogout,
}: {
  userInitial: string;
  appCount?: number | undefined;
  quota?: number | undefined;
  onLogout: () => void;
}): JSX.Element {
  const nav = useNavigate();
  const route = useRoute();
  const { isAdmin } = useAuth();
  const isDash = route.path === "/" || route.segments[0] === "apps";
  const isConn = route.segments[0] === "connections";
  const isKiro = route.segments[0] === "kiro-setup";
  return (
    <div className="app-topbar">
      <button
        type="button"
        className="logo"
        onClick={() => nav("/")}
        style={{ background: "transparent", border: 0 }}
      >
        <BrandMark />
        AppHub
      </button>
      <div className="spacer" />
      <button
        type="button"
        className={`topbar-link ${isDash ? "active" : ""}`}
        onClick={() => nav("/")}
      >
        내 앱
      </button>
      <button
        type="button"
        className={`topbar-link ${isConn ? "active" : ""}`}
        onClick={() => nav("/connections")}
      >
        <span className="row" style={{ gap: 6 }}>
          <Plug size={15} strokeWidth={2} className="icon" />
          저장소 연결
        </span>
      </button>
      <button
        type="button"
        className={`topbar-link ${isKiro ? "active" : ""}`}
        onClick={() => nav("/kiro-setup")}
      >
        <span className="row" style={{ gap: 6 }}>
          <Settings2 size={15} strokeWidth={2} className="icon" />
          Kiro 설정
        </span>
      </button>
      {isAdmin && (
        <button
          type="button"
          className="topbar-link admin"
          onClick={() => nav("/admin")}
          title="관리자 페이지"
        >
          <span className="row" style={{ gap: 6 }}>
            <ShieldCheck size={15} strokeWidth={2} className="icon" />
            관리자
          </span>
        </button>
      )}
      {appCount !== undefined && quota !== undefined && (
        <span className="chip">
          내 앱 {appCount} / {quota}
        </span>
      )}
      <ThemeToggle />
      <button
        type="button"
        className="row-act"
        aria-label="로그아웃"
        title="로그아웃"
        onClick={onLogout}
        style={{ padding: 6 }}
      >
        <LogOut size={18} strokeWidth={2} className="icon" />
      </button>
      <span className="avatar" aria-hidden="true">
        {userInitial}
      </span>
    </div>
  );
}

/**
 * "← 내 앱으로" 등 상단 뒤로가기 링크.
 * 텍스트 링크 + 원형 아이콘 pill 로, 톤앤매너(부드러운 radius·hover)에 맞춘 secondary 스타일.
 * 라이트/다크 모두 시맨틱 토큰만 사용.
 */
export function BackLink({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="back-link" onClick={onClick}>
      <span className="back-link-ico" aria-hidden="true">
        <ChevronLeft size={16} strokeWidth={2.2} className="icon" />
      </span>
      {label}
    </button>
  );
}

export function Modal({
  title,
  children,
  onClose,
  sharp = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  sharp?: boolean;
}): JSX.Element {
  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className={`modal ${sharp ? "sharp" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button type="button" className="row-act" aria-label="닫기" onClick={onClose}>
            <X size={18} className="icon" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Skeleton({ height = 120, count = 1 }: { height?: number; count?: number }): JSX.Element {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 16, color: "var(--on-surface)" }}>{title}</div>
      {desc && <p style={{ marginTop: 6 }}>{desc}</p>}
      {action && <div className="mt4">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ error }: { error: ApiError }): JSX.Element {
  // 계약: message는 그대로 노출 가능. 비어 있으면 code 기반 폴백.
  const msg = error.message || errorFallbackMessage(error.code);
  return (
    <div className="notice error" role="alert">
      <AlertTriangle size={18} className="icon" />
      <div>{msg}</div>
    </div>
  );
}

export function InfoNotice({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="notice info">
      <Info size={18} className="icon" />
      <div>{children}</div>
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled = false,
  describedBy,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  /** 비활성 사유 등 보조 설명 요소 id (aria-describedby). */
  describedBy?: string | undefined;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      aria-describedby={describedBy}
      className={`switch ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  );
}

/**
 * 저장 성공 피드백 — 관리자 탭에서 "저장했어요" 배너를 몇 초 보여주고 자동으로 사라지게 한다.
 * show()를 호출하면 visible=true 로 두고 duration(기본 3초) 후 스스로 false 로 돌린다.
 * 컴포넌트 언마운트 시 타이머를 정리한다.
 */
export function useSaveFeedback(durationMs = 3000): {
  visible: boolean;
  show: () => void;
} {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(true);
    timerRef.current = setTimeout(() => setVisible(false), durationMs);
  }, [durationMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { visible, show };
}

/** "저장했어요" 성공 배너 — Lucide Check + 초록(성공) 토큰. 이모지 금지. */
export function SaveBanner({
  visible,
  label = "저장했어요",
}: {
  visible: boolean;
  label?: string;
}): JSX.Element | null {
  if (!visible) return null;
  return (
    <span className="save-banner" role="status" aria-live="polite">
      <Check size={15} className="icon" />
      {label}
    </span>
  );
}

/** 상대 시간 (KO). */
export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}
