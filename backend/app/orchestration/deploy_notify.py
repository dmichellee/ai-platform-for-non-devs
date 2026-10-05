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

App.status 전이(A안): 파이프라인 종결이 **첫 배포**면 App.status 도 함께 전이한다 — SUCCEEDED 면
CREATING→ACTIVE(+clear_failure, runtimeState=RUNNING), FAILED 면 CREATING→FAILED(+set_failure).
"첫 배포인지" 별도 판별하지 않는다 — transition_status 가 allowed_from=["CREATING"] 조건부라
이미 ACTIVE(2번째 이후 재배포/자동배포)면 조건 불충족으로 no-op 다. 프로비저닝 SFN 의 finalize 는
성공해도 ACTIVE 로 바꾸지 않으므로(첫 배포는 별도 비동기 파이프라인), 이 전이가 CREATING→ACTIVE 의
유일한 경로다.

멱등·역행 금지: 이미 종결(SUCCEEDED/FAILED)된 레코드는 스테이지 이벤트로 되돌리지 않는다.
STATUS_ORDER 인덱스가 현재보다 낮은 값으로도 내리지 않는다(늦게 도착한 이벤트 방어).

  3) CodeBuild Build State Change — provisioner 런타임 재배포(롤백 / 시크릿 변경 재배포, D8).
     detail.project-name=`apphub-{stage}-provisioner` + env APP_STACK_KIND=runtime 인 빌드만.
     buildId 로 Deployment 를 매칭해 IN_PROGRESS→DEPLOYING, SUCCEEDED→SUCCEEDED,
     FAILED/FAULT/STOPPED/TIMED_OUT→FAILED(DEPLOY_FAILED). 파이프라인을 거치지 않는 경로라 이 이벤트가
     없으면 롤백·시크릿 변경 레코드가 PENDING 에 멈춘다.

런타임 배포 성공 후처리(파이프라인 SUCCEEDED / provisioner runtime SUCCEEDED 공통, _after_runtime_success):
  a) 잠자는 앱 재정합(QA H2): runtimeState=SLEEPING 인 ACTIVE 앱은 배포가 끝나면 sleep_app(force) 으로
     desiredCount=0 + 리스너 규칙 forward→Waker TG 를 멱등 재적용한다. 배포(cdk deploy)가 규칙을 앱 TG 로
     되돌리면 태스크 0개인 TG 로 forward 돼 503 이 고착되기 때문 — 재정합 후 접속하면 Waker 가 깨운다.
  b) 시크릿 지연 정리(D8): JSON 키 − (secretKeys ∪ 활성 태스크 정의 참조 KEY) 를 JSON 에서 제거.
     실패 배포에서는 수행하지 않는다. 후처리 실패는 로그만 남기고 삼킨다(배포 상태 기록은 이미 끝남).

무거운 작업(폴링/재시도)은 하지 않는다("메인 서버 무부하") — 단발 조회 후 DDB 갱신만.
로깅은 wake 모듈과 동일하게 print 스타일.
"""

from __future__ import annotations

from typing import Any

from ..data.apps import clear_failure, get_app, set_failure, set_runtime_state, transition_status
from ..data.deployments import list_deployments, put_deployment, update_deployment
from ..domain.secrets import prune_unreferenced_keys
from ..integrations.clients import client
from ..integrations.ecs_runtime import describe_app_task_definitions, referenced_secret_keys
from ..wake import cluster_name, stage
from ..wake.ecs_service import app_service_name
from ..wake.sleep import sleep_app

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

# 첫 배포 FAILED 시 App.failureReason 으로 남길 사용자용 한국어 요약(비개발자 대상).
#  failureCategory(apphub-conventions §4) → 요약. 미상/미매핑은 폴백. 배포 이력에서 상세를 보라는 안내.
_FIRST_DEPLOY_FAILURE_REASON: dict[str, str] = {
    "DOCKERFILE_MISSING": "첫 배포에 실패했어요 — 배포에 필요한 설정 파일(Dockerfile)이 없어요. 배포 이력에서 원인을 확인하세요.",
    "DOCKERFILE_INVALID": "첫 배포에 실패했어요 — 앱 설정이 배포 표준과 달라요. 배포 이력에서 원인을 확인하세요.",
    "BUILD_FAILED": "첫 배포에 실패했어요 — 앱을 빌드하는 중 오류가 발생했어요. 배포 이력에서 원인을 확인하세요.",
    "HEALTHCHECK_FAILED": "첫 배포에 실패했어요 — 앱이 상태 확인(/health)에 응답하지 않아요. 배포 이력에서 원인을 확인하세요.",
    "SOURCE_UNAVAILABLE": "첫 배포에 실패했어요 — 코드 저장소에 접근할 수 없어요. 저장소 연결 상태를 확인하세요.",
    "DEPLOY_FAILED": "첫 배포에 실패했어요 — 새 버전 적용에 실패했어요. 배포 이력에서 원인을 확인하세요.",
}
_FIRST_DEPLOY_FAILURE_FALLBACK = "첫 배포에 실패했어요. 배포 이력에서 원인을 확인하세요."


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
    """실패 액션을 조회해 failureCategory 를 결정(계약 §failureCategory 4분기).

    list_action_executions 로 실패(Failed) 액션을 찾아:
      (a) ValidateBuild 실패 → 해당 CodeBuild build 의 exported env FAILURE_CATEGORY(batch_get_builds).
      (b) Deploy 실패 → DEPLOY_FAILED.
      (c) Source 실패 → SOURCE_UNAVAILABLE(저장소 접근 불가·브랜치 없음·연결 끊김 등 코드 가져오기 실패 전부).
      (d) 조회 실패/미상 → INTERNAL_ERROR(failureCategory 사전 정식 코드).
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

    # Source 실패 — 코드를 가져오지 못한 경우. 안내 문구("저장소 연결 상태 확인")는 labels.ts 에 이미 있음.
    if any(d.get("stageName") == "Source" for d in failed):
        return "SOURCE_UNAVAILABLE"

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
    result = _advance(app_id, existing, target_status, failure_category=failure_category)
    # 첫 배포 완료를 App.status 로도 반영(A안). 조건부 전이라 이미 ACTIVE(재배포)면 no-op.
    app_transition = _advance_app_status(app_id, target_status, failure_category)
    if app_transition:
        result["appStatus"] = app_transition
    if target_status == "SUCCEEDED" and result.get("status") == "SUCCEEDED":
        result["afterSuccess"] = _after_runtime_success(stage_value, app_id)
    return result


# ── provisioner 런타임 재배포(롤백 / 시크릿 변경) — CodeBuild Build State Change ─────────

# CodeBuild build-status → Deployment.status. 그 외(미상)는 스킵.
_BUILD_STATUS_MAP = {
    "IN_PROGRESS": "DEPLOYING",
    "SUCCEEDED": "SUCCEEDED",
    "FAILED": "FAILED",
    "FAULT": "FAILED",
    "STOPPED": "FAILED",
    "TIMED_OUT": "FAILED",
}


def _build_env(detail: dict[str, Any]) -> dict[str, str]:
    env = ((detail.get("additional-information") or {}).get("environment") or {}).get(
        "environment-variables"
    ) or []
    return {str(v.get("name")): str(v.get("value")) for v in env if v.get("name")}


def _short_build_id(build_id: str) -> str:
    """이벤트 build-id(ARN `...:build/{project}:{uuid}`) → StartBuild 반환 형식 `{project}:{uuid}`."""
    marker = ":build/"
    return build_id.split(marker, 1)[1] if marker in build_id else build_id


def _handle_build_event(detail: dict[str, Any], stage_value: str) -> dict[str, Any]:
    if detail.get("project-name") != f"apphub-{stage_value}-provisioner":
        return {"reason": "project-not-matched"}
    env = _build_env(detail)
    if env.get("APP_STACK_KIND") != "runtime":
        return {"reason": "not-runtime-build"}
    app_id = env.get("APP_ID")
    build_id = detail.get("build-id")
    if not app_id or not build_id:
        return {"reason": "no-appId-or-build-id"}
    target_status = _BUILD_STATUS_MAP.get(str(detail.get("build-status")))
    if target_status is None:
        return {"appId": app_id, "reason": f"build-status-{detail.get('build-status')}-skipped"}

    short_id = _short_build_id(str(build_id))
    existing = next(
        (
            d
            for d in list_deployments(app_id, 20)
            if d.get("buildId") in (short_id, build_id)
        ),
        None,
    )
    if existing is None:
        return {"appId": app_id, "reason": "no-record-skipped"}

    failure_category = "DEPLOY_FAILED" if target_status == "FAILED" else None
    result = _advance(app_id, existing, target_status, failure_category=failure_category)
    if target_status == "SUCCEEDED" and result.get("status") == "SUCCEEDED":
        result["afterSuccess"] = _after_runtime_success(stage_value, app_id)
    return result


# ── 런타임 배포 성공 후처리 ─────────────────────────────────────────────────────


def _after_runtime_success(stage_value: str, app_id: str) -> dict[str, Any]:
    """배포 성공 후: (a) 잠자는 앱 재정합(H2) → (b) 시크릿 지연 정리(D8). 실패는 로그 후 삼킴."""
    out: dict[str, Any] = {}
    try:
        out["sleep"] = _resleep_if_sleeping(app_id)
    except Exception as err:  # noqa: BLE001
        print("[deploy-notify] re-sleep failed:", type(err).__name__, str(err)[:200])
        out["sleep"] = {"reason": "error"}
    try:
        out["secrets"] = _prune_secrets(stage_value, app_id)
    except Exception as err:  # noqa: BLE001 - 값이 메시지에 섞일 수 없게 타입명만 기록
        print("[deploy-notify] secret prune failed:", type(err).__name__)
        out["secrets"] = {"reason": "error"}
    return out


def _resleep_if_sleeping(app_id: str) -> dict[str, Any]:
    """runtimeState=SLEEPING 인 ACTIVE 앱을 다시 재운다(멱등, 기존 sleep-transition 로직 재사용).

    배포 후에도 "앱에 반드시 접근 가능"해야 한다: 잠든 앱은 태스크 0개라 규칙이 앱 TG 를 가리키면 503.
    sleep_app(force=True) 가 desiredCount=0 + forward→Waker TG(authenticate-cognito 보존)를 보장한다.
    RUNNING/WAKING 은 건드리지 않는다(WAKING 은 복원 Lambda 가 마무리).
    """
    app = get_app(app_id)
    if not app or app.get("status") != "ACTIVE":
        return {"reason": "not-active"}
    if app.get("runtimeState") != "SLEEPING":
        return {"reason": f"runtime-{app.get('runtimeState')}"}
    return sleep_app(app_id, force=True)


def _prune_secrets(stage_value: str, app_id: str) -> dict[str, Any]:
    """활성 태스크 정의가 참조하는 KEY 를 보존하며 시크릿 JSON 의 미사용 KEY 를 제거한다."""
    app = get_app(app_id)
    if not app or not app.get("secretArn"):
        return {"reason": "no-secret"}
    info = describe_app_task_definitions(cluster_name(), app_service_name(stage_value, app_id))
    if not info["found"]:
        # 서비스를 확인할 수 없으면 무엇이 참조 중인지 모른다 → 아무것도 지우지 않는다(안전 측).
        return {"reason": "service-not-found-skip"}
    referenced = referenced_secret_keys(info["taskDefinitions"], app["secretArn"])
    return prune_unreferenced_keys(app_id, referenced)


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


def _advance_app_status(
    app_id: str, deployment_status: str, failure_category: str | None
) -> str | None:
    """첫 배포 파이프라인 종결을 App.status 로 반영(A안). CREATING 일 때만 전이(조건부·멱등).

    - 배포 SUCCEEDED → CREATING→ACTIVE(+clear_failure, +runtimeState=RUNNING). 이미 ACTIVE(재배포)면 no-op.
    - 배포 FAILED    → CREATING→FAILED(+set_failure). 이미 ACTIVE 인 앱의 재배포 실패는 status 를
      건드리지 않는다(allowed_from=["CREATING"] 이 보장 — ACTIVE 유지).

    멱등: transition_status 는 조건부 쓰기라 조건 불충족(이미 다른 상태)이면 예외를 던진다 — 여기서
    삼켜 no-op 로 만든다. 같은 종결 이벤트가 여러 번 와도(재시도) 두 번째부터는 이미 전이돼 no-op.
    상태 부수효과(clear_failure/set_failure/runtimeState)는 전이가 실제로 성공한 경우에만 수행한다.

    반환: 실제로 전이가 일어났으면 새 status("ACTIVE"|"FAILED"), 아니면 None(로그·결과 표기용).
    """
    if deployment_status == "SUCCEEDED":
        try:
            transition_status(app_id, "ACTIVE", ["CREATING"])
        except Exception:  # noqa: BLE001 - CREATING 아니면(이미 ACTIVE 재배포 등) 조건 실패를 삼킴(멱등)
            return None
        # 첫 배포 성공 잔재(프로비저닝 재시도 실패 사유 등) 제거 + 태스크가 실제로 떴으니 RUNNING.
        #  Deploy 스테이지가 TG healthy 를 확인하고 SUCCEEDED 이므로 태스크는 기동+정상 상태다.
        #  wake-restore 는 첫 배포 중엔 status!=ACTIVE 라 runtimeState 를 못 올려 SLEEPING 에 갇힌다 —
        #  여기서 RUNNING 을 명시 기록해 always-on/on-demand 모두 화면·잠자기 판정을 정합화한다.
        clear_failure(app_id)
        try:
            set_runtime_state(app_id, "RUNNING")
        except Exception:  # noqa: BLE001 - runtimeState 기록 실패는 상태 전이를 막지 않음(멱등)
            pass
        return "ACTIVE"

    # deployment_status == "FAILED"
    try:
        transition_status(app_id, "FAILED", ["CREATING"])
    except Exception:  # noqa: BLE001 - CREATING 아니면(이미 ACTIVE 재배포 실패 등) 삼킴 → ACTIVE 유지
        return None
    reason = _FIRST_DEPLOY_FAILURE_REASON.get(failure_category or "", _FIRST_DEPLOY_FAILURE_FALLBACK)
    detail = f"첫 배포 실패 — 분류: {failure_category or '미상'}"
    set_failure(app_id, reason, detail)
    return "FAILED"


def handle_event(event: dict[str, Any]) -> dict[str, Any]:
    """EventBridge 이벤트를 detail-type 으로 분기해 처리."""
    stage_value = stage()
    detail_type = event.get("detail-type")
    detail = event.get("detail") or {}
    if detail_type == "CodePipeline Stage Execution State Change":
        return _handle_stage_event(detail, stage_value)
    if detail_type == "CodePipeline Pipeline Execution State Change":
        return _handle_pipeline_event(detail, stage_value)
    if detail_type == "CodeBuild Build State Change":
        return _handle_build_event(detail, stage_value)
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
