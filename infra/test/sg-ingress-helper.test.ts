import { describe, it, expect } from "vitest";
import { App, Stack, aws_ec2 as ec2 } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { assertNoOpenIngress } from "./helpers/sg-ingress";

/**
 * D17 공통 헬퍼의 자기검증 — 헬퍼가 실제로 위반을 잡는지(가드가 무력화되지 않았는지).
 * 이 테스트가 없으면 "항상 통과하는" 가드가 되어 D17을 지키지 못할 수 있다.
 */
describe("assertNoOpenIngress 헬퍼 자기검증", () => {
  function stackWithSg(build: (sg: ec2.SecurityGroup) => void, description: string): Template {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "111111111111", region: "ap-northeast-2" },
    });
    const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 2, natGateways: 0 });
    const sg = new ec2.SecurityGroup(stack, "Sg", { vpc, description });
    build(sg);
    return Template.fromStack(stack);
  }

  it("예외 목록에 없는 SG에 0.0.0.0/0 ingress가 있으면 fail 한다", () => {
    const t = stackWithSg(
      (sg) => sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443)),
      "non-exempt sg",
    );
    expect(() => assertNoOpenIngress(t, [])).toThrow(/D17/);
  });

  it("예외 목록에 없는 SG에 ::/0 ingress가 있으면 fail 한다", () => {
    const t = stackWithSg(
      (sg) => sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443)),
      "non-exempt sg",
    );
    expect(() => assertNoOpenIngress(t, [])).toThrow(/D17/);
  });

  it("예외 목록에 해당하는 SG의 0.0.0.0/0은 통과한다", () => {
    const t = stackWithSg(
      (sg) => sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443)),
      "internet-facing exception sg",
    );
    expect(() => assertNoOpenIngress(t, ["internet-facing exception"])).not.toThrow();
  });

  it("대역 한정 CIDR만 있는 SG는 통과한다", () => {
    const t = stackWithSg(
      (sg) => sg.addIngressRule(ec2.Peer.ipv4("10.0.0.0/16"), ec2.Port.tcp(443)),
      "internal sg",
    );
    expect(() => assertNoOpenIngress(t, [])).not.toThrow();
  });
});
