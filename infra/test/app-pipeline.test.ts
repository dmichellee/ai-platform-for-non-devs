import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AppPipelineStack } from "../lib/app-stacks";
import { assertNoOpenIngress } from "./helpers/sg-ingress";
import type { AppPipelineParams } from "../lib/constructs/app-params";

/**
 * L2 — app-pipeline construct CDK assertions (cdk-authoring).
 *
 * 단언 대상:
 *  - ECR lifecycle(최근 5개) + emptyOnDelete(RETAIN 아님)
 *  - CodeBuild 2개(검증+빌드 / 배포)
 *  - CodePipeline 3스테이지(Source / ValidateBuild / Deploy)
 *  - provider별 소스 액션(codecommit / codeconnections)
 *  - SG 개방 대역 부재(D17 공통) — 파이프라인은 SG를 만들지 않지만 공통 순회 적용
 *  - IAM Resource:"*" 최소화(리소스 레벨 미지원 액션만 * 허용)
 */

const ENV = { account: "111122223333", region: "ap-northeast-2" };

function ccParams(overrides: Partial<AppPipelineParams> = {}): AppPipelineParams {
  return {
    stage: "dev",
    appId: "testapp0",
    provider: "codecommit",
    repoUrl: "https://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/myrepo",
    branch: "main",
    autoDeployEnabled: true,
    ...overrides,
  };
}

function synth(params: AppPipelineParams): Template {
  const app = new App();
  const stack = new AppPipelineStack(app, `apphub-dev-app-${params.appId}-pipeline`, {
    env: ENV,
    params,
  });
  return Template.fromStack(stack);
}

describe("app-pipeline — codecommit(자동 트리거)", () => {
  let template: Template;
  beforeAll(() => {
    template = synth(ccParams());
  });

  it("D17 공통 — SG 개방 대역 부재", () => {
    assertNoOpenIngress(template, []);
  });

  describe("ECR — lifecycle 5 + emptyOnDelete", () => {
    it("최근 5개 이미지만 보존하는 lifecycle 정책", () => {
      const repos = template.findResources("AWS::ECR::Repository");
      const bodies = Object.values(repos).map((r) => {
        const props = r.Properties as Record<string, { LifecyclePolicyText?: string } | undefined>;
        return String(props["LifecyclePolicy"]?.LifecyclePolicyText ?? "");
      });
      const joined = bodies.join("|");
      expect(joined).toContain("imageCountMoreThan");
      expect(joined).toContain('"countNumber":5');
    });

    it("ECR은 RETAIN이 아니다(앱 삭제 시 이미지 포함 완전 삭제)", () => {
      const repos = template.findResources("AWS::ECR::Repository");
      for (const repo of Object.values(repos)) {
        // emptyOnDelete:true → Custom::ECRAutoDeleteImages, DeletionPolicy Delete.
        expect(repo.DeletionPolicy).not.toBe("Retain");
        expect(repo.Properties).toMatchObject({ EmptyOnDelete: true });
      }
    });
  });

  describe("CodeBuild — 검증+빌드 / 배포 2개", () => {
    it("CodeBuild 프로젝트가 2개다", () => {
      template.resourceCountIs("AWS::CodeBuild::Project", 2);
    });

    it("검증+빌드 프로젝트는 privileged(docker-in-docker)", () => {
      template.hasResourceProperties("AWS::CodeBuild::Project", {
        Name: "apphub-dev-app-testapp0-validate-build",
        Environment: Match.objectLike({ PrivilegedMode: true }),
      });
    });

    it("배포 프로젝트는 privileged 아님", () => {
      template.hasResourceProperties("AWS::CodeBuild::Project", {
        Name: "apphub-dev-app-testapp0-deploy",
        Environment: Match.objectLike({ PrivilegedMode: false }),
      });
    });
  });

  describe("CodePipeline — 3스테이지", () => {
    it("Source / ValidateBuild / Deploy 스테이지", () => {
      template.hasResourceProperties("AWS::CodePipeline::Pipeline", {
        Name: "apphub-dev-app-testapp0",
        Stages: Match.arrayWith([
          Match.objectLike({ Name: "Source" }),
          Match.objectLike({ Name: "ValidateBuild" }),
          Match.objectLike({ Name: "Deploy" }),
        ]),
      });
    });

    it("codecommit 소스 액션(CodeCommit provider)", () => {
      const pipelines = template.findResources("AWS::CodePipeline::Pipeline");
      const raw = JSON.stringify(Object.values(pipelines));
      expect(raw).toContain("CodeCommit");
    });
  });

  describe("deployBuild DDB 읽기 권한 (실배포 AccessDenied 버그 회귀 방지)", () => {
    it("deploy 프로젝트 역할에 dynamodb:GetItem이 앱 단일 테이블(apphub-dev-main) ARN 범위로 있다", () => {
      // deploy.yml pre_build의 App/PRESET/PERM 조회가 GetItem 권한 없이 AccessDeniedException으로
      //  실패해 runtime 스택이 생성 못 하던 버그. sid ReadAppParamsFromDdb, GetItem만, -main ARN 범위.
      const policies = template.findResources("AWS::IAM::Policy");
      let found = false;
      for (const pol of Object.values(policies)) {
        const doc = (
          pol.Properties as {
            PolicyDocument?: { Statement?: Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> };
          }
        ).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (st.Sid === "ReadAppParamsFromDdb") {
            found = true;
            const act = JSON.stringify(st.Action);
            expect(act).toContain("dynamodb:GetItem");
            // 읽기 전용 — 쓰기 액션이 새어들지 않았는지.
            expect(act).not.toContain("dynamodb:PutItem");
            expect(act).not.toContain("dynamodb:UpdateItem");
            const res = JSON.stringify(st.Resource);
            expect(res).toContain("table/apphub-dev-main");
            expect(st.Resource).not.toBe("*");
          }
        }
      }
      expect(found, "deployBuild 역할에 ReadAppParamsFromDdb statement가 있어야 함").toBe(true);
    });
  });

  describe("IAM — Resource:'*' 최소화", () => {
    it("ecr:GetAuthorizationToken 외에는 * 리소스를 피한다", () => {
      // GetAuthorizationToken은 리소스 레벨 미지원(계정 스코프)이라 * 예외 허용.
      // 그 외 정책 statement에서 Resource:'*' 가 남발되지 않았는지 조잡 감시.
      const policies = template.findResources("AWS::IAM::Policy");
      let starCount = 0;
      for (const pol of Object.values(policies)) {
        const doc = (pol.Properties as Record<string, { PolicyDocument?: { Statement?: unknown[] } }>)["PolicyDocument"]?.PolicyDocument;
        for (const st of (doc?.Statement ?? []) as Array<{ Action?: unknown; Resource?: unknown }>) {
          if (st.Resource === "*") starCount++;
        }
      }
      // GetAuthorizationToken + CDK 관리형(로그/아티팩트 등 일부 CDK가 생성)까지 감안해 상한만 둔다.
      // 우리 코드가 명시적으로 넣은 * 는 GetAuthorizationToken + PreDeployElbDescribe(N2) 두 개.
      expect(starCount).toBeLessThanOrEqual(6);
    });

    it("SID가 붙은 Resource:'*' statement는 허용 목록(EcrAuth, PreDeployElbDescribe)만 — 액션 집합도 고정", () => {
      const allowed: Record<string, string[]> = {
        EcrAuth: ["ecr:GetAuthorizationToken"],
        PreDeployElbDescribe: [
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups",
        ],
      };
      const unexpected: string[] = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const doc = (pol.Properties as { PolicyDocument?: { Statement?: Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> } })
          .PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (st.Resource !== "*" || st.Sid === undefined) continue;
          const acts = (Array.isArray(st.Action) ? st.Action : [st.Action]).map(String).sort();
          if (!allowed[st.Sid] || JSON.stringify(acts) !== JSON.stringify(allowed[st.Sid])) unexpected.push(st.Sid);
        }
      }
      expect(unexpected).toEqual([]);
    });
  });

  describe("QA N2 — 잠든 앱 배포 전 규칙 복귀 권한 (deployBuild 역할)", () => {
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    const deployRolePolicyStmts = (): Stmt[] => {
      const out: Stmt[] = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const props = pol.Properties as { Roles?: unknown; PolicyDocument?: { Statement?: Stmt[] } };
        if (!JSON.stringify(props.Roles).includes("DeployBuildRole")) continue;
        out.push(...(props.PolicyDocument?.Statement ?? []));
      }
      return out;
    };
    const bySid = (sid: string): Stmt => {
      const st = deployRolePolicyStmts().find((x) => x.Sid === sid);
      expect(st, `deployBuild 역할에 ${sid} statement가 있어야 함`).toBeDefined();
      return st!;
    };
    const acts = (a: unknown): string[] => (Array.isArray(a) ? a.map(String) : [String(a)]).sort();

    it("ssm:GetParameter — network 공유값 경로(parameter/apphub/dev/network/*) 한정", () => {
      const st = bySid("PreDeployReadNetworkSsm");
      expect(acts(st.Action)).toEqual(["ssm:GetParameter"]);
      expect(JSON.stringify(st.Resource)).toContain("parameter/apphub/dev/network/*");
    });

    it("ELB DescribeRules/TargetGroups/Listeners — 리소스 레벨 미지원이라 *", () => {
      const st = bySid("PreDeployElbDescribe");
      expect(acts(st.Action)).toEqual([
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:DescribeTargetGroups",
      ]);
      expect(st.Resource).toBe("*");
    });

    it("ModifyRule — 플랫폼 ALB 리스너 규칙(listener-rule/app/apphub-dev-*/*) 한정", () => {
      const st = bySid("PreDeployElbModifyRule");
      expect(acts(st.Action)).toEqual(["elasticloadbalancing:ModifyRule"]);
      expect(JSON.stringify(st.Resource)).toContain("listener-rule/app/apphub-dev-*/*");
      expect(st.Resource).not.toBe("*");
    });

    it("DescribeUserPoolClient — 플랫폼 User Pool ARN(SSM user-pool-arn) 한정", () => {
      const st = bySid("PreDeployCognitoDescribeClient");
      expect(acts(st.Action)).toEqual(["cognito-idp:DescribeUserPoolClient"]);
      expect(JSON.stringify(st.Resource)).toMatch(/SsmParameterValueapphubdevplatformuserpoolarn/);
    });

    it("runtimeState 조회 dynamodb:GetItem(기존 ReadAppParamsFromDdb)이 유지된다", () => {
      expect(acts(bySid("ReadAppParamsFromDdb").Action)).toEqual(["dynamodb:GetItem"]);
    });

    it("validateBuild 역할에는 배포 전 규칙 복귀 권한이 새지 않는다", () => {
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const props = pol.Properties as { Roles?: unknown; PolicyDocument?: { Statement?: Stmt[] } };
        if (!JSON.stringify(props.Roles).includes("ValidateBuildRole")) continue;
        const sids = (props.PolicyDocument?.Statement ?? []).map((x) => x.Sid);
        expect(sids).not.toContain("PreDeployElbModifyRule");
      }
    });
  });
});

describe("app-pipeline — 플랫폼 자산 URI 전파 (D-M5-06)", () => {
  let template: Template;
  beforeAll(() => {
    template = synth(
      ccParams({
        appId: "assetapp",
        validatorS3Uri: "s3://apphub-dev-assets-111122223333/validator/dockerfile-validator.mjs",
        cdkSourceS3Uri: "s3://apphub-dev-assets-111122223333/cdk-source/cdk-src.tgz",
      }),
    );
  });

  it("CodeBuild #1(validate-build)에 VALIDATOR_S3_URI가 주입된다", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: "apphub-dev-app-assetapp-validate-build",
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({
            Name: "VALIDATOR_S3_URI",
            Value: "s3://apphub-dev-assets-111122223333/validator/dockerfile-validator.mjs",
          }),
        ]),
      }),
    });
  });

  it("CodeBuild #2(deploy)에 CDK_SOURCE_S3_URI가 주입된다", () => {
    template.hasResourceProperties("AWS::CodeBuild::Project", {
      Name: "apphub-dev-app-assetapp-deploy",
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({
            Name: "CDK_SOURCE_S3_URI",
            Value: "s3://apphub-dev-assets-111122223333/cdk-source/cdk-src.tgz",
          }),
        ]),
      }),
    });
  });

  it("자산 버킷 오브젝트 GetObject 권한이 부여된다(버킷 범위)", () => {
    const raw = JSON.stringify(Object.values(template.findResources("AWS::IAM::Policy")));
    expect(raw).toContain("s3:GetObject");
    expect(raw).toContain("apphub-dev-assets-111122223333/*");
  });
});

describe("app-pipeline — github(수동 트리거, CodeConnections)", () => {
  let template: Template;
  beforeAll(() => {
    template = synth(
      ccParams({
        appId: "ghapp001",
        provider: "github",
        repoUrl: "https://github.com/acme/myapp",
        autoDeployEnabled: false,
        connectionArn:
          "arn:aws:codeconnections:ap-northeast-2:111122223333:connection/aeb1a1b1-1111-2222-3333-444455556666",
      }),
    );
  });

  it("CodeStarSourceConnection(=CodeConnections) 소스 액션을 쓴다", () => {
    const pipelines = template.findResources("AWS::CodePipeline::Pipeline");
    const raw = JSON.stringify(Object.values(pipelines));
    expect(raw).toContain("CodeStarSourceConnection");
  });

  it("connectionArn이 파이프라인에 주입된다", () => {
    const pipelines = template.findResources("AWS::CodePipeline::Pipeline");
    const raw = JSON.stringify(Object.values(pipelines));
    expect(raw).toContain("aeb1a1b1-1111-2222-3333-444455556666");
  });
});

describe("app-pipeline — 오류 케이스", () => {
  it("github인데 connectionArn 없으면 synth에서 throw", () => {
    expect(() =>
      synth(
        ccParams({
          appId: "badapp01",
          provider: "github",
          repoUrl: "https://github.com/acme/myapp",
        }),
      ),
    ).toThrow(/connectionArn/);
  });
});
