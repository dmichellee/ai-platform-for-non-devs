#!/usr/bin/env python3
"""AppHub AWS 아키텍처 다이어그램 생성 (AWS 공식 아이콘).

docs/ARCHITECTURE-AS-BUILT.md 의 구성도를 AWS 아이콘 이미지로 렌더한다.
산출물: docs/architecture/apphub-architecture-{overview,deploy-flow,wake-flow}.png

실행:
  uv run --with diagrams scripts/gen-architecture-diagram.py
전제: graphviz(dot) 설치 — `brew install graphviz`.

리소스 근거는 infra/lib/{platform-stack,network-stack}.ts 및
infra/lib/constructs/{app-pipeline,app-runtime}.ts (as-built).
"""

from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import (
    ECR,
    ECS,
    ElasticContainerServiceService,
    Fargate,
    Lambda,
)
from diagrams.aws.database import Dynamodb
from diagrams.aws.devtools import Codebuild, Codecommit, Codepipeline
from diagrams.aws.general import Users
from diagrams.aws.integration import Eventbridge, StepFunctions
from diagrams.aws.management import Cloudwatch, SystemsManagerParameterStore
from diagrams.aws.network import (
    CloudFront,
    ElasticLoadBalancing,
    Route53,
    VPC,
)
from diagrams.aws.security import ACM, Cognito, SecretsManager
from diagrams.aws.storage import S3

OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "architecture"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 공통 스타일 — 좌→우 흐름, 촘촘하지 않게.
GRAPH_ATTR = {
    "fontname": "Helvetica",
    "fontsize": "20",
    "bgcolor": "white",
    "pad": "0.6",
    "nodesep": "0.55",
    "ranksep": "0.95",
    "splines": "spline",
}
NODE_ATTR = {"fontname": "Helvetica", "fontsize": "12"}
EDGE_ATTR = {"fontname": "Helvetica", "fontsize": "11", "color": "#4a5568"}

CTRL = "#6b46c1"     # 제어/요청 경로
EVENT = "#dd6b20"    # 이벤트 경로
DATA = "#2b6cb0"     # 데이터/참조 경로


def overview() -> None:
    """전체 구성도 — 4개 스택 경계와 주요 연결.

    엣지는 '구조를 읽는 데 필요한 것'만 남긴다. wake-on-request 상세와 배포 스테이지
    상세는 각각 wake_flow()/deploy_flow() 다이어그램이 담당한다(중복 엣지 금지 —
    한 장에 다 넣으면 그래프가 세로로 터져 읽을 수 없다).
    """
    with Diagram(
        "AppHub — AWS 아키텍처 (구현 기준)",
        filename=str(OUT_DIR / "apphub-architecture-overview"),
        outformat="png",
        show=False,
        # TB: 클러스터 내 형제 노드가 가로로 퍼져 전체 종횡비가 안정된다(LR은 세로로 터짐).
        direction="TB",
        graph_attr={**GRAPH_ATTR, "ranksep": "1.1", "nodesep": "0.35"},
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        users = Users("사용자 · 관리자\n(비개발자)")

        with Cluster("apphub-{stage}-platform  |  컨트롤 플레인 (stage당 1)"):
            with Cluster("웹 · 인증"):
                cf = CloudFront("CloudFront\nSPA + /kiro-config/*")
                s3spa = S3("S3 spa\nReact SPA (OAC)")
                cognito = Cognito("Cognito User Pool\nadmin / user")

            with Cluster("API · 데이터"):
                api = Lambda("Lambda api\nAPI GW REST 핸들러")
                ddb = Dynamodb("DynamoDB main\n단일 테이블 + GSI1/2")
                sm = SecretsManager("Secrets Manager\n앱별 시크릿")

            with Cluster("오케스트레이션"):
                sfn = StepFunctions("SFN provision-app\n· delete-app")
                provisioner = Codebuild("CodeBuild\nprovisioner")
                notify = Lambda("Lambda\ndeploy-notify")
                s3asset = S3("S3 assets\n검증기·CDK·Kiro zip")

        with Cluster("apphub-{stage}-network  |  공유 트래픽 · 런타임 기반 (stage당 1)"):
            albs = ElasticLoadBalancing("공유 ALB ×2\ninternet-facing · internal\nidle 300s")
            cluster = ECS("ECS Cluster\napphub-{stage}-cluster\n★ stage당 1개 (D18)")
            vpc = VPC("VPC 10.20.0.0/16\n2 AZ · NAT×1")
            wake = Lambda("Waker Lambda ×3\nwaker · restore · sleep")
            dns = Route53("Route53\npublic + private zone")
            acm = ACM("ACM *.{appsDomain}")
            ssm = SystemsManagerParameterStore("SSM\n/apphub/{stage}/network/*")

        with Cluster("앱별 스택 ×N  |  앱 = CloudFormation 스택 2개"):
            with Cluster("app-{appId}-pipeline"):
                pipeline = Codepipeline("CodePipeline\nSource→Validate→Deploy")
                ecr = ECR("ECR repo\n최근 5개 보존")

            with Cluster("app-{appId}-runtime"):
                svc = ElasticContainerServiceService("ECS Service\n(공유 클러스터 위)")
                task = Fargate("TaskDefinition\n프리셋 cpu/mem · :8080")
                tg = ElasticLoadBalancing("Target Group\n/health · host 규칙")
                sched = Eventbridge("Scheduler ×2 · Alarm\n가동 시간표 · 유휴")

        src = Codecommit("소스 저장소\nCodeCommit /\nCodeConnections")

        # ── 사용자 진입 ────────────────────────────────────────────────
        users >> Edge(color=CTRL, label="플랫폼 웹") >> cf >> Edge(color=DATA) >> s3spa
        cf >> Edge(color=CTRL, label="XHR + JWT") >> api
        cognito >> Edge(color=CTRL, style="dashed", label="JWT 검증") >> api
        users >> Edge(color=CTRL, label="앱 접속 HTTPS") >> albs

        # ── 컨트롤 플레인 내부 ──────────────────────────────────────────
        api >> Edge(color=DATA) >> ddb
        api >> Edge(color=DATA, style="dashed") >> sm
        api >> Edge(color=CTRL, label="StartExecution") >> sfn
        sfn >> Edge(color=CTRL, label="StartBuild") >> provisioner
        provisioner >> Edge(color=DATA, style="dashed", label="자산 read") >> s3asset
        provisioner >> Edge(color=CTRL, label="cdk deploy\n앱 스택") >> pipeline

        # ── 배포 (상세는 deploy-flow 다이어그램) ────────────────────────
        src >> Edge(color=CTRL, label="push / 수동") >> pipeline
        pipeline >> Edge(color=DATA, label="이미지") >> ecr
        pipeline >> Edge(color=CTRL, label="cdk deploy\nruntime") >> svc
        pipeline >> Edge(color=EVENT, style="dashed", label="State Change") >> notify
        notify >> Edge(color=DATA, label="배포 이력") >> ddb

        # ── 앱 트래픽 · 런타임 (wake 상세는 wake-flow 다이어그램) ────────
        albs >> Edge(color=CTRL) >> tg >> Edge(color=CTRL) >> svc
        svc >> Edge(color=DATA) >> task
        task >> Edge(color=DATA, style="dashed", label="pull") >> ecr
        task >> Edge(color=DATA, style="dashed", label="주입") >> sm
        cluster >> Edge(color=DATA, style="dotted", label="소속") >> svc
        svc >> Edge(color=DATA, style="dotted", label="태스크 배치") >> vpc
        albs >> Edge(color=EVENT, style="dashed", label="잠자는 앱") >> wake
        wake >> Edge(color=EVENT, label="기동 · 중지") >> svc
        sched >> Edge(color=EVENT, style="dotted") >> svc
        api >> Edge(color=CTRL, label="재시작 · 강제중지") >> svc

        # ── 공유 인프라 참조 ────────────────────────────────────────────
        acm >> Edge(color=DATA, style="dotted") >> albs
        dns >> Edge(color=DATA, style="dotted", label="alias") >> albs
        ssm >> Edge(color=DATA, style="dotted", label="공유값") >> svc


def deploy_flow() -> None:
    """배포 흐름 — 파이프라인 4스테이지 + Notify."""
    with Diagram(
        "AppHub — 배포 흐름 (앱별 CodePipeline)",
        filename=str(OUT_DIR / "apphub-architecture-deploy-flow"),
        outformat="png",
        show=False,
        direction="LR",
        graph_attr={**GRAPH_ATTR, "ranksep": "1.1"},
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        src = Codecommit("① Source\nCodeCommit /\nCodeConnections")

        with Cluster("② ValidateBuild  |  CodeBuild (privileged)"):
            validate = Codebuild(
                "Dockerfile 검증\n→ docker build\n→ /health 스모크"
            )
            ecr = ECR("ECR push\n태그=commitSha")

        with Cluster("③ Deploy  |  CodeBuild"):
            deploy = Codebuild("앱 파라미터 조립\n→ cdk deploy\napp-runtime")
            runtime = ElasticContainerServiceService("ECS Service 갱신\n(rolling + 자동 롤백)")

        with Cluster("④ Notify  |  EventBridge → Lambda"):
            evb = Eventbridge("Stage / Execution\nState Change")
            notify = Lambda("deploy-notify")
            ddb = Dynamodb("Deployment 레코드\nPENDING→VALIDATING\n→DEPLOYING→SUCCEEDED")

        ddb_param = Dynamodb("App / Preset /\nPermissionTemplate")

        src >> Edge(color=CTRL) >> validate >> Edge(color=DATA) >> ecr
        ecr >> Edge(color=CTRL, label="imageTag") >> deploy
        ddb_param >> Edge(color=DATA, style="dashed", label="조회") >> deploy
        deploy >> Edge(color=CTRL) >> runtime
        runtime >> Edge(color=EVENT, style="dashed") >> evb
        evb >> Edge(color=EVENT) >> notify >> Edge(color=DATA) >> ddb


def wake_flow() -> None:
    """유휴 절감 — 잠들기 / 접속 시 자동 기동 / 복원."""
    with Diagram(
        "AppHub — 유휴 절감 (wake-on-request)",
        filename=str(OUT_DIR / "apphub-architecture-wake-flow"),
        outformat="png",
        show=False,
        direction="LR",
        graph_attr={**GRAPH_ATTR, "ranksep": "1.1"},
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    ):
        users = Users("사용자 접속")

        with Cluster("공유 ALB  |  리스너 규칙 = 상태의 단일 지점"):
            alb = ElasticLoadBalancing("ALB\nhost 기반 규칙")
            tg_app = ElasticLoadBalancing("앱 Target Group\n(깨어 있음)")
            tg_waker = ElasticLoadBalancing("Waker TG (공유)\n(잠자는 중)")

        with Cluster("전환 Lambda 3종  |  network 스택 공유"):
            waker = Lambda("waker\n대기 페이지 200\n+ 기동 요청")
            restore = Lambda("wake-restore\n규칙 → 앱 TG")
            sleeper = Lambda("sleep-transition\ncount=0 + 규칙 → Waker")

        svc = ElasticContainerServiceService("ECS Service\ndesiredCount 0 ↔ min")
        alarm = Cloudwatch("Alarm idle\n15분 무요청")
        ddb = Dynamodb("runtimeState\nRUNNING / WAKING / SLEEPING")

        users >> Edge(color=CTRL) >> alb
        alb >> Edge(color=CTRL, label="forward") >> tg_app >> Edge(color=CTRL) >> svc
        alb >> Edge(color=EVENT, style="dashed", label="잠자는 동안") >> tg_waker
        tg_waker >> Edge(color=EVENT) >> waker
        waker >> Edge(color=EVENT, label="① desiredCount=min") >> svc
        svc >> Edge(color=EVENT, style="dashed", label="② Task RUNNING") >> restore
        restore >> Edge(color=EVENT, label="③ 규칙 복원") >> tg_app
        alarm >> Edge(color=EVENT, style="dashed", label="유휴 감지") >> sleeper
        sleeper >> Edge(color=EVENT, label="재중지") >> svc
        sleeper >> Edge(color=EVENT, style="dotted", label="규칙 전환") >> tg_waker
        waker >> Edge(color=DATA, style="dotted") >> ddb
        restore >> Edge(color=DATA, style="dotted") >> ddb
        sleeper >> Edge(color=DATA, style="dotted") >> ddb


if __name__ == "__main__":
    overview()
    deploy_flow()
    wake_flow()
    for p in sorted(OUT_DIR.glob("apphub-architecture-*.png")):
        print(f"생성: {p.relative_to(OUT_DIR.parent.parent)}  ({p.stat().st_size // 1024} KB)")
