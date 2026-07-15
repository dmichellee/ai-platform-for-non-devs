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
                "userAppQuota": 5,
                "allowInternetFacing": True,
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
    # 베이스 이미지 허용목록 기능 제거 — 기본 응답에 필드가 없어야 한다.
    assert "allowedBaseImages" not in out["data"]


def test_admin_get_settings_drops_legacy_base_images(ddb_table, stub_clients):
    """구 스키마 잔여 allowedBaseImages 가 DDB 에 있어도 응답에서 무시된다(스키마리스)."""
    from .conftest import seed_settings

    seed_settings(ddb_table, allowedBaseImages=["public.ecr.aws/docker/library/node:20"])
    res = handler(make_event("GET", "/admin/settings", user_id="a1", groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert "allowedBaseImages" not in out["data"]


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
    # 신 body: registeredVpcs·logRetentionDays 없음(프론트가 더 이상 싣지 않음).
    res = handler(
        make_event(
            "PUT",
            "/admin/settings",
            user_id="a1",
            groups=["admin"],
            body={
                "enabledProviders": ["codecommit", "github"],
                "userAppQuota": 10,
                "allowInternetFacing": True,
            },
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["userAppQuota"] == 10
    # 폐기 필드는 응답에 없다.
    assert "registeredVpcs" not in out["data"]
    assert "logRetentionDays" not in out["data"]
    # 실제 저장됐는지
    item = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "SETTINGS"})["Item"]
    assert item["userAppQuota"] == 10
    # 서버가 폐기 필드를 저장하지 않는다.
    assert "registeredVpcs" not in item
    assert "logRetentionDays" not in item


def test_admin_put_settings_ignores_legacy_fields(ddb_table, stub_clients):
    """구 클라이언트가 registeredVpcs·logRetentionDays 를 보내도 검증 없이 무시하고 저장 성공."""
    res = handler(
        make_event(
            "PUT",
            "/admin/settings",
            user_id="a1",
            groups=["admin"],
            body={
                "enabledProviders": ["codecommit"],
                "userAppQuota": 7,
                "allowInternetFacing": False,
                # 폐기 필드(무시 대상) — 형식이 이상해도 거부되지 않아야 한다.
                "registeredVpcs": "이건-이제-검증-안-함",
                "logRetentionDays": -999,
            },
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["userAppQuota"] == 7
    assert "registeredVpcs" not in out["data"]
    assert "logRetentionDays" not in out["data"]
    item = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "SETTINGS"})["Item"]
    assert "registeredVpcs" not in item
    assert "logRetentionDays" not in item


def test_admin_get_settings_drops_legacy_vpc_and_retention(ddb_table, stub_clients):
    """DDB 에 폐기 필드가 남아 있어도 GET 응답에서 무시된다(스키마리스)."""
    from .conftest import seed_settings

    seed_settings(
        ddb_table,
        registeredVpcs=[{"vpcId": "vpc-x", "label": "구"}],
        logRetentionDays=30,
    )
    res = handler(make_event("GET", "/admin/settings", user_id="a1", groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert "registeredVpcs" not in out["data"]
    assert "logRetentionDays" not in out["data"]


def test_admin_put_settings_invalid_provider(ddb_table, stub_clients):
    res = handler(
        make_event(
            "PUT",
            "/admin/settings",
            user_id="a1",
            groups=["admin"],
            body={
                "enabledProviders": ["svn"],
                "userAppQuota": 5,
                "allowInternetFacing": False,
            },
        )
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"


# ── 버그1: 빈/공백 presetId 방어 ─────────────────────────────────────────────

_VALID_PRESET_BODY = {
    "displayName": "보통",
    "cpu": 512,
    "memory": 1024,
    "minCount": 1,
    "maxCount": 3,
    "scaleMetric": "cpu",
    "scaleThreshold": 70,
}


def test_admin_create_preset_empty_presetid_autogenerates(ddb_table, stub_clients):
    """body 에 presetId="" 가 오면 거부되어야 한다(자동발급은 '키 부재'일 때만)."""
    res = handler(
        make_event(
            "POST",
            "/admin/presets",
            user_id="a1",
            groups=["admin"],
            body={**_VALID_PRESET_BODY, "presetId": ""},
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_admin_create_preset_blank_presetid_rejected(ddb_table, stub_clients):
    """공백만 있는 presetId 도 거부(빈 SK 오염 방지)."""
    res = handler(
        make_event(
            "POST",
            "/admin/presets",
            user_id="a1",
            groups=["admin"],
            body={**_VALID_PRESET_BODY, "presetId": "   "},
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_admin_create_preset_no_presetid_autogenerates(ddb_table, stub_clients):
    """presetId 키 자체가 없으면 8자 난수 자동 발급 + 정상 SK 저장."""
    res = handler(
        make_event(
            "POST", "/admin/presets", user_id="a1", groups=["admin"], body=_VALID_PRESET_BODY
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    pid = out["data"]["presetId"]
    assert len(pid) == 8 and pid.isalnum()
    # 빈 SK 아이템이 만들어지지 않았는지 확인
    empty = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PRESET#"})
    assert "Item" not in empty
    stored = ddb_table.get_item(Key={"PK": "CONFIG", "SK": f"PRESET#{pid}"})
    assert stored["Item"]["presetId"] == pid


def test_admin_update_preset_uses_path_id_not_body(ddb_table, stub_clients):
    """PUT 경로의 presetId 를 정본으로 사용 — body 의 presetId 는 무시(SK 불일치 방지)."""
    res = handler(
        make_event(
            "PUT",
            "/admin/presets/keepme",
            user_id="a1",
            groups=["admin"],
            body={**_VALID_PRESET_BODY, "presetId": "ignored"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["presetId"] == "keepme"
    stored = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PRESET#keepme"})
    assert stored["Item"]["presetId"] == "keepme"
    # body 의 "ignored" 로는 저장되지 않음
    assert "Item" not in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PRESET#ignored"})


def test_admin_create_perm_empty_permid_rejected(ddb_table, stub_clients):
    res = handler(
        make_event(
            "POST",
            "/admin/permission-templates",
            user_id="a1",
            groups=["admin"],
            body={
                "displayName": "기본",
                "policyDocument": {"Version": "2012-10-17", "Statement": []},
                "permId": "",
            },
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"
