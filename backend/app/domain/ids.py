"""내부 식별자 생성 (apphub-conventions 1장).

appId: 8자 소문자+숫자 난수. 서브도메인과 별개 내부 식별자. connId 등도 같은 생성기 사용.
암호학적 난수(secrets)로 생성해 예측 불가능하게 한다.
"""

from __future__ import annotations

import secrets

_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def random_id(length: int = 8) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def generate_app_id() -> str:
    return random_id(8)


def generate_conn_id() -> str:
    return random_id(8)
