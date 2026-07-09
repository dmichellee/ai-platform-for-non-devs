import * as path from "node:path";
import {
  Duration,
  RemovalPolicy,
  Stack,
  aws_codebuild as codebuild,
  aws_codecommit as codecommit,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as cpactions,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { resourcePrefix } from "../config";
import type { AppPipelineParams } from "./app-params";

/**
 * app-pipeline — 특정 앱의 **빌드 경로** (apphub-conventions 2장, DESIGN.md 3.1/3.3).
 *
 * 포함(전부 앱별 — 앱 삭제 = 이 스택 삭제로 완결):
 *  - ECR 리포지토리(lifecycle 최근 5개, emptyOnDelete:true → 앱 삭제 시 이미지 포함 완전 삭제)
 *  - CodePipeline: Source(CodeCommit / CodeConnections provider별) → Build#1(검증+빌드) → Build#2(배포)
 *  - CodeBuild #1(검증+빌드): Dockerfile 검증기 실행 → docker build → 스모크 /health → ECR push(태그=commitSha)
 *  - CodeBuild #2(배포): cdk deploy app-runtime (이미지 태그/프리셋/priority 컨텍스트 주입)
 *
 * buildspec 2종은 infra/buildspec/*.yml 파일. 이 construct가 CodeBuild에 로드한다.
 * 자동/수동 트리거: autoDeployEnabled면 source push 트리거, 아니면 StartPipelineExecution(수동, M5).
 */
export interface AppPipelineProps {
  readonly params: AppPipelineParams;
}

export class AppPipeline extends Construct {
  readonly ecrRepo: ecr.Repository;
  readonly pipeline: codepipeline.Pipeline;
  readonly validateBuild: codebuild.PipelineProject;
  readonly deployBuild: codebuild.PipelineProject;

  constructor(scope: Construct, id: string, props: AppPipelineProps) {
    super(scope, id);

    const p = props.params;
    const stack = Stack.of(this);
    const prefix = resourcePrefix(p.stage);
    const appPrefix = `${prefix}-app-${p.appId}`;

    // ── ECR 리포 (lifecycle 5개, 앱 삭제 시 이미지 포함 완전 삭제) ────────────
    this.ecrRepo = new ecr.Repository(this, "Ecr", {
      repositoryName: `${appPrefix}`, // app-runtime의 이미지 참조명과 동일 규약
      imageScanOnPush: true,
      emptyOnDelete: true, // 앱 삭제 시 이미지까지 삭제(RETAIN 아님, cdk-authoring)
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          description: "Keep only the latest 5 images (rollback headroom + cost control, DESIGN 9)",
          maxImageCount: 5,
        },
      ],
    });

    // ── 파이프라인 아티팩트 버킷(앱별, 삭제 시 함께) ─────────────────────────
    const artifactBucket = new s3.Bucket(this, "Artifacts", {
      bucketName: `${appPrefix}-artifacts-${stack.account}`.slice(0, 63),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    // ── CodeBuild 로그 그룹 ──────────────────────────────────────────────────
    const buildLogGroup = new logs.LogGroup(this, "BuildLogs", {
      logGroupName: `/apphub/${p.stage}/app/${p.appId}/build`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ── CodeBuild #1: 검증 + 빌드 ────────────────────────────────────────────
    // privileged: docker build/run(스모크)에 필요.
    this.validateBuild = new codebuild.PipelineProject(this, "ValidateBuild", {
      projectName: `${appPrefix}-validate-build`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // docker-in-docker (build + smoke run)
      },
      environmentVariables: {
        STAGE: { value: p.stage },
        APP_ID: { value: p.appId },
        AWS_ACCOUNT_ID: { value: stack.account },
        AWS_DEFAULT_REGION: { value: stack.region },
        ECR_REPO_NAME: { value: this.ecrRepo.repositoryName },
        TABLE_NAME: { value: `${prefix}-main` },
        // D-M5-06: provisioner가 -c 로 전달한 검증기 번들 위치. validate-build.yml이 소비.
        ...(p.validatorS3Uri ? { VALIDATOR_S3_URI: { value: p.validatorS3Uri } } : {}),
      },
      logging: { cloudWatch: { logGroup: buildLogGroup } },
      buildSpec: codebuild.BuildSpec.fromAsset(
        path.join(__dirname, "..", "..", "buildspec", "validate-build.yml"),
      ),
    });
    // 범위 한정 권한(D8/보안 8): ECR push는 이 앱 리포로만, 로그/DDB 상태 갱신은 범위 지정.
    this.ecrRepo.grantPullPush(this.validateBuild);
    this.validateBuild.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "EcrAuth",
        actions: ["ecr:GetAuthorizationToken"], // 리소스 레벨 미지원(계정 스코프) — 주석 명시
        resources: ["*"],
      }),
    );
    // 배포 이력(Deployment) 상태/failureCategory 갱신은 앱 단일 테이블 아이템으로 한정.
    this.validateBuild.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeploymentStatusWrite",
        actions: ["dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:GetItem"],
        resources: [
          stack.formatArn({ service: "dynamodb", resource: "table", resourceName: `${prefix}-main` }),
        ],
      }),
    );
    // 검증기 번들(VALIDATOR_S3_URI)을 자산 버킷에서 받는다(D-M5-06). 버킷 오브젝트 GetObject만.
    this.grantAssetRead(this.validateBuild, p.validatorS3Uri, "ReadValidatorAsset");

    // ── CodeBuild #2: 배포(cdk deploy app-runtime) ───────────────────────────
    this.deployBuild = new codebuild.PipelineProject(this, "DeployBuild", {
      projectName: `${appPrefix}-deploy`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
      },
      environmentVariables: {
        STAGE: { value: p.stage },
        APP_ID: { value: p.appId },
        AWS_ACCOUNT_ID: { value: stack.account },
        AWS_DEFAULT_REGION: { value: stack.region },
        // D-M5-06: provisioner가 -c 로 전달한 플랫폼 CDK tarball 위치. deploy.yml이 소비
        //  (app-runtime construct 포함 CDK 소스를 받아 cdk deploy app-runtime 실행).
        ...(p.cdkSourceS3Uri ? { CDK_SOURCE_S3_URI: { value: p.cdkSourceS3Uri } } : {}),
      },
      logging: { cloudWatch: { logGroup: buildLogGroup } },
      buildSpec: codebuild.BuildSpec.fromAsset(
        path.join(__dirname, "..", "..", "buildspec", "deploy.yml"),
      ),
    });
    // 배포 빌드는 이 앱의 runtime 스택만 cdk deploy 하도록 CloudFormation 권한을 범위 지정.
    //  (실행 역할이 필요로 하는 CFN/ECS/ELB/Route53/SSM/IAM PassRole은 실배포 환경 정책으로 부여.
    //   여기서는 스택 이름/자원 접두어로 범위를 좁히고, 세부 확장은 M5 provisioner 정책과 정렬한다.)
    this.deployBuild.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeployAppRuntimeCfn",
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:GetTemplate",
          "cloudformation:CreateChangeSet",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:DeleteChangeSet",
        ],
        resources: [
          stack.formatArn({
            service: "cloudformation",
            resource: "stack",
            resourceName: `${appPrefix}-runtime/*`,
          }),
        ],
      }),
    );
    // CDK assume(bootstrap 역할) — deploy-role/publishing-role. 계정 스코프 role path로 한정.
    this.deployBuild.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          stack.formatArn({
            service: "iam",
            region: "",
            resource: "role",
            resourceName: "cdk-*",
          }),
        ],
      }),
    );
    // 플랫폼 CDK 소스 tarball(CDK_SOURCE_S3_URI)을 자산 버킷에서 받는다(D-M5-06). GetObject만.
    this.grantAssetRead(this.deployBuild, p.cdkSourceS3Uri, "ReadCdkSourceAsset");

    // ── 소스 액션 (provider별 분기) ──────────────────────────────────────────
    const sourceOutput = new codepipeline.Artifact("Source");
    const sourceAction = this.buildSourceAction(p, sourceOutput);

    const validateOutput = new codepipeline.Artifact("ValidateBuildOut");

    // ── 파이프라인 조립 ──────────────────────────────────────────────────────
    this.pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: `${appPrefix}`,
      artifactBucket,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [sourceAction] },
        {
          stageName: "ValidateBuild",
          actions: [
            new cpactions.CodeBuildAction({
              actionName: "ValidateAndBuild",
              project: this.validateBuild,
              input: sourceOutput,
              outputs: [validateOutput],
              // 이미지 태그(commitSha)를 다음 스테이지로 전달하기 위한 환경변수는 buildspec exported-variables.
              environmentVariables: {
                AUTO_DEPLOY: { value: p.autoDeployEnabled ? "true" : "false" },
              },
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new cpactions.CodeBuildAction({
              actionName: "DeployRuntime",
              project: this.deployBuild,
              input: validateOutput,
            }),
          ],
        },
      ],
    });
  }

  /**
   * 소스 액션 구성 — provider별 분기(D4).
   *  - codecommit: CodeCommitSourceAction(자동 트리거는 EVENTS/폴링, autoDeploy에 따라).
   *  - github/gitlab: CodeStarConnectionsSourceAction(CodeConnections ARN).
   * 수동 트리거(autoDeployEnabled=false)는 트리거를 끄고 StartPipelineExecution(M5)만 사용.
   */
  private buildSourceAction(
    p: AppPipelineParams,
    output: codepipeline.Artifact,
  ): codepipeline.IAction {
    const trigger = p.autoDeployEnabled
      ? cpactions.CodeCommitTrigger.EVENTS
      : cpactions.CodeCommitTrigger.NONE;

    if (p.provider === "codecommit") {
      // repoUrl 마지막 세그먼트를 리포명으로 사용(예: https://.../v1/repos/<name>).
      const repoName = p.repoUrl.split("/").filter(Boolean).pop() ?? p.repoUrl;
      const repo = codecommit.Repository.fromRepositoryName(this, "SourceRepo", repoName);
      return new cpactions.CodeCommitSourceAction({
        actionName: "Source",
        repository: repo,
        branch: p.branch,
        output,
        trigger,
      });
    }

    // github/gitlab — CodeConnections. repoUrl에서 owner/repo 추출.
    if (!p.connectionArn) {
      throw new Error(
        `provider=${p.provider} 인데 connectionArn이 없습니다. github/gitlab은 CodeConnections ARN이 필요합니다.`,
      );
    }
    const { owner, repo } = this.parseOwnerRepo(p.repoUrl);
    return new cpactions.CodeStarConnectionsSourceAction({
      actionName: "Source",
      connectionArn: p.connectionArn,
      owner,
      repo,
      branch: p.branch,
      output,
      triggerOnPush: p.autoDeployEnabled,
    });
  }

  /**
   * 자산 S3 오브젝트 읽기 권한 부여(D-M5-06). s3://bucket/key URI에서 버킷명을 파싱해
   * `arn:aws:s3:::bucket/*` GetObject만 부여한다(버킷 자체 관리 권한 없음, 최소 권한).
   * URI 미지정(provisioner가 -c 를 안 넘긴 경우)이면 no-op — buildspec이 명시적 실패로 안내한다.
   */
  private grantAssetRead(
    project: codebuild.PipelineProject,
    s3Uri: string | undefined,
    sid: string,
  ): void {
    if (!s3Uri) return;
    const m = /^s3:\/\/([^/]+)\//.exec(s3Uri);
    if (!m) return;
    const bucket = m[1];
    project.addToRolePolicy(
      new iam.PolicyStatement({
        sid,
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::${bucket}/*`],
      }),
    );
  }

  /** repoUrl(https://host/owner/repo(.git)?) → { owner, repo }. */
  private parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
    const cleaned = repoUrl.replace(/\.git$/, "");
    const parts = cleaned.split("/").filter(Boolean);
    const repo = parts.pop() ?? "";
    const owner = parts.pop() ?? "";
    if (!owner || !repo) {
      throw new Error(`repoUrl에서 owner/repo를 추출하지 못했습니다: ${repoUrl}`);
    }
    return { owner, repo };
  }
}
