import {
  Duration,
  RemovalPolicy,
  aws_applicationautoscaling as appscaling,
  aws_cloudwatch as cw,
  aws_cognito as cognito,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { resourcePrefix } from "../config";
import { albParamName, schemeSlug, type AlbSsmKey } from "../alb-keys";
import type { AppRuntimeParams } from "./app-params";

/**
 * app-runtime — 특정 앱의 **실행체** (apphub-conventions 2장, DESIGN.md 3.1/3.5).
 *
 * 포함(전부 앱별 — 앱 삭제 = 이 스택 삭제로 완결):
 *  - ECS Fargate 태스크 정의(프리셋 cpu/mem 주입) + 서비스
 *  - Target Group(/health 헬스체크) + 공유 ALB 리스너 규칙(host 기반, priority 파라미터 주입)
 *  - Route53 레코드(internal: private zone / internet-facing: public+private zone — 배정 ALB alias, D3)
 *  - 앱 태스크 역할(권한 템플릿 정책 주입) + 실행 역할
 *  - 로그 그룹(retention 30, 스택 삭제 시 함께)
 *  - EventBridge Scheduler 2개(가동 스케줄 시작/종료)
 *  - 시크릿은 ECS secrets(환경변수 아님, D8)
 *  - D16 Cognito 인증 리스너 옵션(cognitoProtect) + 앱 전용 Cognito 앱 클라이언트(콜백 정확히 1개)
 *
 * 드리프트 방지(DESIGN 3.5): desiredCount는 최초 생성 시에만 지정, 갱신 배포에선 미지정.
 * 공유 리소스(VPC/ALB/리스너/SG/hosted zone)는 network SSM에서 읽는다(Export 잠금 방지).
 */
export interface AppRuntimeProps {
  readonly params: AppRuntimeParams;
}

export class AppRuntime extends Construct {
  readonly service: ecs.FargateService;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly taskRole: iam.Role;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: AppRuntimeProps) {
    super(scope, id);

    const p = props.params;
    const prefix = resourcePrefix(p.stage);
    const appPrefix = `${prefix}-app-${p.appId}`;
    const isInternal = p.scheme === "internal";

    // ── network 공유 리소스 참조 (SSM, Export 아님) ─────────────────────────
    const netSsm = (key: string): string =>
      ssm.StringParameter.valueForStringParameter(this, `/apphub/${p.stage}/network/${key}`);

    // 배정된 ALB(D20): scheme + albIndex로 `/network/alb/{slug}/{n}/*` 키를 읽는다(계약 §6).
    //  n=0은 network 스택이, n≥1은 증설 스택(apphub-{stage}-alb-{slug}-{n})이 같은 키 체계로 발행한다.
    //  SG는 증설 ALB도 network의 scheme별 SG를 재사용하므로 scheme 고정 키 그대로.
    const albIndex = p.albIndex ?? 0;
    const albSsm = (key: AlbSsmKey): string =>
      ssm.StringParameter.valueForStringParameter(this, albParamName(p.stage, schemeSlug(p.scheme), albIndex, key));

    const vpcId = netSsm("vpc-id");
    const albDns = albSsm("alb-dns");
    const albZoneId = albSsm("alb-canonical-zone-id");
    const listenerArn = albSsm("https-listener-arn");
    // ALB full name은 요청 기반 스케일링·유휴 알람에서만 필요 → 필요할 때만 SSM 참조(불필요한 CFN 파라미터 방지).
    const albFullName = (): string => albSsm("alb-full-name");
    const albSgId = netSsm(isInternal ? "internal-alb-sg-id" : "internet-alb-sg-id");
    const appTaskSgId = netSsm("app-task-sg-id");
    const privateZoneId = netSsm("private-hosted-zone-id");
    const publicZoneId = netSsm("public-hosted-zone-id");
    const appsDomain = ssm.StringParameter.valueForStringParameter(
      this,
      `/apphub/${p.stage}/network/apps-domain`,
    );

    // VPC 참조: 앱 태스크는 PRIVATE_WITH_EGRESS에 배치한다. fromLookup은 계정 접근이 필요해
    //  CI/테스트 synth를 깨므로, network 스택이 발행한 개별 SSM(AZ·private subnet, 0-indexed)로
    //  fromVpcAttributes를 명시 배열로 구성한다(list-token 경고 없이 synth 안정, deploy 시점 resolve).
    //  dev/prod 부트스트랩 VPC는 2 AZ 고정(D-M2-01). 상수 SUBNET_COUNT로 개별 파라미터를 읽는다.
    const SUBNET_COUNT = 2;
    const azs: string[] = [];
    const privateSubnetIds: string[] = [];
    for (let i = 0; i < SUBNET_COUNT; i++) {
      privateSubnetIds.push(netSsm(`private-subnet-id-${i}`));
      azs.push(netSsm(`private-subnet-az-${i}`));
    }
    const vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId,
      availabilityZones: azs,
      privateSubnetIds,
    });

    const albSg = ec2.SecurityGroup.fromSecurityGroupId(this, "AlbSg", albSgId, {
      mutable: false,
    });
    // 앱 전용 태스크 SG — 인바운드는 ALB SG 참조로만(D17, CIDR 금지).
    const taskSg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc,
      securityGroupName: `${appPrefix}-task-sg`,
      description: `App task SG for ${p.appId} - inbound from shared ALB SG only (D17)`,
      allowAllOutbound: true,
    });
    taskSg.connections.allowFrom(albSg, ec2.Port.tcp(8080), "from shared ALB");
    void appTaskSgId; // 공유 태스크 SG는 참조 대상(네트워크 스택)이며, 앱은 전용 SG를 파생 사용.

    // ── 공유 ECS 클러스터 임포트 (D18 — stage당 1개, network 스택 소유) ──────
    // 앱별 클러스터를 만들지 않는다(D18). network가 만든 `${prefix}-cluster`를 SSM에서 읽어
    //  fromClusterAttributes로 임포트하고, 이 위에 서비스만 얹는다(앱 삭제 완결성은 서비스가
    //  이 runtime 스택 소유라 유지됨). vpc는 위에서 fromVpcAttributes로 구성한 것을 재사용.
    const clusterName = netSsm("cluster-name");
    const clusterArn = netSsm("cluster-arn");
    const cluster = ecs.Cluster.fromClusterAttributes(this, "Cluster", {
      clusterName,
      clusterArn,
      vpc,
      securityGroups: [],
    });

    // ── 로그 그룹 (retention 30, 스택 삭제 시 함께) ─────────────────────────
    // 경로 규약: /apphub/{stage}/app/{appId} — platform API의 logs:FilterLogEvents 권한 범위와 일치.
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/apphub/${p.stage}/app/${p.appId}`,
      retention: logs.RetentionDays.ONE_MONTH, // 30일 (DESIGN 9)
      removalPolicy: RemovalPolicy.DESTROY, // 앱 삭제 시 함께 소멸
    });
    this.logGroup = logGroup;

    // ── IAM 역할 ──────────────────────────────────────────────────────────
    // 실행 역할: ECR pull + 로그 write + 시크릿 read(ECS secrets 주입용).
    const executionRole = new iam.Role(this, "ExecutionRole", {
      roleName: `${appPrefix}-exec`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    logGroup.grantWrite(executionRole);

    // 태스크 역할: 권한 템플릿 정책 주입(관리자 정의). 없으면 권한 없음(최소 권한, D7).
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `${appPrefix}-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `App task role for ${p.appId} (permission template injected)`,
    });
    // 권한 템플릿의 policyDocument(IAM 정책 문서)를 인라인 정책으로 부착.
    // "기본(추가 권한 없음)" 템플릿은 Statement:[] 인 빈 정책 — IAM은 빈 Statement 정책을
    // 거부(MalformedPolicyDocument)하므로 Statement 가 실제로 있을 때만 attach 한다.
    const policyStatements = (p.permissionPolicy as { Statement?: unknown[] } | undefined)
      ?.Statement;
    if (Array.isArray(policyStatements) && policyStatements.length > 0) {
      taskRole.attachInlinePolicy(
        new iam.Policy(this, "PermissionTemplate", {
          policyName: "permission-template",
          document: iam.PolicyDocument.fromJson(p.permissionPolicy),
        }),
      );
    }
    this.taskRole = taskRole;

    // ── 태스크 정의 (프리셋 cpu/mem 주입) ───────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      family: `${appPrefix}`,
      cpu: p.cpu,
      memoryLimitMiB: p.memory,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // 이미지: 앱 pipeline이 push한 ECR 리포(태그=commitSha). 리포명 규약은 app-pipeline과 공유.
    //  fromEcrRepository를 쓰면 실행 역할에 ECR pull 정책이 자동 부여된다(fromRegistry는 미부여).
    const ecrRepo = ecr.Repository.fromRepositoryName(this, "Ecr", `${appPrefix}`);
    const image = ecs.ContainerImage.fromEcrRepository(ecrRepo, p.imageTag);

    // 시크릿: 앱당 Secrets Manager 시크릿 1개(JSON {KEY: value}, D8). 리소스는 백엔드 소유 — 참조만.
    //  각 KEY → ECS secrets valueFrom `<arn>:KEY::`(환경변수 아님). 실행 역할은 이 시크릿 1개만 read.
    const secrets: Record<string, ecs.Secret> = {};
    if (p.secretArn && p.secretKeys.length > 0) {
      const sm = secretsmanager.Secret.fromSecretCompleteArn(this, "AppSecret", p.secretArn);
      for (const key of p.secretKeys) {
        // fromSecretsManager(secret, field)는 실행 역할에 해당 시크릿 GetSecretValue를 자동 부여한다.
        secrets[key] = ecs.Secret.fromSecretsManager(sm, key);
      }
    }

    const container = taskDef.addContainer("app", {
      image,
      containerName: "app",
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "app", logGroup }),
      environment: {
        // 컨테이너 계약: 8080 포트(KIRO-STANDARDS C2). PORT도 관례로 주입.
        PORT: "8080",
        ...p.envVars,
      },
      secrets, // ← 시크릿은 여기(환경변수 아님)
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      // D8/QA D-1: 배포 식별자 라벨 — 매 배포 태스크 정의가 달라져 새 리비전 → 태스크 교체.
      //  KEY 목록이 같고 값만 바뀐 시크릿 재배포도 새 태스크가 새 값을 읽는다. 미지정이면 라벨 생략.
      ...(p.deployId ? { dockerLabels: { "apphub.deployId": p.deployId } } : {}),
    });
    void container;

    // ── Fargate 서비스 ──────────────────────────────────────────────────────
    // desiredCount: 최초 생성 시에만 minCount 지정, 갱신 배포에선 미지정(드리프트 방지, DESIGN 3.5).
    this.service = new ecs.FargateService(this, "Service", {
      serviceName: `${appPrefix}`,
      cluster,
      taskDefinition: taskDef,
      securityGroups: [taskSg],
      // fromVpcAttributes로 만든 VPC는 subnetType selection이 불가하므로 subnet 목록을 직접 지정.
      vpcSubnets: { subnets: vpc.privateSubnets },
      ...(p.isInitialDeploy ? { desiredCount: p.minCount } : {}),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true }, // 배포 실패 시 자동 롤백(이전 버전 유지, DESIGN 3.3)
      healthCheckGracePeriod: Duration.seconds(60), // C9 기동 60초
    });

    // ── Target Group (/health 헬스체크) ─────────────────────────────────────
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, "Tg", {
      targetGroupName: `${prefix}-app-${p.appId}`.slice(0, 32),
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: "/health", // C3 헬스체크
        healthyHttpCodes: "200",
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // ── 오토스케일링 (프리셋 min/max + 스케일 기준) ──────────────────────────
    if (p.maxCount > p.minCount) {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: p.minCount,
        maxCapacity: p.maxCount,
      });
      if (p.scaleMetric === "cpu") {
        scaling.scaleOnCpuUtilization("CpuScaling", {
          targetUtilizationPercent: p.scaleThreshold,
        });
      } else {
        // requests 스케일: 공유 ALB를 임포트 리스너로 참조하므로 CDK 그래프가 TG-ALB attach를
        //  정적으로 인식하지 못한다 → scaleOnRequestCount(L2 편의 메서드)는 TargetGroupNeedsAttachedLoad로
        //  synth 실패(QA F-3). ALBRequestCountPerTarget predefined metric + resourceLabel을 명시한
        //  TargetTrackingScalingPolicy를 직접 구성해 attach 정적검증을 우회하면서 실제 요청기반 스케일링을 얻는다.
        //  resourceLabel = "{ALB full-name}/{TG full-name}" (ALB full-name은 network SSM, TG는 이 construct).
        new appscaling.TargetTrackingScalingPolicy(this, "ReqScaling", {
          scalingTarget: scaling,
          predefinedMetric: appscaling.PredefinedMetric.ALB_REQUEST_COUNT_PER_TARGET,
          resourceLabel: `${albFullName()}/${this.targetGroup.targetGroupFullName}`,
          targetValue: p.scaleThreshold,
        });
      }
    }

    // ── 공유 ALB 리스너 규칙 (host 기반, priority 파라미터 주입) ──────────────
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, "Listener", {
      listenerArn,
      securityGroup: albSg,
    });
    const host = `${p.subdomain}.${appsDomain}`;

    // 규칙 생성: 기본은 forward(앱 TG). D16 cognitoProtect면 아래 escape hatch로
    //  authenticate-cognito → forward 체인으로 재정의한다.
    //  (Waker는 잠자기 전환 시 이 액션 체인에서 forward 대상만 Waker TG로 교체 — 인증 유지, DESIGN 3.5)
    const rule = new elbv2.ApplicationListenerRule(this, "HostRule", {
      listener,
      priority: p.rulePriority, // ← DDB 카운터에서 발급받아 주입(자동 채번 금지)
      conditions: [elbv2.ListenerCondition.hostHeaders([host])],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // D16: authenticate-cognito 네이티브 액션. CDK L2(authenticateOidc)는 OIDC 엔드포인트를 요구해
    //  Cognito 네이티브 액션과 맞지 않으므로 CfnListenerRule escape hatch로 정확히 기술한다.
    //  앱 전용 Cognito 앱 클라이언트(QA N1, D16 2026-10-08): Cognito는 콜백 와일드카드를 지원하지 않아
    //  공유 클라이언트(`*.appsDomain`)로는 redirect_mismatch. 앱마다 이 runtime 스택이 클라이언트를 소유해
    //  콜백을 정확히 `https://{subdomain}.{appsDomain}/oauth2/idpresponse` 1개로 둔다(앱 삭제 = 스택 삭제로 정리).
    //  User Pool·Hosted UI 도메인은 platform 소유(SSM 참조). 클라이언트 생성은 CFN 실행 역할(CDK bootstrap)이 수행.
    if (p.cognitoProtect) {
      const platformSsm = (key: string): string =>
        ssm.StringParameter.valueForStringParameter(this, `/apphub/${p.stage}/platform/${key}`);
      const userPoolId = platformSsm("user-pool-id");
      const userPoolArn = platformSsm("user-pool-arn");
      const userPoolDomain = platformSsm("user-pool-domain");
      // appsDomain은 SSM 토큰 → 템플릿 문자열이 Fn::Join으로 합성된다(와일드카드 없음, 정확히 1개).
      const callbackUrl = `https://${host}/oauth2/idpresponse`;
      const authClient = new cognito.CfnUserPoolClient(this, "AuthClient", {
        userPoolId,
        clientName: `${appPrefix}-auth`,
        generateSecret: true, // ALB authenticate-cognito 요구
        allowedOAuthFlowsUserPoolClient: true,
        allowedOAuthFlows: ["code"],
        allowedOAuthScopes: ["openid", "email"],
        supportedIdentityProviders: ["COGNITO"],
        callbackUrLs: [callbackUrl],
        explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
        preventUserExistenceErrors: "ENABLED",
      });
      const cfnRule = rule.node.defaultChild as elbv2.CfnListenerRule;
      cfnRule.actions = [
        {
          type: "authenticate-cognito",
          order: 1,
          authenticateCognitoConfig: {
            userPoolArn,
            userPoolClientId: authClient.ref,
            userPoolDomain,
            onUnauthenticatedRequest: "authenticate",
            scope: "openid",
          },
        },
        {
          type: "forward",
          order: 2,
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ];
    }

    // ── Route53 레코드 (D3 — 배정된 ALB alias) ───────────────────────────────
    // ALB 실체를 fromLookup 없이 DNS + canonical zone id(둘 다 ALB별 SSM)로 alias 대상 구성.
    //  route53_targets.LoadBalancerTarget은 ILoadBalancerV2 실체를 요구하므로,
    //  IAliasRecordTarget을 직접 구현해 SSM 토큰 값만으로 A alias를 만든다.
    //  - internal 앱       : private zone 1개.
    //  - internet-facing 앱: public zone + private zone 2개(버그 C). 사내 DNS가 {appsDomain}을 VPC
    //    Resolver로 포워딩하면 private zone만 보이므로 양쪽에 같은 ALB alias를 둔다(PLATFORM-ENGINEERING 5.2).
    //  논리 ID "AliasA"/"Zone"은 기존 레코드(scheme의 주 zone)를 그대로 유지(교체 방지). 추가분만 신규 ID.
    const albAliasTarget: route53.IAliasRecordTarget = {
      bind: () => ({ dnsName: albDns, hostedZoneId: albZoneId }),
    };
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: isInternal ? privateZoneId : publicZoneId,
      zoneName: appsDomain,
    });
    new route53.ARecord(this, "AliasA", {
      zone,
      recordName: p.subdomain,
      target: route53.RecordTarget.fromAlias(albAliasTarget),
    });
    if (!isInternal) {
      const privateZone = route53.HostedZone.fromHostedZoneAttributes(this, "PrivateZone", {
        hostedZoneId: privateZoneId,
        zoneName: appsDomain,
      });
      new route53.ARecord(this, "AliasAPrivate", {
        zone: privateZone,
        recordName: p.subdomain,
        target: route53.RecordTarget.fromAlias(albAliasTarget),
      });
    }
    void route53_targets;

    // ── EventBridge Scheduler 2개 (가동 스케줄 — DESIGN 3.5) ─────────────────
    // 시작 시각: ECS desiredCount=minCount(태스크 기동). sleepMode=schedule일 때만.
    // 종료 시각: network의 공유 sleep-transition Lambda를 직접 호출(잠자기 전환).
    if (p.sleepMode === "schedule" && p.schedule) {
      // sleep-transition Lambda ARN — network 스택이 SSM(`sleep-transition-fn-arn`)에 발행.
      //  (network-stack.ts publishSsm 참조. 함수명은 결정론적 `${prefix}-sleep-transition`.)
      const sleepTransitionFnArn = netSsm("sleep-transition-fn-arn");

      const schedulerRole = new iam.Role(this, "SchedulerRole", {
        roleName: `${appPrefix}-scheduler`,
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      });
      // start용: ECS UpdateService(desiredCount=min). 이 앱 서비스 ARN으로 한정(D7, Resource:"*" 금지).
      schedulerRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "StartUpdateService",
          actions: ["ecs:UpdateService"],
          resources: [this.service.serviceArn],
        }),
      );
      // stop용: sleep-transition Lambda 호출. 그 함수 ARN으로 한정(Resource:"*" 금지).
      schedulerRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "StopInvokeSleepTransition",
          actions: ["lambda:InvokeFunction"],
          resources: [sleepTransitionFnArn],
        }),
      );

      const cron = (time: string): string => {
        const [hh, mm] = time.split(":");
        const dow = p.schedule!.days.map((d) => d + 1).join(","); // scheduler cron: 1(SUN)~7(SAT)
        return `cron(${Number(mm)} ${Number(hh)} ? * ${dow} *)`;
      };

      // 시작 target: ecs:UpdateService (universal target arn = arn:aws:scheduler:::aws-sdk:ecs:updateService).
      //  start가 desiredCount=min으로 태스크를 띄우면 ECS Task State Change(RUNNING) 이벤트가
      //  자동 발생 → network의 wake-restore Lambda가 리스너 규칙 복원 + runtimeState=RUNNING 기록을
      //  이미 수행한다(backend/app/wake/restore.py). 그래서 start는 ECS만 건드리면 충분(현행 유지).
      const startTarget: scheduler.CfnSchedule.TargetProperty = {
        arn: "arn:aws:scheduler:::aws-sdk:ecs:updateService",
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({
          // 공유 클러스터(D18) ARN — 임포트 클러스터의 clusterArn(network SSM cluster-arn 값).
          Cluster: cluster.clusterArn,
          Service: this.service.serviceName,
          DesiredCount: p.minCount,
        }),
      };

      // 종료 target: sleep-transition Lambda 직접 호출(templated Lambda Invoke target).
      //  target.arn = 함수 ARN, input = payload. sleep.py의 app_id_from_sleep_event가 event.appId를
      //  최우선 파싱하므로 {"appId": ...} payload면 Lambda 코드 변경 없이 그대로 동작(직접호출 케이스).
      //  이 경로가 ECS 정지(desiredCount=0) + 리스너 규칙 to=waker 전환 + runtimeState=SLEEPING 기록을
      //  모두 멱등 수행한다(유휴 알람 경로와 동일한 sleep_app). 이전 updateService 타겟은 desiredCount만
      //  바꿔 규칙 전환·SLEEPING 기록을 건너뛰던 결함을 이 변경이 교정한다.
      const stopTarget: scheduler.CfnSchedule.TargetProperty = {
        arn: sleepTransitionFnArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ appId: p.appId }),
      };

      new scheduler.CfnSchedule(this, "StartSchedule", {
        name: `${appPrefix}-start`,
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: cron(p.schedule.startTime),
        scheduleExpressionTimezone: p.schedule.timezone,
        target: startTarget,
        state: "ENABLED",
      });
      new scheduler.CfnSchedule(this, "StopSchedule", {
        name: `${appPrefix}-stop`,
        flexibleTimeWindow: { mode: "OFF" },
        scheduleExpression: cron(p.schedule.stopTime),
        scheduleExpressionTimezone: p.schedule.timezone,
        target: stopTarget,
        state: "ENABLED",
      });
    }

    // ── 유휴 재중지 알람 (DESIGN 3.5 — 유휴 15분 → 잠자기) ────────────────────
    // always-on은 잠들지 않는다(제외). on-demand/schedule 앱만 유휴 알람을 만든다.
    //  알람명 규약: {appPrefix}-idle → network의 공유 idle-sleep EventBridge 규칙이 잡아
    //  sleep-transition Lambda를 호출한다(alarmName에서 appId 파싱, D-M5-03). 앱 삭제 = 이 알람 삭제.
    //  지표: 앱 TG의 RequestCountPerTarget(TG+ALB 차원). ALB full name은 network SSM에서 읽는다.
    if (p.sleepMode !== "always-on") {
      const idleMetric = new cw.Metric({
        namespace: "AWS/ApplicationELB",
        metricName: "RequestCountPerTarget",
        dimensionsMap: {
          TargetGroup: this.targetGroup.targetGroupFullName,
          LoadBalancer: albFullName(),
        },
        statistic: "Sum",
        period: Duration.minutes(5),
      });
      new cw.Alarm(this, "IdleAlarm", {
        alarmName: `${appPrefix}-idle`,
        alarmDescription: `Idle (no requests) -> sleep transition trigger - ${p.appId}`,
        metric: idleMetric,
        // 5분×3 = 15분 연속 요청 0이면 ALARM(DESIGN 3.5: 유휴 15분).
        threshold: 1,
        comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        // 데이터 없음(=요청 0, 태스크 유휴)도 유휴로 간주해 ALARM 처리.
        treatMissingData: cw.TreatMissingData.BREACHING,
      });
    }
  }
}
