import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { loadConfig } from "../lib/config";
import { PlatformStack } from "../lib/platform-stack";
import { assertNoOpenIngress } from "./helpers/sg-ingress";

/**
 * L2 — platform 스택 CDK assertions.
 * D13(컨트롤 플레인 구성), 데이터 모델(단일 테이블 + GSI), D12(관리자 초대),
 * 보안(SPA 비공개 S3, 시크릿 평문 부재)을 단언한다.
 */
function synth(): Template {
  const app = new App();
  const config = loadConfig("dev");
  const stack = new PlatformStack(app, "apphub-dev-platform", {
    stage: "dev",
    config,
    env: { account: config.account, region: config.region },
  });
  return Template.fromStack(stack);
}

describe("platform 스택", () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  describe("D17 공통 — SG ingress 개방 대역 부재", () => {
    it("platform 스택은 SG를 만들지 않거나, 만들어도 개방 대역이 없다", () => {
      // platform은 SG를 소유하지 않지만, 공통 테스트를 전 스택에 순회 적용한다.
      assertNoOpenIngress(template, []);
    });
  });

  describe("데이터 모델 — 단일 테이블 (DESIGN 4)", () => {
    it("apphub-dev-main 테이블 + GSI1(ownerId)/GSI2(status), PAY_PER_REQUEST", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "apphub-dev-main",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: Match.arrayWith([
          Match.objectLike({ AttributeName: "PK", KeyType: "HASH" }),
          Match.objectLike({ AttributeName: "SK", KeyType: "RANGE" }),
        ]),
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "GSI1",
            KeySchema: Match.arrayWith([
              Match.objectLike({ AttributeName: "ownerId", KeyType: "HASH" }),
            ]),
          }),
          Match.objectLike({
            IndexName: "GSI2",
            KeySchema: Match.arrayWith([
              Match.objectLike({ AttributeName: "status", KeyType: "HASH" }),
            ]),
          }),
        ]),
      });
    });

    it("배포 이력 TTL 속성이 설정된다(90일 TTL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      });
    });
  });

  describe("D12 — Cognito 관리자 초대", () => {
    it("self sign-up 비활성(관리자만 사용자 생성)", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      });
    });

    it("admin / user 그룹이 생성된다", () => {
      template.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
      template.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
        GroupName: "admin",
      });
      template.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
        GroupName: "user",
      });
    });

    it("SPA 클라이언트는 시크릿을 생성하지 않는다(퍼블릭 클라이언트)", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        GenerateSecret: false,
      });
    });

    it("SPA 클라이언트 콜백/로그아웃 URL이 CloudFront 도메인(origin 루트)을 참조한다", () => {
      // redirect_mismatch 회귀 방지: SPA client(GenerateSecret:false)의 Callback/Logout URL은
      //  프론트 AuthContext가 보내는 redirect_uri(`window.location.origin`, origin 루트)와 1바이트까지
      //  일치해야 한다. CloudFront 도메인은 같은 스택 참조이므로 Fn::Join 조각에 나타난다.
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const spa = Object.values(clients).find(
        (c) => (c.Properties as Record<string, unknown>)["GenerateSecret"] === false,
      );
      expect(spa, "SPA client(GenerateSecret:false)가 존재해야 함").toBeDefined();
      const props = spa!.Properties as Record<string, unknown>;
      const callbackJson = JSON.stringify(props["CallbackURLs"]);
      const logoutJson = JSON.stringify(props["LogoutURLs"]);
      // CloudFront distribution DomainName 참조(GetAtt) 조각이 콜백/로그아웃 URL에 포함된다.
      expect(callbackJson).toContain("DomainName");
      expect(logoutJson).toContain("DomainName");
      // origin 루트여야 한다 — `/callback`이나 `/oauth2/idpresponse` 같은 경로가 붙으면 안 된다.
      expect(callbackJson).not.toContain("/callback");
      expect(callbackJson).not.toContain("/oauth2/idpresponse");
      // dev는 로컬 개발 origin(http://localhost:5173)도 트레일링슬래시 없이 허용한다.
      expect(callbackJson).toContain("http://localhost:5173");
      expect(callbackJson).not.toContain("http://localhost:5173/");
    });

    it("ALB 인증용 app-auth 클라이언트는 SPA와 별개(시크릿 O, /oauth2/idpresponse 콜백)", () => {
      // SPA 로그인 수정이 ALB authenticate-cognito 클라이언트를 건드리지 않았음을 고정.
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const appAuth = Object.values(clients).find(
        (c) => (c.Properties as Record<string, unknown>)["GenerateSecret"] === true,
      );
      expect(appAuth, "app-auth client(GenerateSecret:true)가 존재해야 함").toBeDefined();
      const cb = JSON.stringify((appAuth!.Properties as Record<string, unknown>)["CallbackURLs"]);
      expect(cb).toContain("/oauth2/idpresponse");
    });

    it("Hosted UI 도메인 prefix에 조직 식별정보가 없다(account 기반)", () => {
      const domains = template.findResources("AWS::Cognito::UserPoolDomain");
      const prefixes = Object.values(domains).map(
        (d) => (d.Properties as Record<string, unknown>)["Domain"],
      );
      expect(prefixes.length).toBe(1);
      // 형식: apphub-dev-<account>. 조직명 같은 리터럴이 아님.
      expect(String(prefixes[0])).toMatch(/^apphub-dev-\d+$/);
    });
  });

  describe("API Gateway + Lambda 골격 (D13)", () => {
    it("REST API + Cognito authorizer가 붙는다", () => {
      template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
      template.hasResourceProperties("AWS::ApiGateway::Authorizer", {
        Type: "COGNITO_USER_POOLS",
      });
    });

    it("API 핸들러 Lambda에 TABLE_NAME 등 환경변수가 주입된다", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-api",
        Environment: {
          Variables: Match.objectLike({
            TABLE_NAME: Match.anyValue(),
            USER_POOL_ID: Match.anyValue(),
            STAGE: "dev",
            // 핸들러 CORS(app/http/cors.py)가 읽는 허용 origin. dev는 CloudFront 도메인 + localhost:5173.
            ALLOWED_ORIGINS: Match.anyValue(),
          }),
        },
      });
    });

    it("API 핸들러 CORS 허용 origin(ALLOWED_ORIGINS)에 dev localhost가 포함되고 와일드카드가 아니다", () => {
      const fns = template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "apphub-dev-api" },
      });
      const fn = Object.values(fns)[0];
      const vars = (
        fn.Properties as { Environment?: { Variables?: Record<string, unknown> } }
      ).Environment?.Variables;
      const allowed = vars?.["ALLOWED_ORIGINS"];
      // dev는 CloudFront 도메인(Fn::Join으로 렌더)에 ",http://localhost:5173"가 이어붙는다.
      const rendered = JSON.stringify(allowed);
      expect(rendered).toContain("http://localhost:5173");
      // Access-Control-Allow-Origin: * 금지 — 허용 목록에 단독 * 가 있으면 안 된다.
      expect(rendered).not.toContain('"*"');
    });
  });

  describe("SPA 호스팅 — 비공개 S3 + CloudFront(OAC)", () => {
    it("S3 버킷은 퍼블릭 접근을 전면 차단한다", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("CloudFront는 OAC를 사용한다(퍼블릭 S3 아님)", () => {
      template.resourceCountIs("AWS::CloudFront::Distribution", 1);
      // OAC 2개: SPA 버킷(기본 behavior) + 자산 버킷(/kiro-config/* behavior, P-M7-01).
      template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
    });

    it("Kiro 설정 다운로드 — /kiro-config/* behavior가 자산 버킷을 서빙한다 (P-M7-01)", () => {
      const dists = template.findResources("AWS::CloudFront::Distribution");
      const dist = Object.values(dists)[0];
      const config = (dist.Properties as Record<string, { CacheBehaviors?: Array<{ PathPattern?: string }>; Origins?: unknown[] }>)[
        "DistributionConfig"
      ] as { CacheBehaviors?: Array<{ PathPattern?: string }>; Origins?: unknown[] };
      // 기본 origin(SPA) + 자산 origin = 2개.
      expect((config.Origins ?? []).length).toBe(2);
      // /kiro-config/* 경로 behavior가 존재한다.
      const paths = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
      expect(paths).toContain("/kiro-config/*");
    });

    it("KiroConfigUrlPath Output이 발행된다(프론트 다운로드 링크 계약, P-M7-01)", () => {
      const json = template.toJSON() as { Outputs?: Record<string, { Value?: unknown }> };
      expect(Object.keys(json.Outputs ?? {})).toContain("KiroConfigUrlPath");
      expect(json.Outputs!["KiroConfigUrlPath"].Value).toBe("/kiro-config/kiro-config.zip");
    });
  });

  describe("provisioner CodeBuild + 자산 버킷 (D-M5-06)", () => {
    it("provisioner CodeBuild 프로젝트가 존재한다", () => {
      template.hasResourceProperties("AWS::CodeBuild::Project", {
        Name: "apphub-dev-provisioner",
      });
    });

    it("provisioner env에 VALIDATOR_S3_URI / CDK_SOURCE_S3_URI 고정 키가 주입된다", () => {
      const projects = template.findResources("AWS::CodeBuild::Project");
      const prov = Object.values(projects).find(
        (p) => (p.Properties as Record<string, unknown>)["Name"] === "apphub-dev-provisioner",
      );
      expect(prov).toBeDefined();
      const envList =
        (prov!.Properties as Record<string, { EnvironmentVariables?: Array<{ Name: string; Value: unknown }> }>)[
          "Environment"
        ]!.EnvironmentVariables ?? [];
      const names = envList.map((e) => e.Name);
      expect(names).toEqual(
        expect.arrayContaining([
          "STAGE",
          "TABLE_NAME",
          "AWS_ACCOUNT_ID",
          "AWS_DEFAULT_REGION",
          "VALIDATOR_S3_URI",
          "CDK_SOURCE_S3_URI",
        ]),
      );
      // 값은 Fn::Join(자산 버킷 Ref 포함) — 고정 키 경로가 join 조각에 있어야 한다.
      const validator = envList.find((e) => e.Name === "VALIDATOR_S3_URI");
      const cdkSrc = envList.find((e) => e.Name === "CDK_SOURCE_S3_URI");
      // D-M8: 검증기는 Python 2파일이라 단일 파일이 아니라 디렉토리 prefix(validator/)를 가리킨다.
      expect(JSON.stringify(validator!.Value)).toContain("validator/");
      expect(JSON.stringify(cdkSrc!.Value)).toContain("cdk-source/cdk-src.tgz");
    });

    it("자산 S3 버킷(apphub-dev-assets-{account})이 퍼블릭 전면 차단으로 생성된다", () => {
      const buckets = template.findResources("AWS::S3::Bucket");
      const assetBucket = Object.values(buckets).find((b) =>
        /apphub-dev-assets-\d+/.test(
          String((b.Properties as Record<string, unknown>)["BucketName"] ?? ""),
        ),
      );
      expect(assetBucket, "자산 버킷이 존재해야 함").toBeDefined();
      expect(
        (assetBucket!.Properties as Record<string, { BlockPublicAcls?: boolean }>)[
          "PublicAccessBlockConfiguration"
        ],
      ).toMatchObject({ BlockPublicAcls: true, RestrictPublicBuckets: true });
    });

    it("AssetsBucketName Output이 발행된다(deploy.sh 3b 소비)", () => {
      const json = template.toJSON() as { Outputs?: Record<string, unknown> };
      expect(Object.keys(json.Outputs ?? {})).toContain("AssetsBucketName");
    });

    it("provisioner 역할의 Resource:'*' statement는 최소(Describe* + 조건부 EC2 SG만)", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      // Resource가 문자열 "*" 또는 배열 ["*"] 두 형태 모두를 잡는다.
      const isStar = (r: unknown): boolean =>
        r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");
      let star = 0;
      let starWithCondition = 0;
      for (const pol of Object.values(policies)) {
        const doc = (
          pol.Properties as {
            PolicyDocument?: { Statement?: Array<{ Resource?: unknown; Condition?: unknown }> };
          }
        ).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (isStar(st.Resource)) {
            star++;
            if (st.Condition) starWithCondition++;
          }
        }
      }
      // ReadOnlyDescribeStar(리소스레벨 미지원 조회, 무조건) 1개 +
      // AppSecurityGroupManageInRegion(EC2 SG 생성/변경, aws:RequestedRegion 조건, QA M-2 축소) 1개 = 2개.
      expect(star).toBeLessThanOrEqual(2);
      // provisioner 역할에는 * statement가 실제로 존재해야 한다(테스트 경로 유효성 가드).
      expect(star).toBeGreaterThanOrEqual(1);
      // SG 조작 * statement는 반드시 리전 조건이 붙어야 한다(무제한 * 금지, QA M-2).
      expect(starWithCondition).toBeGreaterThanOrEqual(1);
    });

    it("[QA M-2] EC2 SG 변경 권한은 aws:RequestedRegion 조건으로 배포 리전에 한정된다", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress"]),
              Condition: { StringEquals: { "aws:RequestedRegion": "ap-northeast-2" } },
            }),
          ]),
        }),
      });
    });
  });

  describe("Step Functions — 실 ASL (D-M5-01)", () => {
    it("ProvisionApp / DeleteApp 상태 기계 2개가 존재한다", () => {
      template.resourceCountIs("AWS::StepFunctions::StateMachine", 2);
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineName: "apphub-dev-provision-app",
      });
      template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
        StateMachineName: "apphub-dev-delete-app",
      });
    });

    it("task Lambda 2개(provision-task/delete-task, PYTHON_3_13, handler.handler, STAGE+TABLE_NAME env)가 존재한다", () => {
      // D-M8: 런타임 Python 3.13, 핸들러 handler.handler(자산 루트 shim). 데이터 계층이 요구하는
      //  TABLE_NAME(폴백 없음)이 반드시 주입된다(P2 필수 요청). 테이블명은 결정론적 apphub-dev-main.
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-provision-task",
        Runtime: "python3.13",
        Handler: "handler.handler",
        Environment: {
          Variables: Match.objectLike({ STAGE: "dev", TABLE_NAME: "apphub-dev-main" }),
        },
      });
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-delete-task",
        Runtime: "python3.13",
        Handler: "handler.handler",
        Environment: {
          Variables: Match.objectLike({ STAGE: "dev", TABLE_NAME: "apphub-dev-main" }),
        },
      });
    });

    it("API 핸들러 Lambda가 PYTHON_3_13 / handler.handler 로 전환됐다(D-M8)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-api",
        Runtime: "python3.13",
        Handler: "handler.handler",
      });
    });

    it("ProvisionApp ASL은 폴링 루프(Choice+Wait) + Catch(finalize 실패)를 포함한다", () => {
      const sms = template.findResources("AWS::StepFunctions::StateMachine");
      const prov = Object.values(sms).find((s) =>
        String((s.Properties as Record<string, unknown>)["StateMachineName"]) === "apphub-dev-provision-app",
      );
      const defStr = (prov!.Properties as Record<string, unknown>)["DefinitionString"] as
        | string
        | { "Fn::Join": [string, unknown[]] };
      const joined =
        typeof defStr === "string"
          ? defStr
          : defStr["Fn::Join"][1].filter((x) => typeof x === "string").join("");
      // 빌드 폴링 성공 조건 + Wait + Catch.
      expect(joined).toContain("SUCCEEDED");
      expect(joined).toContain('"Type":"Wait"');
      expect(joined).toContain('"Type":"Choice"');
      expect(joined).toContain("States.ALL"); // Catch
    });

    it("DeleteApp ASL은 스택 삭제 폴링(DELETE_COMPLETE) 루프를 포함한다", () => {
      const sms = template.findResources("AWS::StepFunctions::StateMachine");
      const del = Object.values(sms).find((s) =>
        String((s.Properties as Record<string, unknown>)["StateMachineName"]) === "apphub-dev-delete-app",
      );
      const defStr = (del!.Properties as Record<string, unknown>)["DefinitionString"] as
        | string
        | { "Fn::Join": [string, unknown[]] };
      const joined =
        typeof defStr === "string"
          ? defStr
          : defStr["Fn::Join"][1].filter((x) => typeof x === "string").join("");
      expect(joined).toContain("DELETE_COMPLETE");
      expect(joined).toContain('"Type":"Wait"');
      expect(joined).toContain("States.ALL");
    });
  });

  describe("API 역할 — codepipeline:StartPipelineExecution (수동 배포/롤백, M5)", () => {
    it("앱 파이프라인 ARN(apphub-dev-app-*)으로 범위 한정 부여", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const raw = JSON.stringify(Object.values(policies));
      expect(raw).toContain("codepipeline:StartPipelineExecution");
      // Resource:"*" 아님 — 앱 파이프라인 접두어 포함.
      expect(raw).toContain("apphub-dev-app-*");
    });
  });

  describe("관측성 — CloudWatch 대시보드 (DESIGN 9)", () => {
    it("관리자 대시보드가 존재한다", () => {
      template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: "apphub-dev-admin",
      });
    });
  });

  describe("보안 — 시크릿 평문 부재 + Export 미사용", () => {
    it("템플릿 전체에 평문 시크릿 리터럴이 없다", () => {
      // 시크릿 값을 환경변수/파라미터에 박지 않았는지 조잡한 감시(계약: Secrets Manager만).
      const raw = JSON.stringify(template.toJSON());
      expect(raw).not.toMatch(/password['"]?\s*:\s*['"][^'"]{6,}/i);
      expect(raw).not.toMatch(/AKIA[0-9A-Z]{16}/); // AWS access key 패턴
    });

    it("Outputs에 Export가 없다(cdk-authoring)", () => {
      const json = template.toJSON() as {
        Outputs?: Record<string, { Export?: unknown }>;
      };
      for (const [name, out] of Object.entries(json.Outputs ?? {})) {
        expect(out.Export, `Output ${name}에 Export 금지`).toBeUndefined();
      }
    });

    it("공유 참조를 SSM 파라미터로 발행한다", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/platform/table-name",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/platform/user-pool-id",
      });
    });
  });
});
