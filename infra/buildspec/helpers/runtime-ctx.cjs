// app-runtime cdk deploy 컨텍스트 조립 (deploy.yml / provisioner.yml runtime 공용 — buildspec-contract §4).
//
// 입력 env: AWS_DEFAULT_REGION, TABLE_NAME, APP_ID, IMAGE_TAG, IS_INITIAL("true"|"false").
// 출력(stdout): `export CTX_<key>=<value>` 줄들 — buildspec 이 파일로 받아 `.` 로 소싱한다.
//   스칼라: appId subdomain scheme albIndex imageTag rulePriority cpu memory minCount maxCount
//           scaleMetric scaleThreshold sleepMode cognitoProtect isInitialDeploy
//   JSON(base64, 있을 때만): scheduleB64 envVarsB64 secretArn secretKeysB64 permissionPolicyB64
//   (app-params.ts loader 키와 1:1 — 이전 인라인 스크립트와 동일 출력.)
//
// 이중 안전장치(2026-10-08, QA M3): 앱 레코드·프리셋·권한 템플릿 아이템이 없거나 값이 비정상이면
//   cpu=0 / 권한 소실로 진행하지 않고 exit 1 + 사유 메시지(stderr). buildspec 이 FAILURE_CATEGORY=DEPLOY_FAILED
//   를 파일로 남기고 post_build 에서 재export 한다. (관리자 API 는 사용 중 삭제를 409 IN_USE 로 거부 — 1차 방어.)
"use strict";

const { getItem, fail } = require("./aws-cli.cjs");

function buildContext(env, app, preset, perm) {
  const str = (v) => (v == null ? "" : String(v));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

  if (!app) return { error: `앱 레코드(APP#${env.APP_ID})를 찾을 수 없습니다 — 삭제된 앱일 수 있습니다.` };
  if (!app.presetId) return { error: "앱에 크기(presetId)가 지정돼 있지 않습니다." };
  if (!preset) {
    return {
      error:
        `앱의 크기 프리셋(PRESET#${app.presetId})을 찾을 수 없습니다 — 관리자가 삭제했을 수 있습니다. ` +
        "관리자 화면에서 프리셋을 다시 만들거나 앱의 크기를 바꾼 뒤 다시 배포하세요.",
    };
  }
  if (num(preset.cpu) <= 0 || num(preset.memory) <= 0) {
    return { error: `크기 프리셋(PRESET#${app.presetId})의 cpu/memory 값이 올바르지 않습니다(cpu=${str(preset.cpu)}, memory=${str(preset.memory)}).` };
  }
  if (!app.permissionTemplateId) return { error: "앱에 앱 유형(permissionTemplateId)이 지정돼 있지 않습니다." };
  if (!perm) {
    return {
      error:
        `앱의 권한 템플릿(PERM#${app.permissionTemplateId})을 찾을 수 없습니다 — 관리자가 삭제했을 수 있습니다. ` +
        "권한이 사라진 채 배포하지 않도록 중단합니다. 템플릿을 다시 만들거나 앱 유형을 바꾼 뒤 다시 배포하세요.",
    };
  }
  if (!perm.policyDocument || typeof perm.policyDocument !== "object") {
    return { error: `권한 템플릿(PERM#${app.permissionTemplateId})에 정책 문서(policyDocument)가 없습니다.` };
  }

  // D20(계약 §3.3·§5): 배정 ALB 인덱스. 없으면(기존 앱) 0.
  const albIndex = Number.isInteger(num(app.albIndex)) && num(app.albIndex) >= 0 ? num(app.albIndex) : 0;
  const scalars = {
    appId: env.APP_ID,
    subdomain: str(app.subdomain),
    scheme: str(app.scheme),
    albIndex,
    imageTag: str(env.IMAGE_TAG),
    rulePriority: num(app.rulePriority),
    cpu: num(preset.cpu),
    memory: num(preset.memory),
    minCount: num(preset.minCount),
    maxCount: num(preset.maxCount),
    scaleMetric: str(preset.scaleMetric) || "cpu",
    scaleThreshold: num(preset.scaleThreshold) || 70,
    sleepMode: str(app.sleepMode) || "always-on",
    cognitoProtect: app.cognitoProtect === true || str(app.cognitoProtect) === "true",
    isInitialDeploy: env.IS_INITIAL === "true",
  };
  const lines = [];
  for (const [k, v] of Object.entries(scalars)) lines.push(`export CTX_${k}=${JSON.stringify(str(v))}`);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  // schedule: sleepMode=schedule일 때만 유효({startTime,stopTime,days,timezone}).
  if (scalars.sleepMode === "schedule" && app.schedule && typeof app.schedule === "object") {
    lines.push(`export CTX_scheduleB64=${b64(app.schedule)}`);
  }
  // envVars: 평문 문자열맵. 값이 있을 때만.
  if (app.envVars && typeof app.envVars === "object" && Object.keys(app.envVars).length > 0) {
    lines.push(`export CTX_envVarsB64=${b64(app.envVars)}`);
  }
  // 시크릿(D8, 앱당 1개 JSON): secretArn(완전 ARN, 값 아님) + secretKeys. secretKeys 가 비면 둘 다 생략.
  const secretKeys = Array.isArray(app.secretKeys) ? app.secretKeys.map(String) : [];
  if (typeof app.secretArn === "string" && app.secretArn && secretKeys.length > 0) {
    lines.push(`export CTX_secretArn=${JSON.stringify(app.secretArn)}`);
    lines.push(`export CTX_secretKeysB64=${b64(secretKeys)}`);
  }
  // permissionPolicy: 태스크 역할 인라인 정책.
  lines.push(`export CTX_permissionPolicyB64=${b64(perm.policyDocument)}`);
  return { lines };
}

function main() {
  const env = process.env;
  const table = env.TABLE_NAME;
  if (!table || !env.APP_ID) fail("TABLE_NAME/APP_ID 환경변수가 필요합니다.");
  const app = getItem(table, { PK: { S: `APP#${env.APP_ID}` }, SK: { S: "META" } });
  const preset = app && app.presetId ? getItem(table, { PK: { S: "CONFIG" }, SK: { S: `PRESET#${app.presetId}` } }) : null;
  const perm =
    app && app.permissionTemplateId
      ? getItem(table, { PK: { S: "CONFIG" }, SK: { S: `PERM#${app.permissionTemplateId}` } })
      : null;
  const res = buildContext(env, app, preset, perm);
  if (res.error) fail(`배포 컨텍스트 조립 실패 — ${res.error}`);
  process.stdout.write(res.lines.join("\n") + "\n");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    fail(`배포 컨텍스트 조립 중 오류 — ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { buildContext };
