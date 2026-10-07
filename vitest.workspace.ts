import { defineWorkspace } from "vitest/config";

// TS 패키지(infra/frontend)의 vitest 설정을 워크스페이스로 집약한다(루트 `npx vitest`용).
// 루트 `pnpm test`는 `pnpm -r test`로 각 패키지를 실행한다. 백엔드는 Python(pytest)이라 제외.
export default defineWorkspace([
  "infra/vitest.config.ts",
  "frontend/vitest.config.ts",
]);
