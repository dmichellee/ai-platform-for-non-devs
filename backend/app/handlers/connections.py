"""레포 연결 핸들러 (api-contract.md 레포 연결)."""

from __future__ import annotations

from ..data.apps import list_apps_by_owner
from ..data.cc_repos import delete_cc_repo, get_cc_repo, list_cc_repos, put_cc_repo
from ..data.config_repo import get_admin_settings
from ..data.connections import (
    delete_connection,
    get_connection,
    list_connections,
    put_connection,
)
from ..domain.ids import generate_conn_id
from ..domain.repo_name import build_repo_name, validate_repo_name
from ..domain.validate import parse_body
from ..http.errors import errors
from ..http.response import ProxyResult, created, list_response, no_content
from ..http.router import RouteContext
from ..integrations.codecommit import (
    RepositoryDoesNotExist,
    RepositoryNameExists,
    create_repository,
    delete_repository,
)
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
        raise errors.validation("이 기능은 AWS 저장소(CodeCommit) 연결에서만 쓸 수 있어요.")
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

    body 의 `repoName` 은 **base**(사용자 입력)를 의미하며, 서버가 소유자 접두어를 강제로
    붙인다 — 최종명 = `{ownerPrefix}-{base}`(domain/repo_name 규칙, 프론트 미리보기와 동일).
    실제 CodeCommit 레포 생성·DDB 소유권·응답의 repoName 은 모두 **접두어 포함 최종명**이다.

    → 201 {data:{repoName, cloneUrlHttp}} (repoName=최종명). base 이름 규칙 위반 또는
    최종명 길이 초과 시 VALIDATION_ERROR, 계정 전체에 동명(최종명) 존재 시 REPO_NAME_TAKEN(409).
    """
    _require_codecommit_connection(ctx)
    body = parse_body(ctx.event.get("body"))
    base_name = validate_repo_name(body.get("repoName"))
    full_repo_name = build_repo_name(ctx.identity, base_name)

    try:
        created_repo = create_repository(full_repo_name)
    except RepositoryNameExists as err:
        raise errors.repo_name_taken() from err

    repo = put_cc_repo(
        owner_id=ctx.identity.user_id,
        repo_name=created_repo["repoName"],
        clone_url_http=created_repo["cloneUrlHttp"],
    )
    return created(repo)


def _app_using_repo(owner_id: str, repo: dict) -> dict | None:
    """이 레포를 repoUrl 로 쓰는 본인 앱을 찾는다(없으면 None).

    검사 범위 = **본인 앱만**(GSI1 list_apps_by_owner). 근거: 이 레포는 사용자가 AppHub 로
    만든 것(소유권 아이템 PK=USER#{userId})이라 통상 그 레포로 만든 앱도 본인 것이다.
    계정 전체(GSI2) 스캔은 삭제 1건마다 전 앱을 훑어 비용/지연이 커서 "메인 서버 무부하"에
    반한다. (계약에 "본인 앱 기준" 명시.)

    매칭 규칙: cloneUrlHttp 정확 일치를 **우선**하고, 없으면 repoName 이 앱 repoUrl 에
    포함되는지로 **보조** 매칭한다(과거에 다른 clone URL 형태로 저장된 앱까지 안전하게 차단).
    """
    clone_url = repo.get("cloneUrlHttp") or ""
    repo_name = repo.get("repoName") or ""
    apps = list_apps_by_owner(owner_id)

    if clone_url:
        for app in apps:
            if app.get("repoUrl") == clone_url:
                return app
    if repo_name:
        # CodeCommit clone URL 은 `.../v1/repos/{repoName}` 로 끝나므로 레포명 세그먼트로 보조 매칭.
        for app in apps:
            repo_url = app.get("repoUrl") or ""
            if repo_url.rstrip("/").endswith(f"/{repo_name}"):
                return app
    return None


def delete_connection_repo(ctx: RouteContext) -> ProxyResult:
    """DELETE /connections/{connId}/repos/{repoName} — 본인이 만든 CodeCommit 레포 삭제.

    검증 순서:
      (1) 본인 codecommit 연결(_require_codecommit_connection — 아니면 404/400).
      (2) 소유권 아이템 존재(PK=USER#{userId}, SK=CCREPO#{repoName}) — 없으면 404.
      (3) 사용 중 차단: 본인 앱 중 이 레포를 쓰는 앱이 있으면 409 REPO_IN_USE(앱명 포함).
    통과 시: CodeCommit delete-repository → DDB 소유권 삭제 → 204.
    이미 밖에서 지워진 레포(RepositoryDoesNotExist)면 소유권만 정리하고 204(멱등).
    """
    _require_codecommit_connection(ctx)
    repo_name = ctx.params.get("repoName")
    if not repo_name:
        raise errors.validation("저장소 이름이 필요해요.")

    repo = get_cc_repo(ctx.identity.user_id, repo_name)
    if repo is None:
        raise errors.not_found("이 저장소를 찾을 수 없어요.")

    in_use = _app_using_repo(ctx.identity.user_id, repo)
    if in_use is not None:
        raise errors.repo_in_use(in_use.get("name"))

    try:
        delete_repository(repo_name)
    except RepositoryDoesNotExist:
        pass  # 밖에서 이미 지워짐 — 소유권만 정리(멱등).
    delete_cc_repo(ctx.identity.user_id, repo_name)
    return no_content()
