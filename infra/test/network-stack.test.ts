import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import {
  NetworkStack,
  D17_EXEMPT_SG_DESCRIPTION,
} from "../lib/network-stack";
import {
  assertNoOpenIngress,
  assertExemptSgIsActuallyOpen,
} from "./helpers/sg-ingress";
import { testConfig, testEnv } from "./helpers/config";

/**
 * L2 — network 스택 CDK assertions.
 * 설계 결정(D2 공유 ALB, D3 와일드카드 ACM, D17 SG, DESIGN 3.5 idle timeout/Waker)이
 * 코드에 반영됐는지 단언한다.
 */
function synth(overrides?: { allowedIngressCidrs?: readonly string[] }): Template {
  const app = new App();
  const config = testConfig("dev", overrides);
  const stack = new NetworkStack(app, "apphub-dev-network", {
    stage: "dev",
    config,
    env: testEnv(config),
  });
  return Template.fromStack(stack);
}

describe("network 스택", () => {
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  describe("D17 — SG ingress 0.0.0.0/0·::/0 부재 (예외: internet-facing ALB SG)", () => {
    it("예외 SG를 제외한 모든 SG ingress에 개방 대역이 없다", () => {
      assertNoOpenIngress(template, [D17_EXEMPT_SG_DESCRIPTION]);
    });

    it("예외 SG(internet-facing ALB)는 실제로 0.0.0.0/0 ingress를 가진다", () => {
      assertExemptSgIsActuallyOpen(template, D17_EXEMPT_SG_DESCRIPTION);
    });

    it("internal ALB SG는 VPC CIDR 참조 ingress만 가진다(개방 대역 아님)", () => {
      // internal SG의 ingress는 Fn::GetAtt Vpc.CidrBlock 형태여야 한다.
      const json = template.toJSON() as {
        Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      };
      const internalSg = Object.values(json.Resources).find(
        (r) =>
          r.Type === "AWS::EC2::SecurityGroup" &&
          typeof r.Properties?.["GroupDescription"] === "string" &&
          (r.Properties["GroupDescription"] as string).includes("internal ALB SG"),
      );
      expect(internalSg, "internal ALB SG가 존재해야 함").toBeDefined();
      const ingress = (internalSg!.Properties!["SecurityGroupIngress"] as Array<
        Record<string, unknown>
      >);
      expect(ingress.length).toBeGreaterThan(0);
      for (const rule of ingress) {
        expect(rule["CidrIp"]).not.toBe("0.0.0.0/0");
        expect(rule["CidrIpv6"]).not.toBe("::/0");
        // Fn::GetAtt 참조(VPC CIDR)여야 한다.
        expect(rule["CidrIp"]).toHaveProperty("Fn::GetAtt");
      }
    });

    it("앱 태스크 SG 인바운드는 SG 참조로만 부여된다(CIDR 금지)", () => {
      const ingresses = template.findResources("AWS::EC2::SecurityGroupIngress");
      const appTaskRules = Object.values(ingresses).filter(
        (r) => (r.Properties as Record<string, unknown>)["SourceSecurityGroupId"],
      );
      expect(appTaskRules.length).toBeGreaterThanOrEqual(2); // internet + internal ALB SG 참조
      for (const r of appTaskRules) {
        const p = r.Properties as Record<string, unknown>;
        expect(p["CidrIp"]).toBeUndefined();
        expect(p["FromPort"]).toBe(8080);
      }
    });
  });

  describe("D2 — 공유 ALB 2대", () => {
    it("ALB가 정확히 2대(internet-facing 1, internal 1)", () => {
      template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 2);
      template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
        Scheme: "internet-facing",
      });
      template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
        Scheme: "internal",
      });
    });

    it("두 ALB 모두 idle timeout 300초 (SSE 대비, DESIGN 3.5)", () => {
      const albs = template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer");
      const values = Object.values(albs);
      expect(values.length).toBe(2);
      for (const alb of values) {
        const attrs = (alb.Properties as Record<string, unknown>)[
          "LoadBalancerAttributes"
        ] as Array<{ Key: string; Value: string }>;
        const idle = attrs.find((a) => a.Key === "idle_timeout.timeout_seconds");
        expect(idle?.Value).toBe("300");
      }
    });
  });

  describe("D18 — 공유 ECS 클러스터 1개 (stage당 1개)", () => {
    it("ECS 클러스터가 정확히 1개이고 이름이 apphub-dev-cluster다", () => {
      template.resourceCountIs("AWS::ECS::Cluster", 1);
      template.hasResourceProperties("AWS::ECS::Cluster", {
        ClusterName: "apphub-dev-cluster",
      });
    });

    it("공유 클러스터 이름/ARN을 SSM으로 발행한다(app-runtime이 임포트)", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/cluster-name",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/cluster-arn",
      });
    });

    it("Waker/복원/잠자기 3함수 env에 CLUSTER_NAME(apphub-dev-cluster)이 주입된다", () => {
      // backend가 ecs update_service/describe_services의 cluster 인자로 사용(D18).
      for (const name of ["apphub-dev-waker", "apphub-dev-wake-restore", "apphub-dev-sleep-transition"]) {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: name,
          Environment: {
            Variables: Match.objectLike({ CLUSTER_NAME: "apphub-dev-cluster" }),
          },
        });
      }
    });
  });

  describe("D3 — 와일드카드 ACM + Route53", () => {
    it("`*.appsDomain` 인증서를 DNS 검증으로 발급", () => {
      template.hasResourceProperties("AWS::CertificateManager::Certificate", {
        DomainName: "*.apps-dev.example.test",
        ValidationMethod: "DNS",
      });
    });

    it("internal용 private hosted zone을 생성한다", () => {
      // PrivateHostedZone은 VPCs 속성을 가진 HostedZone.
      template.hasResourceProperties("AWS::Route53::HostedZone", {
        VPCs: Match.anyValue(),
      });
    });
  });

  describe("리스너 — HTTPS + HTTP 리다이렉트", () => {
    it("HTTPS(443) 리스너 2개 + HTTP(80) 리다이렉트 2개", () => {
      const listeners = template.findResources("AWS::ElasticLoadBalancingV2::Listener");
      const ports = Object.values(listeners).map(
        (l) => (l.Properties as Record<string, unknown>)["Port"],
      );
      expect(ports.filter((p) => p === 443).length).toBe(2);
      expect(ports.filter((p) => p === 80).length).toBe(2);
    });

    it("HTTP 리스너는 HTTPS로 permanent 리다이렉트", () => {
      template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
        Port: 80,
        DefaultActions: Match.arrayWith([
          Match.objectLike({
            Type: "redirect",
            RedirectConfig: Match.objectLike({
              Protocol: "HTTPS",
              Port: "443",
              StatusCode: "HTTP_301",
            }),
          }),
        ]),
      });
    });
  });

  describe("Waker — wake-on-request 공유 리소스 (DESIGN 3.5)", () => {
    it("Waker Lambda + 복원 Lambda 2개가 존재한다", () => {
      // ACM DNS 검증 커스텀 리소스 등 다른 Lambda가 있을 수 있으므로 함수명으로 특정.
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-waker",
      });
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-wake-restore",
      });
    });

    it("Waker Target Group(type=lambda)이 존재한다", () => {
      template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
        TargetType: "lambda",
      });
    });

    it("잠자기 Lambda(sleep-transition)가 추가로 존재한다 (D-M5-03)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "apphub-dev-sleep-transition",
      });
    });

    it("Waker/복원/잠자기 3함수 모두 STAGE + APPS_DOMAIN + TABLE_NAME env를 갖는다", () => {
      // D-M8 P2 필수 요청: 데이터 계층(app.data.client.table)이 TABLE_NAME 을 요구(폴백 없음).
      //  테이블명은 결정론적 apphub-dev-main(platform 스택이 만든 단일 테이블). 크로스스택/SSM 없이 직접 주입.
      for (const name of ["apphub-dev-waker", "apphub-dev-wake-restore", "apphub-dev-sleep-transition"]) {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: name,
          Environment: {
            Variables: Match.objectLike({
              STAGE: "dev",
              APPS_DOMAIN: "apps-dev.example.test",
              TABLE_NAME: "apphub-dev-main",
            }),
          },
        });
      }
    });

    it("Waker/복원/잠자기 3함수 모두 PYTHON_3_13 / handler.handler 로 전환됐다(D-M8)", () => {
      for (const name of ["apphub-dev-waker", "apphub-dev-wake-restore", "apphub-dev-sleep-transition"]) {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: name,
          Runtime: "python3.13",
          Handler: "handler.handler",
        });
      }
    });

    it("Waker/복원/잠자기 3함수 모두 DDB 접근 IAM(테이블 + index/*)을 가진다(P2 로직 R/W)", () => {
      // grantWakeFunctionPermissions 의 ddbRw: GetItem/PutItem/UpdateItem/Query + tableArn + index/*.
      //  3함수 각각 policy가 있어야 한다. 테이블 ARN 조각(table/apphub-dev-main)으로 확인.
      const policies = template.findResources("AWS::IAM::Policy");
      let ddbRwCount = 0;
      for (const pol of Object.values(policies)) {
        const doc = (
          pol.Properties as {
            PolicyDocument?: { Statement?: Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> };
          }
        ).PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          if (st.Sid === "AppTableRW") {
            const res = JSON.stringify(st.Resource);
            const act = JSON.stringify(st.Action);
            if (res.includes("table/apphub-dev-main") && act.includes("dynamodb:")) {
              ddbRwCount++;
            }
          }
        }
      }
      // waker/restore/sleep 3함수 각각 1개 = 최소 3개.
      expect(ddbRwCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe("트리거 — EventBridge 규칙 (D-M5-03, 공유 규칙 — 앱별 아님)", () => {
    it("복원 규칙: ECS Task State Change RUNNING + group prefix service:apphub-dev-app-", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: Match.objectLike({
          source: ["aws.ecs"],
          "detail-type": ["ECS Task State Change"],
          detail: Match.objectLike({
            lastStatus: ["RUNNING"],
            group: [{ prefix: "service:apphub-dev-app-" }],
          }),
        }),
      });
    });

    it("잠자기 규칙: CloudWatch Alarm State Change ALARM + alarmName prefix apphub-dev-app-", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: Match.objectLike({
          source: ["aws.cloudwatch"],
          "detail-type": ["CloudWatch Alarm State Change"],
          detail: Match.objectLike({
            alarmName: [{ prefix: "apphub-dev-app-" }],
            state: { value: ["ALARM"] },
          }),
        }),
      });
    });

    it("[N5] 유휴 알람 고착 보정 스윕: rate(15 minutes) → sleep-transition, 입력 {sweep:true}", () => {
      const fnId = Object.keys(
        template.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "apphub-dev-sleep-transition" } }),
      )[0];
      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "apphub-dev-idle-sleep-sweep",
        ScheduleExpression: "rate(15 minutes)",
        State: "ENABLED",
        Targets: [
          Match.objectLike({
            Arn: { "Fn::GetAtt": [fnId, "Arn"] },
            Input: JSON.stringify({ sweep: true }),
          }),
        ],
      });
    });

    it("[N5] sleep-transition 역할에 cloudwatch:DescribeAlarms(*, 단독 statement) + GSI Query(index/*)", () => {
      const fns = template.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "apphub-dev-sleep-transition" } });
      const roleId = (Object.values(fns)[0].Properties as { Role: { "Fn::GetAtt": [string, string] } }).Role["Fn::GetAtt"][0];
      type Stmt = { Sid?: string; Action?: unknown; Resource?: unknown };
      const stmts: Stmt[] = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const props = pol.Properties as { Roles?: unknown; PolicyDocument?: { Statement?: Stmt[] } };
        if (JSON.stringify(props.Roles) === JSON.stringify([{ Ref: roleId }])) stmts.push(...(props.PolicyDocument?.Statement ?? []));
      }
      const da = stmts.find((x) => x.Sid === "SweepDescribeAlarms");
      expect(da, "SweepDescribeAlarms statement").toBeDefined();
      expect(da!.Action).toBe("cloudwatch:DescribeAlarms");
      expect(da!.Resource).toBe("*");
      const ddb = stmts.find((x) => x.Sid === "AppTableRW");
      expect(JSON.stringify(ddb!.Action)).toContain("dynamodb:Query");
      expect(JSON.stringify(ddb!.Resource)).toContain("table/apphub-dev-main/index/*");
    });

    it("Resource:'*' statement는 허용 목록(ElbDescribe, SweepDescribeAlarms)만 — 우발적 * 금지", () => {
      const allowed: Record<string, string[]> = {
        ElbDescribe: [
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups",
        ],
        SweepDescribeAlarms: ["cloudwatch:DescribeAlarms"],
      };
      const unexpected: string[] = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const doc = (pol.Properties as { PolicyDocument?: { Statement?: Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> } })
          .PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          const r = st.Resource;
          if (!(r === "*" || (Array.isArray(r) && r.length === 1 && r[0] === "*"))) continue;
          const acts = (Array.isArray(st.Action) ? st.Action : [st.Action]).map(String).sort();
          const sid = st.Sid ?? "<no-sid>";
          if (!allowed[sid] || JSON.stringify(acts) !== JSON.stringify(allowed[sid])) unexpected.push(`${sid}:${acts.join(",")}`);
        }
      }
      expect(unexpected, `허용 목록 밖 Resource:"*": ${unexpected.join(" | ")}`).toEqual([]);
    });

    it("두 규칙이 각각 복원/잠자기 Lambda를 InvokePermission으로 호출한다", () => {
      // EventBridge → Lambda invoke 권한(Principal events.amazonaws.com) 2건 이상.
      const perms = template.findResources("AWS::Lambda::Permission");
      const eventInvokes = Object.values(perms).filter(
        (p) =>
          (p.Properties as Record<string, unknown>)["Principal"] === "events.amazonaws.com" &&
          (p.Properties as Record<string, unknown>)["Action"] === "lambda:InvokeFunction",
      );
      expect(eventInvokes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Waker/복원/잠자기 IAM — ARN 범위 (D-M5-03)", () => {
    it("ECS UpdateService는 공유 클러스터 하위 앱 서비스(apphub-dev-cluster/apphub-dev-app-*)로 범위 한정, Resource:'*' 아님", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      let found = false;
      for (const pol of Object.values(policies)) {
        const doc = (pol.Properties as { PolicyDocument?: { Statement?: Array<{ Action?: unknown; Resource?: unknown }> } })
          .PolicyDocument;
        for (const st of doc?.Statement ?? []) {
          const actions = Array.isArray(st.Action) ? (st.Action as unknown[]) : [st.Action];
          if (actions.includes("ecs:UpdateService")) {
            found = true;
            // 앱 서비스 ARN(Fn::Join)으로 한정 — 전역 * 금지.
            expect(st.Resource).not.toBe("*");
            // D18: 공유 클러스터 하위 서비스 경로 service/{cluster}/{service} 형태여야 한다.
            expect(JSON.stringify(st.Resource)).toContain("service/apphub-dev-cluster/apphub-dev-app-");
          }
        }
      }
      expect(found, "ecs:UpdateService 부여 statement가 있어야 함").toBe(true);
    });

    it("복원/잠자기의 ELB Describe(리소스 레벨 미지원)만 계정 스코프 * — ModifyRule은 규칙 ARN 범위", () => {
      const raw = JSON.stringify(Object.values(template.findResources("AWS::IAM::Policy")));
      expect(raw).toContain("elasticloadbalancing:ModifyRule");
      expect(raw).toContain("listener-rule/app"); // ModifyRule은 규칙 ARN 범위
      expect(raw).toContain("elasticloadbalancing:DescribeRules");
    });

    it("[QA H3] ModifyRule 역할(복원/잠자기)의 역할명을 SSM으로 발행한다 — platform이 User Pool 한정 DescribeUserPoolClient를 부착", () => {
      const fnRoleRef = (fnName: string): unknown => {
        const fns = template.findResources("AWS::Lambda::Function", { Properties: { FunctionName: fnName } });
        const [fn] = Object.values(fns);
        const roleArn = (fn.Properties as { Role: { "Fn::GetAtt": [string, string] } }).Role;
        return { Ref: roleArn["Fn::GetAtt"][0] };
      };
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/wake-restore-role-name",
        Value: fnRoleRef("apphub-dev-wake-restore"),
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/sleep-transition-role-name",
        Value: fnRoleRef("apphub-dev-sleep-transition"),
      });
    });
  });

  describe("교차 스택 참조 — CloudFormation Export 미사용", () => {
    it("Outputs에 Export가 없다(cdk-authoring: Export 대신 SSM/Outputs)", () => {
      const json = template.toJSON() as {
        Outputs?: Record<string, { Export?: unknown }>;
      };
      const outputs = json.Outputs ?? {};
      for (const [name, out] of Object.entries(outputs)) {
        expect(out.Export, `Output ${name}에 Export가 있으면 안 됨`).toBeUndefined();
      }
    });

    it("공유 참조를 SSM 파라미터로 발행한다", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/waker-fn-arn",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/internet-alb-arn",
      });
    });

    it("ALB full name / sleep-transition fn SSM을 발행한다(유휴 알람·잠자기 소비)", () => {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/internet-alb-full-name",
      });
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/apphub/dev/network/sleep-transition-fn-arn",
      });
    });
  });

  describe("D20 — ALB별 SSM 키 n=0 + ALB별 Waker TG (계약 §1.1~§1.3)", () => {
    const KEYS = ["alb-arn", "alb-full-name", "alb-dns", "alb-canonical-zone-id", "https-listener-arn", "waker-tg-arn"];
    const ssmValue = (name: string): unknown => {
      const params = template.findResources("AWS::SSM::Parameter", { Properties: { Name: name } });
      const list = Object.values(params);
      expect(list.length, `SSM ${name} 이 정확히 1개 있어야 함`).toBe(1);
      return (list[0].Properties as Record<string, unknown>)["Value"];
    };

    it("n=0 internet/internal 각각 6개 키를 `/network/alb/{slug}/0/*`로 발행한다", () => {
      for (const slug of ["internet", "internal"]) {
        for (const key of KEYS) ssmValue(`/apphub/dev/network/alb/${slug}/0/${key}`);
      }
    });

    it("기존 scheme 고정 키는 호환 유지되고 값이 신규 키와 같다", () => {
      const pairs: Array<[string, string]> = [
        ["internet-alb-arn", "alb/internet/0/alb-arn"],
        ["internal-alb-arn", "alb/internal/0/alb-arn"],
        ["internet-alb-dns", "alb/internet/0/alb-dns"],
        ["internal-alb-canonical-zone-id", "alb/internal/0/alb-canonical-zone-id"],
        ["internet-alb-full-name", "alb/internet/0/alb-full-name"],
        ["internet-https-listener-arn", "alb/internet/0/https-listener-arn"],
        ["internal-https-listener-arn", "alb/internal/0/https-listener-arn"],
        // 계약 §1.2: legacy waker-tg-arn == alb/internet/0/waker-tg-arn
        ["waker-tg-arn", "alb/internet/0/waker-tg-arn"],
      ];
      for (const [legacy, next] of pairs) {
        expect(ssmValue(`/apphub/dev/network/${next}`)).toEqual(ssmValue(`/apphub/dev/network/${legacy}`));
      }
    });

    it("Waker TG는 2개(ALB마다 1개): 기존 apphub-dev-waker-tg(논리 ID 불변) + 신규 apphub-dev-waker-internal-0", () => {
      const tgs = template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup");
      const byName = new Map(
        Object.entries(tgs).map(([id, r]) => [String((r.Properties as Record<string, unknown>)["Name"]), id]),
      );
      expect(Object.keys(tgs).length).toBe(2);
      // 기존 리소스 교체 금지 — 논리 ID 접두어 "WakerTg"(CDK 해시 suffix) 유지.
      expect(byName.get("apphub-dev-waker-tg")).toMatch(/^WakerTg[0-9A-F]{8}$/);
      expect(byName.get("apphub-dev-waker-internal-0")).toBeDefined();
      for (const r of Object.values(tgs)) {
        expect((r.Properties as Record<string, unknown>)["TargetType"]).toBe("lambda");
      }
    });

    it("internal n=0 waker-tg-arn은 internal 전용 TG를 가리킨다(internet TG와 다름 — 버그 B)", () => {
      const tgs = template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup");
      const internalTgId = Object.entries(tgs).find(
        ([, r]) => (r.Properties as Record<string, unknown>)["Name"] === "apphub-dev-waker-internal-0",
      )![0];
      expect(ssmValue("/apphub/dev/network/alb/internal/0/waker-tg-arn")).toEqual({ Ref: internalTgId });
      expect(ssmValue("/apphub/dev/network/alb/internet/0/waker-tg-arn")).not.toEqual({ Ref: internalTgId });
    });

    it("두 Waker TG 모두 Waker Lambda invoke 권한(elasticloadbalancing) 이후에 생성된다", () => {
      // LambdaTarget은 같은 principal 권한을 1개로 합친다(grantInvoke 캐시) — 두 TG가 모두 그 권한에 의존.
      const perms = Object.entries(template.findResources("AWS::Lambda::Permission")).filter(
        ([, p]) => (p.Properties as Record<string, unknown>)["Principal"] === "elasticloadbalancing.amazonaws.com",
      );
      expect(perms.length).toBeGreaterThanOrEqual(1);
      const permIds = perms.map(([id]) => id);
      for (const tg of Object.values(template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup"))) {
        const deps = (tg as { DependsOn?: string[] }).DependsOn ?? [];
        expect(deps.some((d) => permIds.includes(d))).toBe(true);
      }
    });

    it("public-subnet-id-{i}/az-{i}/count + vpc-cidr 를 발행한다(증설 internet ALB·private 콘솔 소비)", () => {
      for (const i of [0, 1]) {
        ssmValue(`/apphub/dev/network/public-subnet-id-${i}`);
        ssmValue(`/apphub/dev/network/public-subnet-az-${i}`);
      }
      expect(ssmValue("/apphub/dev/network/public-subnet-count")).toBe("2");
      ssmValue("/apphub/dev/network/vpc-cidr");
    });

    it("InternalWakerTargetGroupArn Output", () => {
      const outputs = (template.toJSON() as { Outputs?: Record<string, unknown> }).Outputs ?? {};
      expect(Object.keys(outputs)).toContain("InternalWakerTargetGroupArn");
    });

    it("복원/잠자기 ModifyRule 범위가 플랫폼 ALB 접두어(listener-rule/app/apphub-dev-*/*)로 증설 ALB까지 포함(§7)", () => {
      const raw = JSON.stringify(Object.values(template.findResources("AWS::IAM::Policy")));
      expect(raw).toContain("listener-rule/app/apphub-dev-*/*");
    });
  });

  describe("allowedIngressCidrs 주입", () => {
    it("주입된 CIDR가 internal ALB SG ingress로 반영된다", () => {
      const t = synth({ allowedIngressCidrs: ["10.99.0.0/16"] });
      const json = t.toJSON() as {
        Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      };
      const internalSg = Object.values(json.Resources).find(
        (r) =>
          r.Type === "AWS::EC2::SecurityGroup" &&
          typeof r.Properties?.["GroupDescription"] === "string" &&
          (r.Properties["GroupDescription"] as string).includes("internal ALB SG"),
      );
      const ingress = internalSg!.Properties!["SecurityGroupIngress"] as Array<
        Record<string, unknown>
      >;
      const cidrs = ingress.map((r) => r["CidrIp"]);
      expect(cidrs).toContain("10.99.0.0/16");
      // 주입 시 VPC CIDR fallback은 쓰지 않는다.
      expect(cidrs.some((c) => typeof c === "object")).toBe(false);
    });
  });
});

describe("VPC 대역 파라미터화 (--vpc-cidr)", () => {
  it("기본값이면 VPC CIDR 이 10.20.0.0/16 그대로(기존 설치와 동일, 교체 없음)", () => {
    const app = new App();
    const stack = new NetworkStack(app, "apphub-dev-network-vpcdefault", { stage: "dev", config: testConfig("dev") });
    Template.fromStack(stack).hasResourceProperties("AWS::EC2::VPC", { CidrBlock: "10.20.0.0/16" });
  });
  it("지정한 대역이 VPC·서브넷에 반영된다", () => {
    const app = new App();
    const stack = new NetworkStack(app, "apphub-dev-network-vpccustom", {
      stage: "dev",
      config: testConfig("dev", { vpcCidr: "172.20.0.0/20" }),
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::EC2::VPC", { CidrBlock: "172.20.0.0/20" });
    const subnets = Object.values(t.findResources("AWS::EC2::Subnet")).map(
      (r) => (r as { Properties: { CidrBlock: string } }).Properties.CidrBlock,
    );
    expect(subnets.length).toBe(4);
    for (const c of subnets) expect(c.startsWith("172.20.")).toBe(true);
  });
});
