/**
 * Stage별 설정 타입 + 로더.
 *
 * [P] 플랫폼 개발·설치 규칙 (docs/PLATFORM-ENGINEERING.md):
 *  - 계정/리전/도메인/hostedZoneId 등 환경 리터럴은 **하드코딩하지 않는다**. 퍼블릭 애셋이므로
 *    설치자마다 값이 다르다(cdk-authoring "cdk.context.json에 환경 값 커밋 금지"와 동일 취지).
 *  - 이 값들은 최초 배포 시 주입받는다:
 *      · appsDomain   : deploy.sh `--domain`(필수) → `cdk -c domain=...` (CDK context 1순위)
 *      · hostedZoneId : deploy.sh `--hosted-zone-id`(선택, 미지정 시 Route53 자동 조회) → `-c hostedZoneId=...`
 *      · account/region : CDK 표준(`CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION` — aws 자격증명·--region에서 자동)
 *  - loadConfig는 순수 함수다(App 비의존). bin/apphub.ts가 context/env에서 값을 읽어 overrides로 넘긴다.
 *    누락 시 여기서 친절한 한국어 에러를 던져 synth가 명확히 실패한다(하위호환/검증).
 *  - 모든 스택은 여기서 나온 StageConfig를 주입받아 리소스명을 `apphub-${stage}-*`로 짓는다.
 *  - 앱 스택(app-runtime/app-pipeline)은 이 로더를 쓰지 않는다 — domain/hostedZone을 network 스택이
 *    발행한 SSM(`/apphub/{stage}/network/*`)에서 읽으므로 buildspec에 domain 주입이 불필요하다.
 *
 * SG ingress 규칙 (D17, PLATFORM-ENGINEERING.md 2장):
 *  - 플랫폼 소유 SG의 ingress에 `0.0.0.0/0`·`::/0` 금지. 개방이 필요하면 대역을 한정한다.
 *  - 이 로더는 allowedIngressCidrs에 해당 오픈 대역이 섞여 들어오면 build 이전 단계에서 throw 한다.
 *  - 유일한 예외(internet-facing 공유 ALB SG)는 이 CIDR 목록이 아니라 스택 코드에서 명시적으로 처리한다.
 */

export type Stage = "dev" | "prod";

/**
 * 플랫폼 웹 배포 모드(D19, PLATFORM-ENGINEERING 4.1). 기본 public.
 *  - public : CloudFront+S3 + API GW Regional
 *  - private: 콘솔 internal ALB + ECS(nginx) + Private REST API(VPC 엔드포인트)
 */
export type FrontendMode = "public" | "private";

/** frontendMode 컨텍스트 문자열 검증(미지정 → public). 알 수 없는 값은 throw(조용한 오설치 방지). */
export function parseFrontendMode(raw: string | undefined): FrontendMode {
  if (raw === undefined || raw === "" || raw === "public") return "public";
  if (raw === "private") return "private";
  throw new Error(
    `유효하지 않은 frontendMode: ${JSON.stringify(raw)}. ` +
      "`--frontend-mode public|private`(내부적으로 `-c frontendMode=...`)로 지정하세요.",
  );
}

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
  /** 플랫폼 웹 배포 모드(D19). 기본 public. */
  readonly frontendMode: FrontendMode;
  /** 플랫폼 VPC 대역(IPv4, RFC1918, /16~/22). 기본 10.20.0.0/16. 최초 설치 때만 정할 수 있다(변경 = VPC 교체). */
  readonly vpcCidr: string;
}

/** 플랫폼 VPC 기본 대역 — 기존 설치와 동일. */
export const DEFAULT_VPC_CIDR = "10.20.0.0/16";

/**
 * VPC CIDR 검증. 형식(a.b.c.d/n, 네트워크 주소 정렬), RFC1918 사설 대역 안, 프리픽스 /16~/22
 * (서브넷 /24 × public 2 + private 2 와 여유). 미지정이면 기본값.
 * @throws {Error} 형식·대역·크기 위반(친절한 한국어 안내)
 */
export function parseVpcCidr(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (v === "") return DEFAULT_VPC_CIDR;
  const how = "`--vpc-cidr 10.20.0.0/16` 처럼 사설 대역(10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16) 안의 /16~/22 를 지정하세요.";
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(v);
  if (!m) throw new Error(`유효하지 않은 VPC 대역: ${JSON.stringify(v)}. ${how}`);
  const o = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (o.some((x) => x > 255)) throw new Error(`유효하지 않은 VPC 대역: ${v}. ${how}`);
  if (prefix < 16 || prefix > 22) {
    throw new Error(`VPC 대역 크기는 /16~/22 여야 해요(현재 /${prefix}). ${how}`);
  }
  const ip = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((ip & mask) >>> 0 !== ip) {
    throw new Error(`VPC 대역의 네트워크 주소가 맞지 않아요: ${v}(호스트 비트가 0이어야 함). ${how}`);
  }
  const inRange = (base: number[], bits: number): boolean => {
    const b = ((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3];
    const bm = (0xffffffff << (32 - bits)) >>> 0;
    return prefix >= bits && ((ip & bm) >>> 0) === b;
  };
  if (!(inRange([10, 0, 0, 0], 8) || inRange([172, 16, 0, 0], 12) || inRange([192, 168, 0, 0], 16))) {
    throw new Error(`VPC 대역은 사설 대역이어야 해요: ${v}. ${how}`);
  }
  return v;
}

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

/** loadConfig가 받는 설치 시점 주입값. 하드코딩 리터럴을 대체한다. */
export interface ConfigInputs {
  /**
   * 사용자 앱 apex 도메인(필수). deploy.sh `--domain` → `-c domain=...`.
   * 예: prod=`apps.example.com`, dev=`apps-dev.example.com`(스테이지 도메인을 명시 지정).
   */
  readonly appsDomain?: string;
  /**
   * appsDomain을 관장하는 Route53 public hosted zone ID(선택).
   * 미지정 시 deploy.sh가 Route53에서 자동 조회해 `-c hostedZoneId=...`로 주입한다.
   */
  readonly hostedZoneId?: string;
  /** 배포 대상 계정(필수). CDK 표준 `CDK_DEFAULT_ACCOUNT`에서 온다. */
  readonly account?: string;
  /** 배포 리전(필수). CDK 표준 `CDK_DEFAULT_REGION`(또는 --region)에서 온다. */
  readonly region?: string;
  /** 플랫폼 소유 SG ingress 허용 대역. 전 개방 대역은 거부(D17). */
  readonly allowedIngressCidrs?: readonly string[];
  /** 플랫폼 웹 배포 모드(D19). deploy.sh `--frontend-mode` → `-c frontendMode=...`. 미지정 시 public. */
  readonly frontendMode?: FrontendMode;
  /** 플랫폼 VPC 대역. deploy.sh `--vpc-cidr` → `-c vpcCidr=...`. 미지정 시 기본값(parseVpcCidr). */
  readonly vpcCidr?: string;
}

/**
 * 필수 문자열 입력을 검증한다. 누락 시 설치자가 이해할 수 있는 한국어 에러로 synth를 멈춘다.
 */
function requireInput(
  value: string | undefined,
  label: string,
  howToProvide: string,
): string {
  const v = value?.trim();
  if (!v) {
    throw new Error(
      `${label}가 지정되지 않았습니다. ${howToProvide}`,
    );
  }
  return v;
}

/**
 * stage 설정을 로드한다.
 *
 * 환경 리터럴(account/region/domain/hostedZoneId)은 하드코딩하지 않고 `inputs`로 주입받는다.
 * bin/apphub.ts가 CDK context(`-c domain=... -c hostedZoneId=...`)와 CDK 표준 env
 * (`CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`)에서 값을 읽어 이 로더에 넘긴다.
 *
 * @param stage 대상 스테이지
 * @param inputs 설치 시점 주입값(도메인/계정/리전/hostedZoneId/CIDR).
 * @throws {Error} appsDomain/account/region 누락 시(친절한 한국어 안내).
 * @throws {Error} allowedIngressCidrs에 전 개방 대역이 섞여 있으면(assertNoOpenCidr).
 */
export function loadConfig(stage: Stage, inputs?: ConfigInputs): StageConfig {
  const allowedIngressCidrs = inputs?.allowedIngressCidrs ?? [];

  // D17 강제: 환경 주입 시점에 전 개방 대역을 차단한다(스택 synth 이전).
  assertNoOpenCidr(allowedIngressCidrs);

  const appsDomain = requireInput(
    inputs?.appsDomain,
    "앱 도메인(appsDomain)",
    "설치 시 `--domain <apps.example.com>` 인자로 도메인을 지정하세요" +
      "(내부적으로 `cdk -c domain=...`로 전달됩니다).",
  );
  const account = requireInput(
    inputs?.account,
    "배포 대상 계정(account)",
    "AWS 자격 증명을 설정하세요(CDK 표준 CDK_DEFAULT_ACCOUNT). deploy.sh가 자동 주입합니다.",
  );
  const region = requireInput(
    inputs?.region,
    "배포 리전(region)",
    "`--region <region>`을 지정하거나 AWS 기본 리전을 설정하세요(CDK 표준 CDK_DEFAULT_REGION).",
  );
  // hostedZoneId는 선택 — 미지정 시 deploy.sh가 Route53 자동 조회로 채운다.
  //  그럼에도 synth 시점에 값이 있어야 존 참조가 유효하므로, 최종적으로 없으면 안내한다.
  const hostedZoneId = requireInput(
    inputs?.hostedZoneId,
    `'${appsDomain}'의 Route53 hosted zone ID(hostedZoneId)`,
    "`--hosted-zone-id <id>`로 지정하거나, 해당 도메인의 public hosted zone을 계정에 두면 " +
      "deploy.sh가 자동 조회합니다(PLATFORM-ENGINEERING.md 5.1).",
  );

  return {
    stage,
    account,
    region,
    appsDomain,
    hostedZoneId,
    allowedIngressCidrs,
    frontendMode: inputs?.frontendMode ?? "public",
    vpcCidr: parseVpcCidr(inputs?.vpcCidr),
  };
}

/** 리소스명 접두어. 모든 스택/리소스는 이 접두어로 시작한다. */
export function resourcePrefix(stage: Stage): string {
  return `apphub-${stage}`;
}
