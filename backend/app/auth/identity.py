"""인증·인가 (stack-outputs.md §3.1).

API GW의 Cognito authorizer가 검증한 JWT 클레임을 event.requestContext.authorizer.claims 로 넘긴다.
 - user_id  = claims.sub
 - groups   = claims["cognito:groups"] (문자열 또는 배열로 올 수 있음 → 정규화)

user 그룹: 본인 앱만. admin 그룹: 전체 + CONFIG.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from ..http.errors import errors


@dataclass(frozen=True)
class Identity:
    user_id: str
    groups: list[str] = field(default_factory=list)
    is_admin: bool = False
    email: str | None = None


_GROUP_SPLIT = re.compile(r"[,\s]+")


def _normalize_groups(raw: Any) -> list[str]:
    """cognito:groups 클레임은 REST authorizer에서 콤마 문자열 또는 "[a b]" 형태로 온다 → 배열 정규화."""
    if isinstance(raw, list):
        return [str(g) for g in raw]
    if isinstance(raw, str):
        trimmed = re.sub(r"^\[|\]$", "", raw).strip()
        if trimmed == "":
            return []
        return [g.strip() for g in _GROUP_SPLIT.split(trimmed) if g.strip()]
    return []


def get_identity(event: Mapping[str, Any]) -> Identity:
    """authorizer 클레임에서 신원 추출. sub 없으면 UNAUTHENTICATED."""
    request_context = event.get("requestContext") or {}
    authorizer = request_context.get("authorizer") or {}
    claims = authorizer.get("claims") or {}

    user_id = claims.get("sub")
    if not isinstance(user_id, str) or user_id == "":
        raise errors.unauthenticated()

    groups = _normalize_groups(claims.get("cognito:groups"))
    email_claim = claims.get("email")
    email = email_claim if isinstance(email_claim, str) else None

    return Identity(
        user_id=user_id,
        groups=groups,
        is_admin="admin" in groups,
        email=email,
    )


# ── 가드 ──────────────────────────────────────────────────────────────────────


def require_user(identity: Identity) -> Identity:
    """로그인 사용자 요구. get_identity가 이미 sub를 강제 — 의도 문서화용 명시 가드."""
    return identity


def require_admin(identity: Identity) -> Identity:
    """관리자 전용(CONFIG API, 전체 현황). user가 호출하면 403."""
    if not identity.is_admin:
        raise errors.forbidden("관리자만 사용할 수 있는 기능이에요.")
    return identity


def require_owner(identity: Identity, app: Mapping[str, Any]) -> None:
    """소유자 검사. 본인 앱이거나 admin이면 통과, 아니면 403.

    존재 여부를 흘리지 않기 위해 없는 앱은 호출부에서 not_found로 처리(여기선 소유만 판정).
    """
    if identity.is_admin:
        return
    if app.get("ownerId") != identity.user_id:
        raise errors.forbidden("본인이 만든 앱만 관리할 수 있어요.")
