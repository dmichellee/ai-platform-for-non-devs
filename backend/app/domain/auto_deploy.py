"""자동 배포 토글 반영 (QA M4, 2026-10-08 — api-contract AUTO_DEPLOY_APPLYING).

autoDeployEnabled 는 app-pipeline 스택의 소스 트리거(push 감지)로 구현돼 있어 DDB 값만 바꿔서는 반영되지
않는다. 값이 실제로 바뀌면 provisioner CodeBuild 를 APP_STACK_KIND=pipeline 으로 StartBuild 해 pipeline
스택을 재배포한다(ProvisionApp 의 deploy-pipeline 과 같은 env — `pipeline_build_env`). provisioner.yml 은
빌드 시점에 DDB App 레코드에서 autoDeployEnabled 를 다시 읽으므로 **DDB 갱신 후** 시작해야 한다.

이 빌드는 Deployment 이력을 만들지 않는다 — deploy-notify 는 provisioner 이벤트 중 APP_STACK_KIND=pipeline 을
무시한다(not-runtime-build). runtime 스택과 무관하므로 앱 배포가 진행 중이어도 허용한다.

pipeline 스택 빌드 추적: App 내부 필드 `pipelineStackBuildId`(ProvisionApp deploy-pipeline 과 이 경로가 기록).
  - 그 빌드가 IN_PROGRESS → SKIPPED/ALREADY_APPLYING. 진행 중 빌드가 DDB 를 언제 읽었는지 알 수 없어
    새 값이 반영될지 보장할 수 없으므로 **autoDeployEnabled 변경은 저장하지 않는다**(화면과 실제 불일치 방지).
  - 앱이 ACTIVE 이거나 pipeline 스택 빌드가 SUCCEEDED 로 끝났으면(스택 존재) → StartBuild → APPLYING.
    StartBuild 실패는 저장 유지 + SKIPPED/START_FAILED.
  - CREATING 인데 아직 pipeline 스택 빌드 전(ALB 슬롯 대기 등) → 저장만, APPLYING
    (곧 실행될 deploy-pipeline 이 DDB 의 새 값으로 스택을 만든다).
    다음 PATCH 에 autoDeployEnabled 가 (같은 값이라도) 오면 재시도한다(내부 필드 autoDeployPending).
  - 그 외(FAILED 인데 pipeline 스택이 없거나 확인 불가, CREATING 인데 스택 빌드 실패) → 저장, SKIPPED/NOT_READY.
    START_FAILED 와 같이 autoDeployPending=True 로 남겨, 앱이 준비된 뒤 같은 값으로 다시 저장하면 재시도한다(QA F6).
"""

from __future__ import annotations

from typing import Any

from ..integrations.codebuild import get_build_status, start_provisioner_build
from ..integrations.ssm import platform_param

PIPELINE_BUILD_FIELD = "pipelineStackBuildId"
# START_FAILED·NOT_READY 로 저장만 되고 스택에 반영되지 않은 상태 표시(내부). 다음 PATCH 에 autoDeployEnabled 가
#  같은 값으로 와도 재시도한다(그렇지 않으면 "같은 값 = 무변경" 이라 다시 적용할 방법이 없다).
PENDING_FIELD = "autoDeployPending"

NOTE_APPLYING = "자동 배포 설정을 적용하는 중이에요. 몇 분 뒤 반영돼요."
NOTE_START_FAILED = (
    "자동 배포 설정은 저장됐지만 지금 바로 적용하지 못했어요. 잠시 후 같은 설정으로 다시 저장해 주세요."
)
NOTE_ALREADY_APPLYING = (
    "이전 자동 배포 설정을 적용하는 중이라 이번 변경은 저장하지 않았어요. 몇 분 뒤 다시 바꿔 주세요."
)
NOTE_NOT_READY = (
    "앱이 아직 준비되지 않아 자동 배포 설정을 바로 적용하지 못했어요. "
    "저장은 됐어요. 앱이 준비되면 같은 설정으로 다시 저장해 주세요."
)


def pipeline_build_env(stage: str, app: dict[str, Any]) -> dict[str, str]:
    """provisioner StartBuild env(APP_STACK_KIND=pipeline) — deploy-pipeline step 과 단일 원본."""
    env: dict[str, str] = {
        "APP_ID": app["appId"],
        "STAGE": stage,
        "APP_STACK_KIND": "pipeline",
        "PROVIDER": app["provider"],
        "REPO_URL": app["repoUrl"],
        "BRANCH": app["branch"],
        "AUTO_DEPLOY": str(app.get("autoDeployEnabled")),
    }
    connection_arn = app.get("connectionArn")
    if connection_arn:
        env["CONNECTION_ARN"] = connection_arn
    return env


def start_pipeline_stack_build(stage: str, app: dict[str, Any]) -> str:
    project_name = platform_param(stage, "provisioner-project-name")
    return start_provisioner_build(project_name, pipeline_build_env(stage, app))


def tracked_build_status(app: dict[str, Any]) -> str | None:
    """추적 중인 pipeline 스택 빌드 상태(SUCCEEDED|IN_PROGRESS|FAILED). 없거나 조회 실패면 None."""
    build_id = app.get(PIPELINE_BUILD_FIELD)
    if not isinstance(build_id, str) or not build_id:
        return None
    try:
        return get_build_status(build_id)
    except Exception as err:  # noqa: BLE001 - 조회 실패는 "판단 불가"
        print("[auto-deploy] build status lookup failed:", type(err).__name__)
        return None


def plan(app: dict[str, Any]) -> str:
    """변경 저장 전 판정: "ALREADY_APPLYING" | "START" | "DEFER" | "NOT_READY"."""
    tracked = tracked_build_status(app)
    if tracked == "IN_PROGRESS":
        return "ALREADY_APPLYING"
    status = app.get("status")
    if status == "ACTIVE" or tracked == "SUCCEEDED":
        return "START"
    if status == "CREATING" and tracked is None:
        return "DEFER"
    return "NOT_READY"


def skipped(reason: str) -> dict[str, Any]:
    note = {
        "ALREADY_APPLYING": NOTE_ALREADY_APPLYING,
        "START_FAILED": NOTE_START_FAILED,
        "NOT_READY": NOTE_NOT_READY,
    }[reason]
    return {"status": "SKIPPED", "reason": reason, "note": note}


def applying() -> dict[str, Any]:
    return {"status": "APPLYING", "note": NOTE_APPLYING}
