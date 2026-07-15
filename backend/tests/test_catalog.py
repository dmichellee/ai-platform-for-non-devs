"""L1 — 마법사용 읽기 전용 카탈로그: 프리셋/권한템플릿 목록(user 허용), 서브도메인 실시간 확인.

버그2: 일반 user 가 마법사에서 프리셋/권한템플릿을 못 보던 문제(admin 전용 403) 회귀 방지.
버그3: 서브도메인 실시간 중복/형식 확인 API.
"""

from __future__ import annotations

from app.handler import handler

from .conftest import make_event, parse_result, seed_perm, seed_preset

USER = "user-alice"


# ── 버그2: user 읽기 전용 프리셋/권한템플릿 목록 ─────────────────────────────


def test_user_get_presets_ok(ddb_table, stub_clients):
    seed_preset(ddb_table, "small")
    res = handler(make_event("GET", "/presets", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    items = out["data"]["items"]
    assert len(items) == 1
    assert items[0]["presetId"] == "small"
    # 프리셋은 전부 무해 — admin GET 과 동일 shape(cpu/memory 등 포함)
    assert items[0]["cpu"] == 256


def test_user_get_permission_templates_hides_policy(ddb_table, stub_clients):
    seed_perm(ddb_table, "basic")
    res = handler(make_event("GET", "/permission-templates", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    items = out["data"]["items"]
    assert len(items) == 1
    assert items[0]["permId"] == "basic"
    assert items[0]["displayName"] == "기본"
    # 민감한 policyDocument 는 노출되면 안 됨
    assert "policyDocument" not in items[0]


def test_user_get_presets_empty(ddb_table, stub_clients):
    res = handler(make_event("GET", "/presets", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["items"] == []


# ── 회귀: admin CRUD 는 여전히 admin 전용 ────────────────────────────────────


def test_user_admin_get_presets_still_forbidden(ddb_table, stub_clients):
    """새 /presets 는 user 허용이지만 관리자 /admin/presets 는 여전히 403."""
    res = handler(make_event("GET", "/admin/presets", user_id=USER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_user_create_preset_still_forbidden(ddb_table, stub_clients):
    """쓰기(POST /admin/presets)는 user 에게 여전히 403."""
    res = handler(
        make_event(
            "POST",
            "/admin/presets",
            user_id=USER,
            groups=["user"],
            body={
                "displayName": "x",
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


# ── 버그3: 서브도메인 실시간 확인 ────────────────────────────────────────────


def test_subdomain_check_available(ddb_table, stub_clients):
    res = handler(
        make_event(
            "GET", "/subdomains/check", user_id=USER, groups=["user"], query={"value": "my-new-app"}
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["available"] is True
    assert "reason" not in out["data"]


def test_subdomain_check_taken(ddb_table, stub_clients):
    ddb_table.put_item(
        Item={
            "PK": "SUBDOMAIN#taken-one",
            "SK": "RESERVATION",
            "entityType": "SubdomainReservation",
            "subdomain": "taken-one",
            "appId": "app00001",
            "createdAt": "2026-01-01T00:00:00.000Z",
        }
    )
    res = handler(
        make_event(
            "GET", "/subdomains/check", user_id=USER, groups=["user"], query={"value": "taken-one"}
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["available"] is False
    assert out["data"]["reason"] == "TAKEN"


def test_subdomain_check_invalid_format(ddb_table, stub_clients):
    """형식 위반(대문자/짧음/예약어)은 에러가 아니라 available=false, reason=INVALID."""
    for bad in ("AB", "MyApp", "admin", "-bad", "a--b"):
        res = handler(
            make_event(
                "GET", "/subdomains/check", user_id=USER, groups=["user"], query={"value": bad}
            )
        )
        out = parse_result(res)
        assert out["status"] == 200, bad
        assert out["data"]["available"] is False, bad
        assert out["data"]["reason"] == "INVALID", bad


def test_subdomain_check_missing_value(ddb_table, stub_clients):
    res = handler(make_event("GET", "/subdomains/check", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["available"] is False
    assert out["data"]["reason"] == "INVALID"


# ── VPC 선택 제거: GET /vpcs 폐기 → 라우트 없음(404 ROUTE_NOT_FOUND) ──────────


def test_get_vpcs_removed_route_not_found(ddb_table, stub_clients):
    res = handler(make_event("GET", "/vpcs", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 404
    assert out["error"]["code"] == "ROUTE_NOT_FOUND"


# ── 이슈3: "기본"(default) 템플릿 우선 정렬 ──────────────────────────────────


def test_permission_templates_default_first(ddb_table, stub_clients):
    seed_perm(ddb_table, "zzz-bedrock")
    seed_perm(ddb_table, "default")
    res = handler(make_event("GET", "/permission-templates", user_id=USER, groups=["user"]))
    items = parse_result(res)["data"]["items"]
    assert items[0]["permId"] == "default"


# ── 기능 요구사항 3: 활성 provider 목록 (GET /providers) ─────────────────────


def test_user_get_providers_enabled_only(ddb_table, stub_clients):
    from .conftest import seed_settings

    seed_settings(ddb_table, enabledProviders=["codecommit"])
    res = handler(make_event("GET", "/providers", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["items"] == ["codecommit"]


def test_user_get_providers_defaults_when_no_settings(ddb_table, stub_clients):
    res = handler(make_event("GET", "/providers", user_id=USER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    # 설정 미존재 시 DEFAULT_ADMIN_SETTINGS 의 enabledProviders 를 따른다
    assert isinstance(out["data"]["items"], list)
