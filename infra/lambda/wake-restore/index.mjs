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

// src/wake/restore.ts
var STAGE = () => process.env["STAGE"] ?? "dev";
function appIdFromEcsEvent(event, stage) {
  const d = event.detail;
  if (!d) return void 0;
  const marker = `apphub-${stage}-app-`;
  const fromCluster = d.clusterArn?.split("/").pop();
  if (fromCluster && fromCluster.startsWith(marker)) {
    return fromCluster.slice(marker.length);
  }
  const g = d.group ?? "";
  const svc = g.startsWith("service:") ? g.slice("service:".length) : g;
  if (svc.startsWith(marker)) return svc.slice(marker.length);
  return void 0;
}
function isRunningAndHealthy(event) {
  const d = event.detail;
  if (!d) return false;
  if (d.lastStatus !== "RUNNING") return false;
  if (d.healthStatus === "HEALTHY") return true;
  if (d.healthStatus === "UNKNOWN" || d.healthStatus === void 0) return true;
  return (d.containers ?? []).some((c) => c.healthStatus === "HEALTHY");
}
async function handleTaskStateChange(event) {
  const stage = STAGE();
  if (!isRunningAndHealthy(event)) return { reason: "not-running-healthy" };
  const appId = appIdFromEcsEvent(event, stage);
  if (!appId) return { reason: "no-appId" };
  const app = await getApp(appId);
  if (!app) return { appId, reason: "app-record-missing" };
  if (app.status !== "ACTIVE") return { appId, reason: `status-${app.status}` };
  const appTgArn = await findAppTargetGroupArn(stage, appId);
  if (!appTgArn) return { appId, reason: "app-tg-not-found" };
  const listenerArn = await listenerArnForScheme(stage, app.scheme);
  const wakerTgArn = await networkParam(stage, "waker-tg-arn");
  const appsDomain = await networkParam(stage, "apps-domain");
  const host = `${app.subdomain}.${appsDomain}`;
  const res = await transitionListenerRule({
    listenerArn,
    host,
    appTargetGroupArn: appTgArn,
    wakerTargetGroupArn: wakerTgArn,
    to: "app"
  });
  if (!res.ruleNotFound && app.runtimeState !== "RUNNING") {
    await setRuntimeState(appId, "RUNNING").catch(() => void 0);
  }
  return { appId, restored: res.changed };
}
var handler = async (event) => {
  try {
    const result = await handleTaskStateChange(event);
    console.log("[wake-restore]", JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("[wake-restore] failed:", err.message);
    throw err;
  }
};
export {
  handler
};
