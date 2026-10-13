"""DeleteApp task 디스패처 테스트 (D-M5-05) — step 분기·정리·상태 전이."""

from __future__ import annotations

import pytest
from app.data import alb_registry as reg
from app.data.apps import get_app
from app.data.config_repo import list_alb_registry
from app.data.subdomains import app_id_for_subdomain, reserve_subdomain
from app.orchestration import delete
from botocore.exceptions import ClientError

from .conftest import seed_app

STAGE = "test"
ALB_ARN = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/internal/x"


@pytest.fixture
def del_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)


def _cfn_error(code: str, message: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, "DescribeStacks")


def test_unknown_step_raises(ddb_table, del_env) -> None:
    with pytest.raises(RuntimeError, match="알 수 없는 DeleteApp step"):
        delete.handle({"step": "nope", "appId": "a1"})


def test_delete_runtime_calls_delete_stack(ddb_table, p2_clients, del_env) -> None:
    out = delete.handle({"step": "delete-runtime", "appId": "appd1"})
    assert out["step"] == "delete-runtime"
    call = p2_clients["cloudformation"].calls_for("delete_stack")[0]
    assert call["StackName"] == "apphub-test-app-appd1-runtime"


def test_delete_pipeline_calls_delete_stack(ddb_table, p2_clients, del_env) -> None:
    delete.handle({"step": "delete-pipeline", "appId": "appd1"})
    call = p2_clients["cloudformation"].calls_for("delete_stack")[0]
    assert call["StackName"] == "apphub-test-app-appd1-pipeline"


def test_poll_runtime_in_progress(ddb_table, p2_clients, del_env) -> None:
    p2_clients["cloudformation"].set_response(
        "describe_stacks", {"Stacks": [{"StackStatus": "DELETE_IN_PROGRESS"}]}
    )
    out = delete.handle({"step": "poll-runtime", "appId": "appd1"})
    assert out["stackDeleteState"] == "DELETE_IN_PROGRESS"


def test_poll_runtime_complete(ddb_table, p2_clients, del_env) -> None:
    p2_clients["cloudformation"].set_response(
        "describe_stacks", {"Stacks": [{"StackStatus": "DELETE_COMPLETE"}]}
    )
    out = delete.handle({"step": "poll-runtime", "appId": "appd1"})
    assert out["stackDeleteState"] == "DELETE_COMPLETE"


def test_poll_runtime_missing_stack_is_complete(ddb_table, p2_clients, del_env) -> None:
    # 스택이 이미 없음 → ValidationError → DELETE_COMPLETE(멱등).
    p2_clients["cloudformation"].set_raise(
        "describe_stacks", _cfn_error("ValidationError", "Stack ... does not exist")
    )
    out = delete.handle({"step": "poll-runtime", "appId": "appd1"})
    assert out["stackDeleteState"] == "DELETE_COMPLETE"


def test_poll_runtime_failed_raises(ddb_table, p2_clients, del_env) -> None:
    p2_clients["cloudformation"].set_response(
        "describe_stacks", {"Stacks": [{"StackStatus": "DELETE_FAILED"}]}
    )
    with pytest.raises(RuntimeError, match="runtime 스택 삭제 실패"):
        delete.handle({"step": "poll-runtime", "appId": "appd1"})


def test_poll_pipeline_failed_raises(ddb_table, p2_clients, del_env) -> None:
    p2_clients["cloudformation"].set_response(
        "describe_stacks", {"Stacks": [{"StackStatus": "DELETE_FAILED"}]}
    )
    with pytest.raises(RuntimeError, match="pipeline 스택 삭제 실패"):
        delete.handle({"step": "poll-pipeline", "appId": "appd1"})


def test_cleanup_deletes_secrets_decrements_alb_releases_subdomain_removes_app(
    ddb_table, p2_clients, del_env
) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    reg.increment_alb_rule_count(ALB_ARN)  # ruleCount=1
    seed_app(
        ddb_table,
        "appc1abc",
        "user-1",
        status="DELETING",
        subdomain="c1-app",
        albArn=ALB_ARN,
        secretArn="arn:aws:secretsmanager:...:secret:apphub/test/app/appc1abc-AbC",
        secretKeys=["DB"],
    )
    reserve_subdomain("c1-app", "appc1abc")

    out = delete.handle({"step": "cleanup", "appId": "appc1abc"})
    assert out["cleaned"] is True
    # 앱당 시크릿 1개(D8)를 ARN 으로 즉시 삭제.
    sm_calls = p2_clients["secretsmanager"].calls_for("delete_secret")
    assert len(sm_calls) == 1
    sm_call = sm_calls[0]
    assert sm_call["SecretId"] == "arn:aws:secretsmanager:...:secret:apphub/test/app/appc1abc-AbC"
    assert sm_call["ForceDeleteWithoutRecovery"] is True
    # ALB ruleCount 감소.
    items = [i for i in list_alb_registry() if i.get("albArn") == ALB_ARN]
    assert items[0]["ruleCount"] == 0
    # 서브도메인 예약 해제.
    assert app_id_for_subdomain("c1-app") is None
    # App 레코드 정리.
    assert get_app("appc1abc") is None


def test_cleanup_missing_app_is_noop(ddb_table, p2_clients, del_env) -> None:
    out = delete.handle({"step": "cleanup", "appId": "ghost"})
    assert out["cleaned"] is True
    assert p2_clients["secretsmanager"].calls_for("delete_secret") == []


def test_cleanup_without_secret_arn_deletes_by_name_idempotent(ddb_table, p2_clients, del_env) -> None:
    """secretArn 이 없으면 이름 규약으로 ForceDelete(고아 정리). 없으면 ResourceNotFound → 멱등 통과."""
    from botocore.exceptions import ClientError

    seed_app(ddb_table, "appc2abc", "user-1", status="DELETING", subdomain="c2-app")
    reserve_subdomain("c2-app", "appc2abc")
    p2_clients["secretsmanager"].set_raise(
        "delete_secret",
        ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "DeleteSecret"),
    )
    out = delete.handle({"step": "cleanup", "appId": "appc2abc"})
    assert out["cleaned"] is True
    calls = p2_clients["secretsmanager"].calls_for("delete_secret")
    assert [c["SecretId"] for c in calls] == ["apphub/test/app/appc2abc"]
    assert calls[0]["ForceDeleteWithoutRecovery"] is True
    assert get_app("appc2abc") is None


def test_finalize_success_returns_deleted(ddb_table, p2_clients, del_env) -> None:
    out = delete.handle({"step": "finalize", "appId": "appf1"})
    assert out["status"] == "DELETED"


def test_finalize_failure_transitions_deleting_to_failed(ddb_table, p2_clients, del_env) -> None:
    seed_app(ddb_table, "appf2abc", "user-1", status="DELETING")
    out = delete.handle({"step": "finalize", "appId": "appf2abc", "outcome": "failure"})
    assert out["status"] == "FAILED"
    assert get_app("appf2abc")["status"] == "FAILED"


def test_finalize_failure_idempotent_when_record_gone(ddb_table, p2_clients, del_env) -> None:
    # cleanup 이 이미 레코드를 지운 뒤 실패 finalize → 전이 조건 실패 삼킴(예외 없음).
    out = delete.handle({"step": "finalize", "appId": "gone", "outcome": "failure"})
    assert out["status"] == "FAILED"


def test_finalize_failure_stores_delete_reason(ddb_table, p2_clients, del_env) -> None:
    # 삭제 계열 실패 → "앱 정리 중 문제" 요약 + 단계 상세 저장.
    seed_app(ddb_table, "appf3abc", "user-1", status="DELETING")
    delete.handle(
        {
            "step": "finalize",
            "appId": "appf3abc",
            "outcome": "failure",
            "failedStep": "poll-runtime",
            "error": "DELETE_FAILED",
        }
    )
    app = get_app("appf3abc")
    assert app["status"] == "FAILED"
    assert app["failureReason"] == "앱 정리 중 문제가 발생했어요. 다시 시도하거나 관리자에게 문의해주세요."
    assert "poll-runtime" in app["failureDetail"]


def test_finalize_failure_without_step_uses_delete_fallback(ddb_table, p2_clients, del_env) -> None:
    seed_app(ddb_table, "appf4abc", "user-1", status="DELETING")
    delete.handle({"step": "finalize", "appId": "appf4abc", "outcome": "failure"})
    assert get_app("appf4abc")["failureReason"].startswith("앱 정리 중 문제가 발생했어요.")
