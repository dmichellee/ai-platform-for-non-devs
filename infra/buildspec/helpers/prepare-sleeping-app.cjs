// 잠든 앱 배포 전 규칙 복귀 (2026-10-08, QA N2 / DESIGN 3.5 드리프트 방지 (c) / buildspec-contract §8).
//
// 왜: 잠든 앱(runtimeState=SLEEPING)은 리스너 규칙 forward 가 Waker TG 를 가리켜 앱 TG 에 연결된 LB 가 없다.
//   이 상태로 cdk deploy 하면 ECS 서비스 갱신이 "target group does not have an associated load balancer" 로
//   거부된다. 그래서 cdk deploy 직전에 **forward 대상만** 앱 TG 로 되돌린다.
//   - authenticate-cognito 등 다른 액션은 원형 유지(로그인 보호 우회 금지, DESIGN 3.5).
//   - ECS desiredCount 는 건드리지 않는다(0 유지 — 배포가 깨우지 않음). 배포 중 수 분은 503 가능(설계 허용).
//   - 배포가 끝나면(성공·실패 모두) deploy-notify 가 sleep_app 으로 forward→Waker TG 를 재적용한다.
//
// 입력 env: STAGE, APP_ID, AWS_DEFAULT_REGION, TABLE_NAME, IS_INITIAL("true"|"false").
// 규약(백엔드와 동일 — backend/app/wake/target_group.py · listener_rule.py · integrations/ssm.py):
//   앱 TG 이름 `apphub-{stage}-app-{appId}`[:32], 리스너 SSM `/apphub/{stage}/network/alb/{slug}/{albIndex}/https-listener-arn`
//   (n=0 이고 신규 키 없으면 legacy `/apphub/{stage}/network/{slug}-https-listener-arn`), host `{subdomain}.{apps-domain}`.
//
// 종료 코드: 0 = 처리 완료 또는 해당 없음(최초 배포 / 잠들지 않음 / 규칙·TG 없음 → 경고 후 진행).
//            1 = AWS 호출 실패(권한·스로틀 등) → buildspec 이 DEPLOY_FAILED 로 배포 중단.
//   중단 근거: 규칙이 Waker TG 에 남은 채 cdk deploy 하면 ECS 갱신 거부가 사실상 확정이라(수 분 낭비 + CFN
//   롤백 후 같은 실패), 빨리 멈추는 편이 앱 상태(잠든 채 Waker 로 접속 가능)를 그대로 보존한다.
"use strict";

const { aws, AwsCliError, getItem, fail } = require("./aws-cli.cjs");

function schemeSlug(scheme) {
  if (scheme === "internet-facing" || scheme === "internet") return "internet";
  if (scheme === "internal") return "internal";
  throw new Error(`알 수 없는 ALB scheme: ${JSON.stringify(scheme)}`);
}

function appTargetGroupName(stage, appId) {
  return `apphub-${stage}-app-${appId}`.slice(0, 32);
}

function albIndexOf(app) {
  const n = Number(app.albIndex ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** 단일 TG forward 대상(없거나 가중치 다중이면 null). backend listener_rule.current_forward_target 와 동일. */
function currentForwardTarget(actions) {
  for (const a of actions || []) {
    if (a.Type !== "forward") continue;
    if (a.TargetGroupArn) return a.TargetGroupArn;
    const tgs = (a.ForwardConfig && a.ForwardConfig.TargetGroups) || [];
    return tgs.length === 1 ? tgs[0].TargetGroupArn : null;
  }
  return null;
}

/** forward 액션의 대상만 교체, 그 외 액션 원형 유지. backend listener_rule.replace_forward_target 와 동일. */
function replaceForwardTarget(actions, tgArn) {
  const src = actions || [];
  if (!src.some((a) => a.Type === "forward")) return [{ Type: "forward", Order: 1, TargetGroupArn: tgArn }];
  return src.map((a) => {
    if (a.Type !== "forward") return a;
    const out = { Type: "forward", TargetGroupArn: tgArn };
    if (a.Order != null) out.Order = a.Order;
    return out;
  });
}

function ruleMatchesHost(rule, host) {
  return (rule.Conditions || []).some((c) => {
    if (c.Field !== "host-header") return false;
    const values = (c.HostHeaderConfig && c.HostHeaderConfig.Values) || c.Values || [];
    return values.includes(host);
  });
}

function ssmValue(name) {
  return aws(["ssm", "get-parameter", "--name", name]).Parameter.Value;
}

function listenerArn(stage, slug, index) {
  try {
    return ssmValue(`/apphub/${stage}/network/alb/${slug}/${index}/https-listener-arn`);
  } catch (err) {
    if (index === 0 && err instanceof AwsCliError && err.hasCode("ParameterNotFound")) {
      return ssmValue(`/apphub/${stage}/network/${slug}-https-listener-arn`);
    }
    throw err;
  }
}

function findRule(listener, host) {
  let marker;
  for (;;) {
    const args = ["elbv2", "describe-rules", "--listener-arn", listener];
    if (marker) args.push("--marker", marker);
    const res = aws(args);
    const rule = (res.Rules || []).find((r) => ruleMatchesHost(r, host));
    if (rule) return rule;
    marker = res.NextMarker;
    if (!marker) return null;
  }
}

function findAppTargetGroup(stage, appId) {
  try {
    const res = aws(["elbv2", "describe-target-groups", "--names", appTargetGroupName(stage, appId)]);
    const tgs = res.TargetGroups || [];
    return tgs.length ? tgs[0].TargetGroupArn : null;
  } catch (err) {
    if (err instanceof AwsCliError && err.hasCode("TargetGroupNotFound")) return null;
    throw err;
  }
}

const log = (msg) => process.stdout.write(`[apphub] 잠든 앱 배포 준비: ${msg}\n`);

function main() {
  const { STAGE: stage, APP_ID: appId, TABLE_NAME: table, IS_INITIAL: isInitial } = process.env;
  if (!stage || !appId || !table) fail("STAGE/APP_ID/TABLE_NAME 환경변수가 필요합니다.");
  if (isInitial === "true") return log("최초 배포 — 건너뜀");
  const app = getItem(table, { PK: { S: `APP#${appId}` }, SK: { S: "META" } });
  if (!app) return log("앱 레코드 없음 — 건너뜀");
  if (app.runtimeState !== "SLEEPING") return log(`runtimeState=${app.runtimeState || "-"} — 건너뜀`);

  const slug = schemeSlug(app.scheme);
  const index = albIndexOf(app);
  const host = `${app.subdomain}.${ssmValue(`/apphub/${stage}/network/apps-domain`)}`;
  const listener = listenerArn(stage, slug, index);
  const appTg = findAppTargetGroup(stage, appId);
  if (!appTg) return log(`앱 TG(${appTargetGroupName(stage, appId)}) 없음 — 경고: 규칙 복귀 없이 진행`);
  const rule = findRule(listener, host);
  if (!rule || !rule.RuleArn) return log(`host ${host} 규칙 없음 — 경고: 규칙 복귀 없이 진행`);
  if (currentForwardTarget(rule.Actions) === appTg) return log("이미 앱 TG 로 forward — 변경 없음");

  const actions = replaceForwardTarget(rule.Actions, appTg);
  aws(["elbv2", "modify-rule", "--rule-arn", rule.RuleArn, "--actions", JSON.stringify(actions)]);
  log(`규칙 forward → 앱 TG 복귀 완료(ALB ${slug}/${index}, host ${host}, desiredCount 유지)`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    fail(`잠든 앱 배포 준비(규칙 복귀) 실패 — ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { currentForwardTarget, replaceForwardTarget, appTargetGroupName, schemeSlug };
