"""ECR — 이미지 태그 실존 확인 (롤백).

롤백은 재빌드 없이 이전 커밋 SHA 태그 이미지를 runtime 스택에 재배포한다.
그 태그 이미지가 ECR 에 실존하는지 먼저 확인한다(없으면 되돌릴 수 없음 → 친절 에러).
ECR 리포명 규약: `apphub-{stage}-app-{appId}` (buildspec-contract §5, app-pipeline 이 생성).
이미지 값(레이어)은 다루지 않는다 — 태그 존재 여부만 조회.
"""

from __future__ import annotations

from botocore.exceptions import ClientError

from .clients import client


def app_ecr_repo_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}"


def image_tag_exists(stage: str, app_id: str, image_tag: str) -> bool:
    """지정 태그 이미지가 ECR 리포에 실존하면 True. 리포/태그 미존재는 False(멱등)."""
    repo = app_ecr_repo_name(stage, app_id)
    try:
        res = client("ecr").describe_images(
            repositoryName=repo,
            imageIds=[{"imageTag": image_tag}],
        )
        return bool(res.get("imageDetails"))
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        # 태그/이미지/리포 미존재는 "없음"으로 판정(예외 아님).
        if code in ("ImageNotFoundException", "RepositoryNotFoundException"):
            return False
        raise
