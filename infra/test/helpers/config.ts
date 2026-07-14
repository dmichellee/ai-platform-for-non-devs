/**
 * 테스트용 config 로더 헬퍼.
 *
 * loadConfig는 이제 환경 리터럴(domain/account/region/hostedZoneId)을 하드코딩하지 않고
 * 주입받는다(설치 시 deploy.sh가 -c / CDK_DEFAULT_* 로 넘김). L2 테스트는 실제 배포가
 * 아니므로 여기서 결정적인 기본 테스트값을 주입해 스택을 synth 한다.
 *
 * 값 자체는 임의(테스트 전용)지만, 기존 배포 회귀 확인(템플릿 동등성 diff)은 별도로
 * `cdk synth -c domain=... -c hostedZoneId=...` + CDK_DEFAULT_ACCOUNT 로 실제 값을 넣어
 * 수행한다(이 헬퍼와 무관).
 */
import { loadConfig, type ConfigInputs, type Stage, type StageConfig } from "../../lib/config";

/** 테스트 기본 환경값 — 실제 계정/도메인과 무관한 결정적 더미. */
export const TEST_ACCOUNT = "111122223333";
export const TEST_REGION = "ap-northeast-2";
export const TEST_HOSTED_ZONE_ID = "Z0TEST0HOSTEDZONE0ID";

/** stage에 맞춘 테스트 도메인(prod=apps., dev=apps-dev.). */
export function testAppsDomain(stage: Stage): string {
  return stage === "prod" ? "apps.example.test" : "apps-dev.example.test";
}

/**
 * 테스트용 StageConfig를 만든다. loadConfig에 기본 테스트 입력을 주입하고,
 * overrides(allowedIngressCidrs 등)를 얹는다.
 */
export function testConfig(stage: Stage, overrides?: Partial<ConfigInputs>): StageConfig {
  return loadConfig(stage, {
    appsDomain: testAppsDomain(stage),
    hostedZoneId: TEST_HOSTED_ZONE_ID,
    account: TEST_ACCOUNT,
    region: TEST_REGION,
    ...overrides,
  });
}

/** 테스트 스택에 넘길 env(account/region). */
export function testEnv(config: StageConfig): { account: string; region: string } {
  return { account: config.account, region: config.region };
}
