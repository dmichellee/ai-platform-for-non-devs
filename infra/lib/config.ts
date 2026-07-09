/**
 * Stage별 설정 타입 + 로더.
 *
 * [P] 플랫폼 개발·설치 규칙 (docs/PLATFORM-ENGINEERING.md):
 *  - 계정/리전/도메인/hostedZoneId 등 환경 리터럴은 오직 이 파일에만 둔다. 다른 코드에 하드코딩 금지.
 *  - 모든 스택은 여기서 나온 StageConfig를 주입받아 리소스명을 `apphub-${stage}-*`로 짓는다.
 *
 * SG ingress 규칙 (D17, PLATFORM-ENGINEERING.md 2장):
 *  - 플랫폼 소유 SG의 ingress에 `0.0.0.0/0`·`::/0` 금지. 개방이 필요하면 대역을 한정한다.
 *  - 이 로더는 allowedIngressCidrs에 해당 오픈 대역이 섞여 들어오면 build 이전 단계에서 throw 한다.
 *  - 유일한 예외(internet-facing 공유 ALB SG)는 이 CIDR 목록이 아니라 스택 코드에서 명시적으로 처리한다.
 */

export type Stage = "dev" | "prod";

export interface StageConfig {
  /** dev | prod */
  readonly stage: Stage;
  /** 배포 대상 AWS 계정 */
  readonly account: string;
  /** 배포 리전 */
  readonly region: string;
  /**
   * 사용자 앱이 노출되는 apex 도메인.
   * 와일드카드 인증서(`*.<appsDomain>`)와 앱 서브도메인(`<sub>.<appsDomain>`)의 기준.
   */
  readonly appsDomain: string;
  /** appsDomain을 관장하는 Route53 public hosted zone ID */
  readonly hostedZoneId: string;
  /**
   * 플랫폼 소유 SG(internal ALB 등)에 인바운드를 허용할 대역.
   * 반드시 대역 한정 CIDR. `0.0.0.0/0`·`::/0`는 로더가 거부한다(D17).
   * 미지정 시 스택은 VPC CIDR로 대체한다.
   */
  readonly allowedIngressCidrs: readonly string[];
}

/** 스테이지 무관 고정값. 환경 리터럴의 단일 원본. */
const ACCOUNT = "111122223333";
const REGION = "ap-northeast-2";
const HOSTED_ZONE_ID = "Z0EXAMPLEHOSTEDZONE";
const PROD_APPS_DOMAIN = "apps.example.com";
const DEV_APPS_DOMAIN = "apps-dev.example.com";

/** D17 위반: 전 개방 대역. 플랫폼 소유 SG ingress에 절대 허용하지 않는다. */
const FORBIDDEN_OPEN_CIDRS: readonly string[] = ["0.0.0.0/0", "::/0"];

/**
 * SG ingress로 쓸 CIDR 목록을 검증한다.
 * 전 개방 대역(`0.0.0.0/0`·`::/0`)이 하나라도 있으면 throw (D17, 플랫폼 소유 SG 규칙).
 *
 * @throws {Error} 금지 대역이 포함된 경우
 */
export function assertNoOpenCidr(cidrs: readonly string[]): void {
  const normalized = cidrs.map((c) => c.trim());
  const offenders = normalized.filter((c) => FORBIDDEN_OPEN_CIDRS.includes(c));
  if (offenders.length > 0) {
    throw new Error(
      `[D17] 플랫폼 소유 SG ingress에 전 개방 대역을 사용할 수 없습니다: ${offenders.join(", ")}. ` +
        `대역을 한정하세요(사내 CIDR / VPC CIDR / SG 참조). ` +
        `internet-facing 공유 ALB는 이 목록이 아니라 스택 코드에서 예외 처리합니다.`,
    );
  }
}

/** stage 컨텍스트 문자열을 Stage 유니온으로 좁힌다. */
export function parseStage(raw: string | undefined): Stage {
  if (raw === "dev" || raw === "prod") {
    return raw;
  }
  throw new Error(
    `유효하지 않은 stage: ${JSON.stringify(raw)}. ` +
      `\`cdk synth -c stage=dev|prod\` 형태로 지정하세요.`,
  );
}

/**
 * stage 설정을 로드한다.
 * @param stage 대상 스테이지
 * @param overrides 선택 오버라이드. allowedIngressCidrs 등 설치 시점 주입값.
 * @throws {Error} allowedIngressCidrs에 전 개방 대역이 섞여 있으면 (assertNoOpenCidr).
 */
export function loadConfig(
  stage: Stage,
  overrides?: { readonly allowedIngressCidrs?: readonly string[] },
): StageConfig {
  const allowedIngressCidrs = overrides?.allowedIngressCidrs ?? [];

  // D17 강제: 환경 주입 시점에 전 개방 대역을 차단한다(스택 synth 이전).
  assertNoOpenCidr(allowedIngressCidrs);

  return {
    stage,
    account: ACCOUNT,
    region: REGION,
    appsDomain: stage === "prod" ? PROD_APPS_DOMAIN : DEV_APPS_DOMAIN,
    hostedZoneId: HOSTED_ZONE_ID,
    allowedIngressCidrs,
  };
}

/** 리소스명 접두어. 모든 스택/리소스는 이 접두어로 시작한다. */
export function resourcePrefix(stage: Stage): string {
  return `apphub-${stage}`;
}
