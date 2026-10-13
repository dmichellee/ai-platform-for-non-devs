"""L1 — Dockerfile 정적 검증기.

CodeBuild 검증 단계가 부르는 것과 **동일한** validate_dockerfile 을 호출한다.
failureCategory 와 사람이 읽을 사유(reasons)가 apphub-conventions 4장과 일치하는지 고정.

베이스 이미지 허용목록 검사(구 C6)는 제거됨(사용자 결정) — 어떤 베이스 이미지도
그 자체로는 차단하지 않는다(EXPOSE 8080/금지항목/non-root 경고는 유지).
"""

from __future__ import annotations

import pytest
from app.validator.dockerfile import REQUIRED_EXPOSE_PORT, validate_dockerfile

FIXTURE_OK = """
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
USER node
CMD ["node", "server.js"]
"""

FIXTURE_NO_EXPOSE = """
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
COPY . .
USER node
CMD ["node", "server.js"]
"""

FIXTURE_WRONG_PORT = """
FROM public.ecr.aws/docker/library/node:22-slim
EXPOSE 3000
USER node
CMD ["node", "server.js"]
"""

# 이전엔 '허용 외 베이스'였던 이미지. 이제는 베이스 이미지만으로는 차단되지 않는다.
FIXTURE_ARBITRARY_BASE = """
FROM ubuntu:24.04
EXPOSE 8080
USER app
CMD ["/app/run"]
"""

FIXTURE_MULTISTAGE_OK = """
FROM public.ecr.aws/docker/library/node:22 AS builder
WORKDIR /src
COPY . .
RUN npm ci && npm run build

FROM public.ecr.aws/docker/library/node:22-slim AS runtime
WORKDIR /app
COPY --from=builder /src/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
"""

# 런타임 스테이지 베이스가 무엇이든 통과(포트/USER 충족 시). baseImage 파싱만 확인.
FIXTURE_MULTISTAGE_ARBITRARY_RUNTIME = """
FROM public.ecr.aws/docker/library/node:22-slim AS builder
RUN npm ci && npm run build

FROM debian:bookworm AS runtime
EXPOSE 8080
USER app
CMD ["/app/run"]
"""

FIXTURE_ROOT_USER = """
FROM public.ecr.aws/docker/library/python:3.12-slim
EXPOSE 8080
CMD ["python", "app.py"]
"""

FIXTURE_FORBIDDEN_DOCKERSOCK = """
FROM public.ecr.aws/docker/library/node:22-slim
VOLUME /var/run/docker.sock
EXPOSE 8080
USER node
CMD ["node", "server.js"]
"""

# 프로토콜 표기(8080/tcp)는 허용. 8080 하나만 EXPOSE하고 줄바꿈 이어붙이기를 검증.
FIXTURE_LINE_CONTINUATION = """
FROM public.ecr.aws/docker/library/node:22-slim
RUN apt-get update \\
    && apt-get install -y curl \\
    && rm -rf /var/lib/apt/lists/*
EXPOSE 8080/tcp
USER node
CMD ["node", "server.js"]
"""

# 8080 + 다른 포트를 함께 EXPOSE — 8080 하나만 허용이므로 차단돼야 한다.
FIXTURE_EXTRA_PORT = """
FROM public.ecr.aws/docker/library/node:22-slim
EXPOSE 8080 3000
USER node
CMD ["node", "server.js"]
"""

# 여러 EXPOSE 줄로 8080 + 80 — 역시 차단.
FIXTURE_MULTIPLE_EXPOSE_LINES = """
FROM public.ecr.aws/docker/library/node:22-slim
EXPOSE 8080
EXPOSE 80
USER node
CMD ["node", "server.js"]
"""


# ── C1 존재 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("content", [None, "", "   \n  \n"])
def test_missing_dockerfile(content):
    r = validate_dockerfile(content)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_MISSING"
    assert len(r.reasons) > 0


# ── 정상 케이스 ─────────────────────────────────────────────────────────────


def test_ok_dockerfile_passes():
    r = validate_dockerfile(FIXTURE_OK)
    assert r.ok is True
    assert r.failure_category is None
    assert r.reasons == []
    assert r.warnings == []
    assert r.base_image == "public.ecr.aws/docker/library/node:22-slim"
    assert REQUIRED_EXPOSE_PORT in r.exposed_ports


def test_multistage_runtime_passes():
    r = validate_dockerfile(FIXTURE_MULTISTAGE_OK)
    assert r.ok is True
    assert r.base_image == "public.ecr.aws/docker/library/node:22-slim"


def test_line_continuation_with_8080_passes():
    r = validate_dockerfile(FIXTURE_LINE_CONTINUATION)
    assert r.ok is True
    # 8080/tcp 프로토콜 표기는 허용되고 포트 번호 8080만 파싱된다.
    assert r.exposed_ports == [8080]


# ── 베이스 이미지: 허용목록 검사 제거 → 무엇이든 통과 ──────────────────────────


def test_arbitrary_base_image_passes():
    """이전엔 '허용 외'로 차단되던 ubuntu 베이스가 이제는 통과한다(다른 규칙 충족 시)."""
    r = validate_dockerfile(FIXTURE_ARBITRARY_BASE)
    assert r.ok is True
    assert r.failure_category is None
    assert r.base_image == "ubuntu:24.04"
    # 베이스 이미지 관련 경고/사유가 남아있지 않아야 한다.
    assert not any("허용" in x for x in r.reasons)
    assert not any("허용" in w for w in r.warnings)


def test_multistage_arbitrary_runtime_passes():
    r = validate_dockerfile(FIXTURE_MULTISTAGE_ARBITRARY_RUNTIME)
    assert r.ok is True
    assert r.base_image == "debian:bookworm"


def test_scratch_base_passes():
    """scratch 도 베이스 이미지 검사 대상이 아니므로 통과(포트/사유 없음)."""
    content = """
FROM scratch
COPY app /app
EXPOSE 8080
USER 1000
CMD ["/app"]
"""
    r = validate_dockerfile(content)
    assert r.ok is True
    assert r.base_image == "scratch"


# ── C2 EXPOSE 8080 ──────────────────────────────────────────────────────────


def test_no_expose_invalid():
    r = validate_dockerfile(FIXTURE_NO_EXPOSE)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert any("EXPOSE" in x for x in r.reasons)


def test_wrong_port_invalid():
    r = validate_dockerfile(FIXTURE_WRONG_PORT)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert r.exposed_ports == [3000]
    assert any("8080" in x for x in r.reasons)


def test_extra_port_alongside_8080_invalid():
    """8080은 있으나 3000도 함께 EXPOSE — 8080 하나만 허용이므로 차단."""
    r = validate_dockerfile(FIXTURE_EXTRA_PORT)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert 8080 in r.exposed_ports
    assert 3000 in r.exposed_ports
    # 사유에 '하나만'과 위반 포트(3000)가 명시돼야 한다.
    assert any("하나만" in x and "3000" in x for x in r.reasons)


def test_multiple_expose_lines_extra_port_invalid():
    """여러 EXPOSE 줄로 8080 + 80 — 역시 차단."""
    r = validate_dockerfile(FIXTURE_MULTIPLE_EXPOSE_LINES)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert any("하나만" in x and "80" in x for x in r.reasons)


# ── 금지 항목 ────────────────────────────────────────────────────────────────


def test_dockersock_mount_invalid():
    r = validate_dockerfile(FIXTURE_FORBIDDEN_DOCKERSOCK)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert any("도커 소켓" in x for x in r.reasons)


def test_privileged_hint_invalid():
    content = """
FROM public.ecr.aws/docker/library/node:22-slim
# run me with --privileged please
EXPOSE 8080
USER node
"""
    r = validate_dockerfile(content)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert any("특권" in x for x in r.reasons)


# ── C7 non-root(경고, 차단 아님) ─────────────────────────────────────────────


def test_no_user_is_warning_only():
    r = validate_dockerfile(FIXTURE_ROOT_USER)
    assert r.ok is True
    assert r.failure_category is None
    assert any("non-root" in w for w in r.warnings)


def test_user_root_is_warning():
    content = """
FROM public.ecr.aws/docker/library/node:22-slim
EXPOSE 8080
USER root
CMD ["node", "server.js"]
"""
    r = validate_dockerfile(content)
    assert r.ok is True
    assert any("non-root" in w for w in r.warnings)


# ── 복합 위반(베이스 이미지는 사유가 아님) ────────────────────────────────────


def test_multiple_violations_collected():
    """EXPOSE 누락 + non-root 없음. 베이스(ubuntu)는 사유에 포함되지 않는다."""
    content = """
FROM ubuntu:24.04
CMD ["/run"]
"""
    r = validate_dockerfile(content)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    # EXPOSE 누락은 사유, root 는 경고. 베이스 이미지 사유는 없어야 한다.
    assert any("EXPOSE" in x for x in r.reasons)
    assert not any("허용" in x for x in r.reasons)
