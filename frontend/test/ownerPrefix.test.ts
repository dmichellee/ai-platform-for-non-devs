import { describe, it, expect } from "vitest";
import { computeOwnerPrefix } from "../src/auth/tokens.js";
import type { UserSession } from "../src/auth/tokens.js";

/**
 * 저장소 이름 소유자 접두어 규칙 — 서버(POST /connections/{connId}/repos)가 base 앞에
 * `{ownerPrefix}-` 를 부착하는 규칙을 프론트가 동일하게 구현한다(미리보기·목 일관성).
 * 규칙: email 로컬파트 소문자화 → [a-z0-9._-] 외 `-` 치환 → 앞뒤 구분자 제거,
 *       email 없거나 결과가 비면 sub 앞 8자 폴백.
 */
function sess(partial: Partial<UserSession>): UserSession {
  return {
    sub: "",
    email: "",
    groups: ["user"],
    idToken: "x",
    expiresAt: Date.now() + 3600_000,
    ...partial,
  };
}

describe("computeOwnerPrefix", () => {
  it("email 로컬파트를 소문자화해 접두어로 쓴다", () => {
    expect(computeOwnerPrefix(sess({ email: "DaEun@example.com" }))).toBe("daeun");
  });

  it("허용 외 문자는 하이픈으로 치환한다", () => {
    // '+' 는 허용 집합 밖 → '-' 치환
    expect(computeOwnerPrefix(sess({ email: "jane+tag@example.com" }))).toBe("jane-tag");
  });

  it("허용 문자(., _, -)는 유지하되 앞뒤 구분자는 제거한다", () => {
    expect(computeOwnerPrefix(sess({ email: "_a.b_c-@example.com" }))).toBe("a.b_c");
  });

  it("email 이 없으면 sub 앞 8자로 폴백한다", () => {
    // sub "user-0001" 앞 8자 "user-000" → 양끝 구분자 없음
    expect(computeOwnerPrefix(sess({ email: "", sub: "user-0001" }))).toBe("user-000");
  });

  it("email 로컬파트가 특수문자만이라 비면 sub 로 폴백한다", () => {
    // "@@@" 로컬파트 없음(빈) → sub 폴백
    expect(computeOwnerPrefix(sess({ email: "@example.com", sub: "abcd1234xyz" }))).toBe("abcd1234");
  });

  it("세션이 없으면 빈 문자열을 돌려준다", () => {
    expect(computeOwnerPrefix(null)).toBe("");
  });

  it("email·sub 둘 다 없으면 빈 문자열을 돌려준다", () => {
    expect(computeOwnerPrefix(sess({ email: "", sub: "" }))).toBe("");
  });
});
