"""레포 연결 핸들러 (api-contract.md 레포 연결)."""

from __future__ import annotations

from ..data.cc_repos import list_cc_repos, put_cc_repo
from ..data.config_repo import get_admin_settings
from ..data.connections import (
    delete_connection,
    get_connection,
    list_connections,
    put_connection,
)
from ..domain.ids import generate_conn_id
from ..domain.repo_name import validate_repo_name
from ..domain.validate import parse_body
from ..http.errors import errors
from ..http.response import ProxyResult, created, list_response, no_content
from ..http.router import RouteContext
from ..integrations.codecommit import RepositoryNameExists, create_repository
from ..integrations.codeconnections import (
    create_provider_connection,
    delete_provider_connection,
    refresh_connection_status,
)

_PROVIDERS = ("codecommit", "github", "gitlab")


def list_my_connections(ctx: RouteContext) -> ProxyResult:
    """GET /connections — 본인 목록. github/gitlab PENDING은 최신 상태로 갱신 반영."""
    conns = list_connections(ctx.identity.user_id)
    refreshed = [_refresh_if_pending(c) for c in conns]
    return list_response(refreshed)


def _refresh_if_pending(conn: dict) -> dict:
    if conn["provider"] != "codecommit" and conn["status"] == "PENDING":
        try:
            status = refresh_connection_status(conn["connectionArn"])
            if status != conn["status"]:
                return put_connection(
                    conn_id=conn["connId"],
                    owner_id=conn["ownerId"],
                    provider=conn["provider"],
                    connection_arn=conn["connectionArn"],
                    status=status,
                    display_name=conn["displayName"],
                )
        except Exception:
            pass  # 조회 실패 시 저장된 상태 그대로
    return conn


def create_my_connection(ctx: RouteContext) -> ProxyResult:
    """POST /connections — 연결 생성. body {provider, displayName}.

    codecommit: 즉시 AVAILABLE. github/gitlab: CodeConnections 생성(PENDING).
    """
    body = parse_body(ctx.event.get("body"))
    provider = body.get("provider")
    display_name = body.get("displayName")
    if not isinstance(provider, str) or provider not in _PROVIDERS:
        raise errors.validation("지원하지 않는 저장소 방식이에요.")
    if not isinstance(display_name, str) or display_name == "":
        raise errors.validation("연결 이름을 입력해주세요.")

    settings = get_admin_settings()
    if provider not in settings["enabledProviders"]:
        raise errors.provider_disabled()

    conn_id = generate_conn_id()

    if provider == "codecommit":
        conn = put_connection(
            conn_id=conn_id,
            owner_id=ctx.identity.user_id,
            provider="codecommit",
            connection_arn=f"codecommit:{conn_id}",  # 가상 식별자(외부 연동 없음)
            status="AVAILABLE",
            display_name=display_name,
        )
        return created({**conn, "needsAuthorization": False})

    # github/gitlab: CodeConnections 생성.
    cc = create_provider_connection(provider, display_name)
    conn = put_connection(
        conn_id=conn_id,
        owner_id=ctx.identity.user_id,
        provider=provider,
        connection_arn=cc["connectionArn"],
        status=cc["status"],
        display_name=display_name,
    )
    return created({**conn, "needsAuthorization": cc["needsAuthorization"]})


def delete_my_connection(ctx: RouteContext) -> ProxyResult:
    """DELETE /connections/{connId} — 본인 연결만 삭제."""
    conn_id = ctx.params.get("connId")
    if not conn_id:
        raise errors.validation("연결 식별자가 필요해요.")
    conn = get_connection(ctx.identity.user_id, conn_id)
    if conn is None:
        raise errors.not_found("연결을 찾을 수 없어요.")
    if conn["provider"] != "codecommit":
        try:
            delete_provider_connection(conn["connectionArn"])
        except Exception:
            pass
    delete_connection(ctx.identity.user_id, conn_id)
    return no_content()


# ── CodeCommit 레포 (앱 생성 마법사: 본인이 만든 레포 드롭다운 + 새로 만들기) ──────


def _require_codecommit_connection(ctx: RouteContext) -> dict:
    """경로의 연결이 본인 소유이며 codecommit 인지 확인. 아니면 적절한 에러.

    - 본인 연결이 아님/없음: NOT_FOUND(존재 여부를 흘리지 않음 — 본인 것만 조회).
    - codecommit 이 아님(github/gitlab): VALIDATION_ERROR(이 API 는 AWS 저장소 전용).
    """
    conn_id = ctx.params.get("connId")
    if not conn_id:
        raise errors.validation("연결 식별자가 필요해요.")
    conn = get_connection(ctx.identity.user_id, conn_id)
    if conn is None:
        raise errors.not_found("연결을 찾을 수 없어요.")
    if conn["provider"] != "codecommit":
        raise errors.validation(
            "이 기능은 AWS 저장소(CodeCommit) 연결에서만 쓸 수 있어요."
        )
    return conn


def list_connection_repos(ctx: RouteContext) -> ProxyResult:
    """GET /connections/{connId}/repos — 본인이 AppHub로 만든 CodeCommit 레포 목록.

    각 항목 {repoName, cloneUrlHttp}. 본인 codecommit 연결에만 유효.
    소유권은 DDB(cc_repos)로 추적 — 계정 전체 list-repositories 를 노출하지 않는다.
    """
    _require_codecommit_connection(ctx)
    repos = list_cc_repos(ctx.identity.user_id)
    return list_response(repos)


def create_connection_repo(ctx: RouteContext) -> ProxyResult:
    """POST /connections/{connId}/repos — body {repoName}. CodeCommit 레포 생성 + 소유권 기록.

    → 201 {data:{repoName, cloneUrlHttp}}. 이름 규칙 위반 VALIDATION_ERROR,
    계정 전체에 동명 존재 시 REPO_NAME_TAKEN(409).
    """
    _require_codecommit_connection(ctx)
    body = parse_body(ctx.event.get("body"))
    repo_name = validate_repo_name(body.get("repoName"))

    try:
        created_repo = create_repository(repo_name)
    except RepositoryNameExists as err:
        raise errors.repo_name_taken() from err

    repo = put_cc_repo(
        owner_id=ctx.identity.user_id,
        repo_name=created_repo["repoName"],
        clone_url_http=created_repo["cloneUrlHttp"],
    )
    return created(repo)
