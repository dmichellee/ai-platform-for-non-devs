import { describe, it, expect, beforeAll } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AppRuntimeStack } from "../lib/app-stacks";
import { assertNoOpenIngress } from "./helpers/sg-ingress";
import type { AppRuntimeParams } from "../lib/constructs/app-params";

/**
 * L2 — app-runtime construct CDK assertions (DESIGN.md 3.1/3.5, cdk-authoring 앱 스택 특수 규칙).
 *
 * 단언 대상:
 *  - internal 앱 scheme (public 아님)
 *  - 시크릿이 ECS Secrets(환경변수 아님)로 주입 (D8)
 *  - 로그 그룹 retention 30일 + 스택 삭제 시 함께 삭제
 *  - EventBridge Scheduler 2개(가동 스케줄)
 *  - SG ingress에 0.0.0.0/0 부재(앱 태스크 SG는 ALB SG 참조만) — D17 공통
 *  - 리스너 규칙 priority가 주입 파라미터와 일치(자동 채번 금지)
 *  - D16 cognitoProtect: authenticate-cognito 액션
 *  - desiredCount 최초생성만 지정(갱신 미지정=드리프트 방지, DESIGN 3.5)
 */

const ENV = { account: "111122223333", region: "ap-northeast-2" };

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
    secretArns: {
      API_KEY:
        "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:apphub-dev-testapp0-apikey-AbCdEf",
    },
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

  describe("시크릿 — ECS Secrets(환경변수 아님, D8)", () => {
    it("컨테이너 정의에 Secrets로 주입되고, Environment에는 시크릿 값이 없다", () => {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: "API_KEY", ValueFrom: Match.anyValue() }),
            ]),
          }),
        ]),
      });
    });

    it("Environment에는 평문 시크릿 값이 노출되지 않는다", () => {
      const raw = JSON.stringify(template.toJSON());
      // 시크릿 ARN은 ValueFrom(Secrets)에만. Environment에는 FOO=bar만.
      expect(raw).toContain('"Name":"FOO"');
      // API_KEY가 Environment의 Value로 박히지 않았는지(=Secrets로만) 확인.
      expect(raw).not.toMatch(/"Name":"API_KEY","Value":/);
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

    it("시작 스케줄은 DesiredCount=min, 종료 스케줄은 DesiredCount=0", () => {
      // Target.Input은 Fn::Join 조각(cluster ARN 토큰 포함)이라 전체 템플릿 JSON에서 조각을 찾는다.
      // stringify된 조각에는 내부 따옴표가 이스케이프되어 `DesiredCount\":1` 형태로 나타난다.
      const raw = JSON.stringify(template.toJSON());
      expect(raw).toContain('DesiredCount\\":1'); // 시작(min=1)
      expect(raw).toContain('DesiredCount\\":0'); // 종료
    });
  });

  describe("유휴 재중지 알람 (DESIGN 3.5, D-M5-03)", () => {
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
  it("DesiredCount를 지정하지 않는다(현재 값 유지, DESIGN 3.5)", () => {
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

  it("sleepMode=always-on이면 유휴 알람도 만들지 않는다(잠들지 않음, DESIGN 3.5)", () => {
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
    expect(rawParts).toContain("internetalbfullname"); // internet-facing → internet-alb-full-name SSM
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
    expect(JSON.stringify(spec.ResourceLabel)).toContain("internalalbfullname");
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
