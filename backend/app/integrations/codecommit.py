"""CodeCommit 레포지토리 관리 (AWS 저장소).

- codecommit 연결(provider=codecommit)의 레포를 앱 생성 마법사에서 고르거나 새로 만든다.
- CodeCommit `list-repositories` 는 계정 전체를 반환하고 소유자 필터가 없으므로,
  "본인이 만든 레포만" 은 플랫폼이 DDB(data/cc_repos.py)로 자체 추적한다. 이 모듈은
  실제 CodeCommit API 호출만 담당한다(소유권 판정 없음).

순수 boto3. 시크릿 취급 없음(clone URL HTTPS 는 민감정보 아님 — IAM/자격증명은 별개).

IAM(platform-stack, API Lambda 역할):
  codecommit:ListRepositories(Resource "*" — 리소스 레벨 미지원),
  codecommit:CreateRepository, codecommit:GetRepository(레포 ARN 범위 지정 가능),
  codecommit:DeleteRepository(레포 ARN 범위 지정 가능 — arn:aws:codecommit:{region}:{account}:*).
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from .clients import client


class RepositoryNameExists(Exception):
    """create_repository 시 동명 레포가 계정 전체에 이미 있음(RepositoryNameExistsException)."""


class RepositoryDoesNotExist(Exception):
    """delete/get 대상 레포가 CodeCommit 에 없음(RepositoryDoesNotExistException).

    삭제 흐름에서는 "밖에서 이미 지워짐"을 의미하므로 호출부가 멱등 처리한다.
    """


def list_repositories() -> list[str]:
    """계정 전체 레포 이름 목록(내부용, 페이지네이션 처리).

    주의: 계정 전체를 반환하므로 사용자 목록 API 경로에 직접 쓰지 않는다.
    소유권 필터링은 data/cc_repos.py(DDB) 소관. 진단/중복확인 보조 용도.
    """
    cc = client("codecommit")
    names: list[str] = []
    next_token: str | None = None
    while True:
        kwargs: dict[str, Any] = {}
        if next_token:
            kwargs["nextToken"] = next_token
        res = cc.list_repositories(**kwargs)
        for repo in res.get("repositories", []):
            name = repo.get("repositoryName")
            if isinstance(name, str):
                names.append(name)
        next_token = res.get("nextToken")
        if not next_token:
            return names


def create_repository(repo_name: str) -> dict[str, str]:
    """레포 생성. {repoName, cloneUrlHttp} 반환.

    동명 레포가 계정 전체에 이미 있으면 RepositoryNameExists 를 올린다(호출부가 명확한
    에러코드로 매핑). 그 외 ClientError 는 그대로 전파.
    """
    try:
        res = client("codecommit").create_repository(repositoryName=repo_name)
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "RepositoryNameExistsException":
            raise RepositoryNameExists(repo_name) from err
        raise
    meta = res.get("repositoryMetadata") or {}
    return {
        "repoName": meta.get("repositoryName", repo_name),
        "cloneUrlHttp": meta.get("cloneUrlHttp", ""),
    }


def delete_repository(repo_name: str) -> None:
    """레포 삭제.

    대상 레포가 이미 없으면(RepositoryDoesNotExistException) RepositoryDoesNotExist 를
    올린다(호출부가 멱등 처리 — 소유권만 정리). 그 외 ClientError 는 그대로 전파.
    """
    try:
        client("codecommit").delete_repository(repositoryName=repo_name)
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code")
        if code == "RepositoryDoesNotExistException":
            raise RepositoryDoesNotExist(repo_name) from err
        raise


def get_repository(repo_name: str) -> dict[str, str] | None:
    """레포 조회. 없으면 None. {repoName, cloneUrlHttp}."""
    try:
        res = client("codecommit").get_repository(repositoryName=repo_name)
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "RepositoryDoesNotExistException":
            return None
        raise
    meta = res.get("repositoryMetadata") or {}
    return {
        "repoName": meta.get("repositoryName", repo_name),
        "cloneUrlHttp": meta.get("cloneUrlHttp", ""),
    }
