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
var CONFIG_PK = "CONFIG";
var APP_META_SK = "META";
var appPk = (appId) => `APP#${appId}`;
var albSk = (albArn) => `ALB#${albArn}`;

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
async function transitionStatus(appId, next, allowedFrom) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: loadConfig().tableName,
      Key: { PK: appPk(appId), SK: APP_META_SK },
      UpdateExpression: "SET #s = :next, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":next": next,
        ":now": now,
        ...Object.fromEntries(allowedFrom.map((s, i) => [`:from${i}`, s]))
      },
      ConditionExpression: `attribute_exists(PK) AND (${allowedFrom.map((_, i) => `#s = :from${i}`).join(" OR ")})`
    })
  );
}
async function deleteAppRecord(appId) {
  await ddb.send(
    new DeleteCommand({
      TableName: loadConfig().tableName,
      Key: { PK: appPk(appId), SK: APP_META_SK }
    })
  );
}

// src/data/subdomains.ts
import { PutCommand as PutCommand2, DeleteCommand as DeleteCommand2, GetCommand as GetCommand2 } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
function subdomainPk(subdomain) {
  return `SUBDOMAIN#${subdomain}`;
}
var RESERVATION_SK = "RESERVATION";
async function releaseSubdomain(subdomain) {
  await ddb.send(
    new DeleteCommand2({
      TableName: loadConfig().tableName,
      Key: { PK: subdomainPk(subdomain), SK: RESERVATION_SK }
    })
  );
}

// src/data/alb-registry.ts
import { PutCommand as PutCommand3, UpdateCommand as UpdateCommand2 } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException as ConditionalCheckFailedException2 } from "@aws-sdk/client-dynamodb";
async function decrementAlbRuleCount(albArn) {
  try {
    await ddb.send(
      new UpdateCommand2({
        TableName: loadConfig().tableName,
        Key: { PK: CONFIG_PK, SK: albSk(albArn) },
        UpdateExpression: "SET ruleCount = ruleCount - :one",
        // ruleCount > 0 일 때만 감소(음수 방지). 없거나 0이면 조건 실패 → 멱등 통과.
        ConditionExpression: "attribute_exists(SK) AND ruleCount > :zero",
        ExpressionAttributeValues: { ":one": 1, ":zero": 0 }
      })
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException2) return;
    throw err;
  }
}

// src/integrations/secrets.ts
import {
  SecretsManagerClient,
  DeleteSecretCommand
} from "@aws-sdk/client-secrets-manager";
var sm = new SecretsManagerClient({});
async function deleteSecret(secretArn) {
  try {
    await sm.send(
      new DeleteSecretCommand({
        SecretId: secretArn,
        ForceDeleteWithoutRecovery: true
      })
    );
  } catch (err) {
    const name = err.name ?? "";
    if (name === "ResourceNotFoundException") return;
    throw err;
  }
}
async function deleteSecrets(secretArns) {
  for (const arn of secretArns) {
    await deleteSecret(arn);
  }
}

// src/integrations/cloudformation.ts
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand
} from "@aws-sdk/client-cloudformation";
var cfn = new CloudFormationClient({});
function runtimeStackName(stage, appId) {
  return `apphub-${stage}-app-${appId}-runtime`;
}
function pipelineStackName(stage, appId) {
  return `apphub-${stage}-app-${appId}-pipeline`;
}
async function deleteStack(stackName) {
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));
}
async function getStackDeleteState(stackName) {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const status = res.Stacks?.[0]?.StackStatus ?? "";
    if (status === "DELETE_COMPLETE") return "DELETE_COMPLETE";
    if (status === "DELETE_FAILED") return "DELETE_FAILED";
    return "DELETE_IN_PROGRESS";
  } catch (err) {
    const name = err.name ?? "";
    const msg = err.message ?? "";
    if (name === "ValidationError" || /does not exist/i.test(msg)) {
      return "DELETE_COMPLETE";
    }
    throw err;
  }
}

// src/orchestration/delete.ts
var STAGE = () => process.env["STAGE"] ?? "dev";
async function deleteRuntime(e) {
  await deleteStack(runtimeStackName(STAGE(), e.appId));
  return { step: "delete-runtime", appId: e.appId };
}
async function pollRuntime(e) {
  const state = await getStackDeleteState(runtimeStackName(STAGE(), e.appId));
  if (state === "DELETE_FAILED") {
    throw new Error(`runtime \uC2A4\uD0DD \uC0AD\uC81C \uC2E4\uD328: ${runtimeStackName(STAGE(), e.appId)}`);
  }
  return { step: "poll-runtime", appId: e.appId, stackDeleteState: state };
}
async function deletePipeline(e) {
  await deleteStack(pipelineStackName(STAGE(), e.appId));
  return { step: "delete-pipeline", appId: e.appId };
}
async function pollPipeline(e) {
  const state = await getStackDeleteState(pipelineStackName(STAGE(), e.appId));
  if (state === "DELETE_FAILED") {
    throw new Error(`pipeline \uC2A4\uD0DD \uC0AD\uC81C \uC2E4\uD328: ${pipelineStackName(STAGE(), e.appId)}`);
  }
  return { step: "poll-pipeline", appId: e.appId, stackDeleteState: state };
}
async function cleanup(e) {
  const app = await getApp(e.appId);
  if (!app) return { step: "cleanup", appId: e.appId, cleaned: true };
  const secretArns = Object.values(app.secretArns ?? {});
  if (secretArns.length > 0) await deleteSecrets(secretArns);
  const albArn = app.albArn ?? e.albArn;
  if (albArn) await decrementAlbRuleCount(albArn);
  await releaseSubdomain(app.subdomain);
  await deleteAppRecord(e.appId);
  return { step: "cleanup", appId: e.appId, cleaned: true };
}
async function finalize(e) {
  if (e.outcome === "failure") {
    await transitionStatus(e.appId, "FAILED", ["DELETING"]).catch(() => void 0);
    return { step: "finalize", appId: e.appId, status: "FAILED" };
  }
  return { step: "finalize", appId: e.appId, status: "DELETED" };
}
var DISPATCH = {
  "delete-runtime": deleteRuntime,
  "poll-runtime": pollRuntime,
  "delete-pipeline": deletePipeline,
  "poll-pipeline": pollPipeline,
  cleanup,
  finalize
};
var handler = async (event) => {
  const fn = DISPATCH[event.step];
  if (!fn) throw new Error(`\uC54C \uC218 \uC5C6\uB294 DeleteApp step: ${event.step}`);
  return fn(event);
};
export {
  handler
};
