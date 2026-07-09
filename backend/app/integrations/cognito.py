"""관리자 사용자 관리 (DESIGN.md 5/6 관리자 화면 "사용자 관리": 초대·비활성화·그룹 변경).

IAM(platform-stack, User Pool ARN 범위): AdminCreateUser, AdminAddUserToGroup,
AdminRemoveUserFromGroup, AdminDisableUser, AdminEnableUser, ListUsers, AdminListGroupsForUser.
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from ..config import load_config
from .clients import client


def _default_name_from_email(email: str) -> str:
    """이메일 로컬파트(@ 앞부분)를 표시용 이름 기본값으로. @ 없으면 이메일 전체."""
    at = email.find("@")
    return email[:at] if at > 0 else email


def invite_user(email: str, group: str = "user", name: str | None = None) -> str:
    """관리자 초대: 이메일 + 임시 비밀번호(Cognito 자동 발송). 기본 user 그룹 배정.

    name(표시 이름)을 UserAttributes에 넣어 idToken name 클레임으로 이름 표시가 되게 한다.
    name 미제공/공백이면 이메일 로컬파트를 기본값으로 사용.
    """
    cfg = load_config()
    display_name = name.strip() if (name and name.strip()) else _default_name_from_email(email)
    cognito = client("cognito-idp")
    res = cognito.admin_create_user(
        UserPoolId=cfg.user_pool_id,
        Username=email,
        DesiredDeliveryMediums=["EMAIL"],
        UserAttributes=[
            {"Name": "email", "Value": email},
            {"Name": "email_verified", "Value": "true"},
            {"Name": "name", "Value": display_name},
        ],
    )
    username = (res.get("User") or {}).get("Username") or email
    cognito.admin_add_user_to_group(UserPoolId=cfg.user_pool_id, Username=username, GroupName=group)
    return username


def set_user_group(username: str, group: str) -> None:
    cfg = load_config()
    other = "user" if group == "admin" else "admin"
    cognito = client("cognito-idp")
    cognito.admin_add_user_to_group(UserPoolId=cfg.user_pool_id, Username=username, GroupName=group)
    # 반대 그룹에서 제거(단일 역할 유지). 없으면 no-op.
    try:
        cognito.admin_remove_user_from_group(
            UserPoolId=cfg.user_pool_id, Username=username, GroupName=other
        )
    except ClientError:
        pass


def set_user_enabled(username: str, enabled: bool) -> None:
    cfg = load_config()
    cognito = client("cognito-idp")
    if enabled:
        cognito.admin_enable_user(UserPoolId=cfg.user_pool_id, Username=username)
    else:
        cognito.admin_disable_user(UserPoolId=cfg.user_pool_id, Username=username)


def list_users(limit: int = 60) -> list[dict[str, Any]]:
    cfg = load_config()
    cognito = client("cognito-idp")
    res = cognito.list_users(UserPoolId=cfg.user_pool_id, Limit=limit)
    users: list[dict[str, Any]] = []
    for u in res.get("Users", []):
        username = u.get("Username", "")
        email = ""
        for attr in u.get("Attributes", []):
            if attr.get("Name") == "email":
                email = attr.get("Value", "")
                break
        groups_res = cognito.admin_list_groups_for_user(
            UserPoolId=cfg.user_pool_id, Username=username
        )
        groups = [
            g.get("GroupName", "") for g in groups_res.get("Groups", []) if g.get("GroupName")
        ]
        user: dict[str, Any] = {
            "username": username,
            "email": email,
            "enabled": u.get("Enabled", True),
            "status": u.get("UserStatus", "UNKNOWN"),
            "groups": groups,
        }
        created = u.get("UserCreateDate")
        if created is not None:
            # boto3 는 datetime 반환 — ISO8601 문자열로.
            user["createdAt"] = (
                created.isoformat() if hasattr(created, "isoformat") else str(created)
            )
        users.append(user)
    return users
