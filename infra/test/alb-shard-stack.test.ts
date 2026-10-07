import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AlbShardStack } from "../lib/alb-shard-stack";
import {
  ALB_SSM_KEYS,
  albShardStackName,
  schemeSlug,
  shardAlbName,
  wakerTgName,
  type SchemeSlug,
} from "../lib/alb-keys";
import { assertNoOpenIngress, assertSgDescriptionsAscii } from "./helpers/sg-ingress";

/**
 * L2 — ALB 증설 스택(D20, 계약 delta-2026-10-07 §1~§2, §12).
 *  - SSM 발행 키 6종(`/network/alb/{slug}/{n}/*`)
 *  - Waker TG 이름 규약 + 공유 Waker Lambda invoke 권한(elasticloadbalancing, SourceArn=그 TG)
 *  - scheme별 network ALB SG 재사용(새 SG 생성 없음) + 0.0.0.0/0 없음(D17)
 *  - 리스너 HTTPS(기본 404) + HTTP 리다이렉트, idle 300s
 */
const ENV = { account: "111122223333", region: "ap-northeast-2" };

function synth(slug: SchemeSlug, index: number, stage: "dev" | "prod" = "dev"): Template {
  const app = new App();
  const stack = new AlbShardStack(app, albShardStackName(`apphub-${stage}`, slug, index), {
    env: ENV,
    stage,
    schemeSlug: slug,
    albIndex: index,
  });
  return Template.fromStack(stack);
}

describe("alb-keys — 이름/경로 규약", () => {
  it("scheme → slug (internet-facing → internet), 알 수 없는 값은 throw", () => {
    expect(schemeSlug("internet-facing")).toBe("internet");
    expect(schemeSlug("internet")).toBe("internet");
    expect(schemeSlug("internal")).toBe("internal");
    expect(() => schemeSlug("public")).toThrow();
  });

  it("스택명/ALB명/Waker TG명 규약", () => {
    expect(albShardStackName("apphub-dev", "internet", 1)).toBe("apphub-dev-alb-internet-1");
    expect(shardAlbName("apphub-dev", "internal", 2)).toBe("apphub-dev-internal-alb-2");
    // n=0 internet은 기존 리소스 이름 유지(교체 금지), 그 외는 규약 이름.
    expect(wakerTgName("apphub-dev", "internet", 0)).toBe("apphub-dev-waker-tg");
    expect(wakerTgName("apphub-dev", "internal", 0)).toBe("apphub-dev-waker-internal-0");
    expect(wakerTgName("apphub-prod", "internet", 12)).toBe("apphub-prod-waker-internet-12");
  });

  it("ELB 이름 32자 제한을 넘기면 synth 단계에서 실패한다", () => {
    expect(() => wakerTgName("apphub-prod", "internet", 12345678)).toThrow(/32자/);
    expect(() => shardAlbName("apphub-prod", "internet", 1234567890)).toThrow(/32자/);
  });
});

describe("AlbShardStack — internet n=1", () => {
  let template: Template;
  beforeAll(() => {
    template = synth("internet", 1);
  });

  it("ALB 1대: internet-facing, 이름 apphub-dev-internet-alb-1, idle 300초", () => {
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Name: "apphub-dev-internet-alb-1",
      Scheme: "internet-facing",
      LoadBalancerAttributes: Match.arrayWith([
        { Key: "idle_timeout.timeout_seconds", Value: "300" },
      ]),
    });
  });

  it("internet ALB는 public subnet SSM에 배치된다", () => {
    const raw = JSON.stringify(template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"));
    expect(raw).toContain("networkpublicsubnetid0");
    expect(raw).toContain("networkpublicsubnetid1");
    expect(raw).not.toContain("networkprivatesubnetid");
  });

  it("SG는 network의 internet ALB SG를 재사용한다(새 SG 없음, D17 예외 목록 불변)", () => {
    template.resourceCountIs("AWS::EC2::SecurityGroup", 0);
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
    const raw = JSON.stringify(template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"));
    expect(raw).toContain("networkinternetalbsgid");
  });

  it("D17 — 어떤 SG ingress에도 0.0.0.0/0·::/0가 없다 + SG description ASCII", () => {
    assertNoOpenIngress(template, []);
    assertSgDescriptionsAscii(template);
  });

  it("HTTPS(443, 기본 404) + HTTP(80) → HTTPS 리다이렉트", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
      Certificates: [{ CertificateArn: Match.anyValue() }],
      DefaultActions: [Match.objectLike({ Type: "fixed-response", FixedResponseConfig: Match.objectLike({ StatusCode: "404" }) })],
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect", RedirectConfig: Match.objectLike({ Protocol: "HTTPS", StatusCode: "HTTP_301" }) })],
    });
  });

  it("전용 Waker TG(type=lambda, apphub-dev-waker-internet-1) — 타깃은 공유 Waker Lambda(SSM)", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Name: "apphub-dev-waker-internet-1",
      TargetType: "lambda",
      Targets: [{ Id: { Ref: Match.stringLikeRegexp("networkwakerfnarn") } }],
    });
  });

  it("Waker Lambda invoke 권한: principal elasticloadbalancing, SourceArn = 이 TG(이름 패턴), TG가 권한에 의존", () => {
    const perms = template.findResources("AWS::Lambda::Permission");
    const list = Object.entries(perms);
    expect(list.length).toBe(1);
    const [permId, perm] = list[0];
    const props = perm.Properties as Record<string, unknown>;
    expect(props["Principal"]).toBe("elasticloadbalancing.amazonaws.com");
    expect(props["Action"]).toBe("lambda:InvokeFunction");
    expect(JSON.stringify(props["FunctionName"])).toContain("networkwakerfnarn");
    expect(JSON.stringify(props["SourceArn"])).toContain("targetgroup/apphub-dev-waker-internet-1/*");
    const tgs = template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup");
    const tg = Object.values(tgs)[0] as { DependsOn?: string[] };
    expect(tg.DependsOn).toContain(permId);
  });

  it("SSM `/apphub/dev/network/alb/internet/1/{6 keys}` 발행(계약 §1.1)", () => {
    for (const key of ALB_SSM_KEYS) {
      template.hasResourceProperties("AWS::SSM::Parameter", {
        Name: `/apphub/dev/network/alb/internet/1/${key}`,
      });
    }
    template.resourceCountIs("AWS::SSM::Parameter", ALB_SSM_KEYS.length);
  });

  it("Export 없음(교차 스택 잠금 방지)", () => {
    const outputs = (template.toJSON() as { Outputs?: Record<string, { Export?: unknown }> }).Outputs ?? {};
    for (const out of Object.values(outputs)) expect(out.Export).toBeUndefined();
  });
});

describe("AlbShardStack — internal n=2", () => {
  let template: Template;
  beforeAll(() => {
    template = synth("internal", 2);
  });

  it("internal ALB, private subnet + internal ALB SG 재사용", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Name: "apphub-dev-internal-alb-2",
      Scheme: "internal",
    });
    const raw = JSON.stringify(template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"));
    expect(raw).toContain("networkprivatesubnetid0");
    expect(raw).toContain("networkinternalalbsgid");
    template.resourceCountIs("AWS::EC2::SecurityGroup", 0);
  });

  it("Waker TG 이름 apphub-dev-waker-internal-2 + SSM alb/internal/2/waker-tg-arn", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Name: "apphub-dev-waker-internal-2",
      TargetType: "lambda",
    });
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/apphub/dev/network/alb/internal/2/waker-tg-arn",
    });
  });
});

describe("AlbShardStack — 입력 검증", () => {
  it("albIndex 0(network 소유)이나 음수·비정수는 거부", () => {
    const make = (albIndex: number) => () =>
      new AlbShardStack(new App(), "Shard", { env: ENV, stage: "dev", schemeSlug: "internet", albIndex });
    expect(make(0)).toThrow(/albIndex/);
    expect(make(-1)).toThrow(/albIndex/);
    expect(make(1.5)).toThrow(/albIndex/);
  });
});
