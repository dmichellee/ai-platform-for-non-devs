import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AppRuntimeStack } from "../lib/app-stacks";
import { assertNoOpenIngress } from "./helpers/sg-ingress";
import type { AppRuntimeParams } from "../lib/constructs/app-params";

/**
 * L2 — app-runtime construct CDK assertions (cdk-authoring 앱 스택 특수 규칙).
 *
 * 단언 대상:
 *  - internal 앱 scheme (public 아님)
 *  - 시크릿이 ECS Secrets(환경변수 아님)로 주입 (D8)
 *  - 로그 그룹 retention 30일 + 스택 삭제 시 함께 삭제
 *  - EventBridge Scheduler 2개(가동 스케줄)
 *  - SG ingress에 0.0.0.0/0 부재(앱 태스크 SG는 ALB SG 참조만) — D17 공통
 *  - 리스너 규칙 priority가 주입 파라미터와 일치(자동 채번 금지)
 *  - D16 cognitoProtect: authenticate-cognito 액션
 *  - desiredCount 최초생성만 지정(갱신 미지정=드리프트 방지)
 */

const ENV = { account: "111122223333", region: "ap-northeast-2" };
// D8: 앱당 시크릿 1개(apphub/{stage}/app/{appId}) — 백엔드 소유, 완전 ARN(6자 suffix 포함)으로 참조.
const SECRET_ARN = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:apphub/dev/app/testapp0-AbCdEf";

function baseParams(overrides: Partial<AppRuntimeParams> = {}): AppRuntimeParams {
  return {
    stage: "dev",
    appId: "testapp0",
    subdomain: "testapp0",
    scheme: "internal",
    cpu: 256,
    memory: 512,
    minCount: 1,
    maxCount: 2,
    scaleMetric: "cpu",
    scaleThreshold: 70,
    imageTag: "abc123",
    rulePriority: 137,
    envVars: { FOO: "bar" },
    secretArn: SECRET_ARN,
    secretKeys: ["API_KEY", "DB_PASSWORD"],
    sleepMode: "schedule",
    schedule: { startTime: "09:00", stopTime: "19:00", days: [1, 2, 3, 4, 5], timezone: "Asia/Seoul" },
    cognitoProtect: false,
    isInitialDeploy: true,
    ...overrides,
  };
}

function synth(params: AppRuntimeParams): Template {
  const app = new App();
  const stack = new AppRuntimeStack(app, `apphub-dev-app-${params.appId}-runtime`, {
    env: ENV,
    params,
  });
  return Template.fromStack(stack);
}

describe("app-runtime — internal 앱(schedule + secrets)", () => {
  let template: Template;
  beforeAll(() => {
    template = synth(baseParams());
  });

  describe("D17 공통 — SG ingress 개방 대역 부재", () => {
    it("앱 태스크 SG는 ALB SG 참조로만 인바운드(0.0.0.0/0 부재)", () => {
      // 앱 스택에는 D17 예외 SG가 없다(internet-facing ALB SG는 network 스택 소유).
      assertNoOpenIngress(template, []);
    });

    it("태스크 SG ingress는 SourceSecurityGroupId(ALB SG 참조)로 8080만 연다", () => {
      template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
        FromPort: 8080,
        ToPort: 8080,
        IpProtocol: "tcp",
        SourceSecurityGroupId: Match.anyValue(),
      });
    });
  });

  describe("D18 — 공유 클러스터 임포트(앱별 클러스터 생성 금지)", () => {
    it("app-runtime 스택은 ECS 클러스터를 만들지 않는다(network 공유 클러스터 임포트)", () => {
      template.resourceCountIs("AWS::ECS::Cluster", 0);
    });

    it("ECS 서비스는 여전히 이 스택 소유(앱 삭제 완결성 유지)", () => {
      // 서비스는 runtime 스택 소유 — 클러스터만 network에서 임포트.
      template.resourceCountIs("AWS::ECS::Service", 1);
    });
  });

  describe("scheme — internal", () => {
    it("Route53 A 레코드가 만들어진다(subdomain 기준)", () => {
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Type: "A",
        AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
      });
    });
  });

  describe("시크릿 — 앱당 1개 JSON, KEY별 ECS Secrets(환경변수 아님, D8)", () => {
    type Container = {
      Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
      Environment?: Array<{ Name: string; Value: unknown }>;
    };
    const container = (): Container => {
      const tds = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
      expect(tds.length).toBe(1);
      return (tds[0].Properties as { ContainerDefinitions: Container[] }).ContainerDefinitions[0];
    };

    it("각 KEY가 Secrets[].ValueFrom = `<시크릿 ARN>:KEY::` 로 주입된다", () => {
      const c = container();
      expect(c.Secrets).toEqual([
        { Name: "API_KEY", ValueFrom: `${SECRET_ARN}:API_KEY::` },
        { Name: "DB_PASSWORD", ValueFrom: `${SECRET_ARN}:DB_PASSWORD::` },
      ]);
    });

    it("Environment에는 시크릿 KEY·ARN이 없다(평문 envVars만)", () => {
      const env = container().Environment ?? [];
      const names = env.map((e) => e.Name);
      expect(names).toContain("FOO");
      expect(names).not.toContain("API_KEY");
      expect(names).not.toContain("DB_PASSWORD");
      expect(JSON.stringify(env)).not.toContain("secretsmanager");
    });

    it("이 스택은 시크릿 리소스를 소유하지 않는다(백엔드 소유 — 참조만)", () => {
      template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    });

    it("실행 역할의 시크릿 권한은 이 앱 시크릿 1개(완전 ARN)에 대해서만 GetSecretValue 계열", () => {
      const roles = template.findResources("AWS::IAM::Role", {
        Properties: { RoleName: "apphub-dev-app-testapp0-exec" },
      });
      const [execId] = Object.keys(roles);
      expect(execId).toBeDefined();
      const smStatements: Array<{ Action: unknown; Resource: unknown }> = [];
      for (const pol of Object.values(template.findResources("AWS::IAM::Policy"))) {
        const props = pol.Properties as {
          Roles?: Array<{ Ref?: string }>;
          PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
        };
        for (const st of props.PolicyDocument.Statement) {
          const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
          if (actions.some((a) => String(a).startsWith("secretsmanager:"))) {
            // 시크릿 권한은 실행 역할에만(태스크 역할 아님).
            expect(props.Roles?.map((r) => r.Ref)).toEqual([execId]);
            smStatements.push(st);
          }
        }
      }
      expect(smStatements.length).toBe(1);
      const actions = smStatements[0].Action as string[];
      expect(actions).toContain("secretsmanager:GetSecretValue");
      // 쓰기/삭제/생성 권한 없음.
      for (const a of actions) {
        expect(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]).toContain(a);
      }
      // 리소스 = 정확히 이 시크릿 1개(와일드카드 없음).
      expect(smStatements[0].Resource).toEqual(SECRET_ARN);
    });
  });

  describe("시크릿 없음 — secretArn 미지정", () => {
    it("Secrets 미주입 + 실행 역할에 secretsmanager 권한 없음", () => {
      const t = synth(baseParams({ secretArn: undefined, secretKeys: [] }));
      const raw = JSON.stringify(t.toJSON());
      expect(raw).not.toContain("secretsmanager:");
      expect(raw).not.toContain('"Secrets"');
    });
  });

  describe("로그 그룹 — retention 30 + 삭제 동반", () => {
    it("retention 30일 로그 그룹 + 경로 /apphub/dev/app/{appId}", () => {
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/apphub/dev/app/testapp0",
        RetentionInDays: 30,
      });
    });

    it("로그 그룹은 스택 삭제 시 함께 삭제된다(DeletionPolicy: Delete)", () => {
      const lgs = template.findResources("AWS::Logs::LogGroup");
      for (const lg of Object.values(lgs)) {
        expect(lg.DeletionPolicy).toBe("Delete");
      }
    });
  });

  describe("EventBridge Scheduler — 가동 스케줄 2개", () => {
    it("시작/종료 스케줄 2개가 만들어진다", () => {
      template.resourceCountIs("AWS::Scheduler::Schedule", 2);
    });

    it("시작 스케줄은 ecs:UpdateService universal target + DesiredCount=min(현행 유지)", () => {
      // start는 ECS desiredCount=min으로 태스크 기동 → ECS Task State Change로 wake-restore가
      //  규칙 복원+RUNNING 기록을 자동 수행하므로 ECS만 건드리면 충분(설계 확정).
      template.hasResourceProperties("AWS::Scheduler::Schedule", {
        Name: "apphub-dev-app-testapp0-start",
        Target: Match.objectLike({
          Arn: "arn:aws:scheduler:::aws-sdk:ecs:updateService",
        }),
      });
      // Target.Input은 Fn::Join 조각(cluster ARN 토큰 포함)이라 전체 템플릿 JSON에서 조각을 찾는다.
      //  stringify된 조각에는 내부 따옴표가 이스케이프되어 `DesiredCount\":1` 형태로 나타난다.
      const raw = JSON.stringify(template.toJSON());
      expect(raw).toContain('DesiredCount\\":1'); // 시작(min=1)
    });

    it("종료 스케줄은 sleep-transition Lambda를 직접 호출한다(ECS updateService 아님 — 버그 수정)", () => {
      // 이전 결함: stop이 updateService(DesiredCount=0)만 해서 규칙 전환·SLEEPING 기록을 건너뜀.
      //  이제 network의 sleep-transition Lambda(함수 ARN)를 target으로 직접 호출한다(SSM 동적참조 토큰).
      const schedules = template.findResources("AWS::Scheduler::Schedule");
      const stop = Object.values(schedules).find(
        (s) => (s.Properties as Record<string, unknown>).Name === "apphub-dev-app-testapp0-stop",
      );
      expect(stop).toBeDefined();
      const target = (stop!.Properties as Record<string, unknown>).Target as Record<string, unknown>;
      // 종료 타겟 arn은 ecs universal target이 아니라 Lambda 함수 ARN(SSM 동적참조 Ref).
      const arn = JSON.stringify(target.Arn);
      expect(arn).not.toContain("aws-sdk:ecs:updateService");
      // netSsm("sleep-transition-fn-arn") → CFN 논리ID는 대시 제거된 `...sleeptransitionfnarn...` Ref.
      expect(arn).toContain("sleeptransitionfnarn");
      // Input payload에 appId가 담긴다(sleep.py의 event.appId 직접호출 파싱과 정합).
      // stop의 Input은 정적 문자열 `{"appId":"testapp0"}`.
      expect(JSON.stringify(target.Input)).toContain('appId\\":\\"testapp0');
    });

    it("SchedulerRole에 두 권한이 있다: ecs:UpdateService(start) + lambda:InvokeFunction(stop)", () => {
      // addToPolicy는 별도 AWS::IAM::Policy 리소스(역할 인라인 아님)로 attach된다.
      //  최소권한: ecs는 이 앱 서비스 ARN, lambda는 sleep-transition 함수 ARN으로 한정(Resource:"*" 금지).
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Action: "ecs:UpdateService", Effect: "Allow", Sid: "StartUpdateService" }),
            Match.objectLike({
              Action: "lambda:InvokeFunction",
              Effect: "Allow",
              Sid: "StopInvokeSleepTransition",
            }),
          ]),
        }),
        Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp("SchedulerRole") })]),
      });
    });

    it("SchedulerRole의 두 권한 모두 Resource:'*'가 아니다(ARN 한정)", () => {
      // scheduler 역할의 DefaultPolicy(AWS::IAM::Policy)에서 두 statement의 Resource가 * 아님을 단언.
      const policies = template.findResources("AWS::IAM::Policy");
      const schedPol = Object.values(policies).find((pol) => {
        const stmts =
          ((pol.Properties as Record<string, unknown>).PolicyDocument as {
            Statement?: Array<{ Sid?: string }>;
          }).Statement ?? [];
        return stmts.some((s) => s.Sid === "StopInvokeSleepTransition");
      });
      expect(schedPol).toBeDefined();
      const stmts = (
        (schedPol!.Properties as Record<string, unknown>).PolicyDocument as {
          Statement: Array<{ Action: string; Resource: unknown }>;
        }
      ).Statement;
      const invoke = stmts.find((s) => s.Action === "lambda:InvokeFunction");
      expect(invoke).toBeDefined();
      expect(invoke!.Resource).not.toBe("*");
      expect(JSON.stringify(invoke!.Resource)).toContain("sleeptransitionfnarn"); // 함수 ARN SSM Ref
      const ecsStmt = stmts.find((s) => s.Action === "ecs:UpdateService");
      expect(ecsStmt).toBeDefined();
      expect(ecsStmt!.Resource).not.toBe("*"); // 이 앱 서비스 ARN(Ref)
    });
  });

  describe("유휴 재중지 알람 (D-M5-03)", () => {
    it("sleepMode=schedule이면 유휴 알람({appPrefix}-idle)이 생성된다", () => {
      // network의 공유 idle-sleep 규칙이 이 알람명을 prefix로 잡아 sleep-transition을 호출.
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "apphub-dev-app-testapp0-idle",
        ComparisonOperator: "LessThanThreshold",
        EvaluationPeriods: 3,
        TreatMissingData: "breaching",
        Namespace: "AWS/ApplicationELB",
        MetricName: "RequestCountPerTarget",
      });
    });
  });

  describe("리스너 규칙 priority — 파라미터 주입(자동 채번 금지)", () => {
    it("Priority가 주입값(137)과 일치한다", () => {
      template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
        Priority: 137,
        Conditions: Match.arrayWith([
          Match.objectLike({ Field: "host-header" }),
        ]),
      });
    });
  });

  describe("드리프트 방지 — desiredCount 최초생성만", () => {
    it("isInitialDeploy=true면 서비스에 DesiredCount 지정", () => {
      template.hasResourceProperties("AWS::ECS::Service", {
        DesiredCount: 1,
      });
    });
  });

  describe("Target Group — /health 헬스체크", () => {
    it("헬스체크 경로 /health, 200 기대", () => {
      template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
        HealthCheckPath: "/health",
        Matcher: { HttpCode: "200" },
        Port: 8080,
      });
    });
  });
});

describe("app-runtime — 갱신 배포(isInitialDeploy=false)", () => {
  it("DesiredCount를 지정하지 않는다(현재 값 유지)", () => {
    const template = synth(baseParams({ isInitialDeploy: false }));
    const services = template.findResources("AWS::ECS::Service");
    for (const svc of Object.values(services)) {
      expect((svc.Properties as Record<string, unknown>)["DesiredCount"]).toBeUndefined();
    }
  });
});

describe("app-runtime — 스케줄 없음(always-on)", () => {
  it("sleepMode=always-on이면 Scheduler를 만들지 않는다", () => {
    const p = baseParams({ sleepMode: "always-on" });
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    template.resourceCountIs("AWS::Scheduler::Schedule", 0);
  });

  it("sleepMode=always-on이면 유휴 알람도 만들지 않는다(잠들지 않음)", () => {
    const p = baseParams({ sleepMode: "always-on" });
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });
});

describe("app-runtime — on-demand(유휴 알람 생성)", () => {
  it("sleepMode=on-demand면 유휴 알람이 생성된다(스케줄러는 없음)", () => {
    const p = baseParams({ sleepMode: "on-demand" });
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    template.resourceCountIs("AWS::Scheduler::Schedule", 0);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "apphub-dev-app-testapp0-idle",
    });
  });
});

describe("app-runtime — D16 cognitoProtect(internet-facing)", () => {
  let template: Template;
  beforeAll(() => {
    template = synth(
      baseParams({
        appId: "webapp01",
        subdomain: "myweb",
        scheme: "internet-facing",
        cognitoProtect: true,
        sleepMode: "on-demand",
        // internet-facing이라 schedule 제거
      }),
    );
  });

  it("리스너 규칙에 authenticate-cognito → forward 체인이 있다", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Actions: Match.arrayWith([
        Match.objectLike({ Type: "authenticate-cognito", Order: 1 }),
        Match.objectLike({ Type: "forward", Order: 2 }),
      ]),
    });
  });

  it("여전히 SG 개방 대역이 없다(앱 스택은 D17 예외 SG 없음)", () => {
    assertNoOpenIngress(template, []);
  });

  // ── QA N1 / D16(2026-10-08): 앱 전용 Cognito 앱 클라이언트 ─────────────────
  it("[N1] 앱 전용 UserPoolClient 1개 — secret 발급, code grant, openid+email, COGNITO, 이름 규약", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "apphub-dev-app-webapp01-auth",
      GenerateSecret: true,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email"],
      SupportedIdentityProviders: ["COGNITO"],
      // User Pool은 platform SSM 참조(배포 시점 resolve).
      UserPoolId: { Ref: Match.stringLikeRegexp("SsmParameterValueapphubdevplatformuserpoolid") },
    });
  });

  it("[N1] 콜백 URL은 정확히 1개 `https://myweb.{appsDomain}/oauth2/idpresponse` — 와일드카드 없음", () => {
    const [client] = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
    const cbs = (client.Properties as Record<string, unknown>)["CallbackURLs"] as unknown[];
    expect(cbs.length).toBe(1);
    const join = (cbs[0] as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
    expect(join[0]).toBe("");
    const parts = join[1];
    expect(parts[0]).toBe("https://myweb.");
    expect(JSON.stringify(parts[1])).toMatch(/"Ref":"SsmParameterValueapphubdevnetworkappsdomain/);
    expect(parts[2]).toBe("/oauth2/idpresponse");
    expect(JSON.stringify(cbs)).not.toContain("*");
  });

  it("[N1] 리스너 규칙 authenticate-cognito가 이 앱 클라이언트(Ref)를 쓰고, 공유 app-auth-client-id SSM을 읽지 않는다", () => {
    const clientId = Object.keys(template.findResources("AWS::Cognito::UserPoolClient"))[0];
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Actions: Match.arrayWith([
        Match.objectLike({
          Type: "authenticate-cognito",
          AuthenticateCognitoConfig: Match.objectLike({
            UserPoolClientId: { Ref: clientId },
            UserPoolArn: { Ref: Match.stringLikeRegexp("SsmParameterValueapphubdevplatformuserpoolarn") },
            UserPoolDomain: { Ref: Match.stringLikeRegexp("SsmParameterValueapphubdevplatformuserpooldomain") },
          }),
        }),
      ]),
    });
    expect(JSON.stringify(template.toJSON())).not.toContain("app-auth-client-id");
  });
});

describe("app-runtime — cognitoProtect=false 이면 Cognito 앱 클라이언트 없음 (N1)", () => {
  it("UserPoolClient 0개 + 규칙은 forward 단독", () => {
    const t = synth(
      baseParams({ appId: "open0001", subdomain: "open", scheme: "internet-facing", cognitoProtect: false, sleepMode: "on-demand", schedule: undefined }),
    );
    t.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    expect(JSON.stringify(t.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"))).not.toContain("authenticate-cognito");
  });
  it("[D21 2026-10-14] platform SSM user-pool-*(도메인 포함)을 읽지 않는다 — private 모드(도메인 미발행)에서도 배포 가능", () => {
    const t = synth(
      baseParams({ appId: "open0001", subdomain: "open", scheme: "internet-facing", cognitoProtect: false, sleepMode: "on-demand", schedule: undefined }),
    );
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain("/apphub/dev/platform/user-pool-domain");
    expect(json).not.toContain("/apphub/dev/platform/user-pool-id");
  });
});

describe("app-runtime — deployId docker 라벨 (D8, QA D-1)", () => {
  const containerOf = (t: Template): Record<string, unknown> => {
    const [td] = Object.values(t.findResources("AWS::ECS::TaskDefinition"));
    return ((td.Properties as Record<string, unknown>)["ContainerDefinitions"] as Array<Record<string, unknown>>)[0];
  };
  it("deployId가 있으면 컨테이너 DockerLabels apphub.deployId=<값>", () => {
    const t = synth(baseParams({ deployId: "apphub-dev-app-testapp0-deploy:11112222-3333" }));
    expect(containerOf(t)["DockerLabels"]).toEqual({ "apphub.deployId": "apphub-dev-app-testapp0-deploy:11112222-3333" });
  });
  it("deployId가 다르면 태스크 정의가 달라진다(새 리비전 → 태스크 교체)", () => {
    const a = containerOf(synth(baseParams({ deployId: "build-a" })));
    const b = containerOf(synth(baseParams({ deployId: "build-b" })));
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });
  it("deployId가 없으면 DockerLabels 자체가 없다(기존 synth 불변)", () => {
    expect(containerOf(synth(baseParams()))["DockerLabels"]).toBeUndefined();
  });
});

describe("app-runtime — scaleMetric=requests 오토스케일링 (QA F-3 회귀 방지)", () => {
  // 재현 조건: scaleMetric="requests" AND maxCount>minCount(오토스케일링 활성).
  //  임포트 리스너로 참조한 공유 ALB에서 scaleOnRequestCount(L2)는 TG-ALB attach 미인식으로
  //  synth 실패(TargetGroupNeedsAttachedLoad)했었다. TargetTrackingScalingPolicy(ALBRequestCountPerTarget
  //  + resourceLabel) 직접 구성으로 해소. 이 케이스가 테스트에 없어 놓쳤으므로 반드시 커버한다.
  function reqParams(overrides = {}) {
    return baseParams({
      appId: "reqapp01",
      subdomain: "reqapp01",
      scheme: "internet-facing",
      minCount: 1,
      maxCount: 3,
      scaleMetric: "requests",
      scaleThreshold: 50,
      sleepMode: "on-demand",
      cognitoProtect: false,
      ...overrides,
    });
  }

  it("synth가 성공한다(전에 TargetGroupNeedsAttachedLoad로 실패하던 조합)", () => {
    const p = reqParams();
    delete (p as { schedule?: unknown }).schedule; // on-demand
    expect(() => synth(p)).not.toThrow();
  });

  it("ALBRequestCountPerTarget predefined metric의 TargetTracking 정책이 생성된다", () => {
    const p = reqParams();
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: Match.objectLike({
          PredefinedMetricType: "ALBRequestCountPerTarget",
          // resourceLabel = "{ALB full-name}/{TG full-name}" — SSM 토큰(alb) + TargetGroupFullName(tg)의 Fn::Join
          ResourceLabel: Match.anyValue(),
        }),
        TargetValue: 50,
      }),
    });
  });

  it("resourceLabel이 network ALB full-name SSM + TG full-name 조합(Fn::Join with '/')이다", () => {
    const p = reqParams();
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    const policies = template.findResources("AWS::ApplicationAutoScaling::ScalingPolicy");
    const cfg = Object.values(policies)[0].Properties
      .TargetTrackingScalingPolicyConfiguration as Record<string, unknown>;
    const spec = cfg.PredefinedMetricSpecification as Record<string, unknown>;
    const label = spec.ResourceLabel as { "Fn::Join"?: [string, unknown[]] };
    // Fn::Join["", [ <alb-full-name SSM ref>, "/", <TG full-name GetAtt> ]]
    expect(label["Fn::Join"]).toBeDefined();
    const [sep, parts] = label["Fn::Join"]!;
    expect(sep).toBe("");
    expect(parts).toContain("/"); // 두 full-name 사이 구분자
    const rawParts = JSON.stringify(parts);
    // D20: 배정 ALB별 키 `/network/alb/internet/0/alb-full-name`(albIndex 미지정 = 0).
    expect(rawParts).toContain("networkalbinternet0albfullname");
    expect(rawParts).toContain("TargetGroupFullName"); // 이 construct의 TG full-name
  });

  it("internal scheme이면 internal-alb-full-name SSM을 resourceLabel에 쓴다", () => {
    const p = reqParams({ scheme: "internal", cognitoProtect: false });
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    const policies = template.findResources("AWS::ApplicationAutoScaling::ScalingPolicy");
    const cfg = Object.values(policies)[0].Properties
      .TargetTrackingScalingPolicyConfiguration as Record<string, unknown>;
    const spec = cfg.PredefinedMetricSpecification as Record<string, unknown>;
    expect(JSON.stringify(spec.ResourceLabel)).toContain("networkalbinternal0albfullname");
  });

  it("maxCount==minCount(스케일링 비활성)이면 어떤 ScalingPolicy도 만들지 않는다", () => {
    const p = reqParams({ minCount: 2, maxCount: 2 });
    delete (p as { schedule?: unknown }).schedule;
    const template = synth(p);
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 0);
  });
});

describe("app-runtime — scaleMetric=cpu 오토스케일링(회귀 없음 확인)", () => {
  // cpu 경로는 scaleOnCpuUtilization(TG attach 불필요)로 정상 — F-3 수정이 이 경로를 건드리지 않음을 고정.
  it("cpu + maxCount>minCount면 CPU 기반 TargetTracking 정책(ECSServiceAverageCPUUtilization)이 생성된다", () => {
    const template = synth(baseParams({ scaleMetric: "cpu", minCount: 1, maxCount: 2, scaleThreshold: 70 }));
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: Match.objectLike({
          PredefinedMetricType: "ECSServiceAverageCPUUtilization",
        }),
        TargetValue: 70,
      }),
    });
  });
});

describe("app-runtime — 권한 템플릿 정책 주입", () => {
  it("permissionPolicy가 있으면 태스크 역할에 인라인 정책이 붙는다", () => {
    const template = synth(
      baseParams({
        permissionPolicy: {
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Action: ["bedrock:InvokeModel"], Resource: "*" },
          ],
        },
      }),
    );
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyName: "permission-template",
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "bedrock:InvokeModel" }),
        ]),
      }),
    });
  });
});

describe("app-runtime — D20 albIndex로 배정 ALB SSM 참조 (계약 §6)", () => {
  it("albIndex 미지정(기존 앱) = 0 → `/network/alb/{slug}/0/*` 키를 읽고 scheme 고정 키는 읽지 않는다", () => {
    const t = synth(baseParams({ scheme: "internal", sleepMode: "on-demand" }));
    const params = (t.toJSON() as { Parameters?: Record<string, { Default?: string }> }).Parameters ?? {};
    const names = Object.values(params).map((p) => p.Default);
    expect(names).toContain("/apphub/dev/network/alb/internal/0/https-listener-arn");
    expect(names).toContain("/apphub/dev/network/alb/internal/0/alb-dns");
    expect(names).toContain("/apphub/dev/network/alb/internal/0/alb-canonical-zone-id");
    expect(names).toContain("/apphub/dev/network/alb/internal/0/alb-full-name"); // 유휴 알람
    expect(names).not.toContain("/apphub/dev/network/internal-https-listener-arn");
    expect(names).not.toContain("/apphub/dev/network/internal-alb-dns");
  });

  it("albIndex=3 internet-facing → `/network/alb/internet/3/*`(리스너·DNS·zone id·full name), SG는 scheme 고정 키 재사용", () => {
    const t = synth(
      baseParams({ scheme: "internet-facing", albIndex: 3, cognitoProtect: false, sleepMode: "on-demand", schedule: undefined }),
    );
    const params = (t.toJSON() as { Parameters?: Record<string, { Default?: string }> }).Parameters ?? {};
    const names = Object.values(params).map((p) => p.Default);
    for (const key of ["https-listener-arn", "alb-dns", "alb-canonical-zone-id", "alb-full-name"]) {
      expect(names).toContain(`/apphub/dev/network/alb/internet/3/${key}`);
    }
    expect(names).toContain("/apphub/dev/network/internet-alb-sg-id");
    expect(names.some((n) => typeof n === "string" && n.includes("/alb/internet/0/"))).toBe(false);
    // 리스너 규칙은 albIndex=3 리스너 ARN 파라미터를 참조한다.
    const rule = Object.values(t.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"))[0];
    expect(JSON.stringify(rule)).toContain("networkalbinternet3httpslistenerarn");
  });

  it("always-on + cpu 스케일이면 ALB full name SSM을 참조하지 않는다(불필요 파라미터 없음)", () => {
    const t = synth(baseParams({ sleepMode: "always-on", schedule: undefined }));
    const params = (t.toJSON() as { Parameters?: Record<string, { Default?: string }> }).Parameters ?? {};
    expect(Object.values(params).map((p) => p.Default)).not.toContain(
      "/apphub/dev/network/alb/internal/0/alb-full-name",
    );
  });
});

describe("app-runtime — D3 Route53 레코드 zone (버그 C)", () => {
  const recordZones = (t: Template): string[] =>
    Object.values(t.findResources("AWS::Route53::RecordSet")).map((r) =>
      JSON.stringify((r.Properties as Record<string, unknown>)["HostedZoneId"]),
    );

  it("internal 앱: private zone A alias 1개", () => {
    const t = synth(baseParams({ scheme: "internal" }));
    const zones = recordZones(t);
    expect(zones.length).toBe(1);
    expect(zones[0]).toContain("networkprivatehostedzoneid");
  });

  it("internet-facing 앱: public zone + private zone 2개 A alias(둘 다 배정 ALB)", () => {
    const t = synth(
      baseParams({ scheme: "internet-facing", cognitoProtect: false, sleepMode: "on-demand", schedule: undefined }),
    );
    const records = Object.values(t.findResources("AWS::Route53::RecordSet"));
    expect(records.length).toBe(2);
    const zones = recordZones(t);
    expect(zones.some((z) => z.includes("networkpublichostedzoneid"))).toBe(true);
    expect(zones.some((z) => z.includes("networkprivatehostedzoneid"))).toBe(true);
    for (const r of records) {
      const p = r.Properties as Record<string, unknown>;
      expect(p["Type"]).toBe("A");
      expect(JSON.stringify(p["AliasTarget"])).toContain("networkalbinternet0albdns");
    }
  });

  it("internet-facing의 기존 public zone 레코드 논리 ID(AliasA)는 유지된다(교체 방지)", () => {
    const t = synth(
      baseParams({ scheme: "internet-facing", cognitoProtect: false, sleepMode: "on-demand", schedule: undefined }),
    );
    const ids = Object.keys(t.findResources("AWS::Route53::RecordSet"));
    expect(ids.some((id) => id.startsWith("RuntimeAliasA") && !id.startsWith("RuntimeAliasAPrivate"))).toBe(true);
    expect(ids.some((id) => id.startsWith("RuntimeAliasAPrivate"))).toBe(true);
  });
});
