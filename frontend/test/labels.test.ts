import { describe, it, expect } from "vitest";
import {
  FAILURE_GUIDANCE,
  failureGuidance,
  RUNTIME_LABEL,
  SCHEME_LABEL,
  SLEEP_MODE_LABEL,
  errorFallbackMessage,
} from "../src/lib/labels.js";
import type { FailureCategory } from "../src/lib/types.js";

describe("failureCategory → 한국어 안내 매핑 (apphub-conventions §4)", () => {
  const cats: FailureCategory[] = [
    "DOCKERFILE_MISSING",
    "DOCKERFILE_INVALID",
    "BUILD_FAILED",
    "HEALTHCHECK_FAILED",
    "SOURCE_UNAVAILABLE",
    "DEPLOY_FAILED",
    "INTERNAL_ERROR",
  ];

  it("7개 failureCategory 전부 안내 문구가 있다", () => {
    for (const c of cats) {
      expect(FAILURE_GUIDANCE[c]).toBeTruthy();
      expect(FAILURE_GUIDANCE[c].length).toBeGreaterThan(5);
    }
  });

  it("Dockerfile 관련 실패는 'Kiro에게 …요청' 행동 지침을 담는다", () => {
    expect(failureGuidance("DOCKERFILE_MISSING")).toContain("Kiro에게");
    expect(failureGuidance("DOCKERFILE_INVALID")).toContain("Kiro에게");
    expect(failureGuidance("BUILD_FAILED")).toContain("Kiro에게");
    expect(failureGuidance("HEALTHCHECK_FAILED")).toContain("/health");
  });

  it("SOURCE_UNAVAILABLE은 저장소 연결 확인을 안내한다", () => {
    expect(failureGuidance("SOURCE_UNAVAILABLE")).toContain("저장소 연결");
  });

  it("category 미지정 시 안전한 기본 안내를 반환한다", () => {
    expect(failureGuidance(undefined)).toContain("관리자");
  });
});

describe("runtimeState 3값 한국어 라벨", () => {
  it("실행 중 / 깨우는 중 / 잠자는 중", () => {
    expect(RUNTIME_LABEL.RUNNING).toBe("실행 중");
    expect(RUNTIME_LABEL.WAKING).toBe("깨우는 중");
    expect(RUNTIME_LABEL.SLEEPING).toBe("잠자는 중");
  });
});

describe("용어 사전 준수 라벨", () => {
  it("scheme은 AWS 용어(internet-facing/internal) 대신 사용자 문구", () => {
    expect(SCHEME_LABEL["internet-facing"]).toBe("회사 밖에서도 접속");
    expect(SCHEME_LABEL.internal).toBe("사내에서만");
  });
  it("sleepMode 옵션은 항상 켜두기/쓸 때만 켜기(권장)/시간표대로", () => {
    expect(SLEEP_MODE_LABEL["always-on"]).toContain("항상");
    expect(SLEEP_MODE_LABEL["on-demand"]).toContain("권장");
    expect(SLEEP_MODE_LABEL.schedule).toContain("시간표");
  });
});

describe("에러 코드 폴백 안내", () => {
  it("주요 계약 에러 코드에 한국어 폴백이 있다", () => {
    expect(errorFallbackMessage("QUOTA_EXCEEDED")).toContain("앱 개수");
    expect(errorFallbackMessage("SUBDOMAIN_TAKEN")).toContain("주소");
    expect(errorFallbackMessage("CONNECTION_NOT_READY")).toContain("저장소 연결");
    expect(errorFallbackMessage("UNKNOWN_CODE")).toBeTruthy();
  });
});
