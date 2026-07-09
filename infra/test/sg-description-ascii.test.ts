import { describe, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { loadConfig } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { PlatformStack } from "../lib/platform-stack";
import { AppPipelineStack, AppRuntimeStack } from "../lib/app-stacks";
import type { AppPipelineParams, AppRuntimeParams } from "../lib/constructs/app-params";
import { assertSgDescriptionsAscii } from "./helpers/sg-ingress";

/**
 * L2 공통 재발방지 — EC2 SecurityGroup GroupDescription ASCII 강제.
 *
 * EC2 SG의 GroupDescription은 ASCII만 허용된다. 한글/em-dash가 들어가면 synth·CFN 템플릿
 * 검증은 통과하지만 실제 배포에서 거부된다("Character sets beyond ASCII are not supported").
 * 이 테스트는 전 스택(network/platform/app-runtime/app-pipeline)의 합성 템플릿을 순회하며
 * 모든 SG description이 순수 ASCII인지 단언하여, 이 클래스를 synth 단계에서 잡는다.
 *
 * (D17 개방 대역 부재는 sg-ingress 헬퍼가 별도로 담당한다 — 이 파일은 ASCII만 본다.)
 */

const ENV = { account: "111122223333", region: "ap-northeast-2" };

function networkTemplate(): Template {
  const app = new App();
  const config = loadConfig("dev");
  const stack = new NetworkStack(app, "apphub-dev-network", {
    stage: "dev",
    config,
    env: { account: config.account, region: config.region },
  });
  return Template.fromStack(stack);
}

function platformTemplate(): Template {
  const app = new App();
  const config = loadConfig("dev");
  const stack = new PlatformStack(app, "apphub-dev-platform", {
    stage: "dev",
    config,
    env: { account: config.account, region: config.region },
  });
  return Template.fromStack(stack);
}

function appRuntimeTemplate(): Template {
  const app = new App();
  const params: AppRuntimeParams = {
    stage: "dev",
    appId: "testapp0",
    subdomain: "testapp0",
    scheme: "internal",
    cpu: 256,
    memory: 512,
    minCount: 1,
    maxCount: 2,
    scaleMetric: "cpu",
    scaleThreshold: 70,
    imageTag: "abc123",
    rulePriority: 137,
    envVars: { FOO: "bar" },
    secretArns: {},
    sleepMode: "on-demand",
    cognitoProtect: false,
    isInitialDeploy: true,
  };
  const stack = new AppRuntimeStack(app, "apphub-dev-app-testapp0-runtime", {
    env: ENV,
    params,
  });
  return Template.fromStack(stack);
}

function appPipelineTemplate(): Template {
  const app = new App();
  const params: AppPipelineParams = {
    stage: "dev",
    appId: "testapp0",
    provider: "codecommit",
    repoUrl: "https://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/myrepo",
    branch: "main",
    autoDeployEnabled: true,
  };
  const stack = new AppPipelineStack(app, "apphub-dev-app-testapp0-pipeline", {
    env: ENV,
    params,
  });
  return Template.fromStack(stack);
}

describe("EC2 SG GroupDescription ASCII 강제 (전 스택 공통)", () => {
  it("network 스택의 모든 SG description이 ASCII", () => {
    assertSgDescriptionsAscii(networkTemplate());
  });

  it("platform 스택의 모든 SG description이 ASCII", () => {
    assertSgDescriptionsAscii(platformTemplate());
  });

  it("app-runtime 스택의 모든 SG description이 ASCII", () => {
    assertSgDescriptionsAscii(appRuntimeTemplate());
  });

  it("app-pipeline 스택의 모든 SG description이 ASCII", () => {
    assertSgDescriptionsAscii(appPipelineTemplate());
  });
});
