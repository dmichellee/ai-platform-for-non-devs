"""L1 — 레포 연결 + 배포: provider 검증, 배포 접수/상태전이, 이력 내부키 제거."""

from __future__ import annotations

from app.handler import handler
from app.integrations import clients as integ_clients

from .conftest import StubClient, make_event, parse_result, seed_app, seed_settings

OWNER = "user-alice"
OTHER = "user-bob"


def _stub_codepipeline() -> StubClient:
    """수동 배포가 사용하는 codepipeline StartPipelineExecution stub 주입."""
    stub = StubClient()
    stub.set_response("start_pipeline_execution", {"pipelineExecutionId": "exec-1"})
    integ_clients.set_client("codepipeline", stub)
    return stub


# ── 레포 연결 ────────────────────────────────────────────────────────────────


def test_codecommit_connection_immediate_available(ddb_table, stub_clients):
    seed_settings(ddb_table, enabledProviders=["codecommit"])
    res = handler(
        make_event(
            "POST",
            "/connections",
            user_id=OWNER,
            groups=["user"],
            body={"provider": "codecommit", "displayName": "내 저장소"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["status"] == "AVAILABLE"
    assert out["data"]["needsAuthorization"] is False


def test_disabled_provider_connection(ddb_table, stub_clients):
    seed_settings(ddb_table, enabledProviders=["codecommit"])
    res = handler(
        make_event(
            "POST",
            "/connections",
            user_id=OWNER,
            groups=["user"],
            body={"provider": "github", "displayName": "gh"},
        )
    )
    assert parse_result(res)["error"]["code"] == "PROVIDER_DISABLED"


def test_github_connection_pending(ddb_table, stub_clients):
    seed_settings(ddb_table, enabledProviders=["codecommit", "github"])
    stub_clients["codeconnections"].set_response(
        "create_connection",
        {"ConnectionArn": "arn:aws:codeconnections:...:connection/abc"},
    )
    res = handler(
        make_event(
            "POST",
            "/connections",
            user_id=OWNER,
            groups=["user"],
            body={"provider": "github", "displayName": "gh"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["status"] == "PENDING"
    assert out["data"]["needsAuthorization"] is True


def test_delete_connection_204(ddb_table, stub_clients):
    ddb_table.put_item(
        Item={
            "PK": f"USER#{OWNER}",
            "SK": "CONN#c1",
            "entityType": "RepoConnection",
            "connId": "c1",
            "ownerId": OWNER,
            "provider": "codecommit",
            "connectionArn": "codecommit:c1",
            "status": "AVAILABLE",
            "displayName": "x",
            "createdAt": "x",
            "updatedAt": "x",
        }
    )
    res = handler(make_event("DELETE", "/connections/c1", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 204


# ── 배포 ──────────────────────────────────────────────────────────────────────


def test_deploy_active_201(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="ACTIVE")
    pipe = _stub_codepipeline()
    res = handler(make_event("POST", "/apps/app00001/deploy", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["trigger"] == "manual"
    assert out["data"]["status"] == "PENDING"
    # 실제 파이프라인 실행 트리거 + 실행 식별자 기록.
    starts = pipe.calls_for("start_pipeline_execution")
    assert len(starts) == 1
    assert starts[0]["name"] == "apphub-test-app-app00001"
    assert out["data"]["pipelineExecutionId"] == "exec-1"


def test_deploy_creating_invalid_state(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="CREATING")
    res = handler(make_event("POST", "/apps/app00001/deploy", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"


def test_deploy_other_forbidden(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="ACTIVE")
    res = handler(make_event("POST", "/apps/app00001/deploy", user_id=OTHER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_list_deployments_strips_internal_keys(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="ACTIVE")
    ddb_table.put_item(
        Item={
            "PK": "APP#app00001",
            "SK": "DEPLOY#2026-01-01",
            "entityType": "Deployment",
            "ttl": 1,
            "appId": "app00001",
            "deploymentId": "2026-01-01",
            "trigger": "manual",
            "status": "SUCCEEDED",
            "createdAt": "2026-01-01",
            "updatedAt": "2026-01-01",
        }
    )
    res = handler(make_event("GET", "/apps/app00001/deployments", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    items = out["data"]["items"]
    assert len(items) == 1
    assert items[0]["status"] == "SUCCEEDED"
    # 내부 키(ttl/PK/SK/entityType)는 응답에서 제거
    assert "ttl" not in items[0]
    assert "PK" not in items[0]
    assert "entityType" not in items[0]
