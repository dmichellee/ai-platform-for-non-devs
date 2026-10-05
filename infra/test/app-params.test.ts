import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { secretParams } from "../lib/constructs/app-params";

/**
 * L2 — app-runtime 컨텍스트 loader의 시크릿 키(D8, deploy.yml 계약).
 *  deploy.yml 은 `-c secretArn=<완전 ARN>` + `-c secretKeysB64=<base64(JSON list[str])>` 를 넘기고,
 *  시크릿이 없으면 둘 다 생략한다. 폐기된 `secretArns`(KEY→ARN 맵) 키는 읽지 않는다.
 */
const ARN = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:apphub/dev/app/testapp0-AbCdEf";
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

describe("secretParams — secretArn / secretKeysB64", () => {
  it("둘 다 생략 → 시크릿 없음", () => {
    expect(secretParams(new App())).toEqual({ secretKeys: [] });
  });

  it("base64 JSON list 를 디코드해 KEY 목록 + ARN 을 돌려준다", () => {
    const app = new App({ context: { secretArn: ARN, secretKeysB64: b64(["API_KEY", "DB_PASSWORD"]) } });
    expect(secretParams(app)).toEqual({ secretArn: ARN, secretKeys: ["API_KEY", "DB_PASSWORD"] });
  });

  it("중복 KEY 는 1회만", () => {
    const app = new App({ context: { secretArn: ARN, secretKeysB64: b64(["A", "A"]) } });
    expect(secretParams(app).secretKeys).toEqual(["A"]);
  });

  it("빈 목록은 시크릿 없음으로 취급(ARN 이 있어도 주입 안 함)", () => {
    const app = new App({ context: { secretArn: ARN, secretKeysB64: b64([]) } });
    expect(secretParams(app)).toEqual({ secretKeys: [] });
  });

  it("KEY 가 있는데 secretArn 이 없으면 계약 위반으로 실패", () => {
    const app = new App({ context: { secretKeysB64: b64(["API_KEY"]) } });
    expect(() => secretParams(app)).toThrow(/secretArn/);
  });

  it("목록이 아니면(맵 등) 실패", () => {
    const app = new App({ context: { secretArn: ARN, secretKeysB64: b64({ API_KEY: ARN }) } });
    expect(() => secretParams(app)).toThrow(/JSON list/);
  });

  it("env 변수명 규약 위반 KEY 는 실패", () => {
    const app = new App({ context: { secretArn: ARN, secretKeysB64: b64(["bad-key"]) } });
    expect(() => secretParams(app)).toThrow(/KEY 형식/);
  });

  it("폐기된 secretArns 컨텍스트는 무시한다", () => {
    const app = new App({ context: { secretArns: b64({ API_KEY: ARN }) } });
    expect(secretParams(app)).toEqual({ secretKeys: [] });
  });
});
