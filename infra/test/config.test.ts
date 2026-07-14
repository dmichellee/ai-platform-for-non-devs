import { describe, it, expect } from "vitest";
import {
  assertNoOpenCidr,
  loadConfig,
  parseStage,
  resourcePrefix,
  type ConfigInputs,
} from "../lib/config";

/**
 * L2 성격 단위 테스트 — config 로더.
 *  (1) SG ingress CIDR 검증(D17): 플랫폼 소유 SG에 전 개방 대역이 흘러들지 못하도록 로더 단 차단.
 *  (2) 환경 리터럴 주입(하드코딩 제거): domain/account/region/hostedZoneId를 inputs로 받고,
 *      누락 시 친절한 에러로 synth를 멈춤을 고정.
 */

/** 완전한 테스트 입력(필수값 모두 채움). */
const FULL: ConfigInputs = {
  appsDomain: "apps-dev.example.test",
  hostedZoneId: "Z0TEST0HOSTEDZONE0ID",
  account: "111122223333",
  region: "ap-northeast-2",
};

describe("config 로더 — D17 CIDR 검증", () => {
  it("allowedIngressCidrs에 0.0.0.0/0가 있으면 throw", () => {
    expect(() =>
      loadConfig("dev", { ...FULL, allowedIngressCidrs: ["0.0.0.0/0"] }),
    ).toThrow(/D17/);
  });

  it("allowedIngressCidrs에 ::/0가 있으면 throw", () => {
    expect(() =>
      loadConfig("prod", { ...FULL, allowedIngressCidrs: ["::/0"] }),
    ).toThrow(/D17/);
  });

  it("전 개방 대역이 대역 한정 CIDR 사이에 섞여 있어도 throw", () => {
    expect(() =>
      assertNoOpenCidr(["10.0.0.0/16", "0.0.0.0/0", "192.168.0.0/16"]),
    ).toThrow(/D17/);
  });

  it("대역 한정 CIDR만 있으면 통과", () => {
    expect(() => assertNoOpenCidr(["10.0.0.0/16", "172.16.0.0/12"])).not.toThrow();
    const cfg = loadConfig("dev", { ...FULL, allowedIngressCidrs: ["10.0.0.0/16"] });
    expect(cfg.allowedIngressCidrs).toEqual(["10.0.0.0/16"]);
  });

  it("빈 CIDR 목록(미지정)은 통과하고 기본값이 빈 배열", () => {
    const cfg = loadConfig("dev", FULL);
    expect(cfg.allowedIngressCidrs).toEqual([]);
  });
});

describe("config 로더 — 환경 리터럴 주입(하드코딩 제거)", () => {
  it("주입된 domain/account/region/hostedZoneId를 그대로 반영한다", () => {
    const cfg = loadConfig("prod", {
      appsDomain: "apps.acme.example",
      hostedZoneId: "ZACME123",
      account: "999988887777",
      region: "us-east-1",
    });
    expect(cfg.appsDomain).toBe("apps.acme.example");
    expect(cfg.hostedZoneId).toBe("ZACME123");
    expect(cfg.account).toBe("999988887777");
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.stage).toBe("prod");
  });

  it("stage별 도메인은 자동 규칙이 아니라 주입값을 따른다(명시 지정)", () => {
    // dev/prod가 같은 apex를 주입받아도 로더는 강제 규칙 없이 주어진 값을 쓴다.
    const dev = loadConfig("dev", { ...FULL, appsDomain: "apps-dev.example.test" });
    const prod = loadConfig("prod", { ...FULL, appsDomain: "apps.example.test" });
    expect(dev.appsDomain).toBe("apps-dev.example.test");
    expect(prod.appsDomain).toBe("apps.example.test");
  });

  it("appsDomain 누락 시 친절한 에러(--domain 안내)로 throw", () => {
    expect(() =>
      loadConfig("dev", { ...FULL, appsDomain: undefined }),
    ).toThrow(/--domain/);
  });

  it("account 누락 시 CDK_DEFAULT_ACCOUNT 안내로 throw", () => {
    expect(() =>
      loadConfig("dev", { ...FULL, account: undefined }),
    ).toThrow(/CDK_DEFAULT_ACCOUNT/);
  });

  it("region 누락 시 --region/CDK_DEFAULT_REGION 안내로 throw", () => {
    expect(() =>
      loadConfig("dev", { ...FULL, region: undefined }),
    ).toThrow(/CDK_DEFAULT_REGION|--region/);
  });

  it("hostedZoneId 누락 시 --hosted-zone-id 자동 조회 안내로 throw", () => {
    expect(() =>
      loadConfig("dev", { ...FULL, hostedZoneId: undefined }),
    ).toThrow(/hosted-zone-id/);
  });

  it("빈 문자열/공백도 누락으로 취급한다", () => {
    expect(() => loadConfig("dev", { ...FULL, appsDomain: "  " })).toThrow(/--domain/);
    expect(() => loadConfig("dev", { ...FULL, account: "" })).toThrow(/CDK_DEFAULT_ACCOUNT/);
  });
});

describe("config 로더 — 공통 규약", () => {
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
