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

    it("공유 Waker Target Group(type=lambda)이 존재한다", () => {
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
