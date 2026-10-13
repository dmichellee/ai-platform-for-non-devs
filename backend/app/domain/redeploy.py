"""재빌드 없는 런타임 재배포 (롤백, D8 시크릿 변경 즉시 재배포).

롤백과 시크릿 변경 재배포가 **같은 경로**를 쓴다: provisioner CodeBuild(StartBuild) 를
APP_STACK_KIND=runtime + IMAGE_TAG={commitSha} 로 트리거 → provisioner.yml 이 DDB 의 최신 App
파라미터(secretArn/secretKeys 포함)로 runtime 스택만 `cdk deploy`. 이미지 재빌드 없음.

접수만 하고 완료를 폴링하지 않는다("메인 서버 무부하"). 완료는 deploy-notify 가 CodeBuild
Build State Change 이벤트로 Deployment(buildId 매칭)를 SUCCEEDED/FAILED 로 갱신한다.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..data.deployments import (
    adopt_deployment,
    create_deployment_for_build,
    find_deployment_by_build,
    list_deployments,
    put_deployment,
)
from ..http.errors import errors
from ..integrations.codebuild import start_provisioner_build
from ..integrations.ecr import app_ecr_repo_name, image_tag_exists
from ..integrations.ecs_runtime import describe_app_task_definitions, image_tag_for_repo
from ..integrations.ssm import platform_param
from ..wake import cluster_name
from ..wake.ecs_service import app_service_name

# Deployment 종결 상태. 그 외(PENDING/VALIDATING/BUILDING/DEPLOYING)는 진행 중.
_TERMINAL = {"SUCCEEDED", "FAILED"}

# 진행 중 판정에서 이보다 오래 갱신되지 않은 레코드는 고착(이벤트 유실 등)으로 보고 무시한다.
#  배포(빌드+cdk deploy)는 통상 30분 안쪽 — 2시간이면 충분히 보수적이다. 고착 레코드가 시크릿 저장을
#  영구히 막는 일을 방지한다.
STALE_IN_PROGRESS_AFTER = timedelta(hours=2)


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def find_in_progress_deployment(app_id: str, now: datetime | None = None) -> dict[str, Any] | None:
    """최근 배포 중 진행 중(비종결)이고 고착되지 않은 레코드. 없으면 None."""
    now = now or datetime.now(timezone.utc)
    for dep in list_deployments(app_id, 20):
        if dep.get("status") in _TERMINAL:
            continue
        touched = _parse_iso(dep.get("updatedAt")) or _parse_iso(dep.get("createdAt"))
        if touched is not None and now - touched > STALE_IN_PROGRESS_AFTER:
            continue
        return dep
    return None


def current_deployed_commit(stage: str, app: dict[str, Any]) -> tuple[str | None, str | None]:
    """현재 배포된 커밋 (commitSha, commitMessage).

    1) 마지막 SUCCEEDED 배포의 commitSha(최신순 이력).
    2) 없으면(이력 TTL 만료/커밋 정보 결측) 실행 중 ECS 서비스 PRIMARY 태스크 정의의 앱 이미지 태그.
    3) 둘 다 없으면 (None, None) — 아직 배포된 적 없음.
    """
    for dep in list_deployments(app["appId"], 100):
        if dep.get("status") != "SUCCEEDED":
            continue
        sha = dep.get("commitSha")
        if isinstance(sha, str) and sha:
            return sha, dep.get("commitMessage")
        break  # 최신 성공 배포에 커밋 정보가 없으면 ECS 폴백(더 오래된 성공 배포는 현재 버전이 아님)
    try:
        info = describe_app_task_definitions(cluster_name(), app_service_name(stage, app["appId"]))
    except Exception as err:  # noqa: BLE001 - 조회 실패는 "판단 불가" → 미배포로 취급(안전 측)
        print("[redeploy] describe task definition failed:", type(err).__name__)
        return None, None
    if not info["found"]:
        return None, None
    tag = image_tag_for_repo(info["primary"], app_ecr_repo_name(stage, app["appId"]))
    return (tag, None) if tag else (None, None)


_DEFAULT_START_FAILED = "지금은 앱에 새 설정을 적용(재배포)할 수 없어요. 잠시 후 다시 시도해주세요."


# StartBuild env override 로 실어 보내는 Deployment.trigger 값. provisioner.yml 은 이 변수를 쓰지 않고
#  (모르는 env 는 무시), deploy-notify 가 Build State Change 이벤트의 env 에서 읽어 "레코드보다 이벤트가
#  먼저 온" 경우에 올바른 trigger 로 레코드를 만든다(record_runtime_redeploy 참고).
DEPLOY_TRIGGER_ENV = "DEPLOY_TRIGGER"
REDEPLOY_TRIGGERS = ("rollback", "secret-change")


def start_runtime_redeploy(
    stage: str,
    app_id: str,
    commit_sha: str,
    *,
    trigger: str,
    failed_message: str = _DEFAULT_START_FAILED,
) -> str:
    """provisioner CodeBuild(runtime 재배포) StartBuild → build id.

    trigger(rollback|secret-change)는 env DEPLOY_TRIGGER 로 함께 보낸다(deploy-notify 의 레코드 생성 판단용).
    SSM(provisioner-project-name) 조회와 StartBuild 를 **모두** 친절 에러로 감싼다(QA M1 — 이전에는
    SSM 조회가 try 밖이라 권한/파라미터 문제 시 500 INTERNAL_ERROR 로 새어 나갔다).
    """
    try:
        project_name = platform_param(stage, "provisioner-project-name")
        return start_provisioner_build(
            project_name,
            {
                "APP_ID": app_id,
                "STAGE": stage,
                "APP_STACK_KIND": "runtime",
                "IMAGE_TAG": commit_sha,
                DEPLOY_TRIGGER_ENV: trigger,
            },
        )
    except Exception as err:  # noqa: BLE001 - AWS 예외를 사용자용 친절 에러로 변환
        print("[redeploy] start runtime redeploy failed:", type(err).__name__)
        raise errors.invalid_state(failed_message) from err


def record_runtime_redeploy(
    app_id: str,
    build_id: str,
    *,
    trigger: str,
    commit_sha: str,
    commit_message: str | None,
) -> dict[str, Any]:
    """런타임 재배포 접수 레코드(PENDING)를 빌드 ID 클레임(`DEPLOYBUILD#{buildId}`) 경유로 1건만 만든다.

    경합: StartBuild 직후 빌드가 즉시 실패/종결해 deploy-notify 가 Build State Change 로 레코드를 먼저
    만들 수 있다(이벤트 env 의 DEPLOY_TRIGGER 로 trigger 판단 가능할 때만). 그 경우 클레임에 지면 그
    레코드의 trigger/커밋 정보만 보정해 반환한다(status 유지 — 역행 금지).
    """
    deployment = create_deployment_for_build(
        app_id,
        build_id,
        trigger=trigger,
        status="PENDING",
        commit_sha=commit_sha,
        commit_message=commit_message,
    )
    if deployment is not None:
        return deployment
    existing = find_deployment_by_build(app_id, (build_id,), consistent=True)
    if existing is None:
        # 클레임은 있는데 레코드가 안 보임(극단 — 트랜잭션상 함께 생성되므로 사실상 없음). 응답을 위해 put.
        return put_deployment(
            app_id=app_id,
            trigger=trigger,
            commit_sha=commit_sha,
            commit_message=commit_message,
            build_id=build_id,
        )
    return adopt_deployment(
        app_id, existing, trigger=trigger, commit_sha=commit_sha, commit_message=commit_message
    )


def trigger_secret_change_redeploy(stage: str, app: dict[str, Any]) -> dict[str, Any]:
    """시크릿 변경 저장 직후의 런타임 재배포(D8). PATCH 응답의 `redeploy` 필드를 반환한다.

    - 배포된 커밋이 없으면(ACTIVE 아님 포함) SKIPPED/NOT_DEPLOYED — 다음 첫 배포가 새 시크릿을 쓴다.
    - 이미지가 ECR 에 없으면 SKIPPED/IMAGE_NOT_FOUND. 시작 실패는 SKIPPED/START_FAILED.
      (시크릿 저장 자체는 이미 끝났으므로 에러로 응답하지 않는다 — 저장이 실패한 것으로 오해 방지.)
    - 성공 시 Deployment(trigger=secret-change, PENDING, buildId) 기록 → PENDING + deploymentId.
    """
    app_id = app["appId"]
    if app.get("status") != "ACTIVE":
        return _skipped("NOT_DEPLOYED")
    commit_sha, commit_message = current_deployed_commit(stage, app)
    if not commit_sha:
        return _skipped("NOT_DEPLOYED")
    try:
        exists = image_tag_exists(stage, app_id, commit_sha)
    except Exception:  # noqa: BLE001
        exists = False
    if not exists:
        return _skipped("IMAGE_NOT_FOUND")
    try:
        build_id = start_runtime_redeploy(stage, app_id, commit_sha, trigger="secret-change")
    except Exception:  # noqa: BLE001 - 친절 에러 대신 SKIPPED/START_FAILED 로 응답(저장은 성공)
        return _skipped("START_FAILED")
    deployment = record_runtime_redeploy(
        app_id,
        build_id,
        trigger="secret-change",
        commit_sha=commit_sha,
        commit_message=commit_message,
    )
    return {
        "status": "PENDING",
        "deploymentId": deployment["deploymentId"],
        "note": "새 비밀 값을 앱에 적용하고 있어요(몇 분 걸려요). 진행 상황은 배포 이력에서 볼 수 있어요.",
    }


_SKIP_NOTES = {
    "NOT_DEPLOYED": "저장했어요. 앱이 아직 배포되지 않아서, 첫 배포 때 새 비밀 값이 적용돼요.",
    "IMAGE_NOT_FOUND": "저장했어요. 다만 현재 버전의 앱 이미지를 찾지 못해 바로 적용하지 못했어요. '지금 배포'를 눌러 적용해 주세요.",
    "START_FAILED": "저장했어요. 다만 지금은 앱에 바로 적용하지 못했어요. 잠시 후 '지금 배포'를 눌러 적용해 주세요.",
}


def _skipped(reason: str) -> dict[str, Any]:
    return {"status": "SKIPPED", "reason": reason, "note": _SKIP_NOTES[reason]}
