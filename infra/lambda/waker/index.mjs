// src/data/subdomains.ts
import { PutCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

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

// src/data/subdomains.ts
function subdomainPk(subdomain) {
  return `SUBDOMAIN#${subdomain}`;
}
var RESERVATION_SK = "RESERVATION";
async function appIdForSubdomain(subdomain) {
  const res = await ddb.send(
    new GetCommand({
      TableName: loadConfig().tableName,
      Key: { PK: subdomainPk(subdomain), SK: RESERVATION_SK }
    })
  );
  const appId = res.Item?.["appId"];
  return typeof appId === "string" ? appId : void 0;
}

// src/data/apps.ts
import {
  GetCommand as GetCommand2,
  PutCommand as PutCommand2,
  UpdateCommand,
  DeleteCommand as DeleteCommand2,
  QueryCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";

// src/data/keys.ts
var CONFIG_PK = "CONFIG";
var APP_META_SK = "META";
var appPk = (appId) => `APP#${appId}`;
var presetSk = (presetId) => `PRESET#${presetId}`;

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
    new GetCommand2({
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

// src/data/config-repo.ts
import {
  PutCommand as PutCommand3,
  GetCommand as GetCommand3,
  QueryCommand as QueryCommand2,
  DeleteCommand as DeleteCommand3
} from "@aws-sdk/lib-dynamodb";
async function getPreset(presetId) {
  const res = await ddb.send(
    new GetCommand3({
      TableName: loadConfig().tableName,
      Key: { PK: CONFIG_PK, SK: presetSk(presetId) }
    })
  );
  if (!res.Item) return void 0;
  const { PK, SK, entityType, ...rest } = res.Item;
  void PK;
  void SK;
  void entityType;
  return rest;
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
async function ensureRunning(stage, appId, min) {
  const name = appServiceName(stage, appId);
  const { desiredCount, found } = await describeService(name, name);
  if (!found) return { changed: false, serviceNotFound: true };
  if (desiredCount >= min) return { changed: false, previous: desiredCount };
  await ecs.send(
    new UpdateServiceCommand({ cluster: name, service: name, desiredCount: min })
  );
  return { changed: true, previous: desiredCount };
}

// src/wake/waker.ts
var STAGE = () => process.env["STAGE"] ?? "dev";
var APPS_DOMAIN = () => process.env["APPS_DOMAIN"];
function subdomainFromHost(host, appsDomain) {
  if (!host) return void 0;
  const bare = host.split(":")[0]?.trim().toLowerCase();
  if (!bare) return void 0;
  if (appsDomain && bare.endsWith(`.${appsDomain.toLowerCase()}`)) {
    return bare.slice(0, bare.length - appsDomain.length - 1);
  }
  const firstLabel = bare.split(".")[0];
  return firstLabel || void 0;
}
function extractHost(event) {
  const h = event.headers?.["host"] ?? event.headers?.["Host"];
  if (h) return h;
  const mv = event.multiValueHeaders?.["host"] ?? event.multiValueHeaders?.["Host"];
  return mv?.[0];
}
var WAITING_PAGE = [
  '<!doctype html><html lang="ko"><head><meta charset="utf-8">',
  '<meta http-equiv="refresh" content="5">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>\uC571\uC744 \uC900\uBE44\uD558\uB294 \uC911\uC774\uC5D0\uC694</title>",
  "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
  "text-align:center;padding-top:18vh;color:#1f2937;background:#f9fafb}",
  ".spinner{width:40px;height:40px;margin:0 auto 24px;border:4px solid #e5e7eb;",
  "border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite}",
  "@keyframes spin{to{transform:rotate(360deg)}}h1{font-size:20px}p{color:#6b7280}</style>",
  "</head><body>",
  '<div class="spinner"></div>',
  "<h1>\uC571\uC744 \uC900\uBE44\uD558\uB294 \uC911\uC774\uC5D0\uC694</h1>",
  "<p>\uC7A0\uC2DC\uB9CC \uAE30\uB2E4\uB824\uC8FC\uC138\uC694. \uD654\uBA74\uC774 \uC790\uB3D9\uC73C\uB85C \uC0C8\uB85C\uACE0\uCE68\uB429\uB2C8\uB2E4.</p>",
  "<p>\uBCF4\uD1B5 30\uCD08\uC5D0\uC11C 1\uBD84 \uC815\uB3C4 \uAC78\uB824\uC694.</p>",
  "</body></html>"
].join("");
function waitingPage() {
  return {
    statusCode: 200,
    statusDescription: "200 OK",
    isBase64Encoded: false,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate"
    },
    body: WAITING_PAGE
  };
}
async function wakeByHost(host) {
  const stage = STAGE();
  const subdomain = subdomainFromHost(host, APPS_DOMAIN());
  if (!subdomain) return { reason: "no-subdomain" };
  const appId = await appIdForSubdomain(subdomain);
  if (!appId) return { reason: "no-app-for-subdomain" };
  const app = await getApp(appId);
  if (!app) return { appId, reason: "app-record-missing" };
  if (app.status !== "ACTIVE") return { appId, reason: `status-${app.status}` };
  const preset = await getPreset(app.presetId);
  const min = preset && preset.minCount > 0 ? preset.minCount : 1;
  const res = await ensureRunning(stage, appId, min);
  if (res.serviceNotFound) return { appId, started: false, reason: "service-not-found" };
  if (app.runtimeState === "SLEEPING") {
    await setRuntimeState(appId, "WAKING").catch(() => void 0);
  }
  return { appId, started: res.changed };
}
var handler = async (event) => {
  try {
    const host = extractHost(event);
    const result = await wakeByHost(host);
    console.log("[waker]", JSON.stringify({ host, ...result }));
  } catch (err) {
    console.error("[waker] wake failed:", err.message);
  }
  return waitingPage();
};
export {
  handler
};
