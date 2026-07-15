"""[Notify] 배포 상태 알림 Lambda — EventBridge(CodePipeline 상태변화) → DDB Deployment 갱신.

DESIGN.md 3.3 마지막 단계 `[Notify] EventBridge → Lambda → DDB Deployment 레코드 갱신`의 구현.
이 Lambda 가 없으면 Deployment 레코드가 접수 시점 PENDING 에서 영원히 멈추고(웹 '배포 진행 상황'
화면이 '가져오기'에서 정지), push 자동 배포는 레코드 자체가 생성되지 않는다.

수신 이벤트 2종(EventBridge 규칙은 infra 가 생성):
  1) CodePipeline Stage Execution State Change — 스테이지 단위 진행(Source|ValidateBuild|Deploy).
     STARTED 를 상태(PENDING|VALIDATING|DEPLOYING)로 전이한다. Source STARTED 에서 자동 push
     배포 레코드가 없으면 신규 생성(trigger=auto).
  2) CodePipeline Pipeline Execution State Change — 파이프라인 종결(SUCCEEDED|FAILED|...).
     SUCCEEDED→SUCCEEDED, FAILED/CANCELED/STOPPED→FAILED(+failureCategory 조회), SUPERSEDED→스킵.

멱등·역행 금지: 이미 종결(SUCCEEDED/FAILED)된 레코드는 스테이지 이벤트로 되돌리지 않는다.
STATUS_ORDER 인덱스가 현재보다 낮은 값으로도 내리지 않는다(늦게 도착한 이벤트 방어).

무거운 작업(폴링/재시도)은 하지 않는다("메인 서버 무부하") — 단발 조회 후 DDB 갱신만.
로깅은 wake 모듈과 동일하게 print 스타일.
"""

from __future__ import annotations

from typing import Any

from ..data.deployments import list_deployments, put_deployment, update_deployment
from ..integrations.clients import client
from ..wake import stage

# Deployment.status 진행 순서(apphub-conventions 5장). 프론트가 인덱스 비교로 소비하므로
# 역행 금지 판정에도 이 순서를 쓴다. BUILDING 은 스테이지 이벤트만으로 구분 불가(계약) — 순서에는
# 두되 이번 범위에서 직접 기록하지 않는다(스킵돼도 프론트는 인덱스 비교라 안전).
STATUS_ORDER = ["PENDING", "VALIDATING", "BUILDING", "DEPLOYING", "SUCCEEDED", "FAILED"]

# 스테이지명 → STARTED 시 전이할 status. Deploy STARTED 는 DEPLOYING.
_STAGE_STARTED_STATUS = {
    "Source": "PENDING",
    "ValidateBuild": "VALIDATING",
    "Deploy": "DEPLOYING",
}

# 종결 status(이미 여기 도달했으면 스테이지 이벤트로 되돌리지 않는다).
_TERMINAL = {"SUCCEEDED", "FAILED"}


def _pipeline_name(stage_value: str, app_id: str) -> str:
    return f"apphub-{stage_value}-app-{app_id}"


def app_id_from_pipeline(pipeline: str | None, stage_value: str) -> str | None:
    """detail.pipeline `apphub-{stage}-app-{appId}` 에서 appId 파싱(stage 검증 후).

    다른 stage/패턴 미일치는 None(스킵). appId 부분에 다시 `-` 가 없다는 보장은 없으나 규약상
    appId 는 8자 소문자+숫자 난수라 prefix 제거 후 전체를 appId 로 취한다.
    """
    if not pipeline:
        return None
    marker = f"apphub-{stage_value}-app-"
    if not pipeline.startswith(marker):
        return None
    app_id = pipeline[len(marker) :]
    return app_id or None


def _status_index(status: str | None) -> int:
    """STATUS_ORDER 인덱스. 미상/None 은 -1(어떤 값보다도 낮아 항상 전진 허용)."""
    if status in STATUS_ORDER:
        return STATUS_ORDER.index(status)
    return -1


def _find_deployment(app_id: str, execution_id: str) -> dict[str, Any] | None:
    """최근 20건 중 pipelineExecutionId 가 일치하는 레코드(계약 §매칭 1)."""
    for dep in list_deployments(app_id, 20):
        if dep.get("pipelineExecutionId") == execution_id:
            return dep
    return None


def _source_revision(stage_value: str, app_id: str, execution_id: str) -> tuple[str | None, str | None]:
    """get_pipeline_execution 의 artifactRevisions 에서 (commitSha, commitMessage) 최대한 채움.

    조회 실패/필드 없음은 (None, None) — 커밋 정보는 있으면 좋은 부가정보라 없어도 진행한다.
    """
    try:
        res = client("codepipeline").get_pipeline_execution(
            pipelineName=_pipeline_name(stage_value, app_id),
            pipelineExecutionId=execution_id,
        )
    except Exception as err:  # noqa: BLE001 - 커밋 정보 조회 실패는 무시(레코드는 생성)
        print("[deploy-notify] get_pipeline_execution failed:", str(err))
        return None, None
    revisions = (res.get("pipelineExecution") or {}).get("artifactRevisions") or []
    if not revisions:
        return None, None
    first = revisions[0]
    return first.get("revisionId"), first.get("revisionSummary")


def _failure_category(stage_value: str, app_id: str, execution_id: str) -> str:
    """실패 액션을 조회해 failureCategory 를 결정(계약 §failureCategory 3분기).

    list_action_executions 로 실패(Failed) 액션을 찾아:
      (a) ValidateBuild 실패 → 해당 CodeBuild build 의 exported env FAILURE_CATEGORY(batch_get_builds).
      (b) Deploy 실패 → DEPLOY_FAILED.
      (c) 조회 실패/미상 → INTERNAL_ERROR(failureCategory 사전 정식 코드).
    """
    try:
        res = client("codepipeline").list_action_executions(
            pipelineName=_pipeline_name(stage_value, app_id),
            filter={"pipelineExecutionId": execution_id},
        )
    except Exception as err:  # noqa: BLE001
        print("[deploy-notify] list_action_executions failed:", str(err))
        return "INTERNAL_ERROR"

    details = res.get("actionExecutionDetails") or []
    failed = [d for d in details if d.get("status") == "Failed"]
    if not failed:
        return "INTERNAL_ERROR"

    # ValidateBuild 실패 우선 — 사용자 원인(Dockerfile/빌드/헬스체크)이 담긴 exported env.
    validate = next((d for d in failed if d.get("stageName") == "ValidateBuild"), None)
    if validate is not None:
        category = _validate_build_failure_category(validate)
        if category:
            return category
        return "INTERNAL_ERROR"

    if any(d.get("stageName") == "Deploy" for d in failed):
        return "DEPLOY_FAILED"

    return "INTERNAL_ERROR"


def _validate_build_failure_category(action_detail: dict[str, Any]) -> str | None:
    """ValidateBuild 실패 액션의 CodeBuild build 에서 exported FAILURE_CATEGORY 를 읽는다.

    build id 는 action output 의 executionResult.externalExecutionId. batch_get_builds 로
    exportedEnvironmentVariables(name/value) 를 훑어 FAILURE_CATEGORY 값을 반환. 못 찾으면 None.
    """
    output = action_detail.get("output") or {}
    result = output.get("executionResult") or {}
    build_id = result.get("externalExecutionId")
    if not build_id:
        return None
    try:
        res = client("codebuild").batch_get_builds(ids=[build_id])
    except Exception as err:  # noqa: BLE001
        print("[deploy-notify] batch_get_builds failed:", str(err))
        return None
    builds = res.get("builds") or []
    if not builds:
        return None
    for var in builds[0].get("exportedEnvironmentVariables") or []:
        if var.get("name") == "FAILURE_CATEGORY" and var.get("value"):
            return var["value"]
    return None


# ── 이벤트 핸들링 ─────────────────────────────────────────────────────────────


def _handle_stage_event(detail: dict[str, Any], stage_value: str) -> dict[str, Any]:
    """Stage Execution State Change. STARTED 만 상태 전이(SUCCEEDED/FAILED 는 파이프라인 이벤트 담당)."""
    app_id = app_id_from_pipeline(detail.get("pipeline"), stage_value)
    if not app_id:
        return {"reason": "pipeline-not-matched"}
    stage_name = detail.get("stage")
    state = detail.get("state")
    execution_id = detail.get("execution-id")
    if not execution_id:
        return {"appId": app_id, "reason": "no-execution-id"}
    if state != "STARTED":
        # 스테이지 SUCCEEDED/FAILED 는 파이프라인 종결 이벤트에서 처리(스테이지 성공을 배포 성공으로
        # 오기록하지 않는다). STARTED 외 스테이지 이벤트는 스킵.
        return {"appId": app_id, "reason": f"stage-state-{state}-skipped"}

    next_status = _STAGE_STARTED_STATUS.get(stage_name or "")
    if next_status is None:
        return {"appId": app_id, "reason": f"stage-{stage_name}-not-mapped"}

    existing = _find_deployment(app_id, execution_id)
    if existing is None:
        # 매칭 레코드 없음. Source STARTED 면 자동 push 배포 → 신규 생성(계약 §매칭 2).
        # 그 외 스테이지 STARTED 인데 레코드가 없으면(누락/TTL 만료 등) 새로 만들지 않고 스킵.
        if stage_name != "Source":
            return {"appId": app_id, "reason": "no-record-non-source-skipped"}
        commit_sha, commit_message = _source_revision(stage_value, app_id, execution_id)
        put_deployment(
            app_id=app_id,
            trigger="auto",
            status="PENDING",
            commit_sha=commit_sha,
            commit_message=commit_message,
            pipeline_execution_id=execution_id,
        )
        return {"appId": app_id, "created": True, "status": "PENDING"}

    # 기존 레코드 갱신 — 역행 금지 멱등.
    return _advance(app_id, existing, next_status)


def _handle_pipeline_event(detail: dict[str, Any], stage_value: str) -> dict[str, Any]:
    """Pipeline Execution State Change. 종결 상태를 SUCCEEDED/FAILED 로 기록(+failureCategory)."""
    app_id = app_id_from_pipeline(detail.get("pipeline"), stage_value)
    if not app_id:
        return {"reason": "pipeline-not-matched"}
    state = detail.get("state")
    execution_id = detail.get("execution-id")
    if not execution_id:
        return {"appId": app_id, "reason": "no-execution-id"}

    if state == "SUCCEEDED":
        target_status = "SUCCEEDED"
    elif state in ("FAILED", "CANCELED", "STOPPED"):
        target_status = "FAILED"
    else:
        # STARTED/SUPERSEDED 등 — 종결이 아니거나(재실행에 밀림) SUCCEEDED 로 오기록하면 안 되는 상태.
        # note 없이 스킵(계약: SUPERSEDED 는 무시하지 않되 status 는 두고 스킵 처리 허용).
        return {"appId": app_id, "reason": f"pipeline-state-{state}-skipped"}

    existing = _find_deployment(app_id, execution_id)
    if existing is None:
        # 파이프라인 종결인데 매칭 레코드가 없으면 되돌아가 만들지 않는다(Source STARTED 에서 생성됨).
        return {"appId": app_id, "reason": "no-record-skipped"}

    failure_category = None
    if target_status == "FAILED":
        failure_category = _failure_category(stage_value, app_id, execution_id)
    return _advance(app_id, existing, target_status, failure_category=failure_category)


def _advance(
    app_id: str,
    existing: dict[str, Any],
    next_status: str,
    failure_category: str | None = None,
) -> dict[str, Any]:
    """역행 금지 멱등 갱신. 종결 레코드 보존 + STATUS_ORDER 인덱스 후퇴 금지."""
    current = existing.get("status")
    if current in _TERMINAL:
        return {"appId": app_id, "reason": f"terminal-{current}-preserved"}
    if _status_index(next_status) < _status_index(current):
        return {"appId": app_id, "reason": f"no-regress-{current}->{next_status}"}
    if next_status == current and failure_category is None:
        return {"appId": app_id, "reason": f"already-{current}"}

    deployment_id = existing["deploymentId"]
    update_deployment(
        app_id,
        deployment_id,
        status=next_status,
        failure_category=failure_category,
    )
    result: dict[str, Any] = {"appId": app_id, "status": next_status}
    if failure_category is not None:
        result["failureCategory"] = failure_category
    return result


def handle_event(event: dict[str, Any]) -> dict[str, Any]:
    """EventBridge 이벤트를 detail-type 으로 분기해 처리."""
    stage_value = stage()
    detail_type = event.get("detail-type")
    detail = event.get("detail") or {}
    if detail_type == "CodePipeline Stage Execution State Change":
        return _handle_stage_event(detail, stage_value)
    if detail_type == "CodePipeline Pipeline Execution State Change":
        return _handle_pipeline_event(detail, stage_value)
    return {"reason": f"detail-type-{detail_type}-ignored"}


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    """Lambda 진입점(build.sh shim → handler.handler). 로그 후 결과 반환."""
    try:
        result = handle_event(event)
        print("[deploy-notify]", result)
        return result
    except Exception as err:  # noqa: BLE001 - 로그 후 재전파(EventBridge 재시도에 맡김)
        print("[deploy-notify] failed:", str(err))
        raise
