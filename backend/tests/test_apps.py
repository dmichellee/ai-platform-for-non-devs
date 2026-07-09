"""L1 — 앱 CRUD: 생성 검증(쿼터/프리셋/서브도메인/provider/internet-facing), 인가 경계, 상태 전이."""

from __future__ import annotations

from app.handler import handler

from .conftest import (
    make_event,
    parse_result,
    seed_app,
    seed_perm,
    seed_preset,
    seed_settings,
)

OWNER = "user-alice"
OTHER = "user-bob"

VALID_CREATE = {
    "name": "My App",
    "subdomain": "my-app",
    "provider": "codecommit",
    "repoUrl": "https://git.example.com/my-app",
    "branch": "main",
    "presetId": "small",
    "permissionTemplateId": "basic",
    "scheme": "internal",
    "vpcId": "vpc-123",
    "autoDeployEnabled": True,
    "sleepMode": "on-demand",
    "envVars": {},
}


def _healthy_config(table) -> None:
    seed_settings(table)
    seed_preset(table)
    seed_perm(table)


# ── POST /apps — 앱 생성 ─────────────────────────────────────────────────────


def test_create_ok(ddb_table, stub_clients):
    _healthy_config(ddb_table)
    res = handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=VALID_CREATE))
    out = parse_result(res)
    assert out["status"] == 201
    data = out["data"]
    assert data["status"] == "CREATING"
    assert data["ownerId"] == OWNER
    assert len(data["appId"]) == 8 and data["appId"].isalnum()
    # SFN start_execution 1회 호출
    assert len(stub_clients["stepfunctions"].calls_for("start_execution")) == 1


def test_create_quota_exceeded(ddb_table, stub_clients):
    _healthy_config(ddb_table)
    # quota=3 → 3개 시드
    for i in range(3):
        seed_app(ddb_table, f"app0000{i}", OWNER, subdomain=f"sub{i}")
    res = handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=VALID_CREATE))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "QUOTA_EXCEEDED"
    # 쿼터 초과면 SFN start 안 함
    assert len(stub_clients["stepfunctions"].calls_for("start_execution")) == 0


def test_create_preset_not_found(ddb_table, stub_clients):
    seed_settings(ddb_table, enabledProviders=["codecommit"])
    # preset 미시드
    res = handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=VALID_CREATE))
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "PRESET_NOT_FOUND"


def test_create_reserved_subdomain_invalid(ddb_table, stub_clients):
    res = handler(
        make_event(
            "POST",
            "/apps",
            user_id=OWNER,
            groups=["user"],
            body={**VALID_CREATE, "subdomain": "admin"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "SUBDOMAIN_INVALID"


def test_create_uppercase_subdomain_invalid(ddb_table, stub_clients):
    res = handler(
        make_event(
            "POST",
            "/apps",
            user_id=OWNER,
            groups=["user"],
            body={**VALID_CREATE, "subdomain": "MyApp"},
        )
    )
    assert parse_result(res)["error"]["code"] == "SUBDOMAIN_INVALID"


def test_create_subdomain_taken(ddb_table, stub_clients):
    _healthy_config(ddb_table)
    # 다른 앱이 이미 "my-app" 예약
    ddb_table.put_item(
        Item={
            "PK": "SUBDOMAIN#my-app",
            "SK": "RESERVATION",
            "entityType": "SubdomainReservation",
            "subdomain": "my-app",
            "appId": "otherapp",
            "createdAt": "2026-01-01T00:00:00.000Z",
        }
    )
    res = handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=VALID_CREATE))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "SUBDOMAIN_TAKEN"
    assert len(stub_clients["stepfunctions"].calls_for("start_execution")) == 0


def test_create_internet_facing_not_allowed(ddb_table, stub_clients):
    seed_settings(ddb_table, allowInternetFacing=False)
    seed_preset(ddb_table)
    seed_perm(ddb_table)
    res = handler(
        make_event(
            "POST",
            "/apps",
            user_id=OWNER,
            groups=["user"],
            body={**VALID_CREATE, "scheme": "internet-facing"},
        )
    )
    assert parse_result(res)["error"]["code"] == "INTERNET_FACING_NOT_ALLOWED"


def test_create_provider_disabled(ddb_table, stub_clients):
    seed_settings(ddb_table, enabledProviders=["github"])  # codecommit 비활성
    res = handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=VALID_CREATE))
    assert parse_result(res)["error"]["code"] == "PROVIDER_DISABLED"


def test_create_vpc_not_registered(ddb_table, stub_clients):
    seed_settings(ddb_table, registeredVpcs=[{"vpcId": "vpc-other", "label": "x"}])
    res = handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=VALID_CREATE))
    assert parse_result(res)["error"]["code"] == "VPC_NOT_REGISTERED"


# ── GET /apps/{id} — 소유자 인가 ─────────────────────────────────────────────


def test_get_owner_200(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER)
    res = handler(make_event("GET", "/apps/app00001", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["appId"] == "app00001"


def test_get_other_forbidden(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER)
    res = handler(make_event("GET", "/apps/app00001", user_id=OTHER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 403
    assert out["error"]["code"] == "FORBIDDEN"


def test_get_admin_sees_other(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER)
    res = handler(make_event("GET", "/apps/app00001", user_id="admin-1", groups=["admin"]))
    assert parse_result(res)["status"] == 200


def test_get_missing_404(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps/none", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 404


# ── DELETE /apps/{id} — 상태 전이 ────────────────────────────────────────────


def test_delete_active_to_deleting(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="ACTIVE")
    res = handler(make_event("DELETE", "/apps/app00001", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["status"] == "DELETING"
    assert len(stub_clients["stepfunctions"].calls_for("start_execution")) == 1
    # DDB 상태가 DELETING 으로 전이됐는지 확인
    item = ddb_table.get_item(Key={"PK": "APP#app00001", "SK": "META"})["Item"]
    assert item["status"] == "DELETING"


def test_delete_creating_invalid_state(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="CREATING")
    res = handler(make_event("DELETE", "/apps/app00001", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"
    assert len(stub_clients["stepfunctions"].calls_for("start_execution")) == 0


def test_delete_already_deleting_idempotent(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="DELETING")
    res = handler(make_event("DELETE", "/apps/app00001", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 200
    assert len(stub_clients["stepfunctions"].calls_for("start_execution")) == 0


def test_delete_other_forbidden(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, status="ACTIVE")
    res = handler(make_event("DELETE", "/apps/app00001", user_id=OTHER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_delete_failed_to_deleting(ddb_table, stub_clients):
    # FAILED → DELETING 도 허용(상태 기계, D-M5-05).
    seed_app(ddb_table, "app00001", OWNER, status="FAILED")
    res = handler(make_event("DELETE", "/apps/app00001", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["status"] == "DELETING"


# ── PATCH /apps/{id} — 설정 변경 ─────────────────────────────────────────────


def test_patch_deleting_invalid_state(ddb_table, stub_clients):
    seed_app(ddb_table, "a", OWNER, status="DELETING")
    res = handler(
        make_event(
            "PATCH", "/apps/a", user_id=OWNER, groups=["user"], body={"autoDeployEnabled": False}
        )
    )
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"


def test_patch_ok(ddb_table, stub_clients):
    seed_app(ddb_table, "a", OWNER, status="ACTIVE")
    res = handler(
        make_event(
            "PATCH", "/apps/a", user_id=OWNER, groups=["user"], body={"autoDeployEnabled": False}
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["autoDeployEnabled"] is False


# ── GET /apps — 본인 목록만 ──────────────────────────────────────────────────


def test_list_only_own_apps(ddb_table, stub_clients):
    seed_app(ddb_table, "app00001", OWNER, subdomain="a1")
    seed_app(ddb_table, "app00002", OTHER, subdomain="a2")
    res = handler(make_event("GET", "/apps", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    items = out["data"]["items"]
    assert len(items) == 1
    assert items[0]["appId"] == "app00001"
    # 내부 키(PK/SK/entityType)는 응답에서 제거
    assert "PK" not in items[0]
    assert "entityType" not in items[0]
