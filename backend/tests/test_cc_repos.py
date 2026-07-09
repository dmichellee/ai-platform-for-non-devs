"""L1 — CodeCommit 레포 소유권/드롭다운 API.

- 레포 생성 → 소유권 DDB 기록 → 목록에 본인 것만(타인 것 안 보임)
- 이름 규칙 검증, 계정 전체 중복(REPO_NAME_TAKEN)
- 본인 아닌/없는 연결 처리(NOT_FOUND — 존재 흘리지 않음), github 연결에 repos 호출(VALIDATION_ERROR)
- data 계층 + 통합 계층 단위 검증

CodeCommit 은 moto(create_repository/get_repository 지원)로 실제 호출을 흉내낸다.
목록 API 는 DDB(cc_repos) 만 읽으므로 moto 의 list_repositories 미지원과 무관하다.
"""

from __future__ import annotations

from app.handler import handler

from .conftest import make_event, parse_result

OWNER = "user-alice"
OTHER = "user-bob"


# ── 시드 헬퍼 ──────────────────────────────────────────────────────────────────


def _seed_connection(table, owner_id: str, conn_id: str, provider: str = "codecommit") -> None:
    table.put_item(
        Item={
            "PK": f"USER#{owner_id}",
            "SK": f"CONN#{conn_id}",
            "entityType": "RepoConnection",
            "connId": conn_id,
            "ownerId": owner_id,
            "provider": provider,
            "connectionArn": f"{provider}:{conn_id}",
            "status": "AVAILABLE",
            "displayName": "내 저장소",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }
    )


# ── POST /connections/{connId}/repos — 생성 + 소유권 기록 ────────────────────────


def test_create_repo_records_ownership_and_returns_clone_url(ddb_table, stub_clients):
    _seed_connection(ddb_table, OWNER, "c1")
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            body={"repoName": "my-app"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["repoName"] == "my-app"
    assert out["data"]["cloneUrlHttp"].startswith("https://")
    # 계약 shape: repoName/cloneUrlHttp 만
    assert set(out["data"].keys()) == {"repoName", "cloneUrlHttp"}


def test_created_repo_appears_only_for_owner(ddb_table, stub_clients):
    _seed_connection(ddb_table, OWNER, "c1")
    _seed_connection(ddb_table, OTHER, "c2")
    handler(
        make_event(
            "POST", "/connections/c1/repos",
            user_id=OWNER, groups=["user"], body={"repoName": "alice-repo"},
        )
    )
    # OWNER 목록엔 보임
    mine = parse_result(
        handler(make_event("GET", "/connections/c1/repos", user_id=OWNER, groups=["user"]))
    )
    assert mine["status"] == 200
    assert [r["repoName"] for r in mine["data"]["items"]] == ["alice-repo"]
    # OTHER 목록엔 안 보임(본인이 만든 것만)
    theirs = parse_result(
        handler(make_event("GET", "/connections/c2/repos", user_id=OTHER, groups=["user"]))
    )
    assert theirs["status"] == 200
    assert theirs["data"]["items"] == []


def test_repo_url_from_repos_flows_into_app_create(ddb_table, stub_clients):
    """생성된 레포의 cloneUrlHttp 가 앱 생성 repoUrl 로 쓰일 수 있는지(계약 정합) 확인."""
    _seed_connection(ddb_table, OWNER, "c1")
    created = parse_result(
        handler(
            make_event(
                "POST", "/connections/c1/repos",
                user_id=OWNER, groups=["user"], body={"repoName": "flow-repo"},
            )
        )
    )
    clone_url = created["data"]["cloneUrlHttp"]
    assert "flow-repo" in clone_url


# ── 이름 규칙 / 중복 ────────────────────────────────────────────────────────────


def test_invalid_repo_name_rejected(ddb_table, stub_clients):
    _seed_connection(ddb_table, OWNER, "c1")
    for bad in ["Bad Name", "UPPER", "-leadinghyphen", "trailingdot.", "has/slash", ""]:
        res = handler(
            make_event(
                "POST", "/connections/c1/repos",
                user_id=OWNER, groups=["user"], body={"repoName": bad},
            )
        )
        assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR", bad


def test_duplicate_repo_name_conflict(ddb_table, stub_clients):
    _seed_connection(ddb_table, OWNER, "c1")
    handler(
        make_event(
            "POST", "/connections/c1/repos",
            user_id=OWNER, groups=["user"], body={"repoName": "dup"},
        )
    )
    # 계정 전체에 동명 존재 → REPO_NAME_TAKEN (CodeCommit RepositoryNameExistsException)
    res = handler(
        make_event(
            "POST", "/connections/c1/repos",
            user_id=OWNER, groups=["user"], body={"repoName": "dup"},
        )
    )
    assert parse_result(res)["error"]["code"] == "REPO_NAME_TAKEN"


# ── 인가 / provider 경계 ────────────────────────────────────────────────────────


def test_other_users_connection_not_found(ddb_table, stub_clients):
    """타인 연결 id 로 접근 → NOT_FOUND(본인 파티션에 없으므로 존재 여부 안 흘림)."""
    _seed_connection(ddb_table, OTHER, "c-bob")
    res = handler(
        make_event("GET", "/connections/c-bob/repos", user_id=OWNER, groups=["user"])
    )
    assert parse_result(res)["status"] == 404


def test_create_repo_on_other_connection_forbidden_as_not_found(ddb_table, stub_clients):
    _seed_connection(ddb_table, OTHER, "c-bob")
    res = handler(
        make_event(
            "POST", "/connections/c-bob/repos",
            user_id=OWNER, groups=["user"], body={"repoName": "sneaky"},
        )
    )
    assert parse_result(res)["status"] == 404


def test_github_connection_repos_rejected(ddb_table, stub_clients):
    """github 연결에 repos 호출 → VALIDATION_ERROR(이 API 는 codecommit 전용)."""
    _seed_connection(ddb_table, OWNER, "cgh", provider="github")
    res = handler(
        make_event("GET", "/connections/cgh/repos", user_id=OWNER, groups=["user"])
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_github_connection_create_repo_rejected(ddb_table, stub_clients):
    _seed_connection(ddb_table, OWNER, "cgh", provider="gitlab")
    res = handler(
        make_event(
            "POST", "/connections/cgh/repos",
            user_id=OWNER, groups=["user"], body={"repoName": "x"},
        )
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"


def test_missing_connection_not_found(ddb_table, stub_clients):
    res = handler(
        make_event("GET", "/connections/nope/repos", user_id=OWNER, groups=["user"])
    )
    assert parse_result(res)["status"] == 404


# ── data / 통합 계층 단위 ───────────────────────────────────────────────────────


def test_data_layer_put_list_owned(ddb_table):
    from app.data.cc_repos import cc_repo_owned_by, list_cc_repos, put_cc_repo

    put_cc_repo(OWNER, "r1", "https://git-codecommit/r1")
    put_cc_repo(OWNER, "r2", "https://git-codecommit/r2")
    put_cc_repo(OTHER, "r3", "https://git-codecommit/r3")

    names = sorted(r["repoName"] for r in list_cc_repos(OWNER))
    assert names == ["r1", "r2"]
    assert cc_repo_owned_by(OWNER, "r1") is True
    assert cc_repo_owned_by(OWNER, "r3") is False


def test_integration_create_and_get(ddb_table):
    from app.integrations.codecommit import RepositoryNameExists, create_repository, get_repository

    made = create_repository("integ-repo")
    assert made["repoName"] == "integ-repo"
    assert made["cloneUrlHttp"].startswith("https://")

    got = get_repository("integ-repo")
    assert got is not None and got["repoName"] == "integ-repo"
    assert get_repository("does-not-exist") is None

    import pytest

    with pytest.raises(RepositoryNameExists):
        create_repository("integ-repo")
