/**
 * 앱 스택(app-pipeline / app-runtime) 파라미터 — provisioner CodeBuild가 컨텍스트로 주입한다.
 *
 * DESIGN.md 3.1 / cdk-authoring "앱 스택 특수 규칙":
 *  - app-pipeline/app-runtime은 construct로 작성하고, provisioner가 앱별 파라미터를
 *    컨텍스트(-c appId=... -c ...)로 넘겨 독립 스택 `apphub-{stage}-app-{appId}-{pipeline|runtime}`
 *    으로 synth/deploy 한다. 같은 코드가 플랫폼 설치와 앱 배포 양쪽에서 쓰인다.
 *  - 리스너 규칙 priority는 스택 밖(DDB 카운터)에서 발급받아 파라미터로 주입(자동 채번 금지).
 *  - 시크릿 값은 파라미터에 담지 않는다 — Secrets Manager ARN만 참조(D8, apphub-conventions 7).
 *
 * network/platform 스택의 공유 리소스는 여기 담지 않고, construct가 SSM(`/apphub/{stage}/network/*`,
 * `/apphub/{stage}/platform/*`)에서 읽는다(Export 잠금 방지, cdk-authoring).
 */
import type { App } from "aws-cdk-lib";
import type { Stage } from "../config";

export type AppScheme = "internet-facing" | "internal";
export type AppSleepMode = "always-on" | "on-demand" | "schedule";
export type SourceProvider = "codecommit" | "github" | "gitlab";

/** 가동 스케줄(sleepMode="schedule"). 시각 "HH:MM", 요일 0(일)~6(토). backend AppSchedule과 동형. */
export interface AppScheduleParams {
  readonly startTime: string;
  readonly stopTime: string;
  readonly days: number[];
  readonly timezone: string;
}

/** app-pipeline 스택 파라미터. */
export interface AppPipelineParams {
  readonly stage: Stage;
  readonly appId: string;
  /** 소스 provider별 분기(CodeCommit vs CodeConnections). */
  readonly provider: SourceProvider;
  readonly repoUrl: string;
  readonly branch: string;
  /** github/gitlab일 때 CodeConnections ARN. codecommit이면 미지정. */
  readonly connectionArn?: string;
  /** 자동 배포(push 트리거) 여부. false면 수동(StartPipelineExecution)만. */
  readonly autoDeployEnabled: boolean;
  /**
   * 플랫폼 제공 자산 S3 URI(D-M5-06). provisioner가 -c 로 전달 → 이 construct가 생성하는
   * CodeBuild #1/#2 env(VALIDATOR_S3_URI/CDK_SOURCE_S3_URI)로 주입한다(신뢰 경계, D-M4-05).
   *  - validatorS3Uri: Dockerfile 검증기(Python, dockerfile_validator.py + dockerfile.py) 디렉토리 prefix.
   *  - cdkSourceS3Uri: 플랫폼 CDK tarball(app-runtime construct 포함) 위치.
   */
  readonly validatorS3Uri?: string;
  readonly cdkSourceS3Uri?: string;
}

/** app-runtime 스택 파라미터. */
export interface AppRuntimeParams {
  readonly stage: Stage;
  readonly appId: string;
  /** 접속 서브도메인. `{subdomain}.{appsDomain}` 로 노출. */
  readonly subdomain: string;
  readonly scheme: AppScheme;
  /** 프리셋에서 온 Fargate 유효 조합/스케일 설정(ComputePreset). */
  readonly cpu: number;
  readonly memory: number;
  readonly minCount: number;
  readonly maxCount: number;
  readonly scaleMetric: "cpu" | "requests";
  readonly scaleThreshold: number;
  /** 배포할 이미지 태그(commit SHA). app-pipeline CodeBuild가 ECR push한 태그. */
  readonly imageTag: string;
  /** 리스너 규칙 priority — DDB 카운터에서 발급받아 주입(자동 채번 금지). */
  readonly rulePriority: number;
  /** 권한 템플릿 IAM 정책 문서(PermissionTemplate.policyDocument). 태스크 역할에 주입. */
  readonly permissionPolicy?: Record<string, unknown>;
  /** 평문 환경변수(비시크릿). */
  readonly envVars: Record<string, string>;
  /**
   * 앱 시크릿 1개의 완전 ARN(D8: `apphub/{stage}/app/{appId}`, JSON {KEY: value}).
   * 시크릿 리소스는 백엔드(API Lambda)가 소유 — 이 스택은 참조만 한다. 시크릿이 없으면 미지정.
   */
  readonly secretArn?: string;
  /** 컨테이너에 주입할 시크릿 KEY 목록. 각 KEY → ECS secrets valueFrom `<arn>:KEY::`(환경변수 아님). */
  readonly secretKeys: string[];
  readonly sleepMode: AppSleepMode;
  readonly schedule?: AppScheduleParams;
  /** D16: 리스너 규칙에 authenticate-cognito 액션 부착 여부. */
  readonly cognitoProtect: boolean;
  /**
   * 최초 생성 여부. true면 desiredCount를 minCount로 지정,
   * false(갱신)면 desiredCount 미지정(현재 값 유지 — 스케줄러/Waker 드리프트 방지, DESIGN 3.5).
   */
  readonly isInitialDeploy: boolean;
}

/** 컨텍스트에서 문자열을 꺼낸다(필수). */
export function ctxString(app: App, key: string): string {
  const v = app.node.tryGetContext(key) as string | undefined;
  if (v === undefined || v === null || v === "") {
    throw new Error(`앱 스택 컨텍스트 '${key}' 가 필요합니다 (-c ${key}=...).`);
  }
  return String(v);
}

/** 컨텍스트에서 문자열을 꺼낸다(선택). */
export function ctxStringOpt(app: App, key: string): string | undefined {
  const v = app.node.tryGetContext(key) as string | undefined;
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

/** 컨텍스트에서 숫자를 꺼낸다(필수). */
export function ctxNumber(app: App, key: string): number {
  const raw = ctxString(app, key);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`앱 스택 컨텍스트 '${key}' 는 숫자여야 합니다(받은 값: ${raw}).`);
  return n;
}

/** 컨텍스트에서 boolean을 꺼낸다(기본값 지원). "true"/"false" 문자열 또는 boolean. */
export function ctxBool(app: App, key: string, dflt: boolean): boolean {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}

/** 컨텍스트에서 문자열 맵(JSON/ base64 JSON)을 꺼낸다(기본 빈 객체). */
export function ctxStringMap(app: App, key: string): Record<string, string> {
  const v = ctxJsonOpt<Record<string, unknown>>(app, key);
  if (!v) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return out;
}

/**
 * 컨텍스트에서 app-runtime 파라미터를 조립한다(provisioner가 -c 로 주입한 값).
 * buildspec deploy.yml 계약의 키와 1:1 대응.
 */
export function loadRuntimeParams(app: App, stage: Stage, appId: string): AppRuntimeParams {
  const scheme = ctxString(app, "scheme") === "internal" ? "internal" : "internet-facing";
  const sleepRaw = ctxStringOpt(app, "sleepMode") ?? "always-on";
  const sleepMode: AppSleepMode =
    sleepRaw === "schedule" ? "schedule" : sleepRaw === "on-demand" ? "on-demand" : "always-on";
  const scaleMetric = ctxStringOpt(app, "scaleMetric") === "requests" ? "requests" : "cpu";
  const schedule = ctxJsonOpt<AppScheduleParams>(app, "schedule");
  const permissionPolicy = ctxJsonOpt<Record<string, unknown>>(app, "permissionPolicyB64");
  return {
    stage,
    appId,
    subdomain: ctxString(app, "subdomain"),
    scheme,
    cpu: ctxNumber(app, "cpu"),
    memory: ctxNumber(app, "memory"),
    minCount: ctxNumber(app, "minCount"),
    maxCount: ctxNumber(app, "maxCount"),
    scaleMetric,
    scaleThreshold: ctxNumber(app, "scaleThreshold"),
    imageTag: ctxString(app, "imageTag"),
    rulePriority: ctxNumber(app, "rulePriority"),
    ...(permissionPolicy ? { permissionPolicy } : {}),
    envVars: ctxStringMap(app, "envVars"),
    ...secretParams(app),
    sleepMode,
    ...(schedule ? { schedule } : {}),
    cognitoProtect: ctxBool(app, "cognitoProtect", scheme === "internet-facing"),
    isInitialDeploy: ctxBool(app, "isInitialDeploy", true),
  };
}

/**
 * 시크릿 컨텍스트(D8): `-c secretArn=<완전 ARN>` + `-c secretKeysB64=<base64(JSON list[str])>`.
 * 둘 다 생략 = 시크릿 없음. 한쪽만 있으면 계약 위반으로 실패(빈 KEY 목록은 시크릿 없음으로 취급).
 */
export function secretParams(app: App): { secretArn?: string; secretKeys: string[] } {
  const secretArn = ctxStringOpt(app, "secretArn");
  const rawKeys = ctxJsonOpt<unknown>(app, "secretKeysB64");
  if (rawKeys !== undefined && !Array.isArray(rawKeys)) {
    throw new Error("앱 스택 컨텍스트 'secretKeysB64' 는 문자열 배열(JSON list)이어야 합니다.");
  }
  const secretKeys = Array.from(new Set(((rawKeys as unknown[] | undefined) ?? []).map((k) => String(k))));
  for (const k of secretKeys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`앱 스택 컨텍스트 'secretKeysB64' 의 KEY 형식이 잘못되었습니다: ${k}`);
    }
  }
  if (secretKeys.length > 0 && !secretArn) {
    throw new Error("앱 스택 컨텍스트 'secretKeysB64' 가 있으면 'secretArn' 도 필요합니다.");
  }
  if (secretKeys.length === 0) return { secretKeys: [] };
  return { secretArn, secretKeys };
}

/** 컨텍스트에서 app-pipeline 파라미터를 조립한다. */
export function loadPipelineParams(app: App, stage: Stage, appId: string): AppPipelineParams {
  const providerRaw = ctxString(app, "provider");
  const provider: SourceProvider =
    providerRaw === "github" ? "github" : providerRaw === "gitlab" ? "gitlab" : "codecommit";
  const connectionArn = ctxStringOpt(app, "connectionArn");
  const validatorS3Uri = ctxStringOpt(app, "validatorS3Uri");
  const cdkSourceS3Uri = ctxStringOpt(app, "cdkSourceS3Uri");
  return {
    stage,
    appId,
    provider,
    repoUrl: ctxString(app, "repoUrl"),
    branch: ctxStringOpt(app, "branch") ?? "main",
    ...(connectionArn ? { connectionArn } : {}),
    autoDeployEnabled: ctxBool(app, "autoDeployEnabled", true),
    ...(validatorS3Uri ? { validatorS3Uri } : {}),
    ...(cdkSourceS3Uri ? { cdkSourceS3Uri } : {}),
  };
}

/** 컨텍스트에서 JSON을 꺼낸다(선택). base64 또는 raw JSON 문자열 허용. */
export function ctxJsonOpt<T>(app: App, key: string): T | undefined {
  const raw = ctxStringOpt(app, key);
  if (raw === undefined) return undefined;
  // provisioner가 셸 인용 문제를 피하려고 base64로 넘길 수 있다.
  let text = raw;
  if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0 && !raw.trimStart().startsWith("{") && !raw.trimStart().startsWith("[")) {
    try {
      text = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      text = raw;
    }
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`앱 스택 컨텍스트 '${key}' JSON 파싱 실패: ${(e as Error).message}`);
  }
}
