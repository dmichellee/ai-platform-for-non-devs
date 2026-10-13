"""Dockerfile 검증기 CLI — CodeBuild 검증 단계(buildspec)에서 실행되는 진입점.

buildspec 계약:
 - 실행:   python dockerfile_validator.py <Dockerfile 경로>
 - 출력:   stdout에 결과 JSON 한 줄(DockerfileValidationResult). 사람용 요약은 stderr.
 - 종료코드: ok=true → 0, DOCKERFILE_MISSING/INVALID → 1(파이프라인이 실패로 인식).

베이스 이미지 허용목록 기능은 제거됨(사용자 결정). `--allowed-base-images-json` 등
`--`로 시작하는 미인식 옵션은 하위호환을 위해 조용히 무시한다(파싱만 하고 사용 안 함).

이 파일은 backend 코드(패키지 상대 import)로도, build.sh 가 배포하는 단일 스크립트
(`dockerfile.py` 를 같은 폴더에 두고 절대 import)로도 동작하도록 이중 import 를 지원한다.
검증 로직은 dockerfile.py 에 있고, 단위 테스트도 같은 함수를 직접 호출한다(같은 코드).
"""

from __future__ import annotations

import json
import sys

try:
    # 패키지 컨텍스트(backend/app/validator 로 실행/import).
    from .dockerfile import validate_dockerfile
except ImportError:  # pragma: no cover - 배포 단일 스크립트 폴백
    from dockerfile import validate_dockerfile  # type: ignore[no-redef]


def _parse_args(argv: list[str]) -> str | None:
    """첫 위치 인자(Dockerfile 경로)만 취한다. `--`로 시작하는 옵션과 그 값은 무시."""
    dockerfile_path: str | None = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            # 값을 동반할 수 있는 옵션(예: 구 --allowed-base-images-json <값>)을 통째로 건너뛴다.
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                i += 2
            else:
                i += 1
            continue
        if dockerfile_path is None:
            dockerfile_path = a
        i += 1
    return dockerfile_path


def _read_dockerfile(path: str | None) -> str | None:
    if path is None:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None  # 파일 없음 → 검증기가 DOCKERFILE_MISSING 판정


def main(argv: list[str]) -> int:
    """CLI 진입. 부수효과(파일 IO, 종료코드)는 여기에만 둔다. 종료코드 반환."""
    dockerfile_path = _parse_args(argv)
    content = _read_dockerfile(dockerfile_path)

    result = validate_dockerfile(content)

    # 기계 판독용(배포 이력/후속 단계): stdout 에 결과 JSON 한 줄.
    sys.stdout.write(json.dumps(result.to_dict(), ensure_ascii=False) + "\n")

    # 사람 판독용 요약: stderr.
    if result.ok:
        sys.stderr.write("[dockerfile-validator] OK — 배포 표준을 통과했어요.\n")
        for w in result.warnings:
            sys.stderr.write(f"[warn] {w}\n")
        return 0
    sys.stderr.write(f"[dockerfile-validator] FAILED ({result.failure_category})\n")
    for r in result.reasons:
        sys.stderr.write(f"[fail] {r}\n")
    for w in result.warnings:
        sys.stderr.write(f"[warn] {w}\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
