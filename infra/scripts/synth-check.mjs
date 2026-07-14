#!/usr/bin/env node
// CI-safe synth. 실제 synth 에러는 그대로 실패시키되,
// M1 골격의 빈 App("This app contains no stacks")만 성공으로 취급한다.
// M2에서 스택이 추가되면 이 예외는 자연히 무의미해진다(정상 exit 0).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 환경 값(domain/hostedZone/account/region)은 하드코딩 제거로 이제 주입이 필수다.
//  CI synth는 실제 배포가 아니므로 결정적 더미 값을 넣는다(deploy.sh가 넣는 실제 값과 무관).
const SYNTH_ACCOUNT = "123456789012";
const SYNTH_REGION = "ap-northeast-2";
const args = [
  "cdk", "synth",
  "-c", "stage=dev",
  "-c", "domain=apps-dev.example.test",
  "-c", "hostedZoneId=Z0SYNTHCHECK00000",
  "-c", `account=${SYNTH_ACCOUNT}`,
  "-c", `region=${SYNTH_REGION}`,
];

// VPC(maxAzs)는 계정 AZ를 context provider로 lookup 한다. CI엔 자격증명/캐시가 없어(그리고 자격증명이
//  있어도 대상 계정이 더미면) lookup role assume가 실패한다.
//  → lookup 캐시 파일(cdk.context.json)에 더미 AZ 항목을 미리 채워 실제 SDK 호출을 건너뛴다.
//     CDK가 실제로 참조하는 경로는 이 파일이다(CDK_CONTEXT_JSON은 앱 context일 뿐 lookup 캐시가 아님).
//  로컬 개발자의 기존 cdk.context.json을 보존하기 위해 백업 후 병합, synth 끝나면 원복한다.
const infraDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctxFile = join(infraDir, "cdk.context.json");
const azKey = `availability-zones:account=${SYNTH_ACCOUNT}:region=${SYNTH_REGION}`;
const azVal = [`${SYNTH_REGION}a`, `${SYNTH_REGION}b`];

const hadCtxFile = existsSync(ctxFile);
const originalCtx = hadCtxFile ? readFileSync(ctxFile, "utf8") : null;

let res;
try {
  const merged = hadCtxFile ? JSON.parse(originalCtx) : {};
  // 기존 실계정 캐시는 건드리지 않고 더미 계정 AZ만 추가한다(원복으로 완전 복구).
  merged[azKey] = azVal;
  writeFileSync(ctxFile, JSON.stringify(merged, null, 2));

  res = spawnSync("npx", args, { encoding: "utf8", cwd: infraDir });
} finally {
  // 원복: 파일이 원래 있었으면 원본 내용으로, 없었으면 삭제.
  if (hadCtxFile) {
    writeFileSync(ctxFile, originalCtx);
  } else if (existsSync(ctxFile)) {
    unlinkSync(ctxFile);
  }
}

const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
process.stdout.write(out);

if (res.status === 0) {
  process.exit(0);
}
if (/This app contains no stacks/.test(out)) {
  console.log("[synth:ci] 빈 App(M1 골격) — 스택 없음은 정상. 성공 처리.");
  process.exit(0);
}
process.exit(res.status ?? 1);
