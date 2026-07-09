#!/usr/bin/env node
// CI-safe synth. 실제 synth 에러는 그대로 실패시키되,
// M1 골격의 빈 App("This app contains no stacks")만 성공으로 취급한다.
// M2에서 스택이 추가되면 이 예외는 자연히 무의미해진다(정상 exit 0).
import { spawnSync } from "node:child_process";

const args = ["cdk", "synth", "-c", "stage=dev"];
const res = spawnSync("npx", args, { encoding: "utf8" });
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
