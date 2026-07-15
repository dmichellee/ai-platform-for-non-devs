"""마법사용 읽기 전용 카탈로그 핸들러 (일반 user 접근).

앱 생성 마법사가 프리셋(크기)·권한 템플릿(앱 유형)을 고르려면 목록이 필요하다.
관리자 CONFIG API(`/admin/*`)는 admin 전용이라 user 는 403 → 마법사 목록이 빈다.
이 모듈은 인증만 요구하는(admin 불필요) 읽기 전용 엔드포인트를 제공한다.

- GET /presets              → 프리셋 목록(admin GET 과 동일 shape). 프리셋 필드는 전부 무해.
- GET /permission-templates → 권한 템플릿 목록. **민감한 policyDocument 는 제외**하고
                              displayName/permId 만 노출(마법사 선택에는 이 둘이면 충분).
                              "기본"(permId="default")이 있으면 맨 앞에 정렬(마법사 첫 선택지).
- GET /subdomains/check     → 서브도메인 실시간 중복/형식 확인(입력 중 가벼운 확인).
- GET /providers            → 관리자가 활성화한 저장소 provider 목록(기능 요구사항 3:
                              연결 가능한 저장소 종류는 관리자가 활성/비활성).
                              연결 추가 화면이 활성 provider 카드만 보여주는 데 사용.

쓰기(생성/수정/삭제)는 여전히 `/admin/*`(admin 전용)에만 있다.
"""

from __future__ import annotations

from ..auth.identity import require_user
from ..data.config_repo import get_admin_settings, list_permission_templates, list_presets
from ..data.subdomains import subdomain_available
from ..domain.subdomain import validate_subdomain
from ..http.errors import ApiError
from ..http.response import ProxyResult, list_response, ok
from ..http.router import RouteContext


def get_presets_public(ctx: RouteContext) -> ProxyResult:
    """마법사: 프리셋 목록. 인증만 필요(admin 불필요). shape 은 admin GET 과 동일."""
    require_user(ctx.identity)
    return list_response(list_presets())


def get_permission_templates_public(ctx: RouteContext) -> ProxyResult:
    """마법사: 권한 템플릿 목록. 인증만 필요.

    policyDocument(IAM 정책 문서)는 민감하므로 노출하지 않는다.
    마법사 선택에 필요한 permId/displayName 만 반환한다.
    "기본"(permId="default", 추가 권한 없음)이 있으면 맨 앞에 정렬한다 —
    마법사 문구("잘 모르겠다면 '기본'을 고르세요")와 첫 선택지가 일치하도록.
    """
    require_user(ctx.identity)
    summaries = [
        {"permId": t.get("permId"), "displayName": t.get("displayName")}
        for t in list_permission_templates()
    ]
    summaries.sort(key=lambda t: 0 if t.get("permId") == "default" else 1)
    return list_response(summaries)


def get_providers_public(ctx: RouteContext) -> ProxyResult:
    """연결 추가 화면: 관리자가 활성화한 provider 목록. 인증만 필요.

    기능 요구사항 3 — 연결 가능한 저장소 종류는 관리자가 사전 설정으로 활성/비활성.
    화면은 이 목록에 있는 provider 카드만 노출한다(생성 시 서버 검증은 별도 유지).
    """
    require_user(ctx.identity)
    enabled = get_admin_settings().get("enabledProviders") or []
    items = [p for p in enabled if isinstance(p, str)]
    return list_response(items)


def check_subdomain(ctx: RouteContext) -> ProxyResult:
    """마법사: 서브도메인 실시간 확인. 인증만 필요.

    `?value={sub}` 형식 → `{data:{available: bool, reason?: "INVALID"|"TAKEN"}}`.
    형식 위반이면 available=false, reason="INVALID"(SUBDOMAIN_INVALID 를 던지지 않고 판정 결과로).
    전역 예약 아이템이 있으면 available=false, reason="TAKEN".
    가벼운 확인용 — 원자적 예약은 앱 생성 시(POST /apps)에만 일어난다.
    """
    require_user(ctx.identity)
    value = (ctx.query.get("value") or "").strip()
    if value == "":
        return ok({"available": False, "reason": "INVALID"})

    try:
        validate_subdomain(value)
    except ApiError:
        return ok({"available": False, "reason": "INVALID"})

    if not subdomain_available(value):
        return ok({"available": False, "reason": "TAKEN"})
    return ok({"available": True})
