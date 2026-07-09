"""CodeCommit 레포 이름 규칙 (앱 생성 마법사 "새 저장소 만들기").

CodeCommit 실제 제약은 1~100자, 제어문자·공백·일부 특수문자 금지, `.git` 접미사 금지지만,
비개발자 친화·DNS/URL 안전을 위해 서브도메인과 유사한 안전 부분집합으로 한정한다:
  - 소문자·숫자·하이픈(-)·밑줄(_)·점(.) 만
  - 1~100자
  - 하이픈/점/밑줄로 시작·끝 금지, `.git` 접미사 금지

위반 시 VALIDATION_ERROR(400).

## 사용자 식별자 접두어(사용자 결정)
레포 생성 시 서버가 **소유자 접두어**를 강제로 붙인다 — 최종 레포명 = `{ownerPrefix}-{base}`.
POST body 의 `repoName` 은 **base**(사용자 입력)를 의미하고, 서버가 접두어를 부착한 최종명이
실제 CodeCommit 레포명·응답·DDB 소유권에 쓰인다. 프론트 미리보기는 아래 owner_prefix 규칙을
그대로 복제해 사용자에게 최종 이름을 보여준다(서버·프론트 동일 규칙 필수).
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ..http.errors import errors

if TYPE_CHECKING:
    from ..auth.identity import Identity

# 소문자·숫자로 시작·끝, 중간에 -._ 허용. 단일 문자도 허용(끝 그룹 옵션).
_REPO_NAME_RE = re.compile(r"[a-z0-9]([a-z0-9._-]*[a-z0-9])?")

# 최종 레포명(접두어 + base) 길이 상한 — CodeCommit 실제 제약과 동일.
MAX_REPO_NAME_LEN = 100

# ownerPrefix 정제 시 허용 문자(그 외는 하이픈으로 치환).
_PREFIX_ALLOWED_RE = re.compile(r"[^a-z0-9._-]")
# 앞뒤에서 제거할 구분자.
_PREFIX_TRIM_CHARS = "-._"
# email 로컬파트가 비거나 정제 결과가 빌 때 폴백으로 쓰는 sub 접두 길이.
_SUB_FALLBACK_LEN = 8


def validate_repo_name(repo_name: str) -> str:
    """base 레포 이름 형식 검증. 통과 시 정규화된 base 반환, 위반 시 VALIDATION_ERROR.

    접두어를 붙이기 전의 사용자 입력(base)에 적용한다.
    """
    if not isinstance(repo_name, str) or repo_name == "":
        raise errors.validation("저장소 이름을 입력해주세요.")
    if len(repo_name) > MAX_REPO_NAME_LEN:
        raise errors.validation("저장소 이름은 100자 이하여야 해요.")
    if not _REPO_NAME_RE.fullmatch(repo_name):
        raise errors.validation(
            "저장소 이름은 소문자·숫자로 시작하고 끝나야 하며, "
            "가운데에 하이픈(-)·밑줄(_)·점(.)만 쓸 수 있어요."
        )
    if repo_name.endswith(".git"):
        raise errors.validation("저장소 이름은 '.git' 으로 끝날 수 없어요.")
    return repo_name


def owner_prefix(identity: "Identity") -> str:
    """소유자 식별 접두어. email 로컬파트(@ 앞) 우선, 없거나 비면 sub 앞 8자로 폴백.

    규칙(프론트 미리보기와 반드시 동일):
      1) email 이 있으면 로컬파트(@ 앞)를 취해 소문자화하고, `[a-z0-9._-]` 외 문자는 `-` 로
         치환한 뒤 앞뒤 구분자(`-`,`.`,`_`)를 제거한다.
      2) email 이 없거나 위 정제 결과가 비면 sub(user_id)의 앞 8자를 소문자화해 폴백으로 쓴다.

    반환값은 항상 비어있지 않다(폴백 보장). 조직 식별정보는 담지 않는다 —
    email 로컬파트/무작위 sub 만 사용.
    """
    email = identity.email
    if isinstance(email, str) and email:
        local_part = email.split("@", 1)[0]
        sanitized = _sanitize_prefix(local_part)
        if sanitized:
            return sanitized
    # 폴백: sub 앞 8자(소문자). sub 는 Cognito 무작위 식별자.
    return identity.user_id[:_SUB_FALLBACK_LEN].lower()


def _sanitize_prefix(raw: str) -> str:
    """접두어 정제: 소문자화 → 허용 외 문자 `-` 치환 → 앞뒤 구분자 제거."""
    lowered = raw.lower()
    replaced = _PREFIX_ALLOWED_RE.sub("-", lowered)
    return replaced.strip(_PREFIX_TRIM_CHARS)


def build_repo_name(identity: "Identity", base: str) -> str:
    """base(검증 완료) 에 소유자 접두어를 부착한 최종 레포명 반환.

    최종명 = `{ownerPrefix}-{base}`. 결합 후 100자 초과면 VALIDATION_ERROR
    (base 를 줄이라는 안내). 실제 CodeCommit 레포명·응답·DDB 소유권에 이 값을 쓴다.
    """
    prefix = owner_prefix(identity)
    full_name = f"{prefix}-{base}"
    if len(full_name) > MAX_REPO_NAME_LEN:
        raise errors.validation(
            f"저장소 이름이 너무 길어요. 앞에 '{prefix}-' 가 자동으로 붙기 때문에 "
            f"입력하는 이름을 더 짧게 해주세요(전체 {MAX_REPO_NAME_LEN}자 이하)."
        )
    return full_name
