"""라우트 테이블 (api-contract.md의 단일 원본).

라우터는 세그먼트 수/리터럴 일치로 매칭하므로 등록 순서와 무관하게 충돌 없음.
"""

from __future__ import annotations

from .handlers.admin import (
    create_permission_template,
    create_preset,
    create_user,
    get_alb_registry,
    get_permission_templates,
    get_presets,
    get_settings,
    get_users,
    patch_user,
    put_settings,
    remove_permission_template,
    remove_preset,
    update_permission_template,
    update_preset,
)
from .handlers.apps import (
    admin_list_apps,
    create_app,
    delete_app,
    get_app_detail,
    list_my_apps,
    patch_app,
)
from .handlers.connections import (
    create_connection_repo,
    create_my_connection,
    delete_my_connection,
    list_connection_repos,
    list_my_connections,
)
from .handlers.deployments import (
    list_app_deployments,
    rollback_deploy,
    trigger_deploy,
)
from .handlers.logs import get_app_logs
from .http.router import Router


def build_router() -> Router:
    r = Router()

    # ── 앱 CRUD (사용자: 본인, admin: 전체) ──────────────────────────────────
    r.get("/apps", list_my_apps)
    r.post("/apps", create_app)
    r.get("/apps/:id", get_app_detail)
    r.patch("/apps/:id", patch_app)
    r.delete("/apps/:id", delete_app)

    # ── 배포 ─────────────────────────────────────────────────────────────────
    r.post("/apps/:id/deploy", trigger_deploy)
    r.get("/apps/:id/deployments", list_app_deployments)
    r.post("/apps/:id/rollback", rollback_deploy)

    # ── 로그 ─────────────────────────────────────────────────────────────────
    r.get("/apps/:id/logs", get_app_logs)

    # ── 레포 연결 ──────────────────────────────────────────────────────────────
    r.get("/connections", list_my_connections)
    r.post("/connections", create_my_connection)
    r.delete("/connections/:connId", delete_my_connection)
    r.get("/connections/:connId/repos", list_connection_repos)
    r.post("/connections/:connId/repos", create_connection_repo)

    # ── 관리자: 플랫폼 설정 ─────────────────────────────────────────────────
    r.get("/admin/settings", get_settings)
    r.put("/admin/settings", put_settings)

    # ── 관리자: 프리셋 ──────────────────────────────────────────────────────
    r.get("/admin/presets", get_presets)
    r.post("/admin/presets", create_preset)
    r.put("/admin/presets/:presetId", update_preset)
    r.delete("/admin/presets/:presetId", remove_preset)

    # ── 관리자: 권한 템플릿 ──────────────────────────────────────────────────
    r.get("/admin/permission-templates", get_permission_templates)
    r.post("/admin/permission-templates", create_permission_template)
    r.put("/admin/permission-templates/:permId", update_permission_template)
    r.delete("/admin/permission-templates/:permId", remove_permission_template)

    # ── 관리자: 사용자 관리 ──────────────────────────────────────────────────
    r.get("/admin/users", get_users)
    r.post("/admin/users", create_user)
    r.patch("/admin/users/:username", patch_user)

    # ── 관리자: 전체 현황 / 인프라 ───────────────────────────────────────────
    r.get("/admin/apps", admin_list_apps)
    r.get("/admin/alb-registry", get_alb_registry)

    return r
