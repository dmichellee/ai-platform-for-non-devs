"""관리자 CONFIG 핸들러 (api-contract.md 관리자 섹션). 모두 admin 전용 — user는 전부 403."""

from __future__ import annotations

from ..auth.identity import require_admin
from ..data.config_repo import (
    delete_permission_template,
    delete_preset,
    get_admin_settings,
    list_alb_registry,
    list_permission_templates,
    list_presets,
    put_admin_settings,
    put_permission_template,
    put_preset,
)
from ..domain.admin_validate import (
    generate_id,
    parse_admin_settings,
    parse_permission_template,
    parse_preset,
)
from ..domain.validate import parse_body
from ..http.errors import errors
from ..http.response import ProxyResult, created, list_response, no_content, ok
from ..http.router import RouteContext
from ..integrations.cognito import (
    invite_user,
    list_users,
    set_user_enabled,
    set_user_group,
)

# ── 플랫폼 설정 ────────────────────────────────────────────────────────────────


def get_settings(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    return ok(get_admin_settings())


def put_settings(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    settings = parse_admin_settings(ctx.event.get("body"))
    return ok(put_admin_settings(settings))


# ── 컴퓨팅 프리셋 ──────────────────────────────────────────────────────────────


def get_presets(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    return list_response(list_presets())


def create_preset(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    inp = parse_preset(ctx.event.get("body"))
    preset_id = inp.get("presetId") or generate_id()
    return created(put_preset({**inp, "presetId": preset_id}))


def update_preset(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    preset_id = ctx.params.get("presetId")
    if not preset_id:
        raise errors.validation("프리셋 식별자가 필요해요.")
    inp = parse_preset(ctx.event.get("body"))
    return ok(put_preset({**inp, "presetId": preset_id}))


def remove_preset(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    preset_id = ctx.params.get("presetId")
    if not preset_id:
        raise errors.validation("프리셋 식별자가 필요해요.")
    delete_preset(preset_id)
    return no_content()


# ── 권한 템플릿 ────────────────────────────────────────────────────────────────


def get_permission_templates(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    return list_response(list_permission_templates())


def create_permission_template(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    inp = parse_permission_template(ctx.event.get("body"))
    perm_id = inp.get("permId") or generate_id()
    return created(put_permission_template({**inp, "permId": perm_id}))


def update_permission_template(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    perm_id = ctx.params.get("permId")
    if not perm_id:
        raise errors.validation("템플릿 식별자가 필요해요.")
    inp = parse_permission_template(ctx.event.get("body"))
    return ok(put_permission_template({**inp, "permId": perm_id}))


def remove_permission_template(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    perm_id = ctx.params.get("permId")
    if not perm_id:
        raise errors.validation("템플릿 식별자가 필요해요.")
    delete_permission_template(perm_id)
    return no_content()


# ── 사용자 관리 (Cognito) ──────────────────────────────────────────────────────


def get_users(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    return list_response(list_users())


def create_user(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    body = parse_body(ctx.event.get("body"))
    email = body.get("email")
    group = body.get("group")
    name = body.get("name")
    if not isinstance(email, str) or "@" not in email:
        raise errors.validation("올바른 이메일 주소를 입력해주세요.")
    if name is not None and not isinstance(name, str):
        raise errors.validation("이름 값은 문자열이어야 해요.")
    g = "admin" if group == "admin" else "user"
    username = invite_user(email, g, name)
    return created({"username": username, "email": email, "group": g})


def patch_user(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    username = ctx.params.get("username")
    if not username:
        raise errors.validation("사용자 식별자가 필요해요.")
    body = parse_body(ctx.event.get("body"))
    if "group" in body:
        group = body.get("group")
        if group not in ("admin", "user"):
            raise errors.validation("그룹 값이 올바르지 않아요.")
        set_user_group(username, group)
    if "enabled" in body:
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            raise errors.validation("활성화 값은 true/false여야 해요.")
        set_user_enabled(username, enabled)
    return ok({"username": username})


# ── 인프라 현황 ────────────────────────────────────────────────────────────────


def get_alb_registry(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    return list_response(list_alb_registry())
