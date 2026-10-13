"""DynamoDB 단일 테이블 키 스키마.

| 엔티티              | PK                 | SK              |
|---------------------|--------------------|-----------------|
| App                 | APP#{appId}        | META            |
| Deployment          | APP#{appId}        | DEPLOY#{ts}     |
| DeployExecClaim     | APP#{appId}        | DEPLOYEXEC#{pipelineExecutionId} |
| DeployBuildClaim    | APP#{appId}        | DEPLOYBUILD#{buildId} |
| RepoConnection      | USER#{userId}      | CONN#{connId}   |
| CodeCommitRepo      | USER#{userId}      | CCREPO#{repoName} |
| AlbRegistry         | CONFIG             | ALB#{albArn}    |
| AlbPending (D20)    | CONFIG             | ALBPENDING#{schemeSlug}#{n} |
| ComputePreset       | CONFIG             | PRESET#{id}     |
| PermissionTemplate  | CONFIG             | PERM#{id}       |
| AdminSettings       | CONFIG             | SETTINGS        |

GSI1(PK=ownerId, SK=SK) 은 App 아이템의 ownerId 속성으로 자연히 인덱싱된다.
GSI2(PK=status, SK=SK) 는 App 아이템의 status 속성으로 인덱싱 → 관리자 현황.
"""

from __future__ import annotations

CONFIG_PK = "CONFIG"
APP_META_SK = "META"
SETTINGS_SK = "SETTINGS"


def app_pk(app_id: str) -> str:
    return f"APP#{app_id}"


def user_pk(user_id: str) -> str:
    return f"USER#{user_id}"


def deploy_sk(ts: str) -> str:
    return f"DEPLOY#{ts}"


def deploy_exec_sk(pipeline_execution_id: str) -> str:
    """파이프라인 실행당 Deployment 1건 보장용 클레임 아이템 SK(deploy-notify 경합 방어).

    `DEPLOYEXEC#` 는 `DEPLOY#` prefix 로 시작하지 않으므로(6번째 글자 E≠#) 배포 이력 쿼리에 섞이지 않는다.
    """
    return f"DEPLOYEXEC#{pipeline_execution_id}"


def deploy_build_sk(build_id: str) -> str:
    """provisioner 런타임 재배포 빌드당 Deployment 1건 보장용 클레임 아이템 SK(롤백/시크릿 변경).

    `DEPLOYBUILD#` 도 `DEPLOY#` prefix 와 겹치지 않는다(6번째 글자 B≠#).
    """
    return f"DEPLOYBUILD#{build_id}"


def conn_sk(conn_id: str) -> str:
    return f"CONN#{conn_id}"


def ccrepo_sk(repo_name: str) -> str:
    return f"CCREPO#{repo_name}"


def alb_sk(alb_arn: str) -> str:
    return f"ALB#{alb_arn}"


def alb_pending_sk(scheme_slug: str, index: int) -> str:
    """ALB 증설 대기 아이템 SK (D20, 계약 §3.2)."""
    return f"ALBPENDING#{scheme_slug}#{int(index)}"


def preset_sk(preset_id: str) -> str:
    if not isinstance(preset_id, str) or preset_id.strip() == "":
        raise ValueError("preset_sk: presetId 는 비어 있을 수 없습니다.")
    return f"PRESET#{preset_id}"


def perm_sk(perm_id: str) -> str:
    if not isinstance(perm_id, str) or perm_id.strip() == "":
        raise ValueError("perm_sk: permId 는 비어 있을 수 없습니다.")
    return f"PERM#{perm_id}"


# SK prefix 상수 (begins_with 쿼리용).
class SkPrefix:
    DEPLOY = "DEPLOY#"
    CONN = "CONN#"
    CCREPO = "CCREPO#"
    ALB = "ALB#"
    ALBPENDING = "ALBPENDING#"
    PRESET = "PRESET#"
    PERM = "PERM#"
