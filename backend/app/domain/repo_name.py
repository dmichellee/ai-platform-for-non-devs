"""CodeCommit 레포 이름 규칙 (앱 생성 마법사 "새 저장소 만들기").

CodeCommit 실제 제약은 1~100자, 제어문자·공백·일부 특수문자 금지, `.git` 접미사 금지지만,
비개발자 친화·DNS/URL 안전을 위해 서브도메인과 유사한 안전 부분집합으로 한정한다:
  - 소문자·숫자·하이픈(-)·밑줄(_)·점(.) 만
  - 1~100자
  - 하이픈/점/밑줄로 시작·끝 금지, `.git` 접미사 금지

위반 시 VALIDATION_ERROR(400).
"""

from __future__ import annotations

import re

from ..http.errors import errors

# 소문자·숫자로 시작·끝, 중간에 -._ 허용. 단일 문자도 허용(끝 그룹 옵션).
_REPO_NAME_RE = re.compile(r"[a-z0-9]([a-z0-9._-]*[a-z0-9])?")


def validate_repo_name(repo_name: str) -> str:
    """레포 이름 형식 검증. 통과 시 정규화된 이름 반환, 위반 시 VALIDATION_ERROR."""
    if not isinstance(repo_name, str) or repo_name == "":
        raise errors.validation("저장소 이름을 입력해주세요.")
    if len(repo_name) > 100:
        raise errors.validation("저장소 이름은 100자 이하여야 해요.")
    if not _REPO_NAME_RE.fullmatch(repo_name):
        raise errors.validation(
            "저장소 이름은 소문자·숫자로 시작하고 끝나야 하며, "
            "가운데에 하이픈(-)·밑줄(_)·점(.)만 쓸 수 있어요."
        )
    if repo_name.endswith(".git"):
        raise errors.validation("저장소 이름은 '.git' 으로 끝날 수 없어요.")
    return repo_name
