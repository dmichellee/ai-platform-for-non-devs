"""관리자 CONFIG 핸들러 (api-contract.md 관리자 섹션). 모두 admin 전용 — user는 전부 403."""

from __future__ import annotations

from ..auth.identity import require_admin
from ..data.apps import count_apps_referencing
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
    # parse_preset 이 빈/공백 presetId 는 이미 거부한다. 없으면(키 부재) 자동 발급.
    preset_id = inp.get("presetId") or generate_id()
    return created(put_preset({**inp, "presetId": preset_id}))


def update_preset(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    preset_id = (ctx.params.get("presetId") or "").strip()
    if not preset_id:
        raise errors.validation("프리셋 식별자가 필요해요.")
    inp = parse_preset(ctx.event.get("body"))
    # 경로의 presetId 를 정본으로 사용(body 의 presetId 는 무시해 SK 불일치 방지).
    return ok(put_preset({**inp, "presetId": preset_id}))


def remove_preset(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    preset_id = (ctx.params.get("presetId") or "").strip()
    if not preset_id:
        raise errors.validation("프리셋 식별자가 필요해요.")
    # QA M3: 사용 중인 프리셋을 지우면 다음 배포가 cpu=0 으로 실패한다 → 거부(DELETING 앱 제외).
    in_use = count_apps_referencing("presetId", preset_id)
    if in_use > 0:
        raise errors.in_use(
            f"이 크기를 쓰는 앱이 {in_use}개 있어요. 그 앱을 먼저 삭제한 뒤 다시 시도해 주세요."
        )
    delete_preset(preset_id)
    return no_content()


# ── 권한 템플릿 ────────────────────────────────────────────────────────────────


def get_permission_templates(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    return list_response(list_permission_templates())


def create_permission_template(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    inp = parse_permission_template(ctx.event.get("body"))
    # parse 가 빈/공백 permId 는 이미 거부한다. 없으면(키 부재) 자동 발급.
    perm_id = inp.get("permId") or generate_id()
    return created(put_permission_template({**inp, "permId": perm_id}))


def update_permission_template(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    perm_id = (ctx.params.get("permId") or "").strip()
    if not perm_id:
        raise errors.validation("템플릿 식별자가 필요해요.")
    inp = parse_permission_template(ctx.event.get("body"))
    # 경로의 permId 를 정본으로 사용(body 의 permId 는 무시해 SK 불일치 방지).
    return ok(put_permission_template({**inp, "permId": perm_id}))


def remove_permission_template(ctx: RouteContext) -> ProxyResult:
    require_admin(ctx.identity)
    perm_id = (ctx.params.get("permId") or "").strip()
    if not perm_id:
        raise errors.validation("템플릿 식별자가 필요해요.")
    # QA M3: 사용 중인 권한 템플릿을 지우면 다음 배포에서 앱 권한이 조용히 사라진다 → 거부.
    in_use = count_apps_referencing("permissionTemplateId", perm_id)
    if in_use > 0:
        raise errors.in_use(
            f"이 앱 유형을 쓰는 앱이 {in_use}개 있어요. 그 앱을 먼저 삭제한 뒤 다시 시도해 주세요."
        )
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
