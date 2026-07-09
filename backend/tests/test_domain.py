"""L1 — 도메인/인가 순수 로직: 서브도메인 검증, 신원 추출·그룹 정규화, 가드."""

from __future__ import annotations

import pytest
from app.auth.identity import Identity, get_identity, require_admin, require_owner
from app.domain.subdomain import suggest_subdomain, validate_subdomain
from app.http.errors import ApiError


def _evt(claims: dict) -> dict:
    return {"requestContext": {"authorizer": {"claims": claims}}}


# ── 서브도메인 검증 ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("s", ["my-app", "app123", "a1b", "x" * 40])
def test_valid_subdomains(s):
    validate_subdomain(s)  # should not raise


@pytest.mark.parametrize(
    "s",
    [
        "ab",  # 너무 짧음
        "x" * 41,  # 너무 김
        "MyApp",  # 대문자
        "-lead",  # 하이픈 시작
        "trail-",  # 하이픈 끝
        "dou--ble",  # 연속 하이픈
        "under_score",  # 언더스코어
        "admin",  # 예약어
        "api",
        "www",
        "apphub",
    ],
)
def test_invalid_subdomains(s):
    with pytest.raises(ApiError) as exc:
        validate_subdomain(s)
    assert exc.value.code == "SUBDOMAIN_INVALID"


def test_suggest_subdomain():
    assert suggest_subdomain("My Cool App!") == "my-cool-app"
    import re

    assert re.fullmatch(r"[a-z0-9-]+", suggest_subdomain("AI 챗봇"))


# ── 신원 추출·그룹 정규화 ────────────────────────────────────────────────────


def test_missing_sub_unauthenticated():
    with pytest.raises(ApiError) as exc:
        get_identity(_evt({}))
    assert exc.value.code == "UNAUTHENTICATED"


def test_groups_array_form():
    ident = get_identity(_evt({"sub": "u1", "cognito:groups": ["admin", "user"]}))
    assert ident.is_admin is True
    assert ident.groups == ["admin", "user"]


def test_groups_string_bracket_form():
    ident = get_identity(_evt({"sub": "u1", "cognito:groups": "[user admin]"}))
    assert ident.is_admin is True


def test_no_groups_defaults_to_user():
    ident = get_identity(_evt({"sub": "u1"}))
    assert ident.is_admin is False
    assert ident.groups == []


# ── 가드 ──────────────────────────────────────────────────────────────────────

_ADMIN = Identity(user_id="a", groups=["admin"], is_admin=True)
_USER = Identity(user_id="u", groups=["user"], is_admin=False)


def test_require_admin_user_forbidden():
    with pytest.raises(ApiError):
        require_admin(_USER)


def test_require_admin_admin_passes():
    require_admin(_ADMIN)


def test_require_owner_self_passes():
    require_owner(_USER, {"ownerId": "u"})


def test_require_owner_other_forbidden():
    with pytest.raises(ApiError):
        require_owner(_USER, {"ownerId": "other"})


def test_require_owner_admin_passes_other():
    require_owner(_ADMIN, {"ownerId": "other"})
