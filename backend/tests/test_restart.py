"""L1 — 앱 재시작 (POST /apps/{id}/restart).

재시작 = 같은 이미지·설정으로 컨테이너만 새로 기동(ecs.update_service forceNewDeployment=True).
파이프라인 재실행(배포)과 구분 — 재빌드 없음, Deployment 이력 레코드 생성 안 함.

검증 대상:
 - 정상 재시작: update_service 가 CLUSTER_NAME env + 이름 규약 service + forceNewDeployment=True 로 호출.
 - Deployment 레코드 미생성(배포 이력 아님).
 - 비ACTIVE → 409 INVALID_STATE.
 - SLEEPING → 409 INVALID_STATE(잠자는 앱은 자동 기동 안내).
 - 비소유자 → 403.
 - ECS ClientError → 사용자용 친절 에러(500 아님).
"""

from __future__ import annotations

import pytest
from app.data.deployments import list_deployments
from app.handler import handler
from botocore.exceptions import ClientError

from .conftest import make_event, parse_result, seed_app

OWNER = "user-alice"
OTHER = "user-bob"
ADMIN = "user-admin"
STAGE = "test"


def test_restart_forces_new_deployment(ddb_table, p2_clients) -> None:
    seed_app(ddb_table, "rst00001", OWNER, status="ACTIVE", runtimeState="RUNNING")
    res = handler(make_event("POST", "/apps/rst00001/restart", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["appId"] == "rst00001"
    assert "다시 시작" in out["data"]["note"]
    # update_service: 공유 클러스터명(CLUSTER_NAME env) + 이름 규약 service + forceNewDeployment.
    calls = p2_clients["ecs"].calls_for("update_service")
    assert len(calls) == 1
    assert calls[0]["cluster"] == "apphub-test-cluster"
    assert calls[0]["service"] == "apphub-test-app-rst00001"
    assert calls[0]["forceNewDeployment"] is True
    # desiredCount 는 건드리지 않는다(재시작은 스케일 변경이 아님).
    assert "desiredCount" not in calls[0]


def test_restart_does_not_create_deployment_record(ddb_table, p2_clients) -> None:
    """재시작은 배포 이력이 아니다 — Deployment 레코드를 만들지 않는다."""
    seed_app(ddb_table, "rst00002", OWNER, status="ACTIVE", runtimeState="RUNNING")
    handler(make_event("POST", "/apps/rst00002/restart", user_id=OWNER, groups=["user"]))
    assert list_deployments("rst00002", 20) == []


def test_restart_admin_can_restart_other_app(ddb_table, p2_clients) -> None:
    """admin 은 타인 앱도 재시작 가능(deploy 와 동일한 소유자/admin 인가)."""
    seed_app(ddb_table, "rst00003", OWNER, status="ACTIVE", runtimeState="RUNNING")
    res = handler(make_event("POST", "/apps/rst00003/restart", user_id=ADMIN, groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert p2_clients["ecs"].calls_for("update_service")[0]["service"] == "apphub-test-app-rst00003"


def test_restart_non_active_invalid_state(ddb_table, p2_clients) -> None:
    seed_app(ddb_table, "rst00004", OWNER, status="CREATING")
    res = handler(make_event("POST", "/apps/rst00004/restart", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"
    # 전제조건 불충족이면 ECS 미호출.
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_restart_sleeping_invalid_state(ddb_table, p2_clients) -> None:
    """잠자는 앱은 desiredCount=0 이라 forceNewDeployment 무의미 → 409 + 자동 기동 안내."""
    seed_app(ddb_table, "rst00005", OWNER, status="ACTIVE", runtimeState="SLEEPING")
    res = handler(make_event("POST", "/apps/rst00005/restart", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"
    assert "잠자는" in out["error"]["message"]
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_restart_other_owner_forbidden(ddb_table, p2_clients) -> None:
    seed_app(ddb_table, "rst00006", OWNER, status="ACTIVE", runtimeState="RUNNING")
    res = handler(make_event("POST", "/apps/rst00006/restart", user_id=OTHER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 403
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_restart_missing_app_404(ddb_table, p2_clients) -> None:
    res = handler(make_event("POST", "/apps/nope0001/restart", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["error"]["code"] == "NOT_FOUND"


def test_restart_ecs_error_friendly(ddb_table, p2_clients) -> None:
    """ECS ClientError 는 스택 트레이스/500 노출 없이 사용자용 한국어 친절 에러로 변환."""
    seed_app(ddb_table, "rst00007", OWNER, status="ACTIVE", runtimeState="RUNNING")
    p2_clients["ecs"].set_raise(
        "update_service",
        ClientError(
            {"Error": {"Code": "ServiceNotFoundException", "Message": "service not found"}},
            "UpdateService",
        ),
    )
    res = handler(make_event("POST", "/apps/rst00007/restart", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"
    # 내부 예외 메시지가 사용자 응답으로 새지 않는다.
    assert "service not found" not in out["error"]["message"]
    assert "다시 시작할 수 없어요" in out["error"]["message"]
