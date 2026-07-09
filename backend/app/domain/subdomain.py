"""서브도메인 규칙 (DESIGN.md 3.2).

- 소문자·숫자·하이픈만, 3~40자
- 하이픈으로 시작/끝 금지, 연속 하이픈 금지(DNS 라벨 안전)
- 예약어 금지(admin, api, www 등)
- 전역 유일성은 data/subdomains.py 예약 아이템으로 별도 보장
"""

from __future__ import annotations

import re

from ..http.errors import errors

RESERVED_SUBDOMAINS = frozenset(
    {
        "admin",
        "api",
        "www",
        "app",
        "apps",
        "auth",
        "login",
        "console",
        "dashboard",
        "internal",
        "static",
        "assets",
        "cdn",
        "mail",
        "ftp",
        "ns",
        "root",
        "system",
        "apphub",
        "status",
        "health",
    }
)

# TS: /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/  (fullmatch 로 앵커 대응)
_SUBDOMAIN_RE = re.compile(r"[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])")


def validate_subdomain(subdomain: str) -> None:
    """형식·예약어 검증. 위반 시 SUBDOMAIN_INVALID(400) 발생."""
    if not isinstance(subdomain, str) or len(subdomain) < 3 or len(subdomain) > 40:
        raise errors.subdomain_invalid("주소는 3~40자여야 해요.")
    if not _SUBDOMAIN_RE.fullmatch(subdomain):
        raise errors.subdomain_invalid(
            "주소는 소문자·숫자·하이픈만 쓸 수 있고, 하이픈으로 시작하거나 끝날 수 없어요."
        )
    if "--" in subdomain:
        raise errors.subdomain_invalid("주소에 하이픈을 연속으로 쓸 수 없어요.")
    if subdomain in RESERVED_SUBDOMAINS:
        raise errors.subdomain_invalid("사용할 수 없는 예약된 주소예요. 다른 이름을 입력해주세요.")


def suggest_subdomain(name: str) -> str:
    """앱 이름에서 서브도메인 후보 자동 생성(마법사 기본값 보조)."""
    base = name.lower()
    base = re.sub(r"[^a-z0-9-]+", "-", base)
    base = re.sub(r"-+", "-", base)
    base = re.sub(r"^-|-$", "", base)
    base = base[:40]
    if len(base) < 3:
        return f"app-{base}"[:40]
    return base
