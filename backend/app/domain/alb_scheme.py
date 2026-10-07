"""ALB 공개 범위(scheme) ↔ slug 변환 (계약 delta-2026-10-07 §0).

- `scheme`(DDB/API 값): `internet-facing` | `internal`
- `schemeSlug`(SSM 경로·스택명·리소스명): `internet` | `internal`
"""

from __future__ import annotations

_SCHEME_TO_SLUG = {"internet-facing": "internet", "internal": "internal"}
_SLUG_TO_SCHEME = {v: k for k, v in _SCHEME_TO_SLUG.items()}


def scheme_slug(scheme: str) -> str:
    """scheme → schemeSlug. 이미 slug 면 그대로(멱등). 알 수 없는 값은 ValueError."""
    if scheme in _SCHEME_TO_SLUG:
        return _SCHEME_TO_SLUG[scheme]
    if scheme in _SLUG_TO_SCHEME:
        return scheme
    raise ValueError(f"알 수 없는 ALB scheme: {scheme}")


def scheme_from_slug(slug: str) -> str:
    """schemeSlug → scheme. 이미 scheme 이면 그대로(멱등). 알 수 없는 값은 ValueError."""
    if slug in _SLUG_TO_SCHEME:
        return _SLUG_TO_SCHEME[slug]
    if slug in _SCHEME_TO_SLUG:
        return slug
    raise ValueError(f"알 수 없는 ALB schemeSlug: {slug}")
