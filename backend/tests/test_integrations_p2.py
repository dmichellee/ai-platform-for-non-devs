"""P2 integrations 저수준 테스트 — ssm 캐시, codebuild 정규화, cfn 상태, secrets 멱등."""

from __future__ import annotations

import pytest
from app.integrations import clients as integ_clients
from app.integrations import ssm as ssm_module
from app.integrations.cloudformation import get_stack_delete_state
from app.integrations.codebuild import get_build_status, start_provisioner_build
from app.integrations.secrets import delete_secret, delete_secrets
from botocore.exceptions import ClientError

from .conftest import SsmStub

STAGE = "test"


# ── ssm ──────────────────────────────────────────────────────────────────────


def test_ssm_get_param_caches(p2_clients) -> None:
    stub = SsmStub({"/a/b/c": "v1"})
    integ_clients.set_client("ssm", stub)
    ssm_module.reset_cache()
    assert ssm_module.get_param("/a/b/c") == "v1"
    assert ssm_module.get_param("/a/b/c") == "v1"
    # 캐시 히트 → get_parameter 는 1회만.
    assert len(stub.calls) == 1


def test_ssm_scheme_helpers(p2_clients) -> None:
    stub = SsmStub(
        {
            f"/apphub/{STAGE}/network/internal-alb-arn": "alb-int",
            f"/apphub/{STAGE}/network/internet-alb-arn": "alb-net",
            f"/apphub/{STAGE}/network/internal-https-listener-arn": "lst-int",
            f"/apphub/{STAGE}/network/internet-https-listener-arn": "lst-net",
        }
    )
    integ_clients.set_client("ssm", stub)
    ssm_module.reset_cache()
    assert ssm_module.alb_arn_for_scheme(STAGE, "internal") == "alb-int"
    assert ssm_module.alb_arn_for_scheme(STAGE, "internet-facing") == "alb-net"
    assert ssm_module.listener_arn_for_scheme(STAGE, "internal") == "lst-int"
    assert ssm_module.listener_arn_for_scheme(STAGE, "internet-facing") == "lst-net"


# ── codebuild ────────────────────────────────────────────────────────────────


def test_start_provisioner_build_returns_id(p2_clients) -> None:
    p2_clients["codebuild"].set_response("start_build", {"build": {"id": "bx"}})
    assert start_provisioner_build("proj", {"K": "V"}) == "bx"
    call = p2_clients["codebuild"].calls_for("start_build")[0]
    assert call["environmentVariablesOverride"] == [{"name": "K", "value": "V", "type": "PLAINTEXT"}]


def test_start_provisioner_build_missing_id_raises(p2_clients) -> None:
    p2_clients["codebuild"].set_response("start_build", {"build": {}})
    with pytest.raises(RuntimeError, match="build id 없음"):
        start_provisioner_build("proj", {})


def test_get_build_status_normalizes(p2_clients) -> None:
    cb = p2_clients["codebuild"]
    cb.set_response("batch_get_builds", {"builds": [{"buildStatus": "SUCCEEDED"}]})
    assert get_build_status("b") == "SUCCEEDED"
    cb.set_response("batch_get_builds", {"builds": [{"buildStatus": "IN_PROGRESS"}]})
    assert get_build_status("b") == "IN_PROGRESS"
    cb.set_response("batch_get_builds", {"builds": [{"buildStatus": "FAULT"}]})
    assert get_build_status("b") == "FAILED"
    cb.set_response("batch_get_builds", {"builds": []})
    assert get_build_status("b") == "IN_PROGRESS"


# ── cloudformation ───────────────────────────────────────────────────────────


def test_get_stack_delete_state_missing_stack_is_complete(p2_clients) -> None:
    p2_clients["cloudformation"].set_raise(
        "describe_stacks",
        ClientError({"Error": {"Code": "ValidationError", "Message": "does not exist"}}, "op"),
    )
    assert get_stack_delete_state("apphub-test-app-x-runtime") == "DELETE_COMPLETE"


def test_get_stack_delete_state_reraises_other_errors(p2_clients) -> None:
    p2_clients["cloudformation"].set_raise(
        "describe_stacks",
        ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "op"),
    )
    with pytest.raises(ClientError):
        get_stack_delete_state("apphub-test-app-x-runtime")


# ── secrets ──────────────────────────────────────────────────────────────────


def test_delete_secret_swallows_not_found(p2_clients) -> None:
    p2_clients["secretsmanager"].set_raise(
        "delete_secret",
        ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "gone"}}, "op"),
    )
    delete_secret("arn:missing")  # 예외 없음


def test_delete_secret_reraises_other(p2_clients) -> None:
    p2_clients["secretsmanager"].set_raise(
        "delete_secret",
        ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "op"),
    )
    with pytest.raises(ClientError):
        delete_secret("arn:x")


def test_delete_secrets_iterates(p2_clients) -> None:
    delete_secrets(["arn:1", "arn:2"])
    calls = p2_clients["secretsmanager"].calls_for("delete_secret")
    assert [c["SecretId"] for c in calls] == ["arn:1", "arn:2"]
    assert all(c["ForceDeleteWithoutRecovery"] is True for c in calls)
