import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { PlatformStack } from "../lib/platform-stack";
import type { FrontendMode } from "../lib/config";
import { assertNoOpenIngress, assertSgDescriptionsAscii } from "./helpers/sg-ingress";
import { testConfig, testEnv } from "./helpers/config";

/**
 * L2 — D19 플랫폼 웹 배포 모드(public / private) + D21 로그인 경로 + D20 provisioner/ASL 연동.
 * 계약: _workspace/contracts/delta-2026-10-07-d19-d21.md §4·§5·§9·§12.
 */
function synth(mode: FrontendMode, overrides?: { allowedIngressCidrs?: readonly string[] }): Template {
  const app = new App();
  const config = testConfig("dev", { frontendMode: mode, ...overrides });
  const stack = new PlatformStack(app, "apphub-dev-platform", { stage: "dev", config, env: testEnv(config) });
  return Template.fromStack(stack);
}

type Res = { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] };
const resources = (t: Template): Record<string, Res> =>
  ((t.toJSON() as { Resources?: Record<string, Res> }).Resources ?? {});
const outputs = (t: Template): Record<string, { Value?: unknown }> =>
  ((t.toJSON() as { Outputs?: Record<string, { Value?: unknown }> }).Outputs ?? {});
const ssmNames = (t: Template): string[] =>
  Object.values(t.findResources("AWS::SSM::Parameter")).map((p) =>
    String((p.Properties as Record<string, unknown>)["Name"]),
  );
const ssmValue = (t: Template, name: string): unknown => {
  const list = Object.values(t.findResources("AWS::SSM::Parameter", { Properties: { Name: name } }));
  expect(list.length, `SSM ${name}`).toBe(1);
  return (list[0].Properties as Record<string, unknown>)["Value"];
};

describe("platform — frontendMode=public (기본)", () => {
  let t: Template;
  beforeAll(() => {
    t = synth("public");
  });

  it("CloudFront 대체 도메인 console.{appsDomain} + us-east-1 인증서(같은 스택 내 커스텀 리소스)", () => {
    t.resourceCountIs("AWS::CloudFront::Distribution", 1);
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["console.apps-dev.example.test"],
        ViewerCertificate: Match.objectLike({ SslSupportMethod: "sni-only" }),
      }),
    });
    // DnsValidatedCertificate = AWS::CloudFormation::CustomResource(Region us-east-1) — 별도 스택 없음.
    const certs = Object.values(resources(t)).filter(
      (r) => r.Type === "AWS::CloudFormation::CustomResource" && r.Properties?.["DomainName"] === "console.apps-dev.example.test",
    );
    expect(certs.length).toBe(1);
    expect(certs[0].Properties?.["Region"]).toBe("us-east-1");
    expect(certs[0].Properties?.["HostedZoneId"]).toBe("Z0TEST0HOSTEDZONE0ID");
  });

  it("public zone `console` A/AAAA alias → CloudFront, private zone `console` CNAME → CloudFront 도메인", () => {
    const recs = Object.values(t.findResources("AWS::Route53::RecordSet")).map((r) => r.Properties as Record<string, unknown>);
    const pub = recs.filter((r) => r["HostedZoneId"] === "Z0TEST0HOSTEDZONE0ID");
    expect(pub.map((r) => r["Type"]).sort()).toEqual(["A", "AAAA"]);
    for (const r of pub) {
      expect(r["Name"]).toBe("console.apps-dev.example.test.");
      expect(JSON.stringify(r["AliasTarget"])).toContain("SpaDistribution");
    }
    const priv = recs.filter((r) => JSON.stringify(r["HostedZoneId"]).includes("networkprivatehostedzoneid"));
    expect(priv.length).toBe(1);
    expect(priv[0]["Type"]).toBe("CNAME");
    expect(JSON.stringify(priv[0]["ResourceRecords"])).toContain("DomainName");
  });

  it("API는 Regional, 리소스 정책 없음, VPC 엔드포인트·콘솔 ALB·ECS 없음(반대 모드 리소스 미생성)", () => {
    t.hasResourceProperties("AWS::ApiGateway::RestApi", {
      EndpointConfiguration: { Types: ["REGIONAL"] },
    });
    const api = Object.values(t.findResources("AWS::ApiGateway::RestApi"))[0].Properties as Record<string, unknown>;
    expect(api["Policy"]).toBeUndefined();
    t.resourceCountIs("AWS::EC2::VPCEndpoint", 0);
    t.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
    t.resourceCountIs("AWS::ECS::Service", 0);
    t.resourceCountIs("AWS::EC2::SecurityGroup", 0);
  });

  it("Outputs: FrontendMode/ConsoleUrl/ApiUrl(Regional)/CognitoIdpEndpoint(공용) + SPA 버킷·CloudFront", () => {
    const o = outputs(t);
    expect(o["FrontendMode"].Value).toBe("public");
    expect(o["ConsoleUrl"].Value).toBe("https://console.apps-dev.example.test");
    expect(JSON.stringify(o["ApiUrl"].Value)).toContain(".execute-api.");
    expect(JSON.stringify(o["ApiUrl"].Value)).not.toContain("-{");
    expect(o["CognitoIdpEndpoint"].Value).toBe("https://cognito-idp.ap-northeast-2.amazonaws.com/");
    for (const k of ["SpaBucketName", "CloudFrontDomain", "CloudFrontDistributionId"]) expect(o[k]).toBeDefined();
  });

  it("SSM platform/frontend-mode=public, console-url, spa-bucket-name/cloudfront-* 발행", () => {
    expect(ssmValue(t, "/apphub/dev/platform/frontend-mode")).toBe("public");
    expect(ssmValue(t, "/apphub/dev/platform/console-url")).toBe("https://console.apps-dev.example.test");
    const names = ssmNames(t);
    expect(names).toContain("/apphub/dev/platform/spa-bucket-name");
    expect(names).toContain("/apphub/dev/platform/cloudfront-domain");
  });

  it("CORS(ALLOWED_ORIGINS·preflight)는 콘솔 주소(+dev localhost) — CloudFront 기본 도메인 아님", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "apphub-dev-api",
      Environment: {
        Variables: Match.objectLike({
          ALLOWED_ORIGINS: "https://console.apps-dev.example.test,http://localhost:5173",
        }),
      },
    });
    const raw = JSON.stringify(t.findResources("AWS::ApiGateway::Method"));
    expect(raw).toContain("https://console.apps-dev.example.test");
  });

  it("[D16] API Lambda env FRONTEND_MODE=public", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "apphub-dev-api",
      Environment: { Variables: Match.objectLike({ FRONTEND_MODE: "public" }) },
    });
  });
});

describe("platform — frontendMode=private", () => {
  let t: Template;
  beforeAll(() => {
    t = synth("private");
  });

  it("CloudFront·OAC·us-east-1 인증서 없음(CloudFront 전용 리소스 미생성), 버킷은 SPA+assets", () => {
    t.resourceCountIs("AWS::CloudFront::Distribution", 0);
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 0);
    const buckets = Object.values(t.findResources("AWS::S3::Bucket")).map((b) =>
      JSON.stringify((b.Properties as Record<string, unknown>)["BucketName"]),
    );
    expect(buckets.length).toBe(2); // SPA(비어 있음, QA M-1) + assets
    expect(buckets.some((b) => b.includes("apphub-dev-spa-"))).toBe(true);
    expect(buckets.some((b) => b.includes("apphub-dev-assets-"))).toBe(true);
    // OAC 버킷 정책 문(cloudfront.amazonaws.com)이 없다.
    expect(JSON.stringify(t.findResources("AWS::S3::BucketPolicy"))).not.toContain("cloudfront.amazonaws.com");
    const certs = Object.values(resources(t)).filter((r) => r.Type === "AWS::CloudFormation::CustomResource");
    expect(certs.length).toBe(0);
  });

  it("Private REST API + execute-api 엔드포인트 연결 + 리소스 정책(aws:SourceVpce = 그 엔드포인트만)", () => {
    const [epId] = Object.entries(t.findResources("AWS::EC2::VPCEndpoint")).find(([, r]) =>
      JSON.stringify((r.Properties as Record<string, unknown>)["ServiceName"]).includes("execute-api"),
    )!;
    t.hasResourceProperties("AWS::ApiGateway::RestApi", {
      EndpointConfiguration: { Types: ["PRIVATE"], VpcEndpointIds: [{ Ref: epId }] },
      Policy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Action: "execute-api:Invoke",
            Condition: { StringNotEquals: { "aws:SourceVpce": { Ref: epId } } },
          }),
          Match.objectLike({ Effect: "Allow", Action: "execute-api:Invoke" }),
        ]),
      }),
    });
  });

  it("execute-api · cognito-idp interface 엔드포인트 2개, privateDns 끔, 대역 한정 SG", () => {
    const eps = Object.values(t.findResources("AWS::EC2::VPCEndpoint")).map((r) => r.Properties as Record<string, unknown>);
    expect(eps.length).toBe(2);
    const services = eps.map((e) => JSON.stringify(e["ServiceName"]));
    expect(services.some((s) => s.includes("execute-api"))).toBe(true);
    expect(services.some((s) => s.includes("cognito-idp"))).toBe(true);
    for (const e of eps) {
      expect(e["VpcEndpointType"]).toBe("Interface");
      expect(e["PrivateDnsEnabled"]).toBe(false);
    }
  });

  it("콘솔 ALB: internal, 이름 apphub-dev-console-alb, HTTPS(443) 와일드카드 인증서(network SSM)", () => {
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Name: "apphub-dev-console-alb",
      Scheme: "internal",
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
      Certificates: [{ CertificateArn: { Ref: Match.stringLikeRegexp("networkcertificatearn") } }],
    });
  });

  it("콘솔 ALB SG / 엔드포인트 SG ingress = internal CIDRs 443만(미지정 → VPC CIDR SSM), 0.0.0.0/0 없음", () => {
    assertNoOpenIngress(t, []); // private 모드엔 D17 예외 SG가 없다
    const sgs = Object.values(t.findResources("AWS::EC2::SecurityGroup")).map((r) => r.Properties as Record<string, unknown>);
    const albSg = sgs.find((s) => String(s["GroupDescription"]).includes("console internal ALB"))!;
    const epSg = sgs.find((s) => String(s["GroupDescription"]).includes("VPC endpoints"))!;
    for (const sg of [albSg, epSg]) {
      const ingress = sg["SecurityGroupIngress"] as Array<Record<string, unknown>>;
      expect(ingress.length).toBe(1);
      expect(ingress[0]["FromPort"]).toBe(443);
      expect(JSON.stringify(ingress[0]["CidrIp"])).toContain("networkvpccidr");
    }
  });

  it("--internal-cidrs 주입 시 그 대역만 허용(VPC CIDR 대체 안 함)", () => {
    const t2 = synth("private", { allowedIngressCidrs: ["10.50.0.0/16", "192.168.10.0/24"] });
    const sg = Object.values(t2.findResources("AWS::EC2::SecurityGroup"))
      .map((r) => r.Properties as Record<string, unknown>)
      .find((s) => String(s["GroupDescription"]).includes("console internal ALB"))!;
    const cidrs = (sg["SecurityGroupIngress"] as Array<Record<string, unknown>>).map((r) => r["CidrIp"]);
    expect(cidrs).toEqual(["10.50.0.0/16", "192.168.10.0/24"]);
  });

  it("콘솔 태스크 SG 인바운드는 콘솔 ALB SG 참조(8080)로만 — CIDR 없음", () => {
    const res = resources(t);
    const taskSgId = Object.entries(res).find(
      ([, r]) => r.Type === "AWS::EC2::SecurityGroup" && String(r.Properties?.["GroupDescription"]).includes("console nginx task"),
    )![0];
    const taskSg = res[taskSgId].Properties!;
    expect(taskSg["SecurityGroupIngress"]).toBeUndefined();
    const ingresses = Object.values(res).filter(
      (r) => r.Type === "AWS::EC2::SecurityGroupIngress" && JSON.stringify(r.Properties?.["GroupId"]).includes(taskSgId),
    );
    expect(ingresses.length).toBe(1);
    expect(ingresses[0].Properties?.["SourceSecurityGroupId"]).toBeDefined();
    expect(ingresses[0].Properties?.["CidrIp"]).toBeUndefined();
    expect(ingresses[0].Properties?.["FromPort"]).toBe(8080);
  });

  it("ECS 서비스 apphub-dev-console: 공유 클러스터(SSM), desiredCount 1, 이미지 = CDK 자산(DockerImageAsset)", () => {
    t.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "apphub-dev-console",
      DesiredCount: 1,
      Cluster: { Ref: Match.stringLikeRegexp("networkclustername") },
    });
    const td = Object.values(t.findResources("AWS::ECS::TaskDefinition"))[0].Properties as Record<string, unknown>;
    const c = (td["ContainerDefinitions"] as Array<Record<string, unknown>>)[0];
    expect(JSON.stringify(c["Image"])).toContain("cdk-hnb659fds-container-assets");
    const env = Object.fromEntries(
      (c["Environment"] as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]),
    );
    // config.json(계약 §9.1) 원천 env — 엔드포인트 전용 호스트명 API URL / cognito-idp 엔드포인트 DNS.
    expect(JSON.stringify(env["APPHUB_API_URL"])).toContain(".execute-api.ap-northeast-2.amazonaws.com/dev");
    expect(JSON.stringify(env["APPHUB_COGNITO_IDP_ENDPOINT"])).toContain("DnsEntries");
    expect(env["APPHUB_APPS_DOMAIN"]).toBe("apps-dev.example.test");
    expect(env["APPHUB_STAGE"]).toBe("dev");
    // D16(2026-10-08): config.json frontendMode 원천 — 프론트가 private에서 로그인 보호 토글 비활성.
    expect(env["APPHUB_FRONTEND_MODE"]).toBe("private");
    expect(env["APPHUB_REGION"]).toBe("ap-northeast-2");
    expect(env["APPHUB_USER_POOL_ID"]).toBeDefined();
    expect(env["APPHUB_USER_POOL_CLIENT_ID"]).toBeDefined();
  });

  it("콘솔 TG 헬스체크 /health, private zone `console` CNAME → 콘솔 ALB DNS", () => {
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Name: "apphub-dev-console",
      Port: 8080,
      HealthCheckPath: "/health",
      TargetType: "ip",
    });
    const recs = Object.values(t.findResources("AWS::Route53::RecordSet")).map((r) => r.Properties as Record<string, unknown>);
    expect(recs.length).toBe(1);
    expect(recs[0]["Name"]).toBe("console.apps-dev.example.test.");
    expect(recs[0]["Type"]).toBe("CNAME");
    expect(JSON.stringify(recs[0]["HostedZoneId"])).toContain("networkprivatehostedzoneid");
    expect(JSON.stringify(recs[0]["ResourceRecords"])).toContain("ConsoleAlb");
    expect(JSON.stringify(recs[0]["ResourceRecords"])).toContain("DNSName");
  });

  it("Outputs: ApiUrl = https://{restApiId}-{vpceId}.execute-api.{region}.amazonaws.com/{stage}, CognitoIdpEndpoint = 엔드포인트 DNS", () => {
    const o = outputs(t);
    expect(o["FrontendMode"].Value).toBe("private");
    expect(o["ConsoleUrl"].Value).toBe("https://console.apps-dev.example.test");
    const api = o["ApiUrl"].Value as { "Fn::Join": [string, unknown[]] };
    const parts = api["Fn::Join"][1];
    expect(parts[0]).toBe("https://");
    expect(parts[2]).toBe("-");
    expect(JSON.stringify(parts[3])).toContain("ExecuteApiVpcEndpoint");
    expect(parts[4]).toBe(".execute-api.ap-northeast-2.amazonaws.com/dev");
    expect(JSON.stringify(o["CognitoIdpEndpoint"].Value)).toContain("CognitoIdpVpcEndpoint");
    expect(JSON.stringify(o["CognitoIdpEndpoint"].Value)).toContain("DnsEntries");
    for (const k of ["CloudFrontDomain", "CloudFrontDistributionId"]) expect(o[k]).toBeUndefined();
    expect(o["SpaBucketName"]).toBeDefined(); // 버킷은 두 모드 공통(QA M-1)
  });

  it("SSM frontend-mode=private, api-url = 엔드포인트 URL, cloudfront 키 없음(spa-bucket-name은 공통)", () => {
    expect(ssmValue(t, "/apphub/dev/platform/frontend-mode")).toBe("private");
    expect(JSON.stringify(ssmValue(t, "/apphub/dev/platform/api-url"))).toContain("ExecuteApiVpcEndpoint");
    const names = ssmNames(t);
    expect(names).toContain("/apphub/dev/platform/spa-bucket-name");
    expect(names).not.toContain("/apphub/dev/platform/cloudfront-domain");
  });

  it("SG description ASCII(라이브 전용 실패 방지)", () => {
    assertSgDescriptionsAscii(t);
  });

  it("D21 SPA 클라이언트 설정은 모드와 무관(USER_PASSWORD_AUTH, OAuth 비활성)", () => {
    const spa = Object.values(t.findResources("AWS::Cognito::UserPoolClient"))
      .map((c) => c.Properties as Record<string, unknown>)
      .find((c) => c["GenerateSecret"] === false)!;
    expect(spa["ExplicitAuthFlows"]).toEqual(expect.arrayContaining(["ALLOW_USER_PASSWORD_AUTH"]));
    expect(spa["AllowedOAuthFlowsUserPoolClient"]).toBe(false);
  });

  it("D16 앱 보호용 Cognito 도메인(Hosted UI)은 유지, 공유 app-auth 클라이언트는 없다(앱별 클라이언트는 runtime 소유)", () => {
    t.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    const secretClients = Object.values(t.findResources("AWS::Cognito::UserPoolClient"))
      .map((c) => c.Properties as Record<string, unknown>)
      .filter((c) => c["GenerateSecret"] === true);
    expect(secretClients).toEqual([]);
    expect(ssmNames(t)).not.toContain("/apphub/dev/platform/app-auth-client-id");
    expect(ssmNames(t)).toContain("/apphub/dev/platform/user-pool-domain");
  });

  it("[D16] API Lambda env FRONTEND_MODE=private (백엔드가 cognitoProtect=true 거부)", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "apphub-dev-api",
      Environment: { Variables: Match.objectLike({ FRONTEND_MODE: "private" }) },
    });
  });
});

describe("platform — D20 ProvisionApp ASL slotStatus WAIT 루프 (계약 §4)", () => {
  let def: { States: Record<string, Record<string, unknown>>; StartAt: string };
  beforeAll(() => {
    const t = synth("public");
    const sm = Object.values(t.findResources("AWS::StepFunctions::StateMachine")).find(
      (s) => (s.Properties as Record<string, unknown>)["StateMachineName"] === "apphub-dev-provision-app",
    )!;
    const ds = (sm.Properties as Record<string, unknown>)["DefinitionString"] as
      | string
      | { "Fn::Join": [string, unknown[]] };
    // Lambda ARN 토큰 자리를 문자열로 치환해 JSON 파싱.
    const joined =
      typeof ds === "string" ? ds : ds["Fn::Join"][1].map((x) => (typeof x === "string" ? x : "TOKEN")).join("");
    def = JSON.parse(joined);
  });

  it("시작은 시도 횟수 초기화 → allocate-slot(결과는 $.slot, appId 보존)", () => {
    expect(def.StartAt).toBe("InitSlotWait");
    expect(def.States["InitSlotWait"]["Next"]).toBe("AllocateSlot");
    expect(def.States["AllocateSlot"]["ResultPath"]).toBe("$.slot");
    expect(def.States["AllocateSlot"]["Next"]).toBe("SlotAssigned?");
  });

  it("slotStatus==WAIT → (40회 미만) Wait 30초 → 횟수+1 → allocate-slot 재호출, 그 외 → deploy-pipeline", () => {
    const choice = def.States["SlotAssigned?"] as { Choices: Array<Record<string, unknown>>; Default: string };
    expect(choice.Default).toBe("DeployPipeline");
    expect(JSON.stringify(choice.Choices[0])).toContain('"StringEquals":"WAIT"');
    expect(JSON.stringify(choice.Choices[0])).toContain("$.slot.slotStatus");
    expect(choice.Choices[0]["Next"]).toBe("SlotWaitExhausted?");
    const exhausted = def.States["SlotWaitExhausted?"] as { Choices: Array<Record<string, unknown>>; Default: string };
    expect(exhausted.Choices[0]).toMatchObject({ Variable: "$.slotWait.attempts", NumericGreaterThanEquals: 40 });
    expect(exhausted.Default).toBe("WaitSlot");
    expect(def.States["WaitSlot"]).toMatchObject({ Type: "Wait", Seconds: 30, Next: "CountSlotWait" });
    expect(JSON.stringify(def.States["CountSlotWait"])).toContain("States.MathAdd($.slotWait.attempts, 1)");
    expect(def.States["CountSlotWait"]["Next"]).toBe("AllocateSlot");
  });

  it("40회 초과/allocate-slot 예외 → finalize(failure, failedStep=allocate-slot, error 전달) → Fail", () => {
    expect(exhaustedNext()).toBe("SlotWaitTimeout");
    expect(def.States["SlotWaitTimeout"]["Next"]).toBe("ProvisionFinalizeSlotFailure");
    const fin = JSON.stringify(def.States["ProvisionFinalizeSlotFailure"]);
    expect(fin).toContain('"failedStep":"allocate-slot"');
    expect(fin).toContain('"outcome":"failure"');
    expect(fin).toContain('"error.$":"$.error"');
    const catches = def.States["AllocateSlot"]["Catch"] as Array<Record<string, unknown>>;
    expect(catches[0]["Next"]).toBe("ProvisionFinalizeSlotFailure");
  });

  function exhaustedNext(): unknown {
    return (def.States["SlotWaitExhausted?"] as { Choices: Array<Record<string, unknown>> }).Choices[0]["Next"];
  }
});

describe("platform — D20 provisioner / task IAM (계약 §3·§5)", () => {
  let t: Template;
  beforeAll(() => {
    t = synth("public");
  });
  const stmts = (sid: string): Array<{ Action?: unknown; Resource?: unknown }> => {
    const out: Array<{ Action?: unknown; Resource?: unknown }> = [];
    for (const pol of Object.values(t.findResources("AWS::IAM::Policy"))) {
      const doc = (pol.Properties as { PolicyDocument?: { Statement?: Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> } })
        .PolicyDocument;
      for (const st of doc?.Statement ?? []) if (st.Sid === sid) out.push(st);
    }
    return out;
  };

  it("provisioner CFN 권한이 ALB 증설 스택(apphub-dev-alb-*)까지 포함", () => {
    const [st] = stmts("AppStackCfn");
    expect(JSON.stringify(st.Resource)).toContain("stack/apphub-dev-alb-*");
    expect(JSON.stringify(st.Resource)).toContain("stack/apphub-dev-app-*");
  });

  it("provisioner AlbShardDeploy는 증설 ALB/리스너/Waker TG/Waker 함수/alb SSM 범위로 한정(Resource:'*' 아님)", () => {
    const [st] = stmts("AlbShardDeploy");
    const raw = JSON.stringify(st.Resource);
    expect(st.Resource).not.toBe("*");
    expect(raw).toContain("loadbalancer/app/apphub-dev-*-alb-*/*");
    expect(raw).toContain("targetgroup/apphub-dev-waker-*/*");
    expect(raw).toContain("function:apphub-dev-waker");
    expect(raw).toContain("parameter/apphub/dev/network/alb/*");
  });

  it("provision-task DDB에 Query(ALB 목록)·DeleteItem, deploy-notify DDB에 DeleteItem(ALBPENDING 삭제)", () => {
    const prov = stmts("AppTableRW").filter((s) => JSON.stringify(s.Action).includes("dynamodb:Query"));
    expect(prov.some((s) => JSON.stringify(s.Action).includes("dynamodb:DeleteItem"))).toBe(true);
    const [dn] = stmts("DeployNotifyTableRw");
    expect(dn.Action).toEqual(expect.arrayContaining(["dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:Query"]));
  });

  it("deploy-notify Build 규칙은 provisioner 프로젝트만 필터(APP_STACK_KIND=alb 빌드도 수신)", () => {
    t.hasResourceProperties("AWS::Events::Rule", {
      Name: "apphub-dev-deploy-notify-build",
      EventPattern: { source: ["aws.codebuild"], "detail-type": ["CodeBuild Build State Change"], detail: { "project-name": Match.anyValue() } },
    });
  });
});

describe("platform — private zone `console` 레코드 모드 전환 안전성 (리더 결정 2026-10-07)", () => {
  const privateConsoleRecords = (t: Template): Array<[string, Record<string, unknown>]> =>
    Object.entries(t.findResources("AWS::Route53::RecordSet"))
      .map(([id, r]) => [id, r.Properties as Record<string, unknown>] as [string, Record<string, unknown>])
      .filter(([, p]) => JSON.stringify(p["HostedZoneId"]).includes("networkprivatehostedzoneid"));

  it("두 모드 모두 CNAME 1개, 논리 ID·이름 동일(전환 시 교체가 아니라 값 갱신)", () => {
    const pub = privateConsoleRecords(synth("public"));
    const priv = privateConsoleRecords(synth("private"));
    expect(pub.length).toBe(1);
    expect(priv.length).toBe(1);
    expect(pub[0][1]["Type"]).toBe("CNAME");
    expect(priv[0][1]["Type"]).toBe("CNAME");
    expect(pub[0][0]).toBe(priv[0][0]);
    expect(pub[0][0]).toMatch(/^ConsolePrivateCname/);
    expect(pub[0][1]["Name"]).toBe(priv[0][1]["Name"]);
    expect(JSON.stringify(pub[0][1]["ResourceRecords"])).toContain("SpaDistribution");
    expect(JSON.stringify(priv[0][1]["ResourceRecords"])).toContain("ConsoleAlb");
  });
});

describe("platform — SPA 버킷 모드 공통 (QA M-1, 리더 결정 2026-10-07)", () => {
  it("두 모드 모두 SpaBucket이 같은 논리 ID·이름으로 존재(재전환 시 CREATE 충돌 없음)", () => {
    const spa = (t: Template): Array<[string, unknown]> =>
      Object.entries(t.findResources("AWS::S3::Bucket"))
        .filter(([, b]) => JSON.stringify((b.Properties as Record<string, unknown>)["BucketName"]).includes("-spa-"))
        .map(([id, b]) => [id, (b.Properties as Record<string, unknown>)["BucketName"]]);
    const pub = spa(synth("public"));
    const priv = spa(synth("private"));
    expect(pub.length).toBe(1);
    expect(priv.length).toBe(1);
    expect(pub[0][0]).toMatch(/^SpaBucket/);
    expect(priv[0][0]).toBe(pub[0][0]);
    expect(priv[0][1]).toEqual(pub[0][1]);
  });
});
