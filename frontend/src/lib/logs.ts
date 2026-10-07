/**
 * 로그 화면 공통 유틸(QA M6) — 앱 실행 로그·배포 단계 로그 공용.
 * 계약: 두 API 모두 events 는 시간 내림차순(최신이 [0]), nextToken 은 더 오래된 페이지(뒤에 이어 붙임).
 */
import type { LogEvent } from "./types.js";

export function logKey(e: LogEvent): string {
  return `${e.timestamp}|${e.message}`;
}

/** 줄 끝 개행 제거 — 서버 메시지가 "\n" 으로 끝나 pre-wrap 에서 빈 줄이 생기지 않게. */
export function logText(e: LogEvent): string {
  return e.message.replace(/\s+$/, "");
}

/**
 * 첫 페이지(자동 새로고침으로 갱신)와 이어 받은 과거 페이지를 합쳐 최신순으로.
 * 페이지 경계·새로고침 겹침에서 같은 줄이 두 번 보이지 않도록 중복 제거한다.
 */
export function mergeNewestFirst(...pages: LogEvent[][]): LogEvent[] {
  const seen = new Set<string>();
  const out: LogEvent[] = [];
  for (const page of pages) {
    for (const e of page) {
      const k = logKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  // 서버 순서를 따르되, 합친 결과도 최신이 위가 되도록 안정 정렬.
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 앱 실행 로그 자동 새로고침 주기(QA F2). 매 갱신은 마지막으로 받은 최신 줄 이후만 받는 증분 조회라
 * 서버의 로그 검색 호출이 1회로 끝난다. 서버가 "요청이 많음"(429)을 주면 다음 갱신을 늦춘다.
 */
export const LOG_POLL_MS = 10_000;
export const LOG_POLL_BACKOFF_MS = 30_000;

/** 429(RATE_LIMITED) 판정 — 코드 이름이 계약에서 바뀌어도 HTTP 상태로 판정되도록 둘 다 본다. */
export function isRateLimited(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { httpStatus?: unknown; code?: unknown };
  return err.httpStatus === 429 || err.code === "RATE_LIMITED";
}
