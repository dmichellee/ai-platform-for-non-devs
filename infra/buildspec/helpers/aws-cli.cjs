// buildspec 공용 헬퍼 — AWS CLI 호출 + DDB AttributeValue 언마샬 (deploy.yml / provisioner.yml runtime 공용).
//
// 위치: 플랫폼 CDK tarball(cdk-src.tgz = infra + backend …, scripts/deploy.sh 3b)에 포함되어
//   CodeBuild 에서 `cdk-src/infra/buildspec/helpers/` 로 존재한다. deploy.yml(app-pipeline 에 인라인됨)은
//   항상 같은/이전 tarball 에서 synth 되므로, 이 파일을 참조하는 buildspec 은 tarball 에 이 파일이 있다.
// 의존성: Node 22(buildspec runtime-versions) + AWS CLI v2(CodeBuild 표준 이미지). npm 패키지 없음.
"use strict";

const { execFileSync } = require("node:child_process");

class AwsCliError extends Error {
  constructor(args, stderr, status) {
    super(`aws ${args.slice(0, 2).join(" ")} 실패(exit ${status}): ${String(stderr || "").trim().slice(0, 500)}`);
    this.args = args;
    this.stderr = String(stderr || "");
    this.status = status;
  }
  /** 에러 코드 문자열(ParameterNotFound, TargetGroupNotFound 등)이 stderr 에 있는지. */
  hasCode(code) {
    return this.stderr.includes(code);
  }
}

/** aws CLI 실행 → JSON 파싱 결과(빈 출력이면 {}). 실패 시 AwsCliError. 셸을 거치지 않는다(인용 안전). */
function aws(args) {
  const region = process.env.AWS_DEFAULT_REGION;
  const full = [...args, "--output", "json", ...(region ? ["--region", region] : [])];
  let out;
  try {
    out = execFileSync("aws", full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new AwsCliError(full, err.stderr, err.status);
  }
  const text = String(out || "").trim();
  return text ? JSON.parse(text) : {};
}

/** DDB AttributeValue → 순수 JS 값 재귀 언마샬(S/N/BOOL/NULL/M/L/SS/NS). */
function unmarshall(av) {
  if (av == null || typeof av !== "object") return av;
  if ("S" in av) return av.S;
  if ("N" in av) return Number(av.N);
  if ("BOOL" in av) return av.BOOL;
  if ("NULL" in av) return null;
  if ("M" in av) {
    const o = {};
    for (const [k, v] of Object.entries(av.M)) o[k] = unmarshall(v);
    return o;
  }
  if ("L" in av) return av.L.map(unmarshall);
  if ("SS" in av) return av.SS;
  if ("NS" in av) return av.NS.map(Number);
  return av;
}

/** DDB get-item → 언마샬된 아이템. 없으면 null(호출부가 "없음"을 명시 판정). */
function getItem(table, key) {
  const res = aws(["dynamodb", "get-item", "--table-name", table, "--key", JSON.stringify(key)]);
  if (!res.Item) return null;
  const o = {};
  for (const [k, v] of Object.entries(res.Item)) o[k] = unmarshall(v);
  return o;
}

/** 실패 종료: 사람이 읽을 메시지를 stderr 에 남기고 exit 1 (buildspec 이 FAILURE_CATEGORY 파일을 기록). */
function fail(message) {
  process.stderr.write(`[apphub] ${message}\n`);
  process.exit(1);
}

module.exports = { aws, AwsCliError, unmarshall, getItem, fail };
