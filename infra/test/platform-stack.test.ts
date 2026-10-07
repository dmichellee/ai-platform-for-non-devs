import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { PlatformStack } from "../lib/platform-stack";
import { assertNoOpenIngress } from "./helpers/sg-ingress";
import { testConfig, testEnv } from "./helpers/config";

/**
 * L2 — platform 스택 CDK assertions.
 * D13(컨트롤 플레인 구성), 데이터 모델(단일 테이블 + GSI), D12(관리자 초대),
 * 보안(SPA 비공개 S3, 시크릿 평문 부재)을 단언한다.
 */
function synth(): Template {
  const app = new App();
  const config = testConfig("dev");
  const stack = new PlatformStack(app, "apphub-dev-platform", {
    stage: "dev",
    config,
    env: testEnv(config),
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

    it("[D21] SPA 클라이언트는 USER_PASSWORD_AUTH 허용 + Hosted UI OAuth 비활성 + 토큰 폐기 활성", () => {
      // 자체 로그인 화면이 cognito-idp를 직접 호출(InitiateAuth USER_PASSWORD_AUTH/REFRESH_TOKEN_AUTH,
      //  RevokeToken). OAuth 플로우·콜백 URL은 플랫폼 로그인에 쓰지 않는다(D21).
      const clients = template.findResources("AWS::Cognito::UserPoolClient");
      const spa = Object.values(clients).find(
        (c) => (c.Properties as Record<string, unknown>)["GenerateSecret"] === false,
      );
      expect(spa, "SPA client(GenerateSecret:false)가 존재해야 함").toBeDefined();
      const props = spa!.Properties as Record<string, unknown>;
      expect(props["ExplicitAuthFlows"]).toEqual(
        expect.arrayContaining(["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]),
      );
      expect(props["AllowedOAuthFlowsUserPoolClient"]).toBe(false);
      expect(props["AllowedOAuthFlows"]).toBeUndefined();
      expect(props["CallbackURLs"]).toBeUndefined();
      expect(props["LogoutURLs"]).toBeUndefined();
      expect(props["EnableTokenRevocation"]).toBe(true);
    });

    it("[N1] 공유 AppAuthClient(와일드카드 콜백)와 SSM app-auth-client-id가 없다 — 앱별 클라이언트는 runtime 소유", () => {
      const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient")).map(
        (c) => c.Properties as Record<string, unknown>,
      );
      // platform에는 SPA 클라이언트 1개만(시크릿 없음).
      expect(clients.length).toBe(1);
      expect(clients.some((c) => c["GenerateSecret"] === true)).toBe(false);
      // 와일드카드 콜백 잔재 금지.
      expect(JSON.stringify(template.toJSON())).not.toContain("https://*.");
      const names = Object.values(template.findResources("AWS::SSM::Parameter")).map((p) =>
        String((p.Properties as Record<string, unknown>)["Name"]),
      );
      expect(names).not.toContain("/apphub/dev/platform/app-auth-client-id");
      // runtime이 읽는 계약 키는 계속 발행(user-pool-id/arn/domain).
      expect(names).toEqual(
        expect.arrayContaining([
          "/apphub/dev/platform/user-pool-id",
          "/apphub/dev/platform/user-pool-arn",
          "/apphub/dev/platform/user-pool-domain",
        ]),
      );
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
            // D18: 관리자 강제 중지(sleep_app(force=True))가 in-process ECS 조작 시 cluster 인자로 쓴다.
            //  app/wake/__init__.py cluster_name()이 이 env를 읽음(미주입 시 RuntimeError, 폴백 없음).
            //  결정론적 이름 직접 주입 → network commonEnv와 동일 규약.
            CLUSTER_NAME: "apphub-dev-cluster",
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

    describe("Gateway Responses — authorizer 401/403에 CORS 헤더 부착", () => {
      // 회귀 방지: authorizer가 토큰 만료/부재로 401/403을 게이트웨이 단에서 반환할 때 CORS 헤더가
      //  없으면 브라우저가 응답 status를 읽지 못하고 "CORS 에러"로 오인 → 프론트가 UNAUTHENTICATED를
      //  처리할 수 없다. UNAUTHORIZED/ACCESS_DENIED/DEFAULT_4XX/DEFAULT_5XX에 Allow-Origin/Headers를 단다.
      const EXPECTED_TYPES = ["UNAUTHORIZED", "ACCESS_DENIED", "DEFAULT_4XX", "DEFAULT_5XX"];

      it("4종 GatewayResponse 리소스가 CORS 헤더와 함께 존재한다", () => {
        template.resourceCountIs("AWS::ApiGateway::GatewayResponse", EXPECTED_TYPES.length);
        const responses = template.findResources("AWS::ApiGateway::GatewayResponse");
        const byType = new Map<string, Record<string, unknown>>();
        for (const r of Object.values(responses)) {
          const props = r.Properties as Record<string, unknown>;
          byType.set(String(props["ResponseType"]), props);
        }
        for (const type of EXPECTED_TYPES) {
          const props = byType.get(type);
          expect(props, `${type} GatewayResponse가 존재해야 함`).toBeDefined();
          const params = props!["ResponseParameters"] as Record<string, unknown>;
          // Access-Control-Allow-Origin 헤더가 매핑된다(브라우저가 401을 읽게 하는 핵심).
          const originVal = params["gatewayresponse.header.Access-Control-Allow-Origin"];
          expect(originVal, `${type}에 Allow-Origin 헤더 필요`).toBeDefined();
          // 정적 문자열은 single-quote로 감싼다('https://...'). CloudFront 도메인은 Fn::Join으로 렌더되며,
          //  join 조각에 여는 따옴표 `'https://`가 나타난다(와일드카드 * 아님).
          const originJson = JSON.stringify(originVal);
          expect(originJson).toContain("'https://");
          expect(originJson).not.toContain("'*'");
          // Access-Control-Allow-Headers 헤더도 정적값으로 단다.
          expect(params["gatewayresponse.header.Access-Control-Allow-Headers"]).toBe(
            "'Authorization,Content-Type'",
          );
        }
      });

      it("UNAUTHORIZED GatewayResponse의 Allow-Origin은 콘솔 주소(https://console.{appsDomain})다 (D19)", () => {
        const responses = template.findResources("AWS::ApiGateway::GatewayResponse");
        const unauthorized = Object.values(responses).find(
          (r) => (r.Properties as Record<string, unknown>)["ResponseType"] === "UNAUTHORIZED",
        );
        expect(unauthorized, "UNAUTHORIZED GatewayResponse가 존재해야 함").toBeDefined();
        const params = (unauthorized!.Properties as Record<string, Record<string, unknown>>)[
          "ResponseParameters"
        ];
        expect(params["gatewayresponse.header.Access-Control-Allow-Origin"]).toBe(
          "'https://console.apps-dev.example.test'",
        );
      });
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

    it("KiroConfigUrlPath Output(OS별 2개)이 발행된다(프론트 다운로드 링크 계약, P-M7-01)", () => {
      const json = template.toJSON() as { Outputs?: Record<string, { Value?: unknown }> };
      const keys = Object.keys(json.Outputs ?? {});
      // OS별 2개 Output. 기존 단일 KiroConfigUrlPath는 제거됐다(하위호환 없음).
      expect(keys).toContain("KiroConfigUrlPathMac");
      expect(keys).toContain("KiroConfigUrlPathWindows");
      expect(keys).not.toContain("KiroConfigUrlPath");
      expect(json.Outputs!["KiroConfigUrlPathMac"].Value).toBe("/kiro-config/kiro-config-mac.zip");
      expect(json.Outputs!["KiroConfigUrlPathWindows"].Value).toBe("/kiro-config/kiro-config-windows.zip");
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

    it("Resource:'*' statement는 문서화된 예외 SID로만 허용된다(우발적 * 금지)", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      // Resource가 문자열 "*" 또는 배열 ["*"] 두 형태 모두를 잡는다.
      const isStar = (r: unknown): boolean =>
        r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");
      // 리소스 레벨 미지원 액션이라 IAM 상 "*" 필수인 정당한 예외 목록(전부 주석·문서로 정당화됨).
      //  이 SID들 외에 "*" resource가 나타나면 실패한다(최소권한 회귀 가드).
      const allowedStarSids = new Set([
        "ReadOnlyDescribeStar", // provisioner: Describe*/List*/GetAuthorizationToken (리소스 레벨 미지원 조회)
        "AppSecurityGroupManageInRegion", // provisioner: EC2 SG 생성/변경 (aws:RequestedRegion 조건, QA M-2)
        "CodeConnectionsCreateList", // API: CreateConnection/ListConnections (리소스 레벨 미지원, IAM 시뮬레이터 검증)
        "CodeCommitRepos", // API: ListRepositories/CreateRepository (리소스 레벨 미지원, IAM 시뮬레이터 검증)
        "AppMetricsRead", // API: GetMetricData/DescribeTargetGroups (리소스 레벨 미지원 read-only, 모니터링 탭)
        "AdminStopElbDescribe", // API: DescribeRules/DescribeListeners (리소스 레벨 미지원 read-only, 관리자 강제 중지)
        "DeployNotifyEcsDescribeTaskDef", // deploy-notify: ecs:DescribeTaskDefinition (리소스 레벨 미지원 read-only, D8 지연 정리)
        "DeployNotifyElbDescribe", // deploy-notify: ELB Describe (리소스 레벨 미지원 read-only, 잠든 앱 재정합)
        "AppTaskDefRead", // API: ecs:DescribeTaskDefinition (리소스 레벨 미지원 read-only, 재배포 커밋 폴백)
      ]);
      // CDK 내장 커스텀 리소스(SID 없음) 예외 — D19 public 모드 us-east-1 콘솔 인증서(DnsValidatedCertificate).
      //  acm:RequestCertificate는 생성 시점이라 리소스 레벨 미지원, 대상 인증서 ARN도 사전에 알 수 없다.
      //  액션 집합이 정확히 이 범위 안일 때만 허용(다른 액션이 섞이면 실패).
      const allowedStarActionSets: ReadonlyArray<ReadonlySet<string>> = [
        new Set(["acm:RequestCertificate", "acm:DescribeCertificate", "acm:DeleteCertificate", "acm:AddTagsToCertificate"]),
        new Set(["route53:GetChange"]),
      ];
      const actionsOf = (a: unknown): string[] => (Array.isArray(a) ? a.map(String) : [String(a)]);
      const isAllowedCdkInternal = (a: unknown): boolean =>
        allowedStarActionSets.some((set) => actionsOf(a).every((x) => set.has(x)));
      let star = 0;
      let starWithCondition = 0;
      const unexpected: string[] = [];
      for (const pol of Object.values(policies)) {
        const doc = (
          pol.Properties as {
            PolicyDocument?: {
              Statement?: Array<{ Sid?: string; Action?: unknown; Resource?: unknown; Condition?: unknown }>;
            };
          }
        ).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (isStar(st.Resource)) {
            star++;
            if (st.Condition) starWithCondition++;
            const sidOk = typeof st.Sid === "string" && allowedStarSids.has(st.Sid);
            if (!sidOk && !(st.Sid === undefined && isAllowedCdkInternal(st.Action))) {
              unexpected.push(String(st.Sid ?? "<no-sid>"));
            }
          }
        }
      }
      // 예외 목록에 없는 "*" statement가 하나라도 있으면 실패(문서 갱신 없는 * 추가 차단).
      expect(unexpected, `허용 목록 밖 Resource:"*" statement: ${unexpected.join(", ")}`).toEqual([]);
      // 예외 statement는 실제로 존재해야 한다(테스트 경로 유효성 가드).
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

  describe("[Notify] deploy-notify Lambda + EventBridge 규칙 (DESIGN 3.3)", () => {
    // 배경: [Notify] 단계(EventBridge → Lambda → DDB Deployment 갱신)가 없으면 배포 진행 상황이
    //  영원히 PENDING. platform 스택(컨트롤 플레인 소속)에 함수 + 규칙 2개 + IAM(DDB/pipeline/build)을 고정한다.
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    function stmtsBySid(sidPart: string): Stmt[] {
      const policies = template.findResources("AWS::IAM::Policy");
      const out: Stmt[] = [];
      for (const pol of Object.values(policies)) {
        const doc = (pol.Properties as { PolicyDocument?: { Statement?: Stmt[] } }).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (typeof st.Sid === "string" && st.Sid.includes(sidPart)) out.push(st);
        }
      }
      return out;
    }
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];
    const isStar = (r: unknown): boolean =>
      r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");

    it("deploy-notify 함수가 PYTHON_3_13 / handler.handler / STAGE+TABLE_NAME env로 존재한다", () => {
      // D-M8: 런타임 Python 3.13, 진입점 handler.handler(자산 루트 shim). 데이터 계층이 요구하는
      //  TABLE_NAME(폴백 없음)이 결정론적 apphub-dev-main으로 주입된다(task Lambda와 동일 규약).
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-deploy-notify",
        Runtime: "python3.13",
        Handler: "handler.handler",
        Environment: {
          Variables: Match.objectLike({ STAGE: "dev", TABLE_NAME: "apphub-dev-main" }),
        },
      });
    });

    it("deploy-notify 로그 그룹(/apphub/dev/deploy-notify)이 1개월 retention으로 생성된다", () => {
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/apphub/dev/deploy-notify",
        RetentionInDays: 30,
      });
    });

    it("규칙 (1) stage: CodePipeline Stage Execution State Change + pipeline prefix apphub-dev-app-", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "apphub-dev-deploy-notify-stage",
        EventPattern: Match.objectLike({
          source: ["aws.codepipeline"],
          "detail-type": ["CodePipeline Stage Execution State Change"],
          detail: Match.objectLike({
            pipeline: [{ prefix: "apphub-dev-app-" }],
          }),
        }),
      });
    });

    it("규칙 (2) exec: CodePipeline Pipeline Execution State Change + pipeline prefix apphub-dev-app-", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "apphub-dev-deploy-notify-exec",
        EventPattern: Match.objectLike({
          source: ["aws.codepipeline"],
          "detail-type": ["CodePipeline Pipeline Execution State Change"],
          detail: Match.objectLike({
            pipeline: [{ prefix: "apphub-dev-app-" }],
          }),
        }),
      });
    });

    it("규칙 3개 모두 deploy-notify Lambda를 EventBridge InvokePermission으로 호출한다", () => {
      // 규칙 → Lambda invoke 권한(Principal events.amazonaws.com)이 deploy-notify 함수 대상으로 2건 이상.
      const perms = template.findResources("AWS::Lambda::Permission");
      const notifyInvokes = Object.values(perms).filter((p) => {
        const props = p.Properties as Record<string, unknown>;
        const fnRef = JSON.stringify(props["FunctionName"]);
        return (
          props["Principal"] === "events.amazonaws.com" &&
          props["Action"] === "lambda:InvokeFunction" &&
          fnRef.includes("DeployNotifyFn")
        );
      });
      expect(notifyInvokes.length).toBeGreaterThanOrEqual(3);
    });

    it("IAM (1) DDB GetItem/PutItem/UpdateItem/Query가 apphub-dev-main 테이블 + index/*로 범위 한정된다", () => {
      const stmts = stmtsBySid("DeployNotifyTableRw");
      expect(stmts.length, "DeployNotifyTableRw statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(
        expect.arrayContaining([
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]),
      );
      const resJson = JSON.stringify(st.Resource);
      // 테이블 ARN + index/* (GSI Query 대비). Resource:"*" 아님.
      expect(resJson).toContain("table/apphub-dev-main");
      expect(resJson).toContain("index/*");
      expect(isStar(st.Resource), "DDB는 범위 한정(* 아님)").toBe(false);
    });

    it("IAM (2) codepipeline GetPipelineExecution/ListActionExecutions가 앱 파이프라인 ARN(apphub-dev-app-*)으로 한정된다", () => {
      const stmts = stmtsBySid("DeployNotifyPipelineRead");
      expect(stmts.length, "DeployNotifyPipelineRead statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(
        expect.arrayContaining([
          "codepipeline:GetPipelineExecution",
          "codepipeline:ListActionExecutions",
        ]),
      );
      const resJson = JSON.stringify(st.Resource);
      expect(resJson).toContain("apphub-dev-app-*");
      expect(isStar(st.Resource), "codepipeline read는 범위 한정(* 아님)").toBe(false);
    });

    it("IAM (3) codebuild BatchGetBuilds가 앱 CodeBuild 프로젝트 ARN(project/apphub-dev-app-*)으로 한정된다", () => {
      const stmts = stmtsBySid("DeployNotifyBuildRead");
      expect(stmts.length, "DeployNotifyBuildRead statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(["codebuild:BatchGetBuilds"]);
      const resJson = JSON.stringify(st.Resource);
      // BatchGetBuilds는 리소스 레벨(project ARN) 지원 → 앱 프로젝트로 한정, Resource:"*" 아님.
      expect(resJson).toContain("project/apphub-dev-app-*");
      expect(isStar(st.Resource), "codebuild BatchGetBuilds는 범위 한정(* 아님)").toBe(false);
    });

    it("deploy-notify IAM(DescribeTaskDefinition 예외 제외) 어디에도 Resource:'*'가 없다(전부 ARN 범위 한정)", () => {
      // 회귀 가드: 아래 statement 전부 리소스 레벨 지원 액션이라 * 예외가 없어야 한다.
      for (const sid of [
        "DeployNotifyTableRw",
        "DeployNotifyPipelineRead",
        "DeployNotifyBuildRead",
        "DeployNotifySecretPrune",
        "DeployNotifyEcsService",
        "DeployNotifyNetworkSsmRead",
        "DeployNotifyElbModifyRule",
        "DeployNotifyCognitoDescribeClient",
      ]) {
        for (const st of stmtsBySid(sid)) {
          expect(isStar(st.Resource), `${sid}에 Resource:"*" 금지`).toBe(false);
        }
      }
    });

    it("IAM (4) D8 지연 정리 — GetSecretValue/PutSecretValue가 앱 시크릿 path ARN(apphub/dev/app/*)으로만 부여된다", () => {
      const stmts = stmtsBySid("DeployNotifySecretPrune");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action).sort()).toEqual(
        ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"].sort(),
      );
      const resJson = JSON.stringify(stmts[0].Resource);
      expect(resJson).toContain("secret:apphub/dev/app/*");
      // 삭제·생성 권한은 deploy-notify에 없다(정리=Put만).
      expect(asArray(stmts[0].Action)).not.toContain("secretsmanager:DeleteSecret");
    });

    it("IAM (5) ecs Describe/UpdateService는 공유 클러스터 앱 서비스 ARN, DescribeTaskDefinition만 * 예외(read-only 단독)", () => {
      const svc = stmtsBySid("DeployNotifyEcsService");
      expect(svc.length).toBe(1);
      expect(asArray(svc[0].Action).sort()).toEqual(["ecs:DescribeServices", "ecs:UpdateService"]);
      expect(JSON.stringify(svc[0].Resource)).toContain("service/apphub-dev-cluster/apphub-dev-app-*");
      const td = stmtsBySid("DeployNotifyEcsDescribeTaskDef");
      expect(td.length).toBe(1);
      // * 예외 statement에는 다른 액션이 섞이지 않는다(우발적 확대 방지).
      expect(asArray(td[0].Action)).toEqual(["ecs:DescribeTaskDefinition"]);
      expect(isStar(td[0].Resource)).toBe(true);
    });

    it("IAM (6) 잠든 앱 재정합(sleep_app) — SSM network/*, ModifyRule listener-rule/app/*, cognito DescribeUserPoolClient(User Pool 한정)", () => {
      const ssmSt = stmtsBySid("DeployNotifyNetworkSsmRead");
      expect(ssmSt.length).toBe(1);
      expect(JSON.stringify(ssmSt[0].Resource)).toContain("parameter/apphub/dev/network/*");
      const mr = stmtsBySid("DeployNotifyElbModifyRule");
      expect(mr.length).toBe(1);
      // D20 계약 §7: 플랫폼 ALB(n=0 + 증설 `apphub-dev-{slug}-alb-{n}`) 접두어로 한정.
      expect(JSON.stringify(mr[0].Resource)).toContain("listener-rule/app/apphub-dev-*/*");
      const cg = stmtsBySid("DeployNotifyCognitoDescribeClient");
      expect(cg.length).toBe(1);
      expect(asArray(cg[0].Action)).toEqual(["cognito-idp:DescribeUserPoolClient"]);
      const poolId = Object.keys(template.findResources("AWS::Cognito::UserPool"))[0];
      expect(cg[0].Resource).toEqual({ "Fn::GetAtt": [poolId, "Arn"] });
    });

    it("env CLUSTER_NAME=apphub-dev-cluster 가 주입된다(sleep_app·시크릿 정리의 서비스 조회)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-deploy-notify",
        Environment: { Variables: Match.objectLike({ CLUSTER_NAME: "apphub-dev-cluster" }) },
      });
    });

    it("규칙 (3) build: provisioner CodeBuild Build State Change → deploy-notify (롤백·시크릿 재배포)", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "apphub-dev-deploy-notify-build",
        EventPattern: {
          source: ["aws.codebuild"],
          "detail-type": ["CodeBuild Build State Change"],
          detail: { "project-name": [Match.anyValue()] },
        },
        Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
      });
    });

    it("DeployNotifyFunctionArn Output이 발행된다", () => {
      const json = template.toJSON() as { Outputs?: Record<string, unknown> };
      expect(Object.keys(json.Outputs ?? {})).toContain("DeployNotifyFunctionArn");
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

  describe("API 역할 — codeconnections (레포 연결 생성/조회/삭제)", () => {
    // 회귀 방지: github/gitlab 연결 생성 시 AccessDenied(500). 근본 원인은 CreateConnection이
    //  리소스 레벨 미지원(생성 시점 connection ARN 부재)인데 connection/* 로 한정한 것.
    //  액션별 리소스 범위를 고정한다:
    //   - CreateConnection / ListConnections → codeconnections 서비스 스코프(connection 세그먼트 없음).
    //   - GetConnection / DeleteConnection → connection/* 로 한정.
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    function stmtsBySid(sidPart: string): Stmt[] {
      const policies = template.findResources("AWS::IAM::Policy");
      const out: Stmt[] = [];
      for (const pol of Object.values(policies)) {
        const doc = (
          pol.Properties as { PolicyDocument?: { Statement?: Stmt[] } }
        ).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (typeof st.Sid === "string" && st.Sid.includes(sidPart)) out.push(st);
        }
      }
      return out;
    }
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];

    it("CreateConnection/ListConnections는 Resource:'*' 여야 한다(리소스 레벨 미지원 → IAM 매칭 요건)", () => {
      const stmts = stmtsBySid("CodeConnectionsCreateList");
      expect(stmts.length, "CodeConnectionsCreateList statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "codeconnections:CreateConnection",
          "codeconnections:ListConnections",
        ]),
      );
      // 근본 원인 회귀 방지: 이 두 액션은 리소스 레벨 미지원이라 IAM 상 진짜 전역 "*" 만 매칭된다.
      //  계정/리전 한정 ARN(arn:...:*)이나 connection/* 로 좁히면 implicitDeny로 500이 재발한다.
      //  (IAM 정책 시뮬레이터로 검증: `arn:...:*` → implicitDeny, `*` → allowed)
      const isStar = (r: unknown): boolean =>
        r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");
      expect(isStar(st.Resource), `Resource는 "*" 여야 함(현재: ${JSON.stringify(st.Resource)})`).toBe(true);
    });

    it("GetConnection/DeleteConnection은 connection/* 로 범위를 유지한다(리소스 레벨 지원)", () => {
      const stmts = stmtsBySid("CodeConnectionsGetDelete");
      expect(stmts.length, "CodeConnectionsGetDelete statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "codeconnections:GetConnection",
          "codeconnections:DeleteConnection",
        ]),
      );
      // 이 statement는 connection/* 로 한정된다.
      const resJson = JSON.stringify(st.Resource);
      expect(resJson).toContain("connection/");
      // Create/List가 이 (범위 좁은) statement에 섞여 들어가면 안 된다(회귀 방지).
      expect(actions).not.toContain("codeconnections:CreateConnection");
      expect(actions).not.toContain("codeconnections:ListConnections");
    });

    it("API 역할에는 UseConnection/PassConnection을 부여하지 않는다(소스 소비는 CodePipeline 역할 몫)", () => {
      const raw = JSON.stringify(
        Object.values(template.findResources("AWS::IAM::Policy")),
      );
      // API 핸들러 역할 정책 문서 어디에도 UseConnection/PassConnection이 없다.
      //  (앱 파이프라인은 별도 스택/construct라 이 platform 템플릿에 포함되지 않는다.)
      expect(raw).not.toContain("codeconnections:UseConnection");
      expect(raw).not.toContain("codeconnections:PassConnection");
    });
  });

  describe("API 역할 — codecommit (레포 목록/생성/조회: GET/POST /connections/{connId}/repos)", () => {
    // 회귀 방지: 레포 목록/생성 API가 codecommit boto3 호출 시 AccessDenied(500). 근본 원인은
    //  ListRepositories/CreateRepository가 리소스 레벨 미지원(생성 시점 ARN 부재 / List는 계정 전역)인데
    //  계정/리전 한정 ARN으로 좁힌 것. codeconnections(CreateConnection/ListConnections)와 동일한 교훈.
    //  액션별 리소스 범위를 고정한다(IAM 정책 시뮬레이터 검증):
    //   - ListRepositories / CreateRepository → Resource:"*" (arn:...:* 는 implicitDeny).
    //   - GetRepository → 계정/리전 스코프 ARN(리소스 레벨 지원).
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    function stmtsBySid(sidPart: string): Stmt[] {
      const policies = template.findResources("AWS::IAM::Policy");
      const out: Stmt[] = [];
      for (const pol of Object.values(policies)) {
        const doc = (
          pol.Properties as { PolicyDocument?: { Statement?: Stmt[] } }
        ).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (typeof st.Sid === "string" && st.Sid.includes(sidPart)) out.push(st);
        }
      }
      return out;
    }
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];
    const isStar = (r: unknown): boolean =>
      r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");

    it("ListRepositories/CreateRepository는 Resource:'*' 여야 한다(리소스 레벨 미지원 → IAM 매칭 요건)", () => {
      const stmts = stmtsBySid("CodeCommitRepos");
      expect(stmts.length, "CodeCommitRepos statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "codecommit:ListRepositories",
          "codecommit:CreateRepository",
        ]),
      );
      // 근본 원인 회귀 방지: 이 두 액션은 리소스 레벨 미지원이라 IAM 상 진짜 전역 "*" 만 매칭된다.
      //  계정/리전 한정 ARN(arn:...:*)으로 좁히면 implicitDeny로 500이 재발한다.
      //  (IAM 정책 시뮬레이터로 검증: `arn:...:*` → implicitDeny, `*` → allowed)
      expect(isStar(st.Resource), `Resource는 "*" 여야 함(현재: ${JSON.stringify(st.Resource)})`).toBe(true);
      // GetRepository(범위 좁은 statement)가 이 * statement에 섞여 들어가면 안 된다.
      expect(actions).not.toContain("codecommit:GetRepository");
    });

    it("GetRepository/DeleteRepository는 계정/리전 스코프 ARN으로 한정한다(리소스 레벨 지원, Resource:'*' 아님)", () => {
      const stmts = stmtsBySid("CodeCommitRepoManage");
      expect(stmts.length, "CodeCommitRepoManage statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining(["codecommit:GetRepository", "codecommit:DeleteRepository"]),
      );
      // Resource:"*" 아님 — codecommit 서비스+리전+계정 스코프 ARN이어야 한다.
      expect(isStar(st.Resource), `Resource는 "*"가 아니어야 함(현재: ${JSON.stringify(st.Resource)})`).toBe(false);
      const resJson = JSON.stringify(st.Resource);
      // formatArn(service:"codecommit")은 리전/계정을 채운 arn:aws:codecommit:{region}:{account}:* 형태.
      expect(resJson).toContain("codecommit");
      expect(resJson).toContain("ap-northeast-2"); // 배포 리전 한정
      // Create/List(전역 * statement)가 이 좁은 statement에 섞여 들어가면 안 된다(회귀 방지).
      expect(actions).not.toContain("codecommit:CreateRepository");
      expect(actions).not.toContain("codecommit:ListRepositories");
    });
  });

  describe("API 역할 — 관리자 강제 중지 (POST /admin/apps/{id}/stop → sleep_app(force=True), D18)", () => {
    // 회귀 방지: 관리자 강제 중지는 API Lambda 프로세스 안에서(비동기 아님) 앱을 재운다:
    //  ECS desiredCount=0 + 리스너 규칙 forward를 공유 Waker TG로 전환 + SSM(network) 읽기.
    //  이 권한이 없으면 (a) CLUSTER_NAME RuntimeError, (b) ECS/SSM/ELB AccessDenied로 깨진다.
    //  network wake Lambda(waker/sleep)와 동일 ARN 패턴을 API 역할에 부여했는지 고정한다.
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    function stmtsBySid(sidPart: string): Stmt[] {
      const policies = template.findResources("AWS::IAM::Policy");
      const out: Stmt[] = [];
      for (const pol of Object.values(policies)) {
        const doc = (pol.Properties as { PolicyDocument?: { Statement?: Stmt[] } }).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (typeof st.Sid === "string" && st.Sid.includes(sidPart)) out.push(st);
        }
      }
      return out;
    }
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];

    it("ecs:UpdateService/DescribeServices가 공유 클러스터 경로 ARN(service/{prefix}-cluster/{prefix}-app-*)으로 부여된다", () => {
      const stmts = stmtsBySid("AdminStopEcs");
      expect(stmts.length, "AdminStopEcs statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining(["ecs:DescribeServices", "ecs:UpdateService"]),
      );
      // D18: 공유 클러스터 경로. 클러스터명=서비스명 가정(구 경로)이 아니라 service/{cluster}/{service}.
      const resJson = JSON.stringify(st.Resource);
      expect(resJson).toContain("apphub-dev-cluster/apphub-dev-app-*");
      // Resource:"*" 아님(범위 한정).
      expect(resJson).not.toBe('"*"');
    });

    it("ssm:GetParameter/GetParameters가 network 경로(/apphub/{stage}/network/*)로 부여된다", () => {
      const stmts = stmtsBySid("ReadNetworkSsm");
      expect(stmts.length, "ReadNetworkSsm statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining(["ssm:GetParameter", "ssm:GetParameters"]),
      );
      const resJson = JSON.stringify(st.Resource);
      // sleep_app은 network 경로만 읽는다(listener ARN·waker-tg-arn·apps-domain). platform 경로 불필요.
      expect(resJson).toContain("apphub/dev/network/*");
    });

    it("elasticloadbalancing:ModifyRule이 listener-rule/app 범위로 부여된다(Resource:'*' 아님)", () => {
      const stmts = stmtsBySid("AdminStopElbRules");
      expect(stmts.length, "AdminStopElbRules statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(["elasticloadbalancing:ModifyRule"]);
      const resJson = JSON.stringify(st.Resource);
      expect(resJson).toContain("listener-rule/app");
      const isStar = (r: unknown): boolean =>
        r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");
      expect(isStar(st.Resource), "ModifyRule은 리소스 레벨 지원 → * 아님").toBe(false);
    });

    it("DescribeRules/DescribeListeners는 Resource:'*'(리소스 레벨 미지원), DescribeTargetGroups는 중복 추가하지 않는다", () => {
      const stmts = stmtsBySid("AdminStopElbDescribe");
      expect(stmts.length, "AdminStopElbDescribe statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      const actions = asArray(st.Action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeListeners",
        ]),
      );
      // DescribeTargetGroups는 AppMetricsRead에 이미 있으므로 이 sid엔 없어야 한다(중복 금지).
      expect(actions).not.toContain("elasticloadbalancing:DescribeTargetGroups");
    });
  });

  describe("API 역할 — 시크릿 CRUD · 롤백 (secret/ECR/StartBuild, D-M5-03)", () => {
    // 회귀 방지 핵심: backend는 시크릿을 `apphub/{stage}/app/{appId}/{KEY}`(슬래시)로 만든다.
    //  이전 하이픈 규약(`apphub-{stage}-*`)은 이 이름을 커버하지 못해 DeleteSecret이 라이브에서
    //  AccessDenied 났다. API 역할(CRUD)과 delete-task(DeleteSecret)가 **동일한 path 스타일 ARN**
    //  (`arn:...:secret:apphub/{stage}/app/*`)을 쓰는지 고정한다. path 뒤 `*`가 하위 경로 +
    //  Secrets Manager 6자 랜덤 suffix를 모두 커버한다(AWS "Access all secrets in a path").
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    function stmtsBySid(sidPart: string): Stmt[] {
      const policies = template.findResources("AWS::IAM::Policy");
      const out: Stmt[] = [];
      for (const pol of Object.values(policies)) {
        const doc = (pol.Properties as { PolicyDocument?: { Statement?: Stmt[] } }).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (typeof st.Sid === "string" && st.Sid.includes(sidPart)) out.push(st);
        }
      }
      return out;
    }
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];
    const isStar = (r: unknown): boolean =>
      r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");

    it("secretsmanager CRUD(Create/Put/Get/Describe/Delete)가 path 스타일 시크릿 ARN(apphub/{stage}/app/*)으로 부여된다", () => {
      const stmts = stmtsBySid("AppSecretsCrud");
      expect(stmts.length, "AppSecretsCrud statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(
        expect.arrayContaining([
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:GetSecretValue", // D8: 앱당 JSON 1개 — KEY upsert 시 읽어서 병합
          "secretsmanager:DescribeSecret",
          "secretsmanager:DeleteSecret",
        ]),
      );
      const resJson = JSON.stringify(st.Resource);
      // path 스타일(슬래시). backend 이름 규약을 커버한다.
      expect(resJson).toContain("secret:apphub/dev/app/*");
      // 회귀 가드: 옛 하이픈 규약(apphub-dev-*)이 아니어야 한다(AccessDenied 원인).
      expect(resJson).not.toContain("secret:apphub-dev-*");
      expect(isStar(st.Resource), "시크릿 ARN은 범위 한정(* 아님)").toBe(false);
    });

    it("delete-task의 DeleteSecret도 API 역할과 동일한 path 스타일 ARN을 쓴다(단일 소스 통일)", () => {
      const stmts = stmtsBySid("DeleteAppSecrets");
      expect(stmts.length, "DeleteAppSecrets statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(["secretsmanager:DeleteSecret"]);
      const resJson = JSON.stringify(st.Resource);
      // 라이브 AccessDenied 회귀 방지: path 스타일이어야 하고 옛 하이픈 규약이면 안 된다.
      expect(resJson).toContain("secret:apphub/dev/app/*");
      expect(resJson).not.toContain("secret:apphub-dev-*");
    });

    it("ecr:DescribeImages(롤백 이미지 태그 확인)가 앱 ECR 리포 ARN(repository/apphub-{stage}-app-*)으로 부여된다", () => {
      const stmts = stmtsBySid("AppEcrImages");
      expect(stmts.length, "AppEcrImages statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(["ecr:DescribeImages"]);
      const resJson = JSON.stringify(st.Resource);
      expect(resJson).toContain("repository/apphub-dev-app-*");
      // ecr:DescribeImages는 repository ARN 지원 → Resource:"*" 아님.
      expect(isStar(st.Resource), "ecr:DescribeImages는 범위 한정(* 아님)").toBe(false);
    });

    it("codebuild:StartBuild(롤백 runtime 재배포)가 provisioner 프로젝트 ARN으로 부여된다(task Lambda와 동일 대상)", () => {
      const stmts = stmtsBySid("StartProvisionerBuild");
      expect(stmts.length, "StartProvisionerBuild statement가 존재해야 함").toBe(1);
      const st = stmts[0];
      expect(asArray(st.Action)).toEqual(["codebuild:StartBuild"]);
      const resJson = JSON.stringify(st.Resource);
      // 기존 provisionerBuildArn 상수 재사용 — apphub-dev-provisioner 프로젝트.
      expect(resJson).toContain("project/apphub-dev-provisioner");
      expect(isStar(st.Resource), "StartBuild는 범위 한정(* 아님)").toBe(false);
    });
  });

  describe("API 역할 — QA M6 배포 로그 조회 · M4 자동 배포 토글 (2026-10-08)", () => {
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    type Pol = { Roles?: unknown; PolicyDocument?: { Statement?: Stmt[] } };
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];
    const isStar = (r: unknown): boolean =>
      r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*");
    /** API Lambda(apphub-dev-api) 실행 역할에 붙은 정책 statement만. */
    function apiRoleStmts(): Stmt[] {
      const fns = template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "apphub-dev-api" },
      });
      const role = (Object.values(fns)[0].Properties as { Role: { "Fn::GetAtt": [string, string] } }).Role;
      const roleId = role["Fn::GetAtt"][0];
      const out: Stmt[] = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const p = pol.Properties as Pol;
        if (!JSON.stringify(p.Roles).includes(`"${roleId}"`)) continue;
        out.push(...(p.PolicyDocument?.Statement ?? []));
      }
      return out;
    }
    const bySid = (sid: string): Stmt[] => apiRoleStmts().filter((st) => st.Sid === sid);
    const resourcesOf = (st: Stmt): string[] =>
      (Array.isArray(st.Resource) ? st.Resource : [st.Resource]).map((r) => JSON.stringify(r));

    it("[M6/F4] codepipeline ListActionExecutions만(GetPipelineExecution은 deploy-notify 전용) — 앱 파이프라인(apphub-dev-app-*) 한정", () => {
      const stmts = bySid("DeployLogsPipelineRead");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action)).toEqual(["codepipeline:ListActionExecutions"]);
      // API 역할 어디에도 GetPipelineExecution 없음(최소권한).
      for (const st of apiRoleStmts()) expect(asArray(st.Action)).not.toContain("codepipeline:GetPipelineExecution");
      const res = resourcesOf(stmts[0]);
      expect(res.length).toBe(1);
      expect(res[0]).toContain(":apphub-dev-app-*");
      expect(isStar(stmts[0].Resource)).toBe(false);
    });

    it("[M6/M4] codebuild BatchGetBuilds만(ListBuildsForProject 없음) — 앱 프로젝트 + provisioner 2개 ARN만", () => {
      const stmts = bySid("DeployLogsBuildRead");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action)).toEqual(["codebuild:BatchGetBuilds"]);
      // 최소권한 — backend는 저장된 빌드 ID를 BatchGetBuilds로 조회한다. API 역할 어디에도 ListBuildsForProject 없음.
      for (const st of apiRoleStmts()) expect(asArray(st.Action)).not.toContain("codebuild:ListBuildsForProject");
      const res = resourcesOf(stmts[0]);
      expect(res.length).toBe(2);
      expect(res.some((r) => r.includes("project/apphub-dev-app-*"))).toBe(true);
      expect(res.some((r) => r.includes("project/apphub-dev-provisioner"))).toBe(true);
      expect(isStar(stmts[0].Resource)).toBe(false);
    });

    it("[M6] 앱 빌드 로그 그룹(/apphub/dev/app/{appId}/build)은 AppLogsFilter(/apphub/dev/app/*)가 커버 — 중복 statement 없음", () => {
      const stmts = bySid("AppLogsFilter");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action)).toEqual(
        expect.arrayContaining(["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"]),
      );
      const res = resourcesOf(stmts[0]);
      expect(res.some((r) => r.includes("log-group:/apphub/dev/app/*"))).toBe(true);
      // app-pipeline buildLogGroup 규약이 이 접두어 아래에 있음을 고정(규약이 바뀌면 이 테스트로 감지).
      const pipelineSrc = readFileSync(path.join(__dirname, "..", "lib", "constructs", "app-pipeline.ts"), "utf8");
      expect(pipelineSrc).toContain("logGroupName: `/apphub/${p.stage}/app/${p.appId}/build`");
    });

    it("[M6] provisioner 빌드 로그 — 명시 로그 그룹(/apphub/dev/provisioner, 30일) 1개로 한정 읽기", () => {
      const stmts = bySid("ProvisionerLogsRead");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action).sort()).toEqual(
        ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"].sort(),
      );
      // QA F3 — 그룹 ARN(FilterLogEvents/DescribeLogStreams) + 스트림 ARN(GetLogEvents) 둘 다.
      const res = resourcesOf(stmts[0]);
      expect(res.length).toBe(2);
      expect(res.some((r) => /log-group:\/apphub\/dev\/provisioner"/.test(r))).toBe(true);
      expect(res.some((r) => r.includes("log-group:/apphub/dev/provisioner:*"))).toBe(true);
      // provisioner CodeBuild가 실제로 그 로그 그룹에 쓰는지(기본 /aws/codebuild/... 아님) 고정.
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/apphub/dev/provisioner",
        RetentionInDays: 30,
      });
      template.hasResourceProperties("AWS::CodeBuild::Project", {
        Name: "apphub-dev-provisioner",
        LogsConfig: { CloudWatchLogs: Match.objectLike({ Status: "ENABLED" }) },
      });
    });

    it("[M4] provisioner StartBuild는 기존 StartProvisionerBuild로 유지 — 신규 statement에 StartBuild 중복 없음", () => {
      expect(bySid("StartProvisionerBuild").length).toBe(1);
      for (const sid of ["DeployLogsPipelineRead", "DeployLogsBuildRead", "ProvisionerLogsRead"]) {
        for (const st of bySid(sid)) expect(asArray(st.Action)).not.toContain("codebuild:StartBuild");
      }
    });
  });

  describe("QA M1 / H3 — platform SSM 읽기 · cognito DescribeUserPoolClient", () => {
    type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
    type Pol = { PolicyName?: unknown; Roles?: unknown; PolicyDocument?: { Statement?: Stmt[] } };
    function stmtsBySid(sid: string): Stmt[] {
      const out: Stmt[] = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        for (const st of (pol.Properties as Pol).PolicyDocument?.Statement ?? []) {
          if (st.Sid === sid) out.push(st);
        }
      }
      return out;
    }
    const asArray = (a: unknown): string[] =>
      Array.isArray(a) ? (a as string[]) : typeof a === "string" ? [a] : [];
    const userPoolLogicalId = (): string => Object.keys(template.findResources("AWS::Cognito::UserPool"))[0];

    it("[M1] API 역할은 /apphub/dev/platform/provisioner-project-name 1개만 정확 ARN으로 읽는다(와일드카드 아님)", () => {
      const stmts = stmtsBySid("ReadPlatformSsm");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action)).toEqual(["ssm:GetParameter"]);
      const resJson = JSON.stringify(stmts[0].Resource);
      expect(resJson).toContain("parameter/apphub/dev/platform/provisioner-project-name");
      expect(resJson).not.toContain("platform/*");
    });

    it("[M1] 롤백·시크릿 재배포용 codebuild:StartBuild는 provisioner 프로젝트 한정으로 이미 부여된다", () => {
      const stmts = stmtsBySid("StartProvisionerBuild");
      expect(stmts.length).toBe(1);
      expect(JSON.stringify(stmts[0].Resource)).toContain("project/apphub-dev-provisioner");
    });

    it("[H3] API 역할(관리자 강제 중지 ModifyRule)에 DescribeUserPoolClient가 플랫폼 User Pool ARN으로 한정 부여된다", () => {
      const stmts = stmtsBySid("AdminStopCognitoDescribeClient");
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action)).toEqual(["cognito-idp:DescribeUserPoolClient"]);
      expect(stmts[0].Resource).toEqual({ "Fn::GetAtt": [userPoolLogicalId(), "Arn"] });
    });

    it("[N2] provisioner 역할 — 배포 전 규칙 복귀용 ModifyRule(플랫폼 ALB 규칙)·DescribeUserPoolClient(User Pool) 한정 부여", () => {
      const mr = stmtsBySid("PreDeployRuleRestore");
      expect(mr.length).toBe(1);
      expect(asArray(mr[0].Action)).toEqual(["elasticloadbalancing:ModifyRule"]);
      expect(JSON.stringify(mr[0].Resource)).toContain("listener-rule/app/apphub-dev-*/*");
      expect(mr[0].Resource).not.toBe("*");
      const cg = stmtsBySid("PreDeployCognitoDescribeClient");
      expect(cg.length).toBe(1);
      expect(asArray(cg[0].Action)).toEqual(["cognito-idp:DescribeUserPoolClient"]);
      expect(cg[0].Resource).toEqual({ "Fn::GetAtt": [userPoolLogicalId(), "Arn"] });
    });

    it("[N2] provisioner 역할 — Describe(Rules/TargetGroups/Listeners)·network SSM·DDB GetItem은 기존 statement가 커버", () => {
      const desc = stmtsBySid("ReadOnlyDescribeStar");
      expect(desc.length).toBe(1);
      expect(asArray(desc[0].Action)).toContain("elasticloadbalancing:Describe*");
      const ssmSt = stmtsBySid("ReadSharedSsm");
      expect(ssmSt.length).toBe(1);
      expect(asArray(ssmSt[0].Action)).toContain("ssm:GetParameter");
      expect(JSON.stringify(ssmSt[0].Resource)).toContain("parameter/apphub/dev/network/*");
      const ddb = stmtsBySid("AppTableRead");
      expect(ddb.length).toBe(1);
      expect(asArray(ddb[0].Action)).toEqual(["dynamodb:GetItem"]);
      // 두 PreDeploy statement는 provisioner 역할에 붙는다.
      const pols = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
        ((p.Properties as Pol).PolicyDocument?.Statement ?? []).some((st) => st.Sid === "PreDeployRuleRestore"),
      );
      expect(pols.length).toBe(1);
      expect(JSON.stringify((pols[0].Properties as Pol).Roles)).toContain("ProvisionerRole");
    });

    it("[D16] API Lambda env FRONTEND_MODE=public(기본)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-api",
        Environment: { Variables: Match.objectLike({ FRONTEND_MODE: "public" }) },
      });
    });

    it("[H3] wake-restore/sleep-transition 역할(network 소유)에 DescribeUserPoolClient를 User Pool 한정으로 부착한다", () => {
      const pols = Object.values(template.findResources("AWS::IAM::Policy")).filter(
        (p) => (p.Properties as Pol).PolicyName === "apphub-dev-wake-cognito-describe",
      );
      expect(pols.length).toBe(1);
      const props = pols[0].Properties as Pol;
      const stmts = props.PolicyDocument?.Statement ?? [];
      expect(stmts.length).toBe(1);
      expect(asArray(stmts[0].Action)).toEqual(["cognito-idp:DescribeUserPoolClient"]);
      expect(stmts[0].Resource).toEqual({ "Fn::GetAtt": [userPoolLogicalId(), "Arn"] });
      // 역할 2개 — network SSM 역할명 파라미터(배포 시점 해석)로 참조.
      expect(Array.isArray(props.Roles) && (props.Roles as unknown[]).length).toBe(2);
      const params = JSON.stringify(template.toJSON().Parameters ?? {});
      expect(params).toContain("/apphub/dev/network/wake-restore-role-name");
      expect(params).toContain("/apphub/dev/network/sleep-transition-role-name");
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
