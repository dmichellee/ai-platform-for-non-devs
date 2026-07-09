"""CodeCommit 레포 소유권 데이터 액세스 (CodeCommitRepo).

PK=USER#{userId}, SK=CCREPO#{repoName}.

배경: CodeCommit `list-repositories` 는 계정 전체 레포를 반환하고 "누가 만들었는지"
필터가 없다. "본인이 AppHub로 만든 레포만" 보이게 하려면 플랫폼이 소유권을 DDB로
자체 추적해야 한다. 사용자가 AppHub에서 레포를 **생성**할 때 이 소유권 아이템을 기록하고,
목록 조회는 이 아이템만 반환한다(계정 전체 list-repositories 는 목록 API 경로에 쓰지 않는다).
"""

from __future__ import annotations

from typing import Any

from boto3.dynamodb.conditions import Key

from ..util import now_iso
from .client import clean_item, strip_item, table
from .keys import SkPrefix, ccrepo_sk, user_pk

_CCREPO_DROP = ("PK", "SK", "entityType", "ownerId", "createdAt")


def _to_repo(item: dict[str, Any] | None) -> dict[str, Any] | None:
    """목록/조회 응답용 정제 — 계약 shape {repoName, cloneUrlHttp} 만 남긴다."""
    return strip_item(item, _CCREPO_DROP)


def put_cc_repo(owner_id: str, repo_name: str, clone_url_http: str) -> dict[str, Any]:
    """소유권 기록. 응답 shape {repoName, cloneUrlHttp}(계약 정합)."""
    now = now_iso()
    repo: dict[str, Any] = {"repoName": repo_name, "cloneUrlHttp": clone_url_http}
    item = clean_item(
        {
            "PK": user_pk(owner_id),
            "SK": ccrepo_sk(repo_name),
            "entityType": "CodeCommitRepo",
            "ownerId": owner_id,
            "createdAt": now,
            **repo,
        }
    )
    table().put_item(Item=item)
    return repo


def list_cc_repos(owner_id: str) -> list[dict[str, Any]]:
    """본인이 AppHub로 만든 CodeCommit 레포 목록. 각 항목 {repoName, cloneUrlHttp}."""
    res = table().query(
        KeyConditionExpression=Key("PK").eq(user_pk(owner_id))
        & Key("SK").begins_with(SkPrefix.CCREPO),
    )
    return [_to_repo(i) for i in res.get("Items", [])]  # type: ignore[misc]


def get_cc_repo(owner_id: str, repo_name: str) -> dict[str, Any] | None:
    """소유권 아이템 조회. 없으면 None. {repoName, cloneUrlHttp}(계약 shape)."""
    res = table().get_item(Key={"PK": user_pk(owner_id), "SK": ccrepo_sk(repo_name)})
    return _to_repo(res.get("Item"))


def cc_repo_owned_by(owner_id: str, repo_name: str) -> bool:
    """해당 사용자가 이 레포의 소유자(AppHub로 만든 사람)인지 여부."""
    res = table().get_item(Key={"PK": user_pk(owner_id), "SK": ccrepo_sk(repo_name)})
    return res.get("Item") is not None


def delete_cc_repo(owner_id: str, repo_name: str) -> None:
    """소유권 아이템 삭제(멱등 — 없어도 예외 없음)."""
    table().delete_item(Key={"PK": user_pk(owner_id), "SK": ccrepo_sk(repo_name)})
