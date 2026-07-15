"""L1 — [Notify] deploy-notify Lambda (DESIGN.md 3.3).

CodePipeline 상태변화 EventBridge 이벤트 → DDB Deployment 갱신:
 - 스테이지 STARTED 상태 전이(Source→PENDING, ValidateBuild→VALIDATING, Deploy→DEPLOYING)
 - 자동 push 배포 신규 생성(Source STARTED, 매칭 레코드 없음 → trigger=auto)
 - 파이프라인 종결(SUCCEEDED/FAILED) + failureCategory 3분기 조회
 - 역행 금지 멱등(종결 후 늦게 온 스테이지 이벤트 무시)
 - 다른 stage/패턴 파이프라인 스킵
"""

from __future__ import annotations

import pytest
from app.data.deployments import list_deployments, put_deployment
from app.orchestration import deploy_notify as dn

from .conftest import seed_app

STAGE = "test"
OWNER = "user-alice"
APP = "app00001"
PIPELINE = f"apphub-{STAGE}-app-{APP}"
EXEC = "exec-abc"


@pytest.fixture
def notify_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)


def _stage_event(stage_name: str, state: str, pipeline: str = PIPELINE, execution_id: str = EXEC) -> dict:
    return {
        "detail-type": "CodePipeline Stage Execution State Change",
        "source": "aws.codepipeline",
        "detail": {
            "pipeline": pipeline,
            "stage": stage_name,
            "state": state,
            "execution-id": execution_id,
        },
    }


def _pipeline_event(state: str, pipeline: str = PIPELINE, execution_id: str = EXEC) -> dict:
    return {
        "detail-type": "CodePipeline Pipeline Execution State Change",
        "source": "aws.codepipeline",
        "detail": {
            "pipeline": pipeline,
            "state": state,
            "execution-id": execution_id,
        },
    }


def _seed_manual_pending(ddb_table) -> None:
    """수동 배포 접수 레코드(pipelineExecutionId=EXEC, PENDING) 시드."""
    seed_app(ddb_table, APP, OWNER, status="ACTIVE")
    put_deployment(app_id=APP, trigger="manual", pipeline_execution_id=EXEC)


def _only(ddb_table) -> dict:
    deps = list_deployments(APP, 20)
    assert len(deps) == 1
    return deps[0]


# ── appId 파싱 ────────────────────────────────────────────────────────────────


def test_app_id_from_pipeline_ok() -> None:
    assert dn.app_id_from_pipeline(f"apphub-{STAGE}-app-def67890", STAGE) == "def67890"


def test_app_id_wrong_stage_none() -> None:
    assert dn.app_id_from_pipeline("apphub-prod-app-def67890", STAGE) is None


def test_app_id_wrong_pattern_none() -> None:
    assert dn.app_id_from_pipeline("some-other-pipeline", STAGE) is None


# ── 스테이지 STARTED 상태 전이(기존 레코드) ──────────────────────────────────


def test_validate_build_started_sets_validating(ddb_table, p2_clients, notify_env) -> None:
    _seed_manual_pending(ddb_table)
    res = dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    assert res["status"] == "VALIDATING"
    assert _only(ddb_table)["status"] == "VALIDATING"


def test_deploy_started_sets_deploying(ddb_table, p2_clients, notify_env) -> None:
    _seed_manual_pending(ddb_table)
    dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    res = dn.handle_event(_stage_event("Deploy", "STARTED"))
    assert res["status"] == "DEPLOYING"
    assert _only(ddb_table)["status"] == "DEPLOYING"


def test_source_started_keeps_pending(ddb_table, p2_clients, notify_env) -> None:
    """이미 PENDING 인 수동 배포에 Source STARTED — 같은 값이라 already-PENDING 스킵."""
    _seed_manual_pending(ddb_table)
    res = dn.handle_event(_stage_event("Source", "STARTED"))
    assert res["reason"] == "already-PENDING"
    assert _only(ddb_table)["status"] == "PENDING"


def test_stage_succeeded_skipped(ddb_table, p2_clients, notify_env) -> None:
    """스테이지 SUCCEEDED 는 배포 성공으로 오기록하지 않는다(파이프라인 이벤트 담당)."""
    _seed_manual_pending(ddb_table)
    res = dn.handle_event(_stage_event("ValidateBuild", "SUCCEEDED"))
    assert "skipped" in res["reason"]
    assert _only(ddb_table)["status"] == "PENDING"


# ── 자동 push 배포 신규 생성(매칭 레코드 없음) ───────────────────────────────


def test_auto_deploy_creates_record_on_source_started(ddb_table, p2_clients, notify_env) -> None:
    seed_app(ddb_table, APP, OWNER, status="ACTIVE")
    # 매칭 레코드 없음 + Source STARTED → get_pipeline_execution 으로 커밋 정보 채워 신규 생성.
    p2_clients["codepipeline"].set_response(
        "get_pipeline_execution",
        {
            "pipelineExecution": {
                "artifactRevisions": [
                    {"revisionId": "sha1234", "revisionSummary": "fix: 버그 수정"}
                ]
            }
        },
    )
    res = dn.handle_event(_stage_event("Source", "STARTED"))
    assert res["created"] is True
    dep = _only(ddb_table)
    assert dep["trigger"] == "auto"
    assert dep["status"] == "PENDING"
    assert dep["pipelineExecutionId"] == EXEC
    assert dep["commitSha"] == "sha1234"
    assert dep["commitMessage"] == "fix: 버그 수정"


def test_auto_deploy_creates_without_commit_info(ddb_table, p2_clients, notify_env) -> None:
    """get_pipeline_execution 이 커밋 정보를 못 줘도 레코드는 생성(부가정보 결측 허용)."""
    seed_app(ddb_table, APP, OWNER, status="ACTIVE")
    # codepipeline stub 기본 {} → artifactRevisions 없음.
    res = dn.handle_event(_stage_event("Source", "STARTED"))
    assert res["created"] is True
    dep = _only(ddb_table)
    assert dep["trigger"] == "auto"
    assert "commitSha" not in dep


def test_non_source_stage_without_record_skipped(ddb_table, p2_clients, notify_env) -> None:
    """레코드 없는데 Source 아닌 스테이지 STARTED — 신규 생성하지 않고 스킵."""
    seed_app(ddb_table, APP, OWNER, status="ACTIVE")
    res = dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    assert res["reason"] == "no-record-non-source-skipped"
    assert list_deployments(APP, 20) == []


# ── 파이프라인 종결 ──────────────────────────────────────────────────────────


def test_pipeline_succeeded_sets_succeeded(ddb_table, p2_clients, notify_env) -> None:
    _seed_manual_pending(ddb_table)
    dn.handle_event(_stage_event("Deploy", "STARTED"))
    res = dn.handle_event(_pipeline_event("SUCCEEDED"))
    assert res["status"] == "SUCCEEDED"
    assert _only(ddb_table)["status"] == "SUCCEEDED"


def test_pipeline_superseded_skipped_not_succeeded(ddb_table, p2_clients, notify_env) -> None:
    """SUPERSEDED 는 SUCCEEDED 로 오기록 금지 — 스킵(레코드는 진행 상태 유지)."""
    _seed_manual_pending(ddb_table)
    dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    res = dn.handle_event(_pipeline_event("SUPERSEDED"))
    assert "skipped" in res["reason"]
    assert _only(ddb_table)["status"] == "VALIDATING"


# ── failureCategory 3분기 ────────────────────────────────────────────────────


def test_failure_validate_build_reads_exported_category(ddb_table, p2_clients, notify_env) -> None:
    """(a) ValidateBuild 실패 → CodeBuild exported FAILURE_CATEGORY 를 읽는다."""
    _seed_manual_pending(ddb_table)
    p2_clients["codepipeline"].set_response(
        "list_action_executions",
        {
            "actionExecutionDetails": [
                {
                    "stageName": "ValidateBuild",
                    "status": "Failed",
                    "output": {"executionResult": {"externalExecutionId": "build-1"}},
                }
            ]
        },
    )
    p2_clients["codebuild"].set_response(
        "batch_get_builds",
        {
            "builds": [
                {
                    "exportedEnvironmentVariables": [
                        {"name": "FAILURE_CATEGORY", "value": "DOCKERFILE_INVALID"}
                    ]
                }
            ]
        },
    )
    res = dn.handle_event(_pipeline_event("FAILED"))
    assert res["status"] == "FAILED"
    assert res["failureCategory"] == "DOCKERFILE_INVALID"
    dep = _only(ddb_table)
    assert dep["status"] == "FAILED"
    assert dep["failureCategory"] == "DOCKERFILE_INVALID"


def test_failure_deploy_stage_deploy_failed(ddb_table, p2_clients, notify_env) -> None:
    """(b) Deploy 실패(ValidateBuild 성공) → DEPLOY_FAILED."""
    _seed_manual_pending(ddb_table)
    p2_clients["codepipeline"].set_response(
        "list_action_executions",
        {
            "actionExecutionDetails": [
                {"stageName": "ValidateBuild", "status": "Succeeded"},
                {"stageName": "Deploy", "status": "Failed"},
            ]
        },
    )
    res = dn.handle_event(_pipeline_event("FAILED"))
    assert res["failureCategory"] == "DEPLOY_FAILED"
    assert _only(ddb_table)["failureCategory"] == "DEPLOY_FAILED"


def test_failure_unknown_internal(ddb_table, p2_clients, notify_env) -> None:
    """(c) 실패 액션 조회 불가/미상 → INTERNAL_ERROR."""
    _seed_manual_pending(ddb_table)
    # list_action_executions stub 기본 {} → actionExecutionDetails 없음.
    res = dn.handle_event(_pipeline_event("FAILED"))
    assert res["failureCategory"] == "INTERNAL_ERROR"
    assert _only(ddb_table)["failureCategory"] == "INTERNAL_ERROR"


def test_failure_validate_no_exported_var_internal(ddb_table, p2_clients, notify_env) -> None:
    """ValidateBuild 실패지만 exported FAILURE_CATEGORY 를 못 읽으면 INTERNAL_ERROR."""
    _seed_manual_pending(ddb_table)
    p2_clients["codepipeline"].set_response(
        "list_action_executions",
        {
            "actionExecutionDetails": [
                {
                    "stageName": "ValidateBuild",
                    "status": "Failed",
                    "output": {"executionResult": {"externalExecutionId": "build-1"}},
                }
            ]
        },
    )
    # batch_get_builds 기본 {} → builds 없음.
    res = dn.handle_event(_pipeline_event("FAILED"))
    assert res["failureCategory"] == "INTERNAL_ERROR"


def test_pipeline_canceled_maps_failed(ddb_table, p2_clients, notify_env) -> None:
    _seed_manual_pending(ddb_table)
    res = dn.handle_event(_pipeline_event("CANCELED"))
    assert res["status"] == "FAILED"


# ── 역행 금지 멱등 ───────────────────────────────────────────────────────────


def test_terminal_succeeded_preserved_against_late_stage(ddb_table, p2_clients, notify_env) -> None:
    """SUCCEEDED 후 늦게 온 스테이지 STARTED 이벤트는 무시(종결 보존)."""
    _seed_manual_pending(ddb_table)
    dn.handle_event(_stage_event("Deploy", "STARTED"))
    dn.handle_event(_pipeline_event("SUCCEEDED"))
    assert _only(ddb_table)["status"] == "SUCCEEDED"
    res = dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    assert "terminal-SUCCEEDED-preserved" in res["reason"]
    assert _only(ddb_table)["status"] == "SUCCEEDED"


def test_terminal_failed_preserved(ddb_table, p2_clients, notify_env) -> None:
    """FAILED 후 늦게 온 스테이지/파이프라인 이벤트는 무시."""
    _seed_manual_pending(ddb_table)
    dn.handle_event(_pipeline_event("FAILED"))
    assert _only(ddb_table)["status"] == "FAILED"
    res = dn.handle_event(_stage_event("Deploy", "STARTED"))
    assert "terminal-FAILED-preserved" in res["reason"]


def test_no_regress_deploying_to_validating(ddb_table, p2_clients, notify_env) -> None:
    """DEPLOYING 도달 후 늦게 온 VALIDATING(ValidateBuild STARTED) 은 후퇴 금지."""
    _seed_manual_pending(ddb_table)
    dn.handle_event(_stage_event("Deploy", "STARTED"))
    assert _only(ddb_table)["status"] == "DEPLOYING"
    res = dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    assert "no-regress" in res["reason"]
    assert _only(ddb_table)["status"] == "DEPLOYING"


# ── 다른 stage/패턴 파이프라인 스킵 ──────────────────────────────────────────


def test_other_stage_pipeline_skipped(ddb_table, p2_clients, notify_env) -> None:
    res = dn.handle_event(_stage_event("Source", "STARTED", pipeline="apphub-prod-app-app00001"))
    assert res["reason"] == "pipeline-not-matched"
    assert list_deployments(APP, 20) == []


def test_non_pipeline_detail_type_ignored(ddb_table, p2_clients, notify_env) -> None:
    res = dn.handle_event({"detail-type": "Some Other Event", "detail": {}})
    assert "ignored" in res["reason"]


def test_handle_wraps_and_logs(ddb_table, p2_clients, notify_env) -> None:
    """진입점 handle 이 결과를 그대로 반환(로그 후)."""
    _seed_manual_pending(ddb_table)
    res = dn.handle(_stage_event("ValidateBuild", "STARTED"))
    assert res["status"] == "VALIDATING"
