"""DynamoDB 단일 테이블 키 스키마 (DESIGN.md 4장).

| 엔티티              | PK                 | SK              |
|---------------------|--------------------|-----------------|
| App                 | APP#{appId}        | META            |
| Deployment          | APP#{appId}        | DEPLOY#{ts}     |
| RepoConnection      | USER#{userId}      | CONN#{connId}   |
| CodeCommitRepo      | USER#{userId}      | CCREPO#{repoName} |
| AlbRegistry         | CONFIG             | ALB#{albArn}    |
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


def conn_sk(conn_id: str) -> str:
    return f"CONN#{conn_id}"


def ccrepo_sk(repo_name: str) -> str:
    return f"CCREPO#{repo_name}"


def alb_sk(alb_arn: str) -> str:
    return f"ALB#{alb_arn}"


def preset_sk(preset_id: str) -> str:
    return f"PRESET#{preset_id}"


def perm_sk(perm_id: str) -> str:
    return f"PERM#{perm_id}"


# SK prefix 상수 (begins_with 쿼리용).
class SkPrefix:
    DEPLOY = "DEPLOY#"
    CONN = "CONN#"
    CCREPO = "CCREPO#"
    ALB = "ALB#"
    PRESET = "PRESET#"
    PERM = "PERM#"
