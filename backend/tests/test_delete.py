"""DeleteApp task 디스패처 테스트 (D-M5-05, DESIGN 3.6) — step 분기·정리·상태 전이."""

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
        secretArns={"DB": "arn:aws:secretsmanager:...:secret/db-AbC"},
    )
    reserve_subdomain("c1-app", "appc1abc")

    out = delete.handle({"step": "cleanup", "appId": "appc1abc"})
    assert out["cleaned"] is True
    # 시크릿 삭제(ARN 만) 호출.
    sm_call = p2_clients["secretsmanager"].calls_for("delete_secret")[0]
    assert sm_call["SecretId"] == "arn:aws:secretsmanager:...:secret/db-AbC"
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


def test_cleanup_without_secrets_or_alb(ddb_table, p2_clients, del_env) -> None:
    seed_app(ddb_table, "appc2abc", "user-1", status="DELETING", subdomain="c2-app", secretArns={})
    reserve_subdomain("c2-app", "appc2abc")
    out = delete.handle({"step": "cleanup", "appId": "appc2abc"})
    assert out["cleaned"] is True
    assert p2_clients["secretsmanager"].calls_for("delete_secret") == []
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
