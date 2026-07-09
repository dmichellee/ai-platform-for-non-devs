"""L1 — CodeCommit 레포 소유권/드롭다운 API + 소유자 접두어(사용자 결정).

- 레포 생성 → 서버가 소유자 접두어 부착(최종명 = {ownerPrefix}-{base})
- 접두어 규칙: email 로컬파트 정제 우선, 없으면 sub 앞 8자 폴백(프론트 미리보기와 동일)
- 소유권 DDB 기록·목록·응답의 repoName 은 모두 접두어 포함 최종명
- base 이름 규칙 검증, 최종명 길이 초과 거부, 계정 전체 중복(REPO_NAME_TAKEN, 최종명 기준)
- 본인 아닌/없는 연결 처리(NOT_FOUND — 존재 흘리지 않음), github 연결에 repos 호출(VALIDATION_ERROR)
- data 계층 + 통합 계층 단위 검증

CodeCommit 은 moto(create_repository/get_repository 지원)로 실제 호출을 흉내낸다.
목록 API 는 DDB(cc_repos) 만 읽으므로 moto 의 list_repositories 미지원과 무관하다.
"""

from __future__ import annotations

from app.handler import handler

from .conftest import StubClient, make_event, parse_result, seed_app

OWNER = "user-alice"
OTHER = "user-bob"

# 접두어 규칙에 따른 기대값(테스트 self-doc):
#   email 있는 경우 → 로컬파트 정제. email 없는 경우 → sub 앞 8자(소문자).
OWNER_EMAIL = "Alice.Kim@example.com"
OWNER_EMAIL_PREFIX = "alice.kim"  # 로컬파트 소문자화(허용 문자만)
OWNER_SUB_PREFIX = "user-ali"  # user_id="user-alice" 의 앞 8자(email 미제공 시 폴백)
OTHER_SUB_PREFIX = "user-bob"  # user_id="user-bob" 는 8자 이하 → 그대로


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


# ── POST /connections/{connId}/repos — 생성 + 소유자 접두어 부착 + 소유권 기록 ─────


def test_create_repo_prefixes_email_local_part(ddb_table, stub_clients):
    """email 이 있으면 로컬파트를 접두어로 붙인다: base 'my-app' → 'alice.kim-my-app'."""
    _seed_connection(ddb_table, OWNER, "c1")
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email=OWNER_EMAIL,
            body={"repoName": "my-app"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["repoName"] == f"{OWNER_EMAIL_PREFIX}-my-app"
    assert out["data"]["cloneUrlHttp"].startswith("https://")
    # 최종명이 clone URL 에도 반영(레포가 최종명으로 생성됨)
    assert f"{OWNER_EMAIL_PREFIX}-my-app" in out["data"]["cloneUrlHttp"]
    # 계약 shape: repoName/cloneUrlHttp 만
    assert set(out["data"].keys()) == {"repoName", "cloneUrlHttp"}


def test_create_repo_falls_back_to_sub_when_no_email(ddb_table, stub_clients):
    """email 클레임이 없으면 sub 앞 8자를 접두어로 붙인다: 'my-app' → 'user-ali-my-app'."""
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
    assert out["data"]["repoName"] == f"{OWNER_SUB_PREFIX}-my-app"


def test_created_repo_appears_only_for_owner_with_final_name(ddb_table, stub_clients):
    """목록에는 접두어 포함 최종명이 본인 것만 나타난다(타인 것 안 보임)."""
    _seed_connection(ddb_table, OWNER, "c1")
    _seed_connection(ddb_table, OTHER, "c2")
    handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email=OWNER_EMAIL,
            body={"repoName": "alice-repo"},
        )
    )
    # OWNER 목록엔 최종명으로 보임
    mine = parse_result(
        handler(make_event("GET", "/connections/c1/repos", user_id=OWNER, groups=["user"]))
    )
    assert mine["status"] == 200
    assert [r["repoName"] for r in mine["data"]["items"]] == [f"{OWNER_EMAIL_PREFIX}-alice-repo"]
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
                "POST",
                "/connections/c1/repos",
                user_id=OWNER,
                groups=["user"],
                email=OWNER_EMAIL,
                body={"repoName": "flow-repo"},
            )
        )
    )
    clone_url = created["data"]["cloneUrlHttp"]
    # 최종명(접두어 포함)이 clone URL 에 담긴다.
    assert f"{OWNER_EMAIL_PREFIX}-flow-repo" in clone_url


# ── 접두어 정제 규칙(대문자/특수문자) ────────────────────────────────────────────


def test_email_prefix_sanitizes_uppercase_and_special_chars(ddb_table, stub_clients):
    """대문자·허용 외 특수문자 정제, 앞뒤 구분자 제거: '.-Bob+Lee-.@x' → 'bob-lee'."""
    _seed_connection(ddb_table, OTHER, "c1")
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OTHER,
            groups=["user"],
            email=".-Bob+Lee-.@example.com",
            body={"repoName": "svc"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    # 'Bob+Lee' → 소문자 'bob+lee' → '+' 를 '-' 로 → 'bob-lee'; 앞뒤 '.-','-.'  제거.
    assert out["data"]["repoName"] == "bob-lee-svc"


def test_email_prefix_all_special_falls_back_to_sub(ddb_table, stub_clients):
    """로컬파트가 정제 후 비면 sub 앞 8자로 폴백: '+++@x' → sub 폴백."""
    _seed_connection(ddb_table, OWNER, "c1")
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email="+++@example.com",  # 정제 후 '---' → strip → ''
            body={"repoName": "app"},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["repoName"] == f"{OWNER_SUB_PREFIX}-app"


# ── base 이름 규칙 / 최종명 길이 / 중복 ──────────────────────────────────────────


def test_invalid_base_name_rejected(ddb_table, stub_clients):
    """base(사용자 입력)에 이름 규칙을 적용한다."""
    _seed_connection(ddb_table, OWNER, "c1")
    for bad in ["Bad Name", "UPPER", "-leadinghyphen", "trailingdot.", "has/slash", ""]:
        res = handler(
            make_event(
                "POST",
                "/connections/c1/repos",
                user_id=OWNER,
                groups=["user"],
                email=OWNER_EMAIL,
                body={"repoName": bad},
            )
        )
        assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR", bad


def test_final_name_too_long_rejected(ddb_table, stub_clients):
    """base 자체는 100자 이하라도 접두어 결합 후 100자 초과면 VALIDATION_ERROR."""
    _seed_connection(ddb_table, OWNER, "c1")
    # 접두어 'alice.kim-' 는 10자 → base 91자면 최종 101자 → 초과.
    base = "a" * 91
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email=OWNER_EMAIL,
            body={"repoName": base},
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_final_name_at_limit_accepted(ddb_table, stub_clients):
    """접두어 결합 후 정확히 100자면 통과."""
    _seed_connection(ddb_table, OWNER, "c1")
    base = "a" * 90  # 'alice.kim-' (10) + 90 = 100
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email=OWNER_EMAIL,
            body={"repoName": base},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    assert len(out["data"]["repoName"]) == 100


def test_duplicate_final_name_conflict(ddb_table, stub_clients):
    """동일 소유자가 같은 base 를 두 번 → 같은 최종명 → REPO_NAME_TAKEN(계정 전체 기준)."""
    _seed_connection(ddb_table, OWNER, "c1")
    handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email=OWNER_EMAIL,
            body={"repoName": "dup"},
        )
    )
    res = handler(
        make_event(
            "POST",
            "/connections/c1/repos",
            user_id=OWNER,
            groups=["user"],
            email=OWNER_EMAIL,
            body={"repoName": "dup"},
        )
    )
    assert parse_result(res)["error"]["code"] == "REPO_NAME_TAKEN"


def test_different_owners_same_base_no_conflict(ddb_table, stub_clients):
    """접두어가 다르면 같은 base 라도 최종명이 달라 충돌하지 않는다(소유자 격리)."""
    _seed_connection(ddb_table, OWNER, "c1")
    _seed_connection(ddb_table, OTHER, "c2")
    a = parse_result(
        handler(
            make_event(
                "POST",
                "/connections/c1/repos",
                user_id=OWNER,
                groups=["user"],
                email=OWNER_EMAIL,
                body={"repoName": "shared"},
            )
        )
    )
    b = parse_result(
        handler(
            make_event(
                "POST",
                "/connections/c2/repos",
                user_id=OTHER,
                groups=["user"],  # email 없음 → sub 폴백
                body={"repoName": "shared"},
            )
        )
    )
    assert a["status"] == 201 and b["status"] == 201
    assert a["data"]["repoName"] == f"{OWNER_EMAIL_PREFIX}-shared"
    assert b["data"]["repoName"] == f"{OTHER_SUB_PREFIX}-shared"
    assert a["data"]["repoName"] != b["data"]["repoName"]


# ── 인가 / provider 경계 ────────────────────────────────────────────────────────


def test_other_users_connection_not_found(ddb_table, stub_clients):
    """타인 연결 id 로 접근 → NOT_FOUND(본인 파티션에 없으므로 존재 여부 안 흘림)."""
    _seed_connection(ddb_table, OTHER, "c-bob")
    res = handler(make_event("GET", "/connections/c-bob/repos", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 404


def test_create_repo_on_other_connection_forbidden_as_not_found(ddb_table, stub_clients):
    _seed_connection(ddb_table, OTHER, "c-bob")
    res = handler(
        make_event(
            "POST",
            "/connections/c-bob/repos",
            user_id=OWNER,
            groups=["user"],
            body={"repoName": "sneaky"},
        )
    )
    assert parse_result(res)["status"] == 404


def test_github_connection_repos_rejected(ddb_table, stub_clients):
    """github 연결에 repos 호출 → VALIDATION_ERROR(이 API 는 codecommit 전용)."""
    _seed_connection(ddb_table, OWNER, "cgh", provider="github")
    res = handler(make_event("GET", "/connections/cgh/repos", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_github_connection_create_repo_rejected(ddb_table, stub_clients):
    _seed_connection(ddb_table, OWNER, "cgh", provider="gitlab")
    res = handler(
        make_event(
            "POST",
            "/connections/cgh/repos",
            user_id=OWNER,
            groups=["user"],
            body={"repoName": "x"},
        )
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"


def test_missing_connection_not_found(ddb_table, stub_clients):
    res = handler(make_event("GET", "/connections/nope/repos", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 404


# ── 접두어 규칙 단위(도메인 함수 직접) ──────────────────────────────────────────


def test_owner_prefix_rules():
    from app.auth.identity import Identity
    from app.domain.repo_name import build_repo_name, owner_prefix

    # email 로컬파트 정제
    assert owner_prefix(Identity(user_id="s", email="Alice.Kim@example.com")) == "alice.kim"
    # 특수문자 치환 + 앞뒤 구분자 제거
    assert owner_prefix(Identity(user_id="s", email=".-Bob+Lee-.@x.com")) == "bob-lee"
    # 밑줄/점/하이픈은 허용 문자
    assert owner_prefix(Identity(user_id="s", email="jane_doe.dev@x")) == "jane_doe.dev"
    # email 없음 → sub 앞 8자 소문자
    assert owner_prefix(Identity(user_id="ABCDEFGHIJK", email=None)) == "abcdefgh"
    # email 정제 후 빔 → sub 폴백
    assert owner_prefix(Identity(user_id="fallback9", email="+++@x")) == "fallback"
    # 최종명 조립
    assert build_repo_name(Identity(user_id="s", email="a@x"), "app") == "a-app"


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


# ── DELETE /connections/{connId}/repos/{repoName} — 레포 삭제 ────────────────────


def _create_repo(conn_id: str, owner_id: str, base: str, email: str | None = None) -> dict:
    """헬퍼: 레포 생성 후 응답 data({repoName, cloneUrlHttp}) 반환."""
    res = handler(
        make_event(
            "POST",
            f"/connections/{conn_id}/repos",
            user_id=owner_id,
            groups=["user"],
            email=email,
            body={"repoName": base},
        )
    )
    out = parse_result(res)
    assert out["status"] == 201, out
    return out["data"]


def test_delete_repo_removes_codecommit_and_ownership(ddb_table, stub_clients):
    """정상 삭제: CodeCommit 레포가 실제로 지워지고 소유권 아이템도 사라진다 → 204."""
    from app.integrations.codecommit import get_repository

    _seed_connection(ddb_table, OWNER, "c1")
    repo = _create_repo("c1", OWNER, "to-delete", email=OWNER_EMAIL)
    final_name = repo["repoName"]  # 접두어 포함 최종명
    # 사전 조건: moto CodeCommit 에 실제로 존재.
    assert get_repository(final_name) is not None

    res = handler(
        make_event(
            "DELETE",
            f"/connections/c1/repos/{final_name}",
            user_id=OWNER,
            groups=["user"],
        )
    )
    out = parse_result(res)
    assert out["status"] == 204
    assert res["body"] == ""  # 204 본문 없음
    # CodeCommit 레포가 실제로 삭제됨.
    assert get_repository(final_name) is None
    # 소유권 아이템도 제거되어 목록에서 사라짐.
    listed = parse_result(
        handler(make_event("GET", "/connections/c1/repos", user_id=OWNER, groups=["user"]))
    )
    assert listed["data"]["items"] == []


def test_delete_repo_in_use_conflict_with_app_name(ddb_table, stub_clients):
    """이 레포를 쓰는 본인 앱이 있으면 409 REPO_IN_USE(앱 이름 포함), 레포는 유지."""
    from app.integrations.codecommit import get_repository

    _seed_connection(ddb_table, OWNER, "c1")
    repo = _create_repo("c1", OWNER, "used-repo", email=OWNER_EMAIL)
    final_name = repo["repoName"]
    # 이 레포의 cloneUrlHttp 를 repoUrl 로 쓰는 앱을 시드.
    seed_app(
        ddb_table,
        app_id="app11111",
        owner_id=OWNER,
        name="내 매출 대시보드",
        repoUrl=repo["cloneUrlHttp"],
    )

    res = handler(
        make_event(
            "DELETE",
            f"/connections/c1/repos/{final_name}",
            user_id=OWNER,
            groups=["user"],
        )
    )
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "REPO_IN_USE"
    assert "내 매출 대시보드" in out["error"]["message"]
    # 차단됐으므로 CodeCommit 레포는 그대로 남아 있어야 한다.
    assert get_repository(final_name) is not None


def test_delete_repo_in_use_matched_by_repo_name_suffix(ddb_table, stub_clients):
    """cloneUrlHttp 정확 일치가 아니어도 repoUrl 이 `/{repoName}` 으로 끝나면 사용 중으로 차단."""
    _seed_connection(ddb_table, OWNER, "c1")
    repo = _create_repo("c1", OWNER, "suffix-repo", email=OWNER_EMAIL)
    final_name = repo["repoName"]
    # 다른 형태의 clone URL(예: ssh 또는 축약형)이라도 레포명 세그먼트로 끝나면 매칭.
    seed_app(
        ddb_table,
        app_id="app22222",
        owner_id=OWNER,
        name="다른 앱",
        repoUrl=f"ssh://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/{final_name}",
    )
    res = handler(
        make_event(
            "DELETE",
            f"/connections/c1/repos/{final_name}",
            user_id=OWNER,
            groups=["user"],
        )
    )
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "REPO_IN_USE"


def test_delete_repo_not_in_use_when_other_users_app_uses_it(ddb_table, stub_clients):
    """검사 범위는 본인 앱만 — 타인 앱이 이 레포를 써도 본인 삭제는 통과(계약: 본인 앱 기준)."""
    from app.integrations.codecommit import get_repository

    _seed_connection(ddb_table, OWNER, "c1")
    repo = _create_repo("c1", OWNER, "shared-repo", email=OWNER_EMAIL)
    final_name = repo["repoName"]
    # 타인(OTHER) 앱이 같은 레포를 사용 — 본인 앱 목록(GSI1)에는 안 잡힌다.
    seed_app(
        ddb_table,
        app_id="app33333",
        owner_id=OTHER,
        name="남의 앱",
        repoUrl=repo["cloneUrlHttp"],
    )
    res = handler(
        make_event(
            "DELETE",
            f"/connections/c1/repos/{final_name}",
            user_id=OWNER,
            groups=["user"],
        )
    )
    assert parse_result(res)["status"] == 204
    assert get_repository(final_name) is None


def test_delete_missing_repo_not_found(ddb_table, stub_clients):
    """소유권 아이템이 없는 레포 → 404 NOT_FOUND."""
    _seed_connection(ddb_table, OWNER, "c1")
    res = handler(
        make_event(
            "DELETE",
            "/connections/c1/repos/nonexistent-repo",
            user_id=OWNER,
            groups=["user"],
        )
    )
    out = parse_result(res)
    assert out["status"] == 404
    assert out["error"]["code"] == "NOT_FOUND"
    assert "찾을 수 없어요" in out["error"]["message"]


def test_delete_other_users_repo_not_found(ddb_table, stub_clients):
    """타인이 만든 레포명으로 삭제 시도 → 본인 소유권 아이템 없음 → 404(존재 여부 안 흘림)."""
    _seed_connection(ddb_table, OWNER, "c1")
    _seed_connection(ddb_table, OTHER, "c2")
    other_repo = _create_repo("c2", OTHER, "bob-secret")  # email 없음 → sub 폴백
    other_final = other_repo["repoName"]
    # OWNER 가 OTHER 의 레포명을 자기 연결로 지우려 함 → 본인 파티션에 없음 → 404.
    res = handler(
        make_event(
            "DELETE",
            f"/connections/c1/repos/{other_final}",
            user_id=OWNER,
            groups=["user"],
        )
    )
    assert parse_result(res)["status"] == 404


def test_delete_repo_on_other_connection_not_found(ddb_table, stub_clients):
    """타인 연결 id 로 삭제 시도 → 연결 단계에서 404(존재 여부 안 흘림)."""
    _seed_connection(ddb_table, OTHER, "c-bob")
    res = handler(
        make_event(
            "DELETE",
            "/connections/c-bob/repos/anything",
            user_id=OWNER,
            groups=["user"],
        )
    )
    assert parse_result(res)["status"] == 404


def test_delete_repo_already_gone_is_idempotent_204(ddb_table, stub_clients):
    """CodeCommit 에서 밖으로 이미 지워진 레포 → 소유권만 정리하고 204(멱등).

    moto delete_repository 는 없는 레포에도 예외를 안 던지므로, stub 클라이언트로
    RepositoryDoesNotExistException 을 주입해 멱등 경로를 검증한다.
    """
    from app.data.cc_repos import get_cc_repo, put_cc_repo
    from app.integrations import clients as integ_clients
    from botocore.exceptions import ClientError

    _seed_connection(ddb_table, OWNER, "c1")
    # 소유권 아이템만 존재(레포는 CodeCommit 에서 이미 사라진 상태를 가정).
    put_cc_repo(OWNER, "ghost-repo", "https://git-codecommit/ghost-repo")

    cc_stub = StubClient()
    cc_stub.set_raise(
        "delete_repository",
        ClientError(
            {"Error": {"Code": "RepositoryDoesNotExistException", "Message": "gone"}},
            "DeleteRepository",
        ),
    )
    integ_clients.set_client("codecommit", cc_stub)

    res = handler(
        make_event(
            "DELETE",
            "/connections/c1/repos/ghost-repo",
            user_id=OWNER,
            groups=["user"],
        )
    )
    assert parse_result(res)["status"] == 204
    # delete_repository 가 시도됐고(멱등), 소유권 아이템은 정리됐다.
    assert cc_stub.calls_for("delete_repository") == [{"repositoryName": "ghost-repo"}]
    assert get_cc_repo(OWNER, "ghost-repo") is None


def test_delete_repo_github_connection_rejected(ddb_table, stub_clients):
    """github/gitlab 연결에 레포 삭제 호출 → VALIDATION_ERROR(이 API 는 codecommit 전용)."""
    _seed_connection(ddb_table, OWNER, "cgh", provider="github")
    res = handler(
        make_event(
            "DELETE",
            "/connections/cgh/repos/whatever",
            user_id=OWNER,
            groups=["user"],
        )
    )
    out = parse_result(res)
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"
