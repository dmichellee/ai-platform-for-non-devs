"""L1 — Dockerfile 정적 검증기 (KIRO-STANDARDS.md 3장).

CodeBuild 검증 단계가 부르는 것과 **동일한** validate_dockerfile 을 호출한다.
failureCategory 와 사람이 읽을 사유(reasons)가 apphub-conventions 4장과 일치하는지 고정.
"""

from __future__ import annotations

import pytest
from app.validator.dockerfile import REQUIRED_EXPOSE_PORT, validate_dockerfile

ALLOWED = [
    "public.ecr.aws/docker/library/node:22-slim",
    "public.ecr.aws/docker/library/python:3.12-slim",
    # 태그 없는 리포지토리 허용(모든 태그 허용) 케이스도 섞어 확인.
    "public.ecr.aws/docker/library/node",
]

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

FIXTURE_DISALLOWED_BASE = """
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

FIXTURE_MULTISTAGE_BAD_RUNTIME = """
FROM public.ecr.aws/docker/library/node:22-slim AS builder
RUN npm ci && npm run build

FROM debian:bookworm AS runtime
EXPOSE 8080
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

FIXTURE_LINE_CONTINUATION = """
FROM public.ecr.aws/docker/library/node:22-slim
RUN apt-get update \\
    && apt-get install -y curl \\
    && rm -rf /var/lib/apt/lists/*
EXPOSE 80 8080/tcp
USER node
CMD ["node", "server.js"]
"""


# ── C1 존재 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("content", [None, "", "   \n  \n"])
def test_missing_dockerfile(content):
    r = validate_dockerfile(content, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_MISSING"
    assert len(r.reasons) > 0


# ── 정상 케이스 ─────────────────────────────────────────────────────────────


def test_ok_dockerfile_passes():
    r = validate_dockerfile(FIXTURE_OK, ALLOWED)
    assert r.ok is True
    assert r.failure_category is None
    assert r.reasons == []
    assert r.warnings == []
    assert r.base_image == "public.ecr.aws/docker/library/node:22-slim"
    assert REQUIRED_EXPOSE_PORT in r.exposed_ports


def test_multistage_runtime_allowed_passes():
    r = validate_dockerfile(FIXTURE_MULTISTAGE_OK, ALLOWED)
    assert r.ok is True
    assert r.base_image == "public.ecr.aws/docker/library/node:22-slim"


def test_line_continuation_with_8080_passes():
    r = validate_dockerfile(FIXTURE_LINE_CONTINUATION, ALLOWED)
    assert r.ok is True
    assert 80 in r.exposed_ports
    assert 8080 in r.exposed_ports


# ── C2 EXPOSE 8080 ──────────────────────────────────────────────────────────


def test_no_expose_invalid():
    r = validate_dockerfile(FIXTURE_NO_EXPOSE, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert any("EXPOSE" in x for x in r.reasons)


def test_wrong_port_invalid():
    r = validate_dockerfile(FIXTURE_WRONG_PORT, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert r.exposed_ports == [3000]
    assert any("8080" in x for x in r.reasons)


# ── C6 베이스 이미지 허용목록 ────────────────────────────────────────────────


def test_disallowed_base_invalid():
    r = validate_dockerfile(FIXTURE_DISALLOWED_BASE, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert r.base_image == "ubuntu:24.04"
    assert any("허용 목록" in x for x in r.reasons)


def test_multistage_bad_runtime_invalid():
    r = validate_dockerfile(FIXTURE_MULTISTAGE_BAD_RUNTIME, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert r.base_image == "debian:bookworm"


def test_untagged_allowed_repo_passes_any_tag():
    content = """
FROM public.ecr.aws/docker/library/node:20-slim
EXPOSE 8080
USER node
CMD ["node", "server.js"]
"""
    r = validate_dockerfile(content, ALLOWED)
    assert r.ok is True


def test_empty_allowlist_skips_base_check():
    r = validate_dockerfile(FIXTURE_DISALLOWED_BASE, [])
    assert r.ok is True
    assert any("허용 베이스 이미지 목록" in w for w in r.warnings)


# ── 금지 항목 ────────────────────────────────────────────────────────────────


def test_dockersock_mount_invalid():
    r = validate_dockerfile(FIXTURE_FORBIDDEN_DOCKERSOCK, ALLOWED)
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
    r = validate_dockerfile(content, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert any("특권" in x for x in r.reasons)


# ── C7 non-root(경고, 차단 아님) ─────────────────────────────────────────────


def test_no_user_is_warning_only():
    r = validate_dockerfile(FIXTURE_ROOT_USER, ALLOWED)
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
    r = validate_dockerfile(content, ALLOWED)
    assert r.ok is True
    assert any("non-root" in w for w in r.warnings)


# ── 복합 위반 ────────────────────────────────────────────────────────────────


def test_multiple_violations_collected():
    content = """
FROM ubuntu:24.04
CMD ["/run"]
"""
    r = validate_dockerfile(content, ALLOWED)
    assert r.ok is False
    assert r.failure_category == "DOCKERFILE_INVALID"
    assert len(r.reasons) >= 2
