import { describe, it, expect } from "vitest";
import {
  assertNoOpenCidr,
  loadConfig,
  parseStage,
  resourcePrefix,
} from "../lib/config";

/**
 * L2 성격 단위 테스트 — config 로더의 SG ingress CIDR 검증(D17).
 * 플랫폼 소유 SG에 전 개방 대역이 흘러들지 못하도록 로더 단에서 차단됨을 고정한다.
 */
describe("config 로더 — D17 CIDR 검증", () => {
  it("allowedIngressCidrs에 0.0.0.0/0가 있으면 throw", () => {
    expect(() => loadConfig("dev", { allowedIngressCidrs: ["0.0.0.0/0"] })).toThrow(
      /D17/,
    );
  });

  it("allowedIngressCidrs에 ::/0가 있으면 throw", () => {
    expect(() => loadConfig("prod", { allowedIngressCidrs: ["::/0"] })).toThrow(
      /D17/,
    );
  });

  it("전 개방 대역이 대역 한정 CIDR 사이에 섞여 있어도 throw", () => {
    expect(() =>
      assertNoOpenCidr(["10.0.0.0/16", "0.0.0.0/0", "192.168.0.0/16"]),
    ).toThrow(/D17/);
  });

  it("대역 한정 CIDR만 있으면 통과", () => {
    expect(() => assertNoOpenCidr(["10.0.0.0/16", "172.16.0.0/12"])).not.toThrow();
    const cfg = loadConfig("dev", { allowedIngressCidrs: ["10.0.0.0/16"] });
    expect(cfg.allowedIngressCidrs).toEqual(["10.0.0.0/16"]);
  });

  it("빈 CIDR 목록(미지정)은 통과하고 기본값이 빈 배열", () => {
    const cfg = loadConfig("dev");
    expect(cfg.allowedIngressCidrs).toEqual([]);
  });
});

describe("config 로더 — stage별 값", () => {
  it("dev는 apps-dev 도메인, prod는 apps 도메인", () => {
    expect(loadConfig("dev").appsDomain).toBe("apps-dev.example.com");
    expect(loadConfig("prod").appsDomain).toBe("apps.example.com");
  });

  it("계정/리전/hostedZoneId는 stage 무관 고정", () => {
    const dev = loadConfig("dev");
    const prod = loadConfig("prod");
    expect(dev.account).toBe(prod.account);
    expect(dev.region).toBe("ap-northeast-2");
    expect(dev.hostedZoneId).toBe(prod.hostedZoneId);
  });

  it("resourcePrefix는 apphub-{stage}", () => {
    expect(resourcePrefix("dev")).toBe("apphub-dev");
    expect(resourcePrefix("prod")).toBe("apphub-prod");
  });

  it("parseStage는 dev|prod만 허용", () => {
    expect(parseStage("dev")).toBe("dev");
    expect(parseStage("prod")).toBe("prod");
    expect(() => parseStage("staging")).toThrow();
    expect(() => parseStage(undefined)).toThrow();
  });
});
