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
const base = [
  "cdk", "synth", "--quiet",
  "-c", "stage=dev",
  "-c", `account=${SYNTH_ACCOUNT}`,
  "-c", `region=${SYNTH_REGION}`,
];
const platformCtx = [
  "-c", "domain=apps-dev.example.test",
  "-c", "hostedZoneId=Z0SYNTHCHECK00000",
];
// 엔트리(bin/apphub.ts)의 모드별 합성을 모두 확인한다:
//  플랫폼 public(기본) / 플랫폼 private(D19) / ALB 증설(D20, domain 불필요).
const variants = [
  { name: "platform(public)", args: [...base, ...platformCtx] },
  { name: "platform(private)", args: [...base, ...platformCtx, "-c", "frontendMode=private"] },
  { name: "alb-shard(internet-1)", args: [...base, "-c", "albShard=true", "-c", "albScheme=internet", "-c", "albIndex=1"] },
  { name: "alb-shard(internal-2)", args: [...base, "-c", "albShard=true", "-c", "albScheme=internal", "-c", "albIndex=2"] },
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

const results = [];
try {
  const merged = hadCtxFile ? JSON.parse(originalCtx) : {};
  // 기존 실계정 캐시는 건드리지 않고 더미 계정 AZ만 추가한다(원복으로 완전 복구).
  merged[azKey] = azVal;
  writeFileSync(ctxFile, JSON.stringify(merged, null, 2));

  for (const v of variants) {
    const r = spawnSync("npx", v.args, { encoding: "utf8", cwd: infraDir });
    results.push({ name: v.name, res: r });
    if (r.status !== 0) break;
  }
} finally {
  // 원복: 파일이 원래 있었으면 원본 내용으로, 없었으면 삭제.
  if (hadCtxFile) {
    writeFileSync(ctxFile, originalCtx);
  } else if (existsSync(ctxFile)) {
    unlinkSync(ctxFile);
  }
}

let failed = 0;
for (const { name, res } of results) {
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  process.stdout.write(`\n[synth:ci] ── ${name} ──\n${out}`);
  if (res.status === 0) {
    console.log(`[synth:ci] ${name} OK`);
  } else if (/This app contains no stacks/.test(out)) {
    console.log(`[synth:ci] ${name}: 빈 App — 스택 없음은 정상. 성공 처리.`);
  } else {
    console.log(`[synth:ci] ${name} 실패(exit ${res.status})`);
    failed = res.status ?? 1;
  }
}
process.exit(failed);
