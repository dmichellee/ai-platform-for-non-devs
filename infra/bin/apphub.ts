#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { loadConfig, parseStage, resourcePrefix } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { PlatformStack } from "../lib/platform-stack";
import { AppPipelineStack, AppRuntimeStack } from "../lib/app-stacks";
import { loadPipelineParams, loadRuntimeParams } from "../lib/constructs/app-params";

/**
 * AppHub CDK 엔트리.
 *
 * 두 가지 모드:
 *  (1) 플랫폼 모드 (기본): `cdk synth -c stage=dev|prod`
 *      → network + platform 스택 인스턴스화(관리자 deploy.sh가 배포).
 *  (2) 앱 스택 모드: 컨텍스트에 `appId`가 있으면 앱별 독립 스택만 synth/deploy.
 *      → provisioner CodeBuild가 앱 파라미터를 -c 로 넘겨 실행:
 *        `cdk deploy apphub-{stage}-app-{appId}-{pipeline|runtime} -c appId=... -c appStackKind=...`
 *      appStackKind: "pipeline" | "runtime" (기본 runtime).
 *
 * 환경 리터럴(account/region/domain)은 config.ts에서만 나온다.
 */
const app = new App();

const stage = parseStage(app.node.tryGetContext("stage") ?? "dev");
const config = loadConfig(stage, buildIngressOverrides(app));
const prefix = resourcePrefix(stage);
const env = { account: config.account, region: config.region };

const appId = app.node.tryGetContext("appId") as string | undefined;

if (appId) {
  // ── (2) 앱 스택 모드 ──────────────────────────────────────────────────────
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
  new NetworkStack(app, `${prefix}-network`, { stage, config, env });
  new PlatformStack(app, `${prefix}-platform`, { stage, config, env });
}

app.synth();

/** 설치 시점 주입: 콤마 구분 CIDR 목록(선택). 전 개방 대역은 loadConfig가 거부(D17). */
function buildIngressOverrides(cdkApp: App): { allowedIngressCidrs: string[] } {
  const rawCidrs = cdkApp.node.tryGetContext("allowedIngressCidrs") as string | undefined;
  const allowedIngressCidrs = rawCidrs
    ? rawCidrs
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    : [];
  return { allowedIngressCidrs };
}
