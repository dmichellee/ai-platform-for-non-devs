import * as path from "node:path";
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_targets as elbv2_targets,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { StageConfig, resourcePrefix } from "../lib/config";

/**
 * network-stack — 앱들이 **공유**하는 트래픽 인프라 (apphub-conventions 2장, DESIGN.md 3.1).
 *
 * 포함:
 *  - VPC (dev 부트스트랩용 최소 신규 VPC. D-decision 참조)
 *  - 공유 ALB 2대(internet-facing 1, internal 1) + 각 SG
 *  - 와일드카드 ACM 인증서 `*.{appsDomain}` (DNS 검증, public hosted zone 사용)
 *  - Route53: 기존 public hosted zone 참조 + internal용 private hosted zone
 *  - HTTPS 리스너(idle timeout 300초 — SSE 대비, DESIGN.md 3.5), HTTP→HTTPS 리다이렉트
 *  - Waker Lambda + 복원 Lambda + 공유 Waker Target Group
 *
 * D17 (PLATFORM-ENGINEERING.md 2장): 플랫폼 소유 SG ingress에 0.0.0.0/0·::/0 금지.
 *  유일한 예외 = internet-facing 공유 ALB SG (사용자 앱 인터넷 공개 목적).
 *  그 지점에만 Peer.anyIpv4()/anyIpv6()를 쓰고 D17 예외 주석을 단다.
 */
export interface NetworkStackProps extends StackProps {
  readonly stage: StageConfig["stage"];
  readonly config: StageConfig;
}

/**
 * D17 예외로 허용된 유일한 SG의 GroupDescription 식별 문자열.
 * L2 공통 테스트가 예외 판정에 사용한다(하드코딩 드리프트 방지 — 단일 원본).
 */
export const D17_EXEMPT_SG_DESCRIPTION =
  "Shared internet-facing ALB SG - allowed CIDRs only (D17 exception)";

export class NetworkStack extends Stack {
  /** 앱 런타임/파이프라인 construct가 소비할 공유 리소스 참조 */
  readonly vpc: ec2.IVpc;
  readonly internetFacingAlb: elbv2.ApplicationLoadBalancer;
  readonly internalAlb: elbv2.ApplicationLoadBalancer;
  readonly internetHttpsListener: elbv2.ApplicationListener;
  readonly internalHttpsListener: elbv2.ApplicationListener;
  readonly certificate: acm.ICertificate;
  readonly publicHostedZone: route53.IHostedZone;
  readonly privateHostedZone: route53.PrivateHostedZone;
  readonly appTaskSecurityGroup: ec2.SecurityGroup;
  readonly wakerFunction: lambda.Function;
  readonly wakeRestoreFunction: lambda.Function;
  readonly sleepTransitionFunction: lambda.Function;
  readonly wakerTargetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = resourcePrefix(config.stage);

    // ── VPC ──────────────────────────────────────────────────────────────
    // D-decision: 관리자 등록 VPC는 런타임 개념(DESIGN.md 9)이나, 공유 ALB/앱이
    //  놓일 부트스트랩 VPC가 설치 시점에 필요하다. dev 편의를 위해 최소 신규 VPC를
    //  생성한다(2 AZ, public + private-with-egress). NAT는 비용 최소화를 위해 1개.
    const vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `${prefix}-vpc`,
      maxAzs: 2,
      natGateways: 1,
      ipAddresses: ec2.IpAddresses.cidr("10.20.0.0/16"),
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;

    // internal ALB ingress로 허용할 대역: 설치 시점 주입 CIDR, 미지정 시 VPC CIDR.
    // (PLATFORM-ENGINEERING.md 2장: internal은 사내/VPC 대역만)
    const internalIngressCidrs =
      config.allowedIngressCidrs.length > 0
        ? [...config.allowedIngressCidrs]
        : [vpc.vpcCidrBlock];

    // ── Route53 ──────────────────────────────────────────────────────────
    // public zone: 기존 존 참조(설치 전제조건 5.1). private zone: internal 앱용 신규.
    const publicHostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "PublicZone",
      { hostedZoneId: config.hostedZoneId, zoneName: config.appsDomain },
    );
    this.publicHostedZone = publicHostedZone;

    const privateHostedZone = new route53.PrivateHostedZone(this, "PrivateZone", {
      zoneName: config.appsDomain,
      vpc,
      comment: `${prefix} internal apps zone`,
    });
    this.privateHostedZone = privateHostedZone;

    // ── ACM 와일드카드 인증서 ──────────────────────────────────────────────
    // `*.{appsDomain}` — DNS 검증(public zone 자동). internet-facing/internal 공용.
    const certificate = new acm.Certificate(this, "WildcardCert", {
      domainName: `*.${config.appsDomain}`,
      subjectAlternativeNames: [config.appsDomain],
      validation: acm.CertificateValidation.fromDns(publicHostedZone),
    });
    this.certificate = certificate;

    // ── 보안 그룹 ──────────────────────────────────────────────────────────
    // internet-facing ALB SG — D17 예외(사용자 앱 인터넷 공개 목적).
    const internetAlbSg = new ec2.SecurityGroup(this, "InternetAlbSg", {
      vpc,
      securityGroupName: `${prefix}-internet-alb-sg`,
      description: D17_EXEMPT_SG_DESCRIPTION,
      allowAllOutbound: true,
    });
    // [D17 예외] internet-facing 공유 ALB. 이 지점만 anyIpv4/anyIpv6 허용된다.
    //  PLATFORM-ENGINEERING.md 2장 예외 목록 · L2 공통 테스트의 예외 SG.
    internetAlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS from internet (D17 exception)");
    internetAlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect from internet (D17 exception)");
    internetAlbSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), "HTTPS from internet IPv6 (D17 exception)");
    internetAlbSg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), "HTTP redirect from internet IPv6 (D17 exception)");

    // internal ALB SG — 사내/VPC 대역만. anyIpv4 금지.
    const internalAlbSg = new ec2.SecurityGroup(this, "InternalAlbSg", {
      vpc,
      securityGroupName: `${prefix}-internal-alb-sg`,
      description: "Shared internal ALB SG - VPC CIDR only (D17)",
      allowAllOutbound: true,
    });
    for (const cidr of internalIngressCidrs) {
      internalAlbSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `HTTPS from ${cidr}`);
      internalAlbSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `HTTP redirect from ${cidr}`);
    }

    // 앱 태스크 공유 SG — ALB SG 참조로만 인바운드(CIDR 금지). 앱 컨테이너 포트 8080.
    // 실제 앱 태스크는 이 SG를 참조/파생하여 사용(app-runtime, M4).
    const appTaskSg = new ec2.SecurityGroup(this, "AppTaskSg", {
      vpc,
      securityGroupName: `${prefix}-app-task-sg`,
      description: "Shared app task SG - inbound from ALB SG only (D17)",
      allowAllOutbound: true,
    });
    appTaskSg.connections.allowFrom(internetAlbSg, ec2.Port.tcp(8080), "from internet ALB");
    appTaskSg.connections.allowFrom(internalAlbSg, ec2.Port.tcp(8080), "from internal ALB");
    this.appTaskSecurityGroup = appTaskSg;

    // ── 공유 ALB 2대 ───────────────────────────────────────────────────────
    const internetFacingAlb = new elbv2.ApplicationLoadBalancer(this, "InternetAlb", {
      loadBalancerName: `${prefix}-internet-alb`,
      vpc,
      internetFacing: true,
      securityGroup: internetAlbSg,
      idleTimeout: Duration.seconds(300), // SSE/스트리밍 대비 (DESIGN.md 3.5)
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    this.internetFacingAlb = internetFacingAlb;

    const internalAlb = new elbv2.ApplicationLoadBalancer(this, "InternalAlb", {
      loadBalancerName: `${prefix}-internal-alb`,
      vpc,
      internetFacing: false, // scheme=internal
      securityGroup: internalAlbSg,
      idleTimeout: Duration.seconds(300),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.internalAlb = internalAlb;

    // ── Waker / 복원 / 잠자기 Lambda 3종 (D-M5-03, D-M8 Python 전환) ─────────
    // 함수 실코드는 backend(Python)가 build.sh로 infra/lambda/{waker,wake-restore,sleep-transition}에
    //  동기화해 둔다(app/ + handler.py shim). runtime=PYTHON_3_13, handler="handler.handler".
    //  network가 함수 리소스 + 트리거(EventBridge) + IAM(ecs/ddb/ssm/elbv2, ARN 범위)을 확정한다.
    //  공통 env: STAGE, APPS_DOMAIN(host = {subdomain}.{appsDomain} 구성용) +
    //   TABLE_NAME — 데이터 계층(app.data.client.table)이 요구(폴백 없음, D-M8 P2 필수 요청).
    //   테이블은 platform 스택이 만든 apphub-{stage}-main. 테이블명은 결정론적(`${prefix}-main`)이라
    //   크로스스택 참조/SSM 런타임 조회 없이 직접 주입한다(deploy.yml의 TABLE_NAME 재구성과 동일 규약).
    //   DDB 접근 IAM은 grantWakeFunctionPermissions의 ddbRw(tableArn + index/*)가 3함수에 부여.
    const commonEnv = {
      STAGE: config.stage,
      APPS_DOMAIN: config.appsDomain,
      TABLE_NAME: `${prefix}-main`,
    };
    const fnLog = (name: string): logs.LogGroup =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/apphub/${config.stage}/${name}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    // Waker — ALB Lambda 타깃. Host→앱 식별→ensureRunning(멱등)→대기페이지 200.
    const wakerFunction = new lambda.Function(this, "WakerFn", {
      functionName: `${prefix}-waker`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "waker")),
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup: fnLog("waker"),
      environment: commonEnv,
      description: "wake-on-request entry point (D-M5-03)",
    });
    this.wakerFunction = wakerFunction;

    // 복원 — EventBridge(ECS Task State Change RUNNING) 수신 → 리스너 규칙 forward를 앱 TG로 복원.
    const wakeRestoreFunction = new lambda.Function(this, "WakeRestoreFn", {
      functionName: `${prefix}-wake-restore`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "wake-restore")),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: fnLog("wake-restore"),
      environment: commonEnv,
      description: "on app healthy event -> restore listener rule (D-M5-03)",
    });
    this.wakeRestoreFunction = wakeRestoreFunction;

    // 잠자기 — 유휴 알람(CloudWatch Alarm State Change) 수신 → desiredCount=0 + 규칙 to=waker.
    const sleepTransitionFunction = new lambda.Function(this, "SleepTransitionFn", {
      functionName: `${prefix}-sleep-transition`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "sleep-transition")),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: fnLog("sleep-transition"),
      environment: commonEnv,
      description: "idle alarm -> sleep transition (desiredCount=0 + rule to=waker) (D-M5-03)",
    });
    this.sleepTransitionFunction = sleepTransitionFunction;

    // ── Waker/복원/잠자기 IAM (D-M5-03, ARN 범위 — Resource:"*"는 미지원 액션만) ──
    this.grantWakeFunctionPermissions(config.stage, prefix, {
      waker: wakerFunction,
      restore: wakeRestoreFunction,
      sleep: sleepTransitionFunction,
    });

    // ── 트리거: 복원 EventBridge 규칙(ECS Task State Change RUNNING) ──────────
    // 앱 서비스(group=service:apphub-{stage}-app-*)의 태스크가 RUNNING이 되면 복원 Lambda 호출.
    //  앱별 규칙이 아니라 group prefix 패턴 단일 규칙 → 앱 삭제 시 network에 잔여 리소스 없음(공유).
    const restoreRule = new events.Rule(this, "WakeRestoreRule", {
      ruleName: `${prefix}-wake-restore`,
      description: "ECS task RUNNING -> restore listener rule (wake-on-request)",
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          lastStatus: ["RUNNING"],
          group: [{ prefix: `service:${prefix}-app-` }],
        },
      },
    });
    restoreRule.addTarget(new events_targets.LambdaFunction(wakeRestoreFunction));

    // ── 트리거: 잠자기 EventBridge 규칙(CloudWatch Alarm State Change → ALARM) ─
    // app-runtime이 만드는 유휴 알람(이름 규약 apphub-{stage}-app-{appId}-idle)이 ALARM으로 바뀌면
    //  잠자기 Lambda 호출. 알람명 prefix 패턴 단일 규칙(앱별 아님) → network 잔여 리소스 없음.
    //  sleep.ts가 event.detail.alarmName에서 appId를 파싱한다(계약 정합).
    const sleepRule = new events.Rule(this, "IdleSleepRule", {
      ruleName: `${prefix}-idle-sleep`,
      description: "idle alarm ALARM -> sleep transition",
      eventPattern: {
        source: ["aws.cloudwatch"],
        detailType: ["CloudWatch Alarm State Change"],
        detail: {
          alarmName: [{ prefix: `${prefix}-app-` }],
          state: { value: ["ALARM"] },
        },
      },
    });
    sleepRule.addTarget(new events_targets.LambdaFunction(sleepTransitionFunction));

    // 공유 Waker Target Group — 잠자는 앱의 리스너 규칙이 이 TG로 forward 전환된다.
    const wakerTargetGroup = new elbv2.ApplicationTargetGroup(this, "WakerTg", {
      targetGroupName: `${prefix}-waker-tg`,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2_targets.LambdaTarget(wakerFunction)],
    });
    this.wakerTargetGroup = wakerTargetGroup;

    // ── HTTPS 리스너 + HTTP→HTTPS 리다이렉트 ────────────────────────────────
    // 기본 동작: 매칭 규칙 없는 호스트는 404 고정 응답(앱 규칙은 app-runtime이 추가).
    const internetHttpsListener = this.addHttpsListener(internetFacingAlb, certificate);
    this.addHttpRedirect(internetFacingAlb);
    this.internetHttpsListener = internetHttpsListener;

    const internalHttpsListener = this.addHttpsListener(internalAlb, certificate);
    this.addHttpRedirect(internalAlb);
    this.internalHttpsListener = internalHttpsListener;

    // ── 공유 참조 SSM 파라미터 (Export 대신, cdk-authoring 규칙) ─────────────
    // app-runtime(M4)이 VPC를 fromVpcAttributes로 재구성하고 앱 도메인/서브넷을 읽는 데 쓴다.
    //  (fromLookup은 계정 접근이 필요해 CI/앱스택 synth를 깨므로 SSM 발행값으로 대체)
    new ssm.StringParameter(this, "SsmAppsDomain", {
      parameterName: `/apphub/${config.stage}/network/apps-domain`,
      stringValue: config.appsDomain,
    });
    // 앱 태스크 배치용 private subnet: AZ 개수가 dev 부트스트랩 VPC에서 2로 고정(D-M2-01)이라
    //  개별 SSM 파라미터(0-indexed)로 발행한다. app-runtime이 fromVpcAttributes에 명시 배열로
    //  넘겨 synth 시점 list-token 경고를 피한다. AZ도 subnet과 1:1로 개별 발행.
    vpc.privateSubnets.forEach((subnet, i) => {
      new ssm.StringParameter(this, `SsmPrivateSubnet${i}`, {
        parameterName: `/apphub/${config.stage}/network/private-subnet-id-${i}`,
        stringValue: subnet.subnetId,
      });
      new ssm.StringParameter(this, `SsmPrivateSubnetAz${i}`, {
        parameterName: `/apphub/${config.stage}/network/private-subnet-az-${i}`,
        stringValue: subnet.availabilityZone,
      });
    });
    new ssm.StringParameter(this, "SsmPrivateSubnetCount", {
      parameterName: `/apphub/${config.stage}/network/private-subnet-count`,
      stringValue: String(vpc.privateSubnets.length),
    });

    this.publishSsm(config.stage, {
      "vpc-id": vpc.vpcId,
      "internet-alb-arn": internetFacingAlb.loadBalancerArn,
      "internet-alb-dns": internetFacingAlb.loadBalancerDnsName,
      "internet-alb-canonical-zone-id": internetFacingAlb.loadBalancerCanonicalHostedZoneId,
      // ALB full name(app/name/id) — app-runtime의 유휴 알람 RequestCountPerTarget 차원에 필요(D-M5-03).
      "internet-alb-full-name": internetFacingAlb.loadBalancerFullName,
      "internal-alb-arn": internalAlb.loadBalancerArn,
      "internal-alb-dns": internalAlb.loadBalancerDnsName,
      "internal-alb-canonical-zone-id": internalAlb.loadBalancerCanonicalHostedZoneId,
      "internal-alb-full-name": internalAlb.loadBalancerFullName,
      "internet-https-listener-arn": internetHttpsListener.listenerArn,
      "internal-https-listener-arn": internalHttpsListener.listenerArn,
      "certificate-arn": certificate.certificateArn,
      "public-hosted-zone-id": config.hostedZoneId,
      "private-hosted-zone-id": privateHostedZone.hostedZoneId,
      "app-task-sg-id": appTaskSg.securityGroupId,
      "internet-alb-sg-id": internetAlbSg.securityGroupId,
      "internal-alb-sg-id": internalAlbSg.securityGroupId,
      "waker-fn-arn": wakerFunction.functionArn,
      "waker-fn-name": wakerFunction.functionName,
      "wake-restore-fn-arn": wakeRestoreFunction.functionArn,
      "sleep-transition-fn-arn": sleepTransitionFunction.functionArn,
      "sleep-transition-fn-name": sleepTransitionFunction.functionName,
      "waker-tg-arn": wakerTargetGroup.targetGroupArn,
    });

    // ── CloudFormation Outputs (deploy.sh / 문서 소비용) ────────────────────
    this.output("VpcId", vpc.vpcId);
    this.output("InternetAlbArn", internetFacingAlb.loadBalancerArn);
    this.output("InternetAlbDnsName", internetFacingAlb.loadBalancerDnsName);
    this.output("InternalAlbArn", internalAlb.loadBalancerArn);
    this.output("InternalAlbDnsName", internalAlb.loadBalancerDnsName);
    this.output("InternetHttpsListenerArn", internetHttpsListener.listenerArn);
    this.output("InternalHttpsListenerArn", internalHttpsListener.listenerArn);
    this.output("CertificateArn", certificate.certificateArn);
    this.output("PrivateHostedZoneId", privateHostedZone.hostedZoneId);
    this.output("AppTaskSecurityGroupId", appTaskSg.securityGroupId);
    this.output("WakerFunctionArn", wakerFunction.functionArn);
    this.output("WakeRestoreFunctionArn", wakeRestoreFunction.functionArn);
    this.output("SleepTransitionFunctionArn", sleepTransitionFunction.functionArn);
    this.output("WakerTargetGroupArn", wakerTargetGroup.targetGroupArn);

    void route53_targets; // internet-facing 앱 alias 레코드는 app-runtime에서 사용.
  }

  /** HTTPS(443) 리스너 — 인증서 부착, idle timeout은 ALB 레벨. 기본 404 응답. */
  private addHttpsListener(
    alb: elbv2.ApplicationLoadBalancer,
    certificate: acm.ICertificate,
  ): elbv2.ApplicationListener {
    return alb.addListener("Https", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      // open:false — 리스너가 SG에 0.0.0.0/0을 자동 추가하지 못하게 막고,
      //  ingress는 각 ALB SG에서 명시적으로만 관리한다(D17: internal은 대역 한정).
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "No app for this host",
      }),
    });
  }

  /** HTTP(80) → HTTPS(443) 영구 리다이렉트. */
  private addHttpRedirect(alb: elbv2.ApplicationLoadBalancer): void {
    alb.addListener("HttpRedirect", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false, // SG 자동 개방 방지 (D17)
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });
  }

  /**
   * Waker / 복원 / 잠자기 Lambda IAM (D-M5-03, apphub-conventions 7 — ARN 범위).
   *
   * 공통: DDB RW(단일 테이블), SSM GetParameter(network 공유값).
   * waker/sleep: ECS Describe/UpdateService(앱 서비스 apphub-{stage}-app-*).
   * 복원/sleep: ELBv2 리스너 규칙 전환(DescribeRules/ModifyRule) + DescribeTargetGroups.
   *
   * ELBv2 Describe 계열(DescribeRules/DescribeTargetGroups)은 리소스 레벨 미지원 → 계정 스코프
   * 예외로 둔다(주석). ModifyRule은 listener-rule ARN을 지원하나 앱 규칙 ARN을 사전에 알 수 없어
   * (런타임 조회) listener-rule/app 하위 와일드카드 패턴으로 좁힌다.
   */
  private grantWakeFunctionPermissions(
    stage: string,
    prefix: string,
    fns: { waker: lambda.Function; restore: lambda.Function; sleep: lambda.Function },
  ): void {
    const tableArn = this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${prefix}-main` });
    const ssmNetworkArn = this.formatArn({ service: "ssm", resource: "parameter", resourceName: `apphub/${stage}/network/*` });
    const appServiceArn = this.formatArn({ service: "ecs", resource: "service", resourceName: `${prefix}-app-*/${prefix}-app-*` });
    const listenerRuleArn = this.formatArn({
      service: "elasticloadbalancing",
      resource: "listener-rule/app",
      resourceName: "*",
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });

    const ddbRw = (fn: lambda.Function): void =>
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "AppTableRW",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          resources: [tableArn, `${tableArn}/index/*`],
        }),
      );
    const ssmRead = (fn: lambda.Function): void =>
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "ReadNetworkSsm",
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: [ssmNetworkArn],
        }),
      );
    const ecsControl = (fn: lambda.Function): void =>
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "EcsDescribeUpdate",
          actions: ["ecs:DescribeServices", "ecs:UpdateService"],
          resources: [appServiceArn],
        }),
      );
    const elbControl = (fn: lambda.Function): void => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "ElbModifyRule",
          actions: ["elasticloadbalancing:ModifyRule"],
          resources: [listenerRuleArn],
        }),
      );
      // Describe*/DescribeTargetGroups는 리소스 레벨 미지원 → 계정 스코프 * (정당 예외).
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: "ElbDescribe",
          actions: [
            "elasticloadbalancing:DescribeRules",
            "elasticloadbalancing:DescribeTargetGroups",
            "elasticloadbalancing:DescribeListeners",
          ],
          resources: ["*"],
        }),
      );
    };

    // waker: DDB RW + SSM + ECS(기동).
    ddbRw(fns.waker);
    ssmRead(fns.waker);
    ecsControl(fns.waker);
    // 복원: DDB RW + SSM + ELB(규칙 복원).
    ddbRw(fns.restore);
    ssmRead(fns.restore);
    elbControl(fns.restore);
    // 잠자기: DDB RW + SSM + ECS(중지) + ELB(규칙 to=waker).
    ddbRw(fns.sleep);
    ssmRead(fns.sleep);
    ecsControl(fns.sleep);
    elbControl(fns.sleep);
  }

  /** 공유 참조 SSM 파라미터 발행. 경로: /apphub/{stage}/network/{key} */
  private publishSsm(stage: string, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      new ssm.StringParameter(this, `Ssm-${key}`, {
        parameterName: `/apphub/${stage}/network/${key}`,
        stringValue: value,
      });
    }
  }

  /** CloudFormation Output 헬퍼 — export 없이(값 변경 잠금 방지). */
  private output(id: string, value: string): void {
    new CfnOutput(this, id, { value });
  }
}
