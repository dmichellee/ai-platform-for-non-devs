"""앱 CRUD 핸들러 (api-contract.md 앱 CRUD).

무거운 프로비저닝/삭제는 Step Functions로 위임(메인 서버 무부하). 여기서는 접수 + 상태 전이만.
"""

from __future__ import annotations

from typing import Any

from ..auth.identity import require_admin, require_owner
from ..config import load_config
from ..data.apps import (
    count_apps_by_owner,
    get_app,
    list_all_apps,
    list_apps_by_owner,
    put_app,
    transition_status,
    update_app,
)
from ..data.config_repo import (
    get_admin_settings,
    get_permission_template,
    get_preset,
)
from ..data.connections import get_connection
from ..data.subdomains import release_subdomain, reserve_subdomain
from ..domain.ids import generate_app_id
from ..domain.redeploy import find_in_progress_deployment, trigger_secret_change_redeploy
from ..domain.secrets import apply_secret_changes, create_initial_secret
from ..domain.subdomain import validate_subdomain
from ..domain.validate import parse_create_app, parse_patch_app
from ..http.errors import errors
from ..http.response import ProxyResult, created, list_response, ok
from ..http.router import RouteContext
from ..integrations.clients import client
from ..integrations.secrets import delete_secret
from ..integrations.sfn import start_delete, start_provision
from ..wake import cluster_name
from ..wake.ecs_service import app_service_name
from ..wake.sleep import sleep_app

_VALID_STATUS = ("CREATING", "ACTIVE", "FAILED", "DELETING")

# 기술 정보 최소화: failureDetail(실패 단계·정제된 예외 메시지)은 관리자에게만 노출.
# failureReason(사용자용 한국어 요약)은 user/admin 모두에게 노출(앱 상세에서 원인 확인 — UX 갭 해소).
_ADMIN_ONLY_APP_FIELDS = ("failureDetail",)
# 내부 동시성 제어 필드(D8 시크릿 JSON 버전 조건부 갱신) — 누구에게도 노출하지 않는다.
_INTERNAL_APP_FIELDS = ("version", "secretLockId", "secretLockExpiresAt")


def _view_app(app: dict[str, Any], is_admin: bool) -> dict[str, Any]:
    """응답용 App 뷰(원본 불변). 내부 필드 제거 + admin 이 아니면 관리자 전용 필드 제거.

    시크릿은 `secretKeys`(KEY 목록, 항상 배열) 만 노출한다 — 값은 DDB 에도 없다(D8).
    """
    hidden = _INTERNAL_APP_FIELDS if is_admin else _INTERNAL_APP_FIELDS + _ADMIN_ONLY_APP_FIELDS
    view = {k: v for k, v in app.items() if k not in hidden}
    view["secretKeys"] = list(app.get("secretKeys") or [])
    # albIndex(D20, 내부용): 배정된 앱인데 값이 없으면(기존 앱) 0 으로 간주.
    if view.get("albArn") and view.get("albIndex") is None:
        view["albIndex"] = 0
    return view


def list_my_apps(ctx: RouteContext) -> ProxyResult:
    """GET /apps — 본인 앱 목록(admin도 자기 소유만; 전체는 /admin/apps)."""
    apps = list_apps_by_owner(ctx.identity.user_id)
    return list_response([_view_app(a, ctx.identity.is_admin) for a in apps])


def get_app_detail(ctx: RouteContext) -> ProxyResult:
    """GET /apps/{id} — 소유자/관리자만. failureDetail 은 admin 에게만."""
    app = _load_owned_app(ctx)
    return ok(_view_app(app, ctx.identity.is_admin))


def create_app(ctx: RouteContext) -> ProxyResult:
    """POST /apps — 앱 생성.

    검증 순서: 형식 → 서브도메인 규칙 → provider 활성 → internet-facing 허용 →
      프리셋/권한템플릿 존재 → 연결 상태 → 쿼터 → 서브도메인 예약(원자적) → App(CREATING) → SFN start.

    VPC 선택 기능은 제거됐다(1차는 플랫폼 부트스트랩 VPC 단일 배치 — DESIGN 3.7·10장).
    프론트는 vpcId 를 보내지 않으며, 서버는 App 레코드에 vpcId 를 저장하지 않는다.
    앱이 배치될 VPC 는 ALB 슬롯 배정 시점에 network SSM(vpc-id)에서 확정된다.
    """
    req = parse_create_app(ctx.event.get("body"))
    validate_subdomain(req["subdomain"])

    settings = get_admin_settings()

    if req["provider"] not in settings["enabledProviders"]:
        raise errors.provider_disabled()
    if req["scheme"] == "internet-facing" and not settings["allowInternetFacing"]:
        raise errors.internet_facing_not_allowed()

    if get_preset(req["presetId"]) is None:
        raise errors.preset_not_found()
    if get_permission_template(req["permissionTemplateId"]) is None:
        raise errors.permission_template_not_found()

    # github/gitlab는 승인된 연결이 필요.
    connection_arn: str | None = None
    if req["provider"] in ("github", "gitlab"):
        conn = get_connection(ctx.identity.user_id, req["connectionId"])
        if conn is None:
            raise errors.validation("선택한 저장소 연결을 찾을 수 없어요.")
        if conn["status"] != "AVAILABLE":
            raise errors.connection_not_ready()
        connection_arn = conn["connectionArn"]

    # 쿼터 검사(사용자당 앱 수).
    count = count_apps_by_owner(ctx.identity.user_id)
    if count >= settings["userAppQuota"]:
        raise errors.quota_exceeded(settings["userAppQuota"])

    app_id = generate_app_id()
    stage = load_config().stage

    # 서브도메인 전역 예약(원자적 유일성). 실패 시 SUBDOMAIN_TAKEN.
    reserve_subdomain(req["subdomain"], app_id)

    # 시크릿(있으면)을 앱당 1개 JSON 시크릿으로 먼저 저장하고 ARN 만 확보(값은 DDB/로그에 남기지 않음, D8).
    #  실패 시 아래 except 에서 저장된 시크릿까지 정리(오염 방지).
    secret_arn: str | None = None
    try:
        secret_arn, secret_keys = create_initial_secret(stage, app_id, req.get("secrets") or {})

        app_record: dict[str, Any] = {
            "appId": app_id,
            "ownerId": ctx.identity.user_id,
            "name": req["name"],
            "subdomain": req["subdomain"],
            "provider": req["provider"],
            "repoUrl": req["repoUrl"],
            "branch": req["branch"],
            "presetId": req["presetId"],
            "permissionTemplateId": req["permissionTemplateId"],
            "scheme": req["scheme"],
            "autoDeployEnabled": req["autoDeployEnabled"],
            "sleepMode": req["sleepMode"],
            "envVars": req["envVars"],
            # 시크릿은 Secrets Manager 에만. DDB엔 ARN + KEY 목록만(값 없음, D8).
            "secretKeys": secret_keys,
            "version": 0,
            "status": "CREATING",
            "runtimeState": "SLEEPING",
            "cognitoProtect": req["cognitoProtect"],
        }
        if connection_arn is not None:
            app_record["connectionArn"] = connection_arn
        if secret_arn is not None:
            app_record["secretArn"] = secret_arn
        if "schedule" in req:
            app_record["schedule"] = req["schedule"]

        app = put_app(app_record)

        provision_input: dict[str, Any] = {
            "appId": app_id,
            "ownerId": app["ownerId"],
            "subdomain": app["subdomain"],
            "scheme": app["scheme"],
            "presetId": app["presetId"],
            "permissionTemplateId": app["permissionTemplateId"],
            "provider": app["provider"],
            "repoUrl": app["repoUrl"],
            "branch": app["branch"],
            "cognitoProtect": app["cognitoProtect"],
        }
        if connection_arn is not None:
            provision_input["connectionArn"] = connection_arn

        start_provision(provision_input)
        return created(_view_app(app, ctx.identity.is_admin))
    except Exception:
        # App 레코드 생성/SFN start 실패 시 서브도메인 예약 + 저장된 시크릿 롤백(오염 방지).
        try:
            release_subdomain(req["subdomain"])
        except Exception:
            pass
        if secret_arn:
            try:
                delete_secret(secret_arn)
            except Exception:
                pass
        raise


def patch_app(ctx: RouteContext) -> ProxyResult:
    """PATCH /apps/{id} — 설정 변경. DELETING이면 409.

    secrets/secretsRemove(있으면, D8):
      1) 배포가 진행 중이면 409 INVALID_STATE(진행 중 배포가 옛 KEY 목록으로 끝나 꼬이는 것 방지).
      2) 시크릿 JSON upsert(없으면 CreateSecret) + secretKeys 재계산을 App.version 조건부로 반영
         (삭제 KEY 는 JSON 에서 지우지 않고 secretKeys 에서만 제외 — 배포 성공 후 지연 정리).
         동시 수정 충돌은 409 CONFLICT.
      3) 실제 변경이 있으면 재빌드 없는 런타임 재배포를 즉시 트리거 → 응답 data.redeploy.
    값은 Secrets Manager 로만 가고 DDB·로그·응답에는 남지 않는다.
    """
    app = _load_owned_app(ctx)
    if app["status"] == "DELETING":
        raise errors.invalid_state("삭제 중인 앱은 설정을 변경할 수 없어요.")
    patch = parse_patch_app(ctx.event.get("body"))

    secrets_requested = "secrets" in patch or "secretsRemove" in patch
    upsert_secrets: dict[str, str] = patch.pop("secrets", {}) or {}
    remove_secrets: list[str] = patch.pop("secretsRemove", []) or []

    redeploy: dict[str, Any] | None = None
    updated = app
    if secrets_requested:
        if find_in_progress_deployment(app["appId"]) is not None:
            raise errors.invalid_state(
                "지금 배포가 진행 중이에요. 배포가 끝난 뒤 비밀 값을 다시 저장해 주세요."
            )
        stage = load_config().stage
        updated, changed = apply_secret_changes(stage, app, upsert_secrets, remove_secrets)
        if changed:
            redeploy = trigger_secret_change_redeploy(stage, updated)

    if patch:
        updated = update_app(app["appId"], patch)

    view = _view_app(updated, ctx.identity.is_admin)
    if redeploy is not None:
        view["redeploy"] = redeploy
    return ok(view)


def _accept_delete(app: dict[str, Any]) -> ProxyResult:
    """삭제 접수 공통 로직: CREATING 거부 → DELETING 멱등 → 조건부 전이 + DeleteApp SFN start.

    소유/인가 판정은 호출부(delete_app=소유자/admin, admin_delete_app=admin 전용)에서 끝낸 뒤 호출한다.
    """
    if app["status"] == "CREATING":
        raise errors.invalid_state("앱을 만드는 중이에요. 완료된 후 삭제할 수 있어요.")
    if app["status"] == "DELETING":
        # 멱등: 이미 삭제 중이면 그대로 접수 응답.
        return ok({"appId": app["appId"], "status": "DELETING"})
    # ACTIVE|FAILED → DELETING (상태 기계 준수).
    transition_status(app["appId"], "DELETING", ["ACTIVE", "FAILED"])
    delete_input: dict[str, Any] = {
        "appId": app["appId"],
        "ownerId": app["ownerId"],
        "subdomain": app["subdomain"],
    }
    if app.get("albArn") is not None:
        delete_input["albArn"] = app["albArn"]
    if app.get("rulePriority") is not None:
        delete_input["rulePriority"] = app["rulePriority"]
    start_delete(delete_input)
    return ok({"appId": app["appId"], "status": "DELETING"})


def delete_app(ctx: RouteContext) -> ProxyResult:
    """DELETE /apps/{id} — 삭제 접수(소유자/admin). ACTIVE|FAILED → DELETING 후 DeleteApp SFN start."""
    app = _load_owned_app(ctx)
    return _accept_delete(app)


def admin_delete_app(ctx: RouteContext) -> ProxyResult:
    """DELETE /admin/apps/{id} — 관리자에 의한 앱 삭제(타인 앱 포함, D10). 관리자 전용.

    소유자 검사 없이 그룹(admin)만 확인한다. 삭제 접수 로직은 delete_app 과 동일(공통 함수).
    프론트: 앱 이름 입력 일치 확인 모달 → adminDeleteApp(appId) (api-requests.md 항목 10).
    """
    require_admin(ctx.identity)
    app_id = ctx.params.get("id")
    if not app_id:
        raise errors.validation("앱 식별자가 필요해요.")
    app = get_app(app_id)
    if app is None:
        raise errors.not_found("앱을 찾을 수 없어요.")
    return _accept_delete(app)


def admin_list_apps(ctx: RouteContext) -> ProxyResult:
    """GET /admin/apps — 전체 현황. status 필터 옵션. 관리자 전용."""
    require_admin(ctx.identity)
    status_filter = ctx.query.get("status")
    status = status_filter if status_filter in _VALID_STATUS else None
    return list_response([_view_app(a, True) for a in list_all_apps(status)])


def admin_stop_app(ctx: RouteContext) -> ProxyResult:
    """POST /admin/apps/{id}/stop — 관리자 강제 중지(DESIGN 3.5). 관리자 전용, 타인 앱 포함.

    "강제 중지 = 관리자가 앱을 재우는 것" — ECS desiredCount=0 + 리스너 규칙을 Waker 로 전환 +
    runtimeState=SLEEPING(sleep_app(force=True) 재사용, always-on 앱도 대상). ACTIVE 앱만 의미 있음.
    무거운 작업 없음(UpdateService/ModifyRule 만) — 이후 요청이 오면 wake-on-request 로 다시 깨어난다.
    """
    require_admin(ctx.identity)
    app_id = ctx.params.get("id")
    if not app_id:
        raise errors.validation("앱 식별자가 필요해요.")
    app = get_app(app_id)
    if app is None:
        raise errors.not_found("앱을 찾을 수 없어요.")
    if app["status"] != "ACTIVE":
        raise errors.invalid_state("정상 상태(ACTIVE)인 앱만 중지할 수 있어요.")

    result = sleep_app(app_id, force=True)
    # 응답에는 사용자 화면 계약(App runtimeState)만 노출. 내부 세부(ruleSwitched 등)는 제외.
    return ok({"appId": app_id, "runtimeState": "SLEEPING", "stopped": result.get("stopped", False)})


def restart_app(ctx: RouteContext) -> ProxyResult:
    """POST /apps/{id}/restart — 앱 다시 시작(소유자/admin). body 없음.

    "재시작 = 같은 이미지·같은 설정으로 컨테이너만 새로 기동" — ECS forceNewDeployment.
    파이프라인 재실행(배포)과 구분된다: 재빌드 없음, Deployment 이력 레코드도 만들지 않는다.
    무거운 작업 없음(UpdateService 1회) — 메인 서버 무부하.

    전제조건:
      - status != ACTIVE → 409 (준비된 앱만 재시작 가능)
      - runtimeState == SLEEPING → 409 (잠자는 앱은 desiredCount=0 이라 forceNewDeployment 무의미;
        접속 주소로 들어가면 wake-on-request 로 자동 기동됨)
    """
    app = _load_owned_app(ctx)
    if app["status"] != "ACTIVE":
        raise errors.invalid_state("앱이 준비된 상태(정상)일 때만 다시 시작할 수 있어요.")
    if app.get("runtimeState") == "SLEEPING":
        raise errors.invalid_state(
            "앱이 잠자는 중이에요. 접속 주소로 들어가면 자동으로 켜져요."
        )

    stage = load_config().stage
    _force_new_deployment_or_friendly_error(stage, app["appId"])
    return ok(
        {
            "appId": app["appId"],
            "note": "앱을 다시 시작하고 있어요. 잠시 후(약 1분) 새로고침해 주세요.",
        }
    )


def _force_new_deployment_or_friendly_error(stage: str, app_id: str) -> None:
    """ecs.update_service(forceNewDeployment=True). ClientError 는 사용자용 친절 에러로 마스킹.

    cluster/service 규약(DESIGN.md D18)은 wake 헬퍼를 재사용한다(CLUSTER_NAME env + 이름 파생).
    """
    try:
        client("ecs").update_service(
            cluster=cluster_name(),
            service=app_service_name(stage, app_id),
            forceNewDeployment=True,
        )
    except Exception as err:  # noqa: BLE001 - AWS 예외를 사용자용 친절 에러로 변환
        raise errors.invalid_state(
            "지금은 앱을 다시 시작할 수 없어요. 잠시 후 다시 시도해주세요."
        ) from err


def load_owned_app(ctx: RouteContext) -> dict[str, Any]:
    """공유 로더: 앱 조회 + 소유자 검사. 없으면 404, 타인 앱이면 403."""
    app_id = ctx.params.get("id")
    if not app_id:
        raise errors.validation("앱 식별자가 필요해요.")
    app = get_app(app_id)
    if app is None:
        raise errors.not_found("앱을 찾을 수 없어요.")
    require_owner(ctx.identity, app)
    return app


# 하위 핸들러(deployments/logs)에서 재사용.
_load_owned_app = load_owned_app
