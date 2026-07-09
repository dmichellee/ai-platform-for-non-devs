"""Step Functions task Lambda 디스패처 (ProvisionApp / DeleteApp).

각 상태 기계는 단일 task Lambda + event.step 분기(D-M5-01). 상태 기계(ASL)는
Task 나열 + Wait/Choice(빌드/스택 폴링) + Retry/Catch(재시도·실패 전이)만 담당하고,
무거운 작업은 시작만(StartBuild/StartPipelineExecution/DeleteStack) — 폴링은 상태 조회만.
"""

from __future__ import annotations

import os


def stage() -> str:
    """실행 stage. task/wake Lambda env 에 STAGE 주입(stack-outputs §F/§I). 미주입 시 dev 폴백."""
    return os.environ.get("STAGE") or "dev"
