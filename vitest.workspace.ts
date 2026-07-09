import { defineWorkspace } from "vitest/config";

// 테스트 러너 통일: 각 패키지의 vitest 설정을 워크스페이스로 집약한다.
// 루트에서 `pnpm test` 시 전 패키지 테스트가 이 워크스페이스로 실행된다.
export default defineWorkspace([
  "infra/vitest.config.ts",
  "frontend/vitest.config.ts",
  "backend/vitest.config.ts",
]);
