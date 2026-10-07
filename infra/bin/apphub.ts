#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { loadConfig, parseFrontendMode, parseStage, resourcePrefix, type ConfigInputs } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { PlatformStack } from "../lib/platform-stack";
import { AlbShardStack } from "../lib/alb-shard-stack";
import { albShardStackName, assertAlbIndex, schemeSlug } from "../lib/alb-keys";
import { AppPipelineStack, AppRuntimeStack } from "../lib/app-stacks";
import { loadPipelineParams, loadRuntimeParams } from "../lib/constructs/app-params";

/**
 * AppHub CDK 엔트리.
 *
 * 세 가지 모드:
 *  (1) 플랫폼 모드 (기본): `cdk synth -c stage=dev|prod -c domain=... [-c frontendMode=public|private]`
 *      → network + platform 스택 인스턴스화(관리자 deploy.sh가 배포).
 *  (3) ALB 증설 모드(D20): `-c albShard=true -c albScheme=internet|internal -c albIndex=n(≥1)`
 *      → `apphub-{stage}-alb-{scheme}-{n}` AlbShardStack만 synth(provisioner APP_STACK_KIND=alb).
 *      domain 불필요 — network SSM에서 읽는다.
 *  (2) 앱 스택 모드: 컨텍스트에 `appId`가 있으면 앱별 독립 스택만 synth/deploy.
 *      → provisioner CodeBuild가 앱 파라미터를 -c 로 넘겨 실행:
 *        `cdk deploy apphub-{stage}-app-{appId}-{pipeline|runtime} -c appId=... -c appStackKind=...`
 *      appStackKind: "pipeline" | "runtime" (기본 runtime).
 *
 * 환경 리터럴(account/region/domain/hostedZoneId)은 하드코딩하지 않는다. 최초 배포 시 주입:
 *  - domain/hostedZoneId : CDK context(`-c domain=... -c hostedZoneId=...`) — deploy.sh가 인자를 -c로 전달.
 *  - account/region      : CDK 표준(`CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`).
 * 미지정 시 loadConfig가 친절한 한국어 에러로 synth를 멈춘다.
 *
 * 앱 스택 모드(appId 지정)는 domain/hostedZone을 쓰지 않는다 — construct가 network SSM에서 읽는다.
 * 따라서 provisioner/buildspec은 domain을 -c로 넘길 필요가 없다.
 */
const app = new App();

const stage = parseStage(app.node.tryGetContext("stage") ?? "dev");
const prefix = resourcePrefix(stage);
const appId = app.node.tryGetContext("appId") as string | undefined;

const albShard = String(app.node.tryGetContext("albShard") ?? "").toLowerCase() === "true";

if (albShard) {
  // ── (3) ALB 증설 모드 (D20) ───────────────────────────────────────────────
  const rawScheme = ctxOpt(app, "albScheme");
  if (!rawScheme) throw new Error("ALB 증설 모드에는 -c albScheme=internet|internal 이 필요합니다.");
  const slug = schemeSlug(rawScheme);
  const index = assertAlbIndex(Number(ctxOpt(app, "albIndex") ?? "NaN"), { min: 1 });
  const env = { account: resolveAccount(app), region: resolveRegion(app) };
  new AlbShardStack(app, albShardStackName(prefix, slug, index), {
    env,
    stage,
    schemeSlug: slug,
    albIndex: index,
  });
} else if (appId) {
  // ── (2) 앱 스택 모드 ──────────────────────────────────────────────────────
  //  앱 스택은 domain/hostedZone을 쓰지 않는다(construct가 network SSM에서 읽음).
  //  따라서 loadConfig(domain 필수)를 호출하지 않는다 — provisioner/buildspec은 domain을
  //  -c 로 넘기지 않으므로, 여기서 loadConfig를 타면 "도메인 미지정"으로 앱 배포가 깨진다.
  //  필요한 것은 account/region(env)뿐이며, CDK 표준 env/context에서 얻는다.
  const env = { account: resolveAccount(app), region: resolveRegion(app) };
  const kind = (app.node.tryGetContext("appStackKind") as string | undefined) ?? "runtime";
  if (kind === "pipeline") {
    new AppPipelineStack(app, `${prefix}-app-${appId}-pipeline`, {
      env,
      params: loadPipelineParams(app, stage, appId),
    });
  } else {
    new AppRuntimeStack(app, `${prefix}-app-${appId}-runtime`, {
      env,
      params: loadRuntimeParams(app, stage, appId),
    });
  }
} else {
  // ── (1) 플랫폼 모드 ──────────────────────────────────────────────────────
  //  network/platform은 domain/hostedZone이 필요하다 → loadConfig가 주입값을 검증.
  const config = loadConfig(stage, buildConfigInputs(app));
  const env = { account: config.account, region: config.region };
  const network = new NetworkStack(app, `${prefix}-network`, { stage, config, env });
  const platform = new PlatformStack(app, `${prefix}-platform`, { stage, config, env });
  // platform은 network가 발행한 SSM(역할명·VPC·인증서 등)을 배포 시점에 읽는다 → 배포 순서를 명시
  //  (Export 없는 순서 의존 — 값 변경 잠금 없음).
  platform.addDependency(network);
}

app.synth();

/**
 * 설치 시점 주입값을 조립한다(하드코딩 대체).
 *  - domain / hostedZoneId : CDK context(deploy.sh가 인자를 -c 로 전달). 우선순위 1순위.
 *  - account / region      : CDK 표준 env(CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION).
 *    (context로도 override 가능하게 두어 테스트/특수 상황에서 주입 가능. 없으면 표준 env.)
 *  - allowedIngressCidrs   : 콤마 구분 CIDR 목록(선택). 전 개방 대역은 loadConfig가 거부(D17).
 * 필수값(domain/account/region) 누락 시 loadConfig가 친절한 에러를 던진다.
 */
function buildConfigInputs(cdkApp: App): ConfigInputs {
  const rawCidrs = ctxOpt(cdkApp, "allowedIngressCidrs");
  const allowedIngressCidrs = rawCidrs
    ? rawCidrs
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    : [];

  return {
    appsDomain: ctxOpt(cdkApp, "domain"),
    hostedZoneId: ctxOpt(cdkApp, "hostedZoneId"),
    account: resolveAccount(cdkApp),
    region: resolveRegion(cdkApp),
    allowedIngressCidrs,
    frontendMode: parseFrontendMode(ctxOpt(cdkApp, "frontendMode")),
  };
}

/** context에서 비어있지 않은 문자열을 꺼낸다(없으면 undefined). */
function ctxOpt(cdkApp: App, key: string): string | undefined {
  const v = cdkApp.node.tryGetContext(key) as string | undefined;
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

/** 계정: CDK 표준 env(CDK_DEFAULT_ACCOUNT). context override도 허용(테스트/특수 상황). */
function resolveAccount(cdkApp: App): string | undefined {
  return ctxOpt(cdkApp, "account") ?? process.env.CDK_DEFAULT_ACCOUNT;
}

/** 리전: CDK 표준 env(CDK_DEFAULT_REGION) 또는 --region. context override도 허용. */
function resolveRegion(cdkApp: App): string | undefined {
  return ctxOpt(cdkApp, "region") ?? process.env.CDK_DEFAULT_REGION;
}
