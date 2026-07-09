"""L1 — inviteUser: name 속성 / 이메일 로컬파트 폴백 / 그룹 배정."""

from __future__ import annotations

import pytest
from app.integrations import clients as integ_clients
from app.integrations.cognito import invite_user

from .conftest import StubClient


@pytest.fixture
def cognito_stub():
    stub = StubClient()
    stub.set_response("admin_create_user", {"User": {"Username": "invited-user"}})
    integ_clients.set_client("cognito-idp", stub)
    yield stub
    integ_clients.reset_clients()


def _attrs_of(stub: StubClient, idx: int = 0) -> dict[str, str]:
    call = stub.calls_for("admin_create_user")[idx]
    return {a["Name"]: a.get("Value", "") for a in call.get("UserAttributes", [])}


def test_name_provided_goes_to_attributes(cognito_stub):
    invite_user("newbie@example.com", "user", "홍길동")
    attrs = _attrs_of(cognito_stub)
    assert attrs["name"] == "홍길동"
    assert attrs["email"] == "newbie@example.com"
    assert attrs["email_verified"] == "true"


def test_name_missing_falls_back_to_local_part(cognito_stub):
    invite_user("someone@example.com", "user")
    assert _attrs_of(cognito_stub)["name"] == "someone"


def test_name_blank_falls_back(cognito_stub):
    invite_user("blankname@example.com", "user", "   ")
    assert _attrs_of(cognito_stub)["name"] == "blankname"


def test_name_trimmed(cognito_stub):
    invite_user("trimmed@example.com", "user", "  이름  ")
    assert _attrs_of(cognito_stub)["name"] == "이름"


def test_no_atsign_uses_full_email(cognito_stub):
    invite_user("noatsign", "user")
    assert _attrs_of(cognito_stub)["name"] == "noatsign"


def test_invite_adds_to_group(cognito_stub):
    invite_user("grouped@example.com", "admin", "관리자")
    call = cognito_stub.calls_for("admin_add_user_to_group")[0]
    assert call["GroupName"] == "admin"
