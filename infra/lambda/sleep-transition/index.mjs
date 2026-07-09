// src/data/apps.ts
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";

// src/data/client.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
var base = new DynamoDBClient({});
var ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: {
    removeUndefinedValues: true,
    // 선택 속성 미지정 시 attribute 자체를 제거
    convertEmptyValues: false
  }
});

// src/config.ts
function req(name) {
  const v = process.env[name];
  if (v === void 0 || v === "") {
    throw new Error(`\uD544\uC218 \uD658\uACBD\uBCC0\uC218 \uB204\uB77D: ${name}`);
  }
  return v;
}
function optList(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(",").map((s) => s.trim().replace(/\/$/, "")).filter((s) => s.length > 0);
}
function loadConfig() {
  return {
    tableName: req("TABLE_NAME"),
    userPoolId: req("USER_POOL_ID"),
    userPoolClientId: req("USER_POOL_CLIENT_ID"),
    stage: req("STAGE"),
    appsDomain: req("APPS_DOMAIN"),
    provisionSmArn: req("PROVISION_SM_ARN"),
    deleteSmArn: req("DELETE_SM_ARN"),
    allowedOrigins: optList("ALLOWED_ORIGINS")
  };
}

// src/data/keys.ts
var APP_META_SK = "META";
var appPk = (appId) => `APP#${appId}`;

// src/data/apps.ts
function toApp(item) {
  const { PK, SK, entityType, ...rest } = item;
  void PK;
  void SK;
  void entityType;
  return rest;
}
async function getApp(appId) {
  const res = await ddb.send(
    new GetCommand({
      TableName: loadConfig().tableName,
      Key: { PK: appPk(appId), SK: APP_META_SK }
    })
  );
  return res.Item ? toApp(res.Item) : void 0;
}
async function setRuntimeState(appId, state) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: loadConfig().tableName,
      Key: { PK: appPk(appId), SK: APP_META_SK },
      UpdateExpression: "SET runtimeState = :r, updatedAt = :now",
      ExpressionAttributeValues: { ":r": state, ":now": now },
      ConditionExpression: "attribute_exists(PK)"
    })
  );
}

// src/integrations/ssm.ts
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
var ssm = new SSMClient({});
var cache = /* @__PURE__ */ new Map();
async function getParam(name) {
  const cached = cache.get(name);
  if (cached !== void 0) return cached;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter?.Value;
  if (value === void 0) {
    throw new Error(`SSM \uD30C\uB77C\uBBF8\uD130 \uAC12\uC774 \uC5C6\uC2B5\uB2C8\uB2E4: ${name}`);
  }
  cache.set(name, value);
  return value;
}
function networkParam(stage, key) {
  return getParam(`/apphub/${stage}/network/${key}`);
}
function listenerArnForScheme(stage, scheme) {
  return networkParam(
    stage,
    scheme === "internal" ? "internal-https-listener-arn" : "internet-https-listener-arn"
  );
}

// src/wake/target-group.ts
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
var elbv2 = new ElasticLoadBalancingV2Client({});
function appTargetGroupName(stage, appId) {
  return `apphub-${stage}-app-${appId}`.slice(0, 32);
}
async function findAppTargetGroupArn(stage, appId) {
  const name = appTargetGroupName(stage, appId);
  try {
    const res = await elbv2.send(new DescribeTargetGroupsCommand({ Names: [name] }));
    return res.TargetGroups?.[0]?.TargetGroupArn;
  } catch {
    return void 0;
  }
}

// src/wake/listener-rule.ts
import {
  ElasticLoadBalancingV2Client as ElasticLoadBalancingV2Client2,
  DescribeRulesCommand,
  ModifyRuleCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
var elbv22 = new ElasticLoadBalancingV2Client2({});
async function findRuleByHost(listenerArn, host) {
  let marker;
  do {
    const res = await elbv22.send(
      new DescribeRulesCommand({ ListenerArn: listenerArn, ...marker ? { Marker: marker } : {} })
    );
    for (const rule of res.Rules ?? []) {
      const matches = (rule.Conditions ?? []).some((c) => {
        if (c.Field !== "host-header") return false;
        const values = c.HostHeaderConfig?.Values ?? c.Values ?? [];
        return values.includes(host);
      });
      if (matches) return rule;
    }
    marker = res.NextMarker;
  } while (marker);
  return void 0;
}
function currentForwardTarget(actions) {
  const fwd = (actions ?? []).find((a) => a.Type === "forward");
  if (!fwd) return void 0;
  if (fwd.TargetGroupArn) return fwd.TargetGroupArn;
  const tgs = fwd.ForwardConfig?.TargetGroups ?? [];
  return tgs.length === 1 ? tgs[0]?.TargetGroupArn : void 0;
}
function replaceForwardTarget(actions, newTargetGroupArn) {
  const src = actions ?? [];
  const hasForward = src.some((a) => a.Type === "forward");
  if (!hasForward) {
    return [{ Type: "forward", Order: 1, TargetGroupArn: newTargetGroupArn }];
  }
  return src.map((a) => {
    if (a.Type !== "forward") return a;
    const replaced = {
      Type: "forward",
      TargetGroupArn: newTargetGroupArn,
      ...a.Order !== void 0 ? { Order: a.Order } : {}
    };
    return replaced;
  });
}
async function transitionListenerRule(input) {
  const rule = await findRuleByHost(input.listenerArn, input.host);
  if (!rule || !rule.RuleArn) {
    return { changed: false, ruleNotFound: true };
  }
  const desiredTarget = input.to === "waker" ? input.wakerTargetGroupArn : input.appTargetGroupArn;
  const current = currentForwardTarget(rule.Actions);
  if (current === desiredTarget) {
    return { changed: false, ruleArn: rule.RuleArn };
  }
  const newActions = replaceForwardTarget(rule.Actions, desiredTarget);
  await elbv22.send(
    new ModifyRuleCommand({ RuleArn: rule.RuleArn, Actions: newActions })
  );
  return { changed: true, ruleArn: rule.RuleArn };
}

// src/wake/ecs-service.ts
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand
} from "@aws-sdk/client-ecs";
var ecs = new ECSClient({});
function appServiceName(stage, appId) {
  return `apphub-${stage}-app-${appId}`;
}
async function describeService(cluster, service) {
  const res = await ecs.send(
    new DescribeServicesCommand({ cluster, services: [service] })
  );
  const svc = (res.services ?? []).find(
    (s) => s.serviceName === service && s.status !== "INACTIVE"
  );
  if (!svc) return { desiredCount: 0, found: false };
  return { desiredCount: svc.desiredCount ?? 0, found: true };
}
async function ensureStopped(stage, appId) {
  const name = appServiceName(stage, appId);
  const { desiredCount, found } = await describeService(name, name);
  if (!found) return { changed: false, serviceNotFound: true };
  if (desiredCount === 0) return { changed: false, previous: desiredCount };
  await ecs.send(
    new UpdateServiceCommand({ cluster: name, service: name, desiredCount: 0 })
  );
  return { changed: true, previous: desiredCount };
}

// src/wake/sleep.ts
var STAGE = () => process.env["STAGE"] ?? "dev";
function appIdFromSleepEvent(event, stage) {
  if (event.appId) return event.appId;
  const alarmName = event.detail?.alarmName ?? event.alarmData?.alarmName;
  if (!alarmName) return void 0;
  const m = new RegExp(`^apphub-${stage}-app-(.+)-idle$`).exec(alarmName);
  return m?.[1];
}
async function sleepApp(appId) {
  const stage = STAGE();
  const app = await getApp(appId);
  if (!app) return { appId, reason: "app-record-missing" };
  if (app.status !== "ACTIVE") return { appId, reason: `status-${app.status}` };
  if (app.sleepMode === "always-on") return { appId, reason: "always-on" };
  const stop = await ensureStopped(stage, appId);
  const appTgArn = await findAppTargetGroupArn(stage, appId);
  const wakerTgArn = await networkParam(stage, "waker-tg-arn");
  const listenerArn = await listenerArnForScheme(stage, app.scheme);
  const appsDomain = await networkParam(stage, "apps-domain");
  const host = `${app.subdomain}.${appsDomain}`;
  let ruleSwitched = false;
  if (appTgArn) {
    const t = await transitionListenerRule({
      listenerArn,
      host,
      appTargetGroupArn: appTgArn,
      wakerTargetGroupArn: wakerTgArn,
      to: "waker"
    });
    ruleSwitched = t.changed;
  }
  if (app.runtimeState !== "SLEEPING") {
    await setRuntimeState(appId, "SLEEPING").catch(() => void 0);
  }
  return { appId, stopped: stop.changed, ruleSwitched };
}
var handler = async (event) => {
  const stage = STAGE();
  const appId = appIdFromSleepEvent(event, stage);
  if (!appId) {
    console.warn("[sleep-transition] appId \uC5C6\uC74C:", JSON.stringify(event));
    return { reason: "no-appId" };
  }
  const result = await sleepApp(appId);
  console.log("[sleep-transition]", JSON.stringify(result));
  return result;
};
export {
  handler
};
