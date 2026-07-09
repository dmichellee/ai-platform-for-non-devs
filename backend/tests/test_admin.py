"""L1 — 관리자 CONFIG: 인가 경계(user 403), 프리셋 Fargate 검증, 설정 저장."""

from __future__ import annotations

from app.handler import handler

from .conftest import make_event, parse_result

# ── 인가 경계 ────────────────────────────────────────────────────────────────


def test_user_get_settings_forbidden(ddb_table, stub_clients):
    res = handler(make_event("GET", "/admin/settings", user_id="u1", groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 403
    assert out["error"]["code"] == "FORBIDDEN"


def test_user_put_settings_forbidden_no_write(ddb_table, stub_clients):
    res = handler(
        make_event(
            "PUT",
            "/admin/settings",
            user_id="u1",
            groups=["user"],
            body={
                "enabledProviders": ["codecommit"],
                "registeredVpcs": [],
                "userAppQuota": 5,
                "allowInternetFacing": True,
                "allowedBaseImages": [],
            },
        )
    )
    assert parse_result(res)["status"] == 403
    # 쓰기 미발생 확인
    got = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "SETTINGS"})
    assert "Item" not in got


def test_user_admin_apps_forbidden(ddb_table, stub_clients):
    res = handler(make_event("GET", "/admin/apps", user_id="u1", groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_user_create_preset_forbidden(ddb_table, stub_clients):
    res = handler(
        make_event(
            "POST",
            "/admin/presets",
            user_id="u1",
            groups=["user"],
            body={
                "displayName": "작게",
                "cpu": 256,
                "memory": 512,
                "minCount": 1,
                "maxCount": 2,
                "scaleMetric": "cpu",
                "scaleThreshold": 70,
            },
        )
    )
    assert parse_result(res)["status"] == 403


def test_admin_get_settings_default(ddb_table, stub_clients):
    res = handler(make_event("GET", "/admin/settings", user_id="a1", groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["userAppQuota"] == 5  # DEFAULT


# ── 프리셋 검증(Fargate 유효 조합) ───────────────────────────────────────────


def test_admin_create_valid_preset(ddb_table, stub_clients):
    res = handler(
        make_event(
            "POST",
            "/admin/presets",
            user_id="a1",
            groups=["admin"],
            body={
                "displayName": "보통",
                "cpu": 512,
                "memory": 1024,
                "minCount": 1,
                "maxCount": 3,
                "scaleMetric": "cpu",
                "scaleThreshold": 70,
            },
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert len(out["data"]["presetId"]) == 8 and out["data"]["presetId"].isalnum()


def test_admin_invalid_fargate_combo(ddb_table, stub_clients):
    res = handler(
        make_event(
            "POST",
            "/admin/presets",
            user_id="a1",
            groups=["admin"],
            body={
                "displayName": "이상",
                "cpu": 256,
                "memory": 8192,
                "minCount": 1,
                "maxCount": 2,
                "scaleMetric": "cpu",
                "scaleThreshold": 70,
            },
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


# ── 설정 저장 ────────────────────────────────────────────────────────────────


def test_admin_put_settings_ok(ddb_table, stub_clients):
    res = handler(
        make_event(
            "PUT",
            "/admin/settings",
            user_id="a1",
            groups=["admin"],
            body={
                "enabledProviders": ["codecommit", "github"],
                "registeredVpcs": [{"vpcId": "vpc-1", "label": "기본"}],
                "userAppQuota": 10,
                "allowInternetFacing": True,
                "allowedBaseImages": ["public.ecr.aws/docker/library/node:20"],
                "logRetentionDays": 30,
            },
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["userAppQuota"] == 10
    # 실제 저장됐는지
    item = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "SETTINGS"})["Item"]
    assert item["userAppQuota"] == 10


def test_admin_put_settings_invalid_provider(ddb_table, stub_clients):
    res = handler(
        make_event(
            "PUT",
            "/admin/settings",
            user_id="a1",
            groups=["admin"],
            body={
                "enabledProviders": ["svn"],
                "registeredVpcs": [],
                "userAppQuota": 5,
                "allowInternetFacing": False,
                "allowedBaseImages": [],
            },
        )
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"
