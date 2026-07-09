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
var deploySk = (ts) => `DEPLOY#${ts}`;
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
async function updateApp(appId, patch) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const entries = Object.entries({ ...patch, updatedAt: now }).filter(
    ([, v]) => v !== void 0
  );
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  const res = await ddb.send(
    new UpdateCommand({
      TableName: loadConfig().tableName,
      Key: { PK: appPk(appId), SK: APP_META_SK },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(PK)",
      ReturnValues: "ALL_NEW"
    })
  );
  return toApp(res.Attributes);
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

// src/data/alb-registry.ts
import { PutCommand as PutCommand2, UpdateCommand as UpdateCommand2 } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
var RULE_PRIORITY_BASE = 1;
var ALB_RULE_SOFT_LIMIT = 90;
var RULE_PRIORITY_SEQ_SK = "RULEPRIORITYSEQ";
async function ensureAlbRegistered(albArn, scheme, vpcId) {
  try {
    await ddb.send(
      new PutCommand2({
        TableName: loadConfig().tableName,
        Item: {
          PK: CONFIG_PK,
          SK: albSk(albArn),
          entityType: "AlbRegistry",
          albArn,
          scheme,
          vpcId,
          ruleCount: 0
        },
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      })
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return;
    throw err;
  }
}
async function nextRulePriority() {
  const res = await ddb.send(
    new UpdateCommand2({
      TableName: loadConfig().tableName,
      Key: { PK: CONFIG_PK, SK: RULE_PRIORITY_SEQ_SK },
      UpdateExpression: "SET #seq = if_not_exists(#seq, :base) + :one",
      ExpressionAttributeNames: { "#seq": "seq" },
      ExpressionAttributeValues: { ":base": RULE_PRIORITY_BASE - 1, ":one": 1 },
      ReturnValues: "UPDATED_NEW"
    })
  );
  const seq = res.Attributes?.["seq"];
  if (typeof seq !== "number") {
    throw new Error("\uADDC\uCE59 priority \uCE74\uC6B4\uD130 \uBC1C\uAE09 \uC2E4\uD328(seq \uBBF8\uBC18\uD658).");
  }
  return seq;
}
async function incrementAlbRuleCount(albArn) {
  const res = await ddb.send(
    new UpdateCommand2({
      TableName: loadConfig().tableName,
      Key: { PK: CONFIG_PK, SK: albSk(albArn) },
      UpdateExpression: "SET ruleCount = if_not_exists(ruleCount, :zero) + :one",
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
      ConditionExpression: "attribute_exists(SK)",
      ReturnValues: "UPDATED_NEW"
    })
  );
  return res.Attributes?.["ruleCount"] ?? 0;
}
async function allocateAlbSlot(albArn, scheme, vpcId) {
  await ensureAlbRegistered(albArn, scheme, vpcId);
  const rulePriority = await nextRulePriority();
  const ruleCount = await incrementAlbRuleCount(albArn);
  return {
    albArn,
    rulePriority,
    needsScaleOut: ruleCount >= ALB_RULE_SOFT_LIMIT
  };
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
function platformParam(stage, key) {
  return getParam(`/apphub/${stage}/platform/${key}`);
}
function albArnForScheme(stage, scheme) {
  return networkParam(stage, scheme === "internal" ? "internal-alb-arn" : "internet-alb-arn");
}

// src/integrations/codebuild.ts
import {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand
} from "@aws-sdk/client-codebuild";
var codebuild = new CodeBuildClient({});
async function startProvisionerBuild(input) {
  const environmentVariablesOverride = Object.entries(input.env).map(
    ([name, value]) => ({ name, value, type: "PLAINTEXT" })
  );
  const res = await codebuild.send(
    new StartBuildCommand({
      projectName: input.projectName,
      environmentVariablesOverride
    })
  );
  const id = res.build?.id;
  if (!id) throw new Error("provisioner CodeBuild \uC2DC\uC791 \uC2E4\uD328(build id \uC5C6\uC74C).");
  return id;
}
async function getBuildStatus(buildId) {
  const res = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  const build = res.builds?.[0];
  const status = build?.buildStatus;
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (status === void 0 || status === "IN_PROGRESS") return "IN_PROGRESS";
  return "FAILED";
}

// src/integrations/codepipeline.ts
import {
  CodePipelineClient,
  StartPipelineExecutionCommand
} from "@aws-sdk/client-codepipeline";
var cp = new CodePipelineClient({});
function appPipelineName(stage, appId) {
  return `apphub-${stage}-app-${appId}`;
}
async function startPipeline(stage, appId) {
  const res = await cp.send(
    new StartPipelineExecutionCommand({ name: appPipelineName(stage, appId) })
  );
  return res.pipelineExecutionId;
}

// src/data/deployments.ts
import { PutCommand as PutCommand3, QueryCommand as QueryCommand2 } from "@aws-sdk/lib-dynamodb";
var NINETY_DAYS_SEC = 90 * 24 * 60 * 60;
async function putDeployment(input) {
  const now = /* @__PURE__ */ new Date();
  const ts = now.toISOString();
  const deployment = {
    appId: input.appId,
    deploymentId: ts,
    trigger: input.trigger,
    status: input.status ?? "PENDING",
    createdAt: ts,
    updatedAt: ts,
    ...input.commitSha !== void 0 ? { commitSha: input.commitSha } : {},
    ...input.commitMessage !== void 0 ? { commitMessage: input.commitMessage } : {},
    ...input.pipelineExecutionId !== void 0 ? { pipelineExecutionId: input.pipelineExecutionId } : {}
  };
  const item = {
    PK: appPk(input.appId),
    SK: deploySk(ts),
    entityType: "Deployment",
    ttl: Math.floor(now.getTime() / 1e3) + NINETY_DAYS_SEC,
    ...deployment
  };
  await ddb.send(new PutCommand3({ TableName: loadConfig().tableName, Item: item }));
  return deployment;
}

// src/orchestration/provision.ts
var STAGE = () => process.env["STAGE"] ?? "dev";
async function allocateSlot(e) {
  const app = await getApp(e.appId);
  if (!app) throw new Error(`App \uB808\uCF54\uB4DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${e.appId}`);
  if (app.albArn && app.rulePriority !== void 0) {
    return {
      step: "allocate-slot",
      appId: e.appId,
      albArn: app.albArn,
      rulePriority: app.rulePriority
    };
  }
  const scheme = app.scheme;
  const albArn = await albArnForScheme(STAGE(), scheme);
  const slot = await allocateAlbSlot(albArn, scheme, app.vpcId);
  await updateApp(e.appId, { albArn: slot.albArn, rulePriority: slot.rulePriority });
  return {
    step: "allocate-slot",
    appId: e.appId,
    albArn: slot.albArn,
    rulePriority: slot.rulePriority,
    needsScaleOut: slot.needsScaleOut
  };
}
async function deployPipeline(e) {
  const stage = STAGE();
  const app = await getApp(e.appId);
  if (!app) throw new Error(`App \uB808\uCF54\uB4DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${e.appId}`);
  const projectName = await platformParam(stage, "provisioner-project-name");
  const buildId = await startProvisionerBuild({
    projectName,
    env: {
      APP_ID: e.appId,
      STAGE: stage,
      APP_STACK_KIND: "pipeline",
      PROVIDER: app.provider,
      REPO_URL: app.repoUrl,
      BRANCH: app.branch,
      AUTO_DEPLOY: String(app.autoDeployEnabled),
      ...app.connectionArn ? { CONNECTION_ARN: app.connectionArn } : {}
    }
  });
  return { step: "deploy-pipeline", appId: e.appId, buildId };
}
async function pollBuild(e) {
  if (!e.buildId) throw new Error("poll-build: buildId\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
  const buildStatus = await getBuildStatus(e.buildId);
  if (buildStatus === "FAILED") {
    throw new Error(`provisioner CodeBuild \uC2E4\uD328(build ${e.buildId}).`);
  }
  return { step: "poll-build", appId: e.appId, buildId: e.buildId, buildStatus };
}
async function firstDeploy(e) {
  const stage = STAGE();
  const pipelineExecutionId = await startPipeline(stage, e.appId);
  await putDeployment({
    appId: e.appId,
    trigger: "auto",
    status: "PENDING",
    ...pipelineExecutionId ? { pipelineExecutionId } : {}
  });
  return {
    step: "first-deploy",
    appId: e.appId,
    ...pipelineExecutionId ? { pipelineExecutionId } : {}
  };
}
async function finalize(e) {
  if (e.outcome === "failure") {
    await transitionStatus(e.appId, "FAILED", ["CREATING"]).catch(() => void 0);
    return { step: "finalize", appId: e.appId, status: "FAILED" };
  }
  await transitionStatus(e.appId, "ACTIVE", ["CREATING"]);
  const app = await getApp(e.appId);
  const runtimeState = app?.runtimeState ?? "SLEEPING";
  return { step: "finalize", appId: e.appId, status: "ACTIVE", runtimeState };
}
var DISPATCH = {
  "allocate-slot": allocateSlot,
  "deploy-pipeline": deployPipeline,
  "poll-build": pollBuild,
  "first-deploy": firstDeploy,
  finalize
};
var handler = async (event) => {
  const fn = DISPATCH[event.step];
  if (!fn) throw new Error(`\uC54C \uC218 \uC5C6\uB294 ProvisionApp step: ${event.step}`);
  return fn(event);
};
export {
  handler
};
