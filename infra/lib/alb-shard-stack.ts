import {
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_lambda as lambda,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { Stage } from "./config";
import { resourcePrefix } from "./config";
import {
  albParamName,
  assertAlbIndex,
  shardAlbName,
  wakerTgName,
  type AlbSsmKey,
  type SchemeSlug,
} from "./alb-keys";

/**
 * AlbShardStack — ALB 증설 스택 `apphub-{stage}-alb-{slug}-{n}` (n≥1, D20 / 계약 §1~§2).
 *
 * provisioner CodeBuild(`APP_STACK_KIND=alb`)가 `cdk deploy -c albShard=true -c albScheme=.. -c albIndex=..`
 * 로 배포한다. 앱 생성 흐름이 network 스택을 재배포하지 않도록 독립 스택으로 분리했다.
 *
 * 포함(전부 이 ALB 전용 — 여러 앱이 공유하는 플랫폼 소유 리소스, 앱 삭제와 무관):
 *  - ALB 1대(scheme, idle 300s, 공유 VPC 서브넷 — internet은 public, internal은 private)
 *    SG는 network의 scheme별 ALB SG를 **재사용**(새 SG를 만들지 않음 → D17 예외 목록 불변)
 *  - HTTPS 리스너(와일드카드 인증서, 기본 404) + HTTP→HTTPS 리다이렉트
 *  - 전용 Waker TG(`apphub-{stage}-waker-{slug}-{n}`) + 공유 Waker Lambda invoke 권한
 *    (principal elasticloadbalancing, SourceArn = 이 TG — 이름이 결정적이라 ARN 패턴으로 지정)
 *  - SSM `/apphub/{stage}/network/alb/{slug}/{n}/{alb-arn|alb-full-name|alb-dns|alb-canonical-zone-id|
 *    https-listener-arn|waker-tg-arn}` 발행
 *
 * 입력은 전부 network SSM(계약 §1.3) — domain/hostedZone 컨텍스트 불필요.
 */
export interface AlbShardStackProps extends StackProps {
  readonly stage: Stage;
  readonly schemeSlug: SchemeSlug;
  /** n ≥ 1 (n=0은 network 스택 소유). */
  readonly albIndex: number;
}

/**
 * 부트스트랩 VPC 서브넷 개수(2 AZ 고정, D-M2-01). synth 시점에 루프 횟수가 필요하므로 상수로 둔다
 * (app-runtime의 SUBNET_COUNT와 동일 근거). network가 `{public|private}-subnet-count`도 발행한다.
 */
const SUBNET_COUNT = 2;

export class AlbShardStack extends Stack {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly httpsListener: elbv2.ApplicationListener;
  readonly wakerTargetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: AlbShardStackProps) {
    super(scope, id, props);

    const { stage, schemeSlug: slug } = props;
    const index = assertAlbIndex(props.albIndex, { min: 1 });
    const prefix = resourcePrefix(stage);
    const isInternet = slug === "internet";

    const netSsm = (key: string): string =>
      ssm.StringParameter.valueForStringParameter(this, `/apphub/${stage}/network/${key}`);

    // ── 공유 VPC (network SSM, fromVpcAttributes 명시 배열 — lookup 없이 synth) ─────
    const subnetKind = isInternet ? "public" : "private";
    const azs: string[] = [];
    const subnetIds: string[] = [];
    for (let i = 0; i < SUBNET_COUNT; i++) {
      subnetIds.push(netSsm(`${subnetKind}-subnet-id-${i}`));
      azs.push(netSsm(`${subnetKind}-subnet-az-${i}`));
    }
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: netSsm("vpc-id"),
      availabilityZones: azs,
      ...(isInternet ? { publicSubnetIds: subnetIds } : { privateSubnetIds: subnetIds }),
    });

    // ── scheme별 ALB SG 재사용 (D17: internet SG는 network의 유일한 예외 SG — 여기서 새로 만들지 않는다) ─
    //  mutable:false — 리스너/타깃이 이 SG에 규칙을 덧붙이지 못하게 한다(ingress는 network가 단일 관리).
    const albSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "AlbSg",
      netSsm(isInternet ? "internet-alb-sg-id" : "internal-alb-sg-id"),
      { mutable: false },
    );

    // ── ALB ───────────────────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: shardAlbName(prefix, slug, index),
      vpc,
      internetFacing: isInternet,
      securityGroup: albSg,
      idleTimeout: Duration.seconds(300), // SSE/스트리밍 대비 — n=0과 동일
      vpcSubnets: { subnets: isInternet ? vpc.publicSubnets : vpc.privateSubnets },
    });
    this.alb = alb;

    // ── 리스너: HTTPS(와일드카드 인증서, 기본 404) + HTTP 리다이렉트 ─────────────
    const certificate = acm.Certificate.fromCertificateArn(this, "WildcardCert", netSsm("certificate-arn"));
    const httpsListener = alb.addListener("Https", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false, // SG 자동 개방 금지(D17) — ingress는 network ALB SG가 관리
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "No app for this host",
      }),
    });
    this.httpsListener = httpsListener;
    alb.addListener("HttpRedirect", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
    });

    // ── 전용 Waker TG + 공유 Waker Lambda invoke 권한 (계약 §1.2) ─────────────────
    //  Lambda 타깃 TG는 생성 시 타깃 등록 검증을 위해 invoke 권한이 먼저 있어야 한다. SourceArn을 TG ARN으로
    //  정확히 걸면 TG↔권한 순환이 생기므로, 결정적인 TG 이름으로 ARN 패턴(`targetgroup/{name}/*`)을 쓴다
    //  (Lambda 리소스 정책 SourceArn은 ArnLike 평가). 권한은 이 스택 소유 → 스택 삭제 시 함께 제거.
    const tgName = wakerTgName(prefix, slug, index);
    const wakerFnArn = netSsm("waker-fn-arn");
    const invokePermission = new lambda.CfnPermission(this, "WakerInvokeFromTg", {
      action: "lambda:InvokeFunction",
      functionName: wakerFnArn,
      principal: "elasticloadbalancing.amazonaws.com",
      sourceAccount: this.account,
      sourceArn: this.formatArn({
        service: "elasticloadbalancing",
        resource: "targetgroup",
        resourceName: `${tgName}/*`,
      }),
    });
    const wakerTargetGroup = new elbv2.ApplicationTargetGroup(this, "WakerTg", {
      targetGroupName: tgName,
      targetType: elbv2.TargetType.LAMBDA,
    });
    wakerTargetGroup.addTarget({
      attachToApplicationTargetGroup: () => ({
        targetType: elbv2.TargetType.LAMBDA,
        targetJson: { id: wakerFnArn },
      }),
    });
    wakerTargetGroup.node.addDependency(invokePermission);
    this.wakerTargetGroup = wakerTargetGroup;

    // ── SSM 발행 (계약 §1.1) + Outputs ─────────────────────────────────────────
    const values: Record<AlbSsmKey, string> = {
      "alb-arn": alb.loadBalancerArn,
      "alb-full-name": alb.loadBalancerFullName,
      "alb-dns": alb.loadBalancerDnsName,
      "alb-canonical-zone-id": alb.loadBalancerCanonicalHostedZoneId,
      "https-listener-arn": httpsListener.listenerArn,
      "waker-tg-arn": wakerTargetGroup.targetGroupArn,
    };
    for (const [key, value] of Object.entries(values)) {
      new ssm.StringParameter(this, `Ssm-${key}`, {
        parameterName: albParamName(stage, slug, index, key as AlbSsmKey),
        stringValue: value,
      });
    }

    new CfnOutput(this, "AlbArn", { value: alb.loadBalancerArn });
    new CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
    new CfnOutput(this, "HttpsListenerArn", { value: httpsListener.listenerArn });
    new CfnOutput(this, "WakerTargetGroupArn", { value: wakerTargetGroup.targetGroupArn });
  }
}
