"""Dockerfile 정적 검증기 (KIRO-STANDARDS.md 3장 · DESIGN.md 3.3 [Build & Validate] 1~2단계).

이 모듈은 **독립적**이며 두 곳에서 같은 코드로 실행된다:
 (1) CodeBuild 검증 단계(buildspec)에서 레포 루트 Dockerfile 내용을 넣어 실행 → 실패 시 파이프라인 중단.
 (2) backend 단위 테스트(픽스처 기반)에서 같은 함수를 호출해 회귀 방지.

**정적 파싱만** 한다. 실동작(C3+C9 헬스체크 스모크: 이미지 실행 → GET /health 200)은
buildspec에서 빌드된 이미지를 실행해 확인하는 영역이라 검증기 범위 밖이다.

검사(KIRO-STANDARDS 3장 표):
 - C1 Dockerfile 존재            → 없으면 DOCKERFILE_MISSING
 - C2 EXPOSE 8080 **하나만**      → 없거나 8080이 아니거나 8080 외 다른 포트가 함께 있으면 DOCKERFILE_INVALID
 - 금지 항목(privileged/host mount 등) → 있으면 DOCKERFILE_INVALID
 - C7 non-root(USER 지시자)       → 없으면 경고(차단하지 않음)

EXPOSE는 8080 **하나만** 허용한다(사용자 결정). 플랫폼은 8080만 라우팅하므로 다른 포트를
EXPOSE하면 오해를 부르고, ALB/타깃그룹 계약과 어긋난다. 8080에 더해 다른 포트가 있으면
차단한다(`8080/tcp` 프로토콜 표기는 허용).

베이스 이미지는 검사하지 않는다(허용목록 기능 제거 — 사용자 결정). 베이스 이미지는
멀티스테이지 런타임 스테이지 기준으로 파싱해 결과(baseImage)에 참고용으로만 담는다.

반환은 apphub-conventions 4장 failureCategory(DOCKERFILE_MISSING / DOCKERFILE_INVALID)와
사람이 읽을 수 있는 사유 목록. 통과해도 경고(warnings)는 별도로 담아 반환한다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# 컨테이너 계약 포트(KIRO-STANDARDS C2).
REQUIRED_EXPOSE_PORT = 8080


@dataclass(frozen=True)
class DockerfileValidationResult:
    ok: bool
    reasons: list[str]
    warnings: list[str]
    exposed_ports: list[int]
    failure_category: str | None = None
    base_image: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """buildspec-contract §1 출력 shape(camelCase). ok=true면 failureCategory/baseImage 생략 규약 준수."""
        out: dict[str, Any] = {
            "ok": self.ok,
            "reasons": list(self.reasons),
            "warnings": list(self.warnings),
            "exposedPorts": list(self.exposed_ports),
        }
        if self.failure_category is not None:
            out["failureCategory"] = self.failure_category
        if self.base_image is not None:
            out["baseImage"] = self.base_image
        return out


@dataclass(frozen=True)
class _ForbiddenPattern:
    regex: re.Pattern[str]
    reason: str


_FORBIDDEN_PATTERNS: list[_ForbiddenPattern] = [
    _ForbiddenPattern(
        re.compile(r"--privileged\b", re.IGNORECASE),
        "특권 모드(--privileged) 사용이 감지됐어요. 앱은 특권 없이 실행돼야 해요.",
    ),
    _ForbiddenPattern(
        re.compile(r"(^|\s)VOLUME\s+.*/var/run/docker\.sock", re.IGNORECASE | re.MULTILINE),
        "도커 소켓(/var/run/docker.sock) 마운트가 감지됐어요. 호스트 도커 접근은 허용되지 않아요.",
    ),
    _ForbiddenPattern(
        re.compile(r"/var/run/docker\.sock", re.IGNORECASE),
        "도커 소켓(/var/run/docker.sock) 접근이 감지됐어요. 호스트 도커 접근은 허용되지 않아요.",
    ),
    _ForbiddenPattern(
        re.compile(r"--network[= ]host\b", re.IGNORECASE),
        "호스트 네트워크(--network host) 사용이 감지됐어요. 격리된 네트워크에서 실행돼야 해요.",
    ),
    _ForbiddenPattern(
        re.compile(r"--cap-add[= ]", re.IGNORECASE),
        "추가 커널 권한(--cap-add) 요청이 감지됐어요. 기본 권한만 사용해야 해요.",
    ),
    _ForbiddenPattern(
        re.compile(r"(^|\s)MOUNT\s+type=bind[^\n]*source=/(?!$)", re.IGNORECASE | re.MULTILINE),
        "호스트 경로 바인드 마운트가 감지됐어요. 호스트 파일시스템 마운트는 허용되지 않아요.",
    ),
]

_FROM_RE = re.compile(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$", re.IGNORECASE)
_EXPOSE_RE = re.compile(r"^EXPOSE\s+(.+)$", re.IGNORECASE)
_USER_RE = re.compile(r"^USER\s+(\S+)", re.IGNORECASE)
_WS_SPLIT = re.compile(r"\s+")


@dataclass
class _FromInstruction:
    image: str
    stage_name: str | None = None


def _normalize_instructions(content: str) -> list[str]:
    """주석/빈 줄 제거, 백슬래시 줄바꿈(`\\`) 이어붙여 논리적 명령 단위로 정규화."""
    raw_lines = re.split(r"\r?\n", content)
    joined: list[str] = []
    buffer = ""
    for raw in raw_lines:
        line = raw.replace("\t", " ")
        trimmed = line.strip()
        if trimmed.startswith("#"):
            continue
        if buffer:
            buffer += " " + trimmed
        else:
            buffer = trimmed
        if buffer.endswith("\\"):
            buffer = buffer[:-1].rstrip() + " "
        else:
            if buffer.strip():
                joined.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        joined.append(buffer.strip())
    return joined


def _parse_from(instruction: str) -> _FromInstruction | None:
    m = _FROM_RE.match(instruction)
    if not m:
        return None
    return _FromInstruction(image=m.group(1), stage_name=m.group(2))


def _resolve_runtime_base_image(froms: list[_FromInstruction]) -> str | None:
    """멀티스테이지에서 '런타임 스테이지'(마지막 FROM)의 실제 베이스 이미지."""
    if not froms:
        return None
    stage_to_image: dict[str, str] = {}
    resolved: str | None = None
    for f in froms:
        base = f.image
        seen: set[str] = set()
        while base in stage_to_image and base not in seen:
            seen.add(base)
            base = stage_to_image[base]
        if f.stage_name:
            stage_to_image[f.stage_name] = base
        resolved = base
    return resolved


def _parse_exposed_ports(instructions: list[str]) -> list[int]:
    ports: list[int] = []
    for ins in instructions:
        m = _EXPOSE_RE.match(ins)
        if not m:
            continue
        for tok in _WS_SPLIT.split(m.group(1).strip()):
            port_str = tok.split("/")[0]
            try:
                ports.append(int(port_str))
            except ValueError:
                continue
    return ports


def _has_non_root_user(instructions: list[str]) -> bool:
    last_user: str | None = None
    for ins in instructions:
        m = _USER_RE.match(ins)
        if m:
            last_user = m.group(1).lower()
    if last_user is None:
        return False
    if last_user in ("root", "0") or last_user.startswith("0:"):
        return False
    return True


def validate_dockerfile(content: str | None) -> DockerfileValidationResult:
    """Dockerfile을 정적 검증한다.

    차단 사유가 하나라도 있으면 ok=false + failureCategory.
    DOCKERFILE_MISSING은 내용이 아예 없을 때만. 그 외 규칙 위반은 DOCKERFILE_INVALID.
    베이스 이미지는 검사하지 않는다(허용목록 기능 제거) — baseImage는 참고용으로만 반환.
    """
    reasons: list[str] = []
    warnings: list[str] = []

    # ── C1: 존재 ──────────────────────────────────────────────────────────────
    if content is None or content.strip() == "":
        return DockerfileValidationResult(
            ok=False,
            failure_category="DOCKERFILE_MISSING",
            reasons=[
                "레포 루트에 Dockerfile이 없어요(또는 비어 있어요). "
                "배포 표준에 맞는 Dockerfile이 필요해요."
            ],
            warnings=[],
            exposed_ports=[],
        )

    instructions = _normalize_instructions(content)

    # ── FROM / 베이스 이미지 ────────────────────────────────────────────────────
    # 베이스 이미지 허용목록 검사는 제거됨(사용자 결정) — baseImage는 참고용으로만 파싱.
    froms = [f for f in (_parse_from(i) for i in instructions) if f is not None]
    if not froms:
        reasons.append("Dockerfile에 FROM 지시자가 없어요. 베이스 이미지를 지정해야 해요.")
    base_image = _resolve_runtime_base_image(froms)

    # ── C2: EXPOSE는 8080 하나만 ─────────────────────────────────────────────────
    # 플랫폼은 8080만 라우팅한다. 8080이 없으면/다르면 물론, 8080에 더해 다른 포트가
    # 함께 EXPOSE돼 있어도 차단한다(`8080/tcp` 프로토콜 표기는 _parse_exposed_ports가
    # 포트 번호만 뽑으므로 허용됨).
    exposed_ports = _parse_exposed_ports(instructions)
    if not exposed_ports:
        reasons.append(
            f"EXPOSE 지시자가 없어요. 앱이 {REQUIRED_EXPOSE_PORT} 포트를 쓰도록 "
            f"'EXPOSE {REQUIRED_EXPOSE_PORT}'를 추가하세요."
        )
    elif REQUIRED_EXPOSE_PORT not in exposed_ports:
        reasons.append(
            f"앱이 {REQUIRED_EXPOSE_PORT} 포트를 쓰도록 설정되어 있지 않아요"
            f"(현재 EXPOSE: {', '.join(str(p) for p in exposed_ports)}). "
            f"'EXPOSE {REQUIRED_EXPOSE_PORT}'가 필요해요."
        )
    else:
        # 8080은 있으나 다른 포트도 함께 EXPOSE된 경우 → 8080 하나만 허용.
        extra_ports = sorted({p for p in exposed_ports if p != REQUIRED_EXPOSE_PORT})
        if extra_ports:
            reasons.append(
                f"EXPOSE는 {REQUIRED_EXPOSE_PORT} 하나만 허용돼요. "
                f"다른 포트({', '.join(str(p) for p in extra_ports)})도 EXPOSE돼 있어요. "
                f"'EXPOSE {REQUIRED_EXPOSE_PORT}'만 남기고 나머지 EXPOSE는 제거하세요."
            )

    # ── 금지 항목 ────────────────────────────────────────────────────────────────
    for pat in _FORBIDDEN_PATTERNS:
        if pat.regex.search(content):
            reasons.append(pat.reason)

    # ── C7: non-root(경고만) ─────────────────────────────────────────────────────
    if not _has_non_root_user(instructions):
        warnings.append(
            "컨테이너가 root로 실행될 수 있어요(USER 지시자 없음/root). "
            "보안을 위해 non-root 사용자 실행을 권장해요."
        )

    if reasons:
        return DockerfileValidationResult(
            ok=False,
            failure_category="DOCKERFILE_INVALID",
            reasons=reasons,
            warnings=warnings,
            exposed_ports=exposed_ports,
            base_image=base_image,
        )

    return DockerfileValidationResult(
        ok=True,
        reasons=[],
        warnings=warnings,
        exposed_ports=exposed_ports,
        base_image=base_image,
    )


__all__ = ["validate_dockerfile", "DockerfileValidationResult", "REQUIRED_EXPOSE_PORT"]
