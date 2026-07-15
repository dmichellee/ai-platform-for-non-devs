import * as path from "node:path";
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_apigateway as apigw,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cw,
  aws_codebuild as codebuild,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_ssm as ssm,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as sfn_tasks,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { StageConfig, resourcePrefix } from "../lib/config";

/**
 * platform-stack — 앱과 무관한 컨트롤 플레인 (apphub-conventions 2장, DESIGN.md 3.1).
 *
 * 포함:
 *  - Cognito User Pool(그룹 admin/user, 관리자 초대 흐름) + Client + Hosted UI 도메인
 *  - DynamoDB 단일 테이블 apphub-{stage}-main (PK/SK + GSI1 ownerId + GSI2 status)
 *  - REST API Gateway + Lambda 핸들러 골격(실핸들러는 M3 backend) + Cognito authorizer
 *  - Step Functions 스텁 (ProvisionApp / DeleteApp — M5에서 채움)
 *  - SPA 호스팅: S3(비공개) + CloudFront(OAC)
 *  - provisioner CodeBuild 프로젝트(앱 스택 cdk deploy용) 뼈대
 *  - CloudWatch 대시보드(관리자 관측성) 최소
 *
 * 교차 스택 참조는 Export 대신 SSM/명시 Outputs (cdk-authoring 규칙).
 */
export interface PlatformStackProps extends StackProps {
  readonly stage: StageConfig["stage"];
  readonly config: StageConfig;
}

export class PlatformStack extends Stack {
  readonly table: dynamodb.Table;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly api: apigw.RestApi;
  readonly apiHandler: lambda.Function;
  readonly spaBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly provisioner: codebuild.Project;
  readonly provisionStateMachine: sfn.StateMachine;
  readonly deleteStateMachine: sfn.StateMachine;
  /** DESIGN 3.3 [Notify]: CodePipeline 상태 → DDB Deployment 레코드 갱신 Lambda */
  readonly deployNotifyFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = resourcePrefix(config.stage);

    // ── DynamoDB 단일 테이블 ────────────────────────────────────────────────
    // PK/SK + GSI1(ownerId → 사용자별 앱) + GSI2(status → 관리자 현황). PAY_PER_REQUEST.
    const table = new dynamodb.Table(this, "MainTable", {
      tableName: `${prefix}-main`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl", // 배포 이력 90일 TTL (DESIGN.md 4)
      removalPolicy: config.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "ownerId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
    });
    this.table = table;

    // ── Cognito User Pool ──────────────────────────────────────────────────
    // 관리자 초대 기본(selfSignUp 비활성). 그룹 admin/user.
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: false, // 관리자 초대만 (DESIGN.md 5)
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: config.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.userPool = userPool;

    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admin",
      description: "Platform admin - view/stop/delete all apps + CONFIG",
    });
    new cognito.CfnUserPoolGroup(this, "UserGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "user",
      description: "Regular user - CRUD on own apps",
    });

    // Hosted UI 도메인 — stage+account 기반으로 전역 유일화(퍼블릭 애셋: 조직 식별정보 금지).
    const hostedUiDomainPrefix = `apphub-${config.stage}-${this.account}`;
    userPool.addDomain("HostedUi", {
      cognitoDomain: { domainPrefix: hostedUiDomainPrefix },
    });
    // ALB authenticate-cognito(D16)용 클라이언트 — SPA 클라이언트와 별개.
    //  ALB는 client_secret이 있는 클라이언트 + 콜백 `https://{host}/oauth2/idpresponse`를 요구한다.
    //  앱 서브도메인은 앱마다 다르므로 와일드카드 콜백을 허용 목록에 넣는다(*.appsDomain).
    const appAuthClient = userPool.addClient("AppAuthClient", {
      userPoolClientName: `${prefix}-app-auth`,
      generateSecret: true, // ALB authenticate-cognito 요구
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://*.${config.appsDomain}/oauth2/idpresponse`],
      },
    });

    // ── SPA 호스팅: 비공개 S3 + CloudFront(OAC) ────────────────────────────
    const spaBucket = new s3.Bucket(this, "SpaBucket", {
      bucketName: `${prefix}-spa-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.stage !== "prod",
    });
    this.spaBucket = spaBucket;

    const distribution = new cloudfront.Distribution(this, "SpaDistribution", {
      comment: `${prefix} SPA`,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(spaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // SPA 라우팅: 404/403 → index.html
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });
    this.distribution = distribution;

    // ── SPA User Pool Client (Hosted UI code grant) ────────────────────────
    // 콜백/로그아웃 URL은 **프론트 AuthContext가 실제로 보내는 redirect_uri와 1바이트까지 일치**해야
    //  한다(불일치 시 Cognito redirect_mismatch). 진실은 프론트다:
    //   - frontend/src/auth/AuthContext.tsx: redirect_uri = `config.redirectUri ?? window.location.origin`.
    //     deploy.sh는 config.json에 redirectUri를 넣지 않으므로 → 항상 `window.location.origin`.
    //   - `window.location.origin`은 **경로/트레일링슬래시 없는 origin 루트**(예: https://{host}).
    //   - 콜백 처리도 origin 루트에서 `?code=`를 읽는다(`/callback` 경로 미사용).
    //   - logout_uri도 동일하게 origin 루트.
    //  따라서 callback/logout 모두 `https://{cloudFrontDomain}`(경로 없음) 로 등록한다.
    //  같은 스택 내 distribution 참조이므로 순환 없음(CloudFront→UserPoolClient 단방향 토큰 참조).
    //  dev는 로컬 개발 편의를 위해 Vite dev 서버 origin(http://localhost:5173)도 함께 허용한다.
    const spaOriginUrl = `https://${distribution.distributionDomainName}`;
    const localDevOrigins = config.stage === "prod" ? [] : ["http://localhost:5173"];
    const userPoolClient = userPool.addClient("SpaClient", {
      userPoolClientName: `${prefix}-spa`,
      generateSecret: false, // SPA(퍼블릭 클라이언트)
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        // redirect_uri == callbackUrl (origin 루트, 경로/트레일링슬래시 없음).
        callbackUrls: [spaOriginUrl, ...localDevOrigins],
        // logout_uri == logoutUrl (동일 origin 루트).
        logoutUrls: [spaOriginUrl, ...localDevOrigins],
      },
    });
    this.userPoolClient = userPoolClient;

    // ── REST API Gateway + Lambda 핸들러 골격 ──────────────────────────────
    // D-decision: REST API 채택(HTTP API 아님). 근거는 반환값 참조.
    const apiLogGroup = new logs.LogGroup(this, "ApiHandlerLogs", {
      logGroupName: `/apphub/${config.stage}/api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const apiHandler = new lambda.Function(this, "ApiHandler", {
      functionName: `${prefix}-api`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      // D-M8: backend(Python)가 진실. backend/build.sh가 app/ 를 infra/lambda/api/ 로 동기화하고
      //  자산 루트에 handler.py shim(app.handler.handler 재노출)을 둔다. deploy.sh가 cdk deploy 전
      //  `bash backend/build.sh`로 산출물(infra/lambda/api/handler.py + app/)을 보장한다.
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "api")),
      timeout: Duration.seconds(29), // API GW 통합 타임아웃 상한
      memorySize: 512,
      logGroup: apiLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        STAGE: config.stage,
        APPS_DOMAIN: config.appsDomain,
        // D18: 공유 ECS 클러스터명(`${prefix}-cluster`). 관리자 강제 중지(POST /admin/apps/{id}/stop →
        //  sleep_app(force=True))가 API Lambda 프로세스 안에서 app/wake/ecs_service.py의
        //  describe_services/update_service를 cluster 인자로 호출한다(app/wake/__init__.py cluster_name()이
        //  이 env를 읽음 — 미주입 시 RuntimeError, 폴백 없음). network-stack commonEnv와 동일 규약으로
        //  결정론적 이름을 직접 주입(크로스스택 참조/SSM 런타임 조회 없음).
        CLUSTER_NAME: `${prefix}-cluster`,
        // 핸들러 CORS(app/http/cors.py)가 요청 Origin을 허용 목록과
        //  대조해 그대로 에코한다(와일드카드 * 미사용 — D17/PLATFORM-ENGINEERING과 무관하나 보안 관행).
        //  허용 origin은 SPA CloudFront 도메인. dev는 Vite dev 서버(localhost:5173)도 함께 허용
        //  (SpaClient callbackUrls의 localDevOrigins와 동일 정책). distribution은 위에서 이미 참조 중이라 순환 없음.
        ALLOWED_ORIGINS:
          `https://${distribution.distributionDomainName}` +
          (config.stage === "dev" ? ",http://localhost:5173" : ""),
      },
      description: "Platform REST handler (M3 routing)",
    });
    table.grantReadWriteData(apiHandler);
    this.apiHandler = apiHandler;

    // ── API 역할 IAM (D-M3-02, ARN 범위 지정 — Resource:"*" 금지) ────────────
    // 아래 3종은 M3 API 핸들러가 실제 사용하는 최소 권한. 모두 리소스 레벨로 좁힌다.
    //
    // (1) logs:FilterLogEvents — 앱 로그 뷰어(GET /apps/{id}/logs). 앱 로그 그룹은
    //     runtime 스택이 `/apphub/{stage}/app/*`(하위: `.../<appId>`)로 만든다(app-runtime).
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppLogsFilter",
        actions: ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"],
        resources: [
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `/apphub/${config.stage}/app/*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
          this.formatArn({
            service: "logs",
            resource: "log-group",
            resourceName: `/apphub/${config.stage}/app/*:log-stream:*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // (2) cognito-idp Admin* — 관리자 사용자 관리(초대/그룹/활성). User Pool ARN으로 한정.
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CognitoUserAdmin",
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:ListUsers",
          "cognito-idp:ListUsersInGroup",
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    // (3) codeconnections — 레포 연결 생성/조회/삭제. 액션별 리소스 레벨 지원 여부에 따라 분리한다.
    //     (AWS Service Authorization Reference: list_awscodeconnections)
    //
    //     ┌ 리소스 레벨 미지원(Resource types 열 공백) → Resource:"*" 필수 ─────────────────┐
    //     │ - CreateConnection: 생성 시점엔 connection ARN이 없어 리소스 레벨 미지원(AWS 문서).
    //     │   connection/* 로 한정하면 AccessDenied(요구 리소스가 codeconnections:...:*)로 거부된다.
    //     │ - ListConnections: List 액션(계정 전체 목록 반환). connection 리소스는 문서상 optional이나
    //     │   계정 스코프 조회이므로 보수적으로 * 로 둔다.
    //     │ ⇒ D17/최소권한 원칙의 정당한 예외. 서비스(codeconnections) + 배포 리전/계정으로만 좁힌다.
    //     └────────────────────────────────────────────────────────────────────────────────┘
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CodeConnectionsCreateList",
        actions: [
          "codeconnections:CreateConnection",
          "codeconnections:ListConnections",
        ],
        // 리소스 레벨 미지원(AWS 문서) → Resource:"*" 필수.
        //  주의: 계정/리전 한정 ARN(arn:aws:codeconnections:{region}:{account}:*)조차
        //  IAM 상 "모든 리소스"로 인정되지 않아 매칭 실패(implicitDeny)한다.
        //  IAM 정책 시뮬레이터로 검증: `arn:...:*` → implicitDeny, `*` → allowed.
        //  따라서 이 두 액션만은 진짜 전역 "*"를 쓴다(D17/최소권한 원칙의 정당한 예외).
        //  범위 축소는 리소스가 아니라 조건 키(codeconnections:ProviderType 등)로만 가능하다.
        resources: ["*"],
      }),
    );
    //     ┌ 리소스 레벨 지원(Resource types: Connection*) → connection/* 로 범위 유지 ──────────┐
    //     │ - GetConnection / DeleteConnection: 특정 connection ARN 대상 → 계정 스코프 connection/*.
    //     │   UseConnection/PassConnection은 소스에서 연결을 소비하는 CodePipeline 역할이 필요로 하며
    //     │   (CodeStarConnectionsSourceAction가 app-pipeline에서 자동 부여), API 역할엔 불필요 → 미포함.
    //     └────────────────────────────────────────────────────────────────────────────────┘
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CodeConnectionsGetDelete",
        actions: [
          "codeconnections:GetConnection",
          "codeconnections:DeleteConnection",
        ],
        resources: [
          this.formatArn({
            service: "codeconnections",
            resource: "connection",
            resourceName: "*",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // (3b) codecommit — 레포 목록/생성/조회(GET/POST /connections/{connId}/repos). 액션별 리소스 레벨
    //     지원 여부에 따라 분리한다. codeconnections(3)과 동일하게 IAM 정책 시뮬레이터로 검증했다:
    //       - simulate-custom-policy 결과(2026-07-09, ap-northeast-2, account 111122223333):
    //         · ListRepositories / CreateRepository @ `arn:aws:codecommit:{region}:{account}:*` → implicitDeny
    //         · ListRepositories / CreateRepository @ `*`                                       → allowed
    //         · GetRepository @ `arn:aws:codecommit:{region}:{account}:some-repo`               → allowed
    //
    //     ┌ 리소스 레벨 미지원 → Resource:"*" 필수 (D17/최소권한 원칙의 정당한 예외, conventions 7장) ┐
    //     │ - ListRepositories: List 액션(계정 전역 목록 반환) — 특정 repo 리소스에 매칭되지 않는다.
    //     │   계정/리전 한정 ARN(arn:...:*)조차 IAM 상 매칭 실패(implicitDeny) → 진짜 전역 "*" 필요.
    //     │ - CreateRepository: 생성 시점엔 repo ARN이 아직 없어 리소스 레벨 미지원. arn:...:* 로 좁히면
    //     │   implicitDeny(500 재발). codeconnections:CreateConnection과 동일한 이유.
    //     └───────────────────────────────────────────────────────────────────────────────────────┘
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CodeCommitRepos",
        actions: [
          "codecommit:ListRepositories",
          "codecommit:CreateRepository",
        ],
        // 리소스 레벨 미지원(IAM 시뮬레이터 검증) → Resource:"*" 필수.
        //  계정/리전 한정 ARN조차 implicitDeny(codeconnections:CreateConnection/ListConnections와 동일).
        //  범위 축소는 리소스가 아니라 조건 키로만 가능하다.
        resources: ["*"],
      }),
    );
    //     ┌ 리소스 레벨 지원 → 계정/리전 한정 ARN 유지 ─────────────────────────────────────────────┐
    //     │ - GetRepository/DeleteRepository: 특정 repo ARN 대상 → 계정/리전 스코프로 한정.
    //     │   (GetRepository는 IAM 시뮬레이터 allowed 확인. DeleteRepository는 사용자가 AppHub로 만든
    //     │    본인 레포 삭제 API(DELETE /connections/{id}/repos/{name})가 사용 — 핸들러가 소유권을
    //     │    DDB로 검증하므로 IAM은 계정/리전 스코프로 충분.)
    //     │   앱 레포 명명 규약이 아직 없어 계정 리전 전체(*)로 두되, 서비스+리전+계정으로는 좁힌다.
    //     │   레포 명명 규약이 생기면 resourceName을 그 접두어로 더 좁힌다(후속).
    //     └───────────────────────────────────────────────────────────────────────────────────────┘
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CodeCommitRepoManage",
        actions: ["codecommit:GetRepository", "codecommit:DeleteRepository"],
        resources: [
          this.formatArn({
            service: "codecommit",
            resource: "*",
          }),
        ],
      }),
    );

    // (4) codepipeline:StartPipelineExecution — 수동 배포/롤백 트리거(DESIGN 3.3/9, M5).
    //     앱 파이프라인 이름 규약은 `apphub-{stage}-app-{appId}`(app-pipeline construct pipelineName).
    //     계정 내 앱 파이프라인(apphub-{stage}-app-*)으로 ARN 범위를 한정한다.
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "StartAppPipeline",
        actions: ["codepipeline:StartPipelineExecution"],
        resources: [
          this.formatArn({ service: "codepipeline", resource: `${prefix}-app-*` }),
        ],
      }),
    );
    // (5) 모니터링 메트릭 (GET /apps/{id}/metrics — 접속량/CPU/메모리 시계열)
    //     - cloudwatch:GetMetricData: 리소스 레벨 권한 미지원 → Resource:"*" (정당 예외, conventions 7장)
    //     - elasticloadbalancing:DescribeTargetGroups: Describe 계열은 리소스 레벨 미지원 → "*"
    //       (network-stack 복원/sleep 역할의 동일 액션 예외와 같은 근거. read-only)
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppMetricsRead",
        actions: ["cloudwatch:GetMetricData", "elasticloadbalancing:DescribeTargetGroups"],
        resources: ["*"],
      }),
    );

    // (6) 관리자 강제 중지 (POST /admin/apps/{id}/stop → app/wake/sleep.py sleep_app(force=True), D-M4-04/D-M5-03).
    //     이 경로는 API Lambda 프로세스 안에서(비동기 Waker/SFN 아님) 앱을 재운다:
    //       ECS desiredCount=0(ensure_stopped) + 리스너 규칙 forward를 공유 Waker TG로 전환(transition_listener_rule)
    //       + runtimeState=SLEEPING. 이를 위해 network의 wake Lambda(waker/sleep)와 동일한 ECS/SSM/ELB 권한이
    //       API 역할에도 필요하다(network-stack.ts grantWakeFunctionPermissions와 동일 ARN 패턴).
    //     주의: DescribeTargetGroups(find_app_target_group_arn)는 위 AppMetricsRead에 이미 있으므로 중복 추가하지 않는다.
    //
    // (6a) ECS 강제 중지 — 공유 클러스터(D18) 하위 앱 서비스만.
    //      ARN 경로: service/{prefix}-cluster/{prefix}-app-*  (network-stack appServiceArn과 동일 — 공유 클러스터 경로).
    //      D18 이전엔 클러스터명=서비스명 가정이었으나 공유 클러스터로 경로가 변경됐다(service/{cluster}/{service}).
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AdminStopEcs",
        actions: ["ecs:DescribeServices", "ecs:UpdateService"],
        resources: [
          this.formatArn({
            service: "ecs",
            resource: "service",
            resourceName: `${prefix}-cluster/${prefix}-app-*`,
          }),
        ],
      }),
    );
    // (6b) network 공유값 SSM 읽기 — sleep_app이 listener_arn_for_scheme/network_param으로 리스너 ARN·
    //      waker-tg-arn·apps-domain을 읽는다(app/integrations/ssm.py, /apphub/{stage}/network/* 경로만 사용).
    //      network-stack grantWakeFunctionPermissions의 ssmNetworkArn(ReadNetworkSsm)과 동일 패턴.
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadNetworkSsm",
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: `apphub/${config.stage}/network/*`,
          }),
        ],
      }),
    );
    // (6c) 리스너 규칙 forward 전환 — transition_listener_rule이 host 규칙의 forward 대상을 공유 Waker TG로 교체.
    //      ModifyRule은 listener-rule ARN을 지원하나 앱 규칙 ARN을 사전에 알 수 없어(런타임 조회)
    //      listener-rule/app/* 와일드카드로 좁힌다(network-stack elbControl의 listenerRuleArn과 동일 패턴).
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AdminStopElbRules",
        actions: ["elasticloadbalancing:ModifyRule"],
        resources: [
          this.formatArn({
            service: "elasticloadbalancing",
            resource: "listener-rule/app",
            resourceName: "*",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // (6d) ELB Describe 계열 — DescribeRules(find_rule_by_host)·DescribeListeners는 리소스 레벨 미지원 →
    //      Resource:"*" (정당 예외, conventions 7장). network-stack elbControl의 ElbDescribe와 동일 근거(read-only).
    //      DescribeTargetGroups는 AppMetricsRead에 이미 있어 여기서는 제외(중복 금지).
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AdminStopElbDescribe",
        actions: [
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeListeners",
        ],
        resources: ["*"],
      }),
    );

    // (7) 앱 시크릿 CRUD (POST/DELETE /apps/{id}/secrets 등, D-M5-03 시크릿 관리).
    //     backend가 `apphub/{stage}/app/{appId}/{KEY}`(슬래시) 이름으로 시크릿을 CRUD한다.
    //     appSecretArn(path 스타일 `apphub/{stage}/app/*`)이 6자 랜덤 suffix까지 커버 —
    //     delete-task의 DeleteSecret과 동일 상수를 공유(하이픈 규약 AccessDenied 회귀 방지).
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppSecretsCrud",
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:DeleteSecret",
        ],
        resources: [this.appSecretArn(config.stage)],
      }),
    );
    // (8) 롤백 이미지 태그 확인 (GET /apps/{id}/deployments 등 롤백 후보 조회, D-M5-03 롤백).
    //     ecr:DescribeImages는 repository ARN을 지원 → 앱 ECR 리포(apphub-{stage}-app-*)로 한정.
    //     (app-pipeline construct가 만드는 리포 명명 규약 apphub-{stage}-app-{appId}.)
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppEcrImages",
        actions: ["ecr:DescribeImages"],
        resources: [
          this.formatArn({
            service: "ecr",
            resource: "repository",
            resourceName: `${prefix}-app-*`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // (9) 롤백 runtime 재배포 트리거 (POST /apps/{id}/rollback → provisioner StartBuild, D-M5-03 롤백).
    //     롤백은 선택 이미지 태그로 runtime 스택을 재배포하므로 provisioner CodeBuild를 시작한다.
    //     provisionerBuildArn(`${prefix}-provisioner`)로 한정 — task Lambda의 StartPollProvisioner와 동일 대상.
    apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "StartProvisionerBuild",
        actions: ["codebuild:StartBuild"],
        resources: [this.provisionerBuildArn(prefix)],
      }),
    );

    const api = new apigw.RestApi(this, "Api", {
      restApiName: `${prefix}-api`,
      description: "AppHub control plane REST API",
      deployOptions: { stageName: config.stage },
      // OPTIONS preflight는 API GW가 각 리소스에 만드는 MOCK 통합이 처리한다(ANY proxy 통합보다 우선).
      //  실제 응답의 CORS는 Lambda 핸들러(app/http/cors.py)가 붙이므로, 두 경로의 정책을 정합시킨다:
      //   - allowOrigins: SPA CloudFront 도메인(+dev localhost) == ALLOWED_ORIGINS env == 핸들러 에코 대상.
      //   - allowHeaders: Cors.DEFAULT_HEADERS는 Authorization 포함(핸들러 ALLOW_HEADERS와 정합).
      //   - allowCredentials: 핸들러가 Access-Control-Allow-Credentials:true를 붙이므로 preflight도 맞춘다.
      //  Access-Control-Allow-Origin: * 는 사용하지 않는다(credentials와 양립 불가·보안 관행).
      defaultCorsPreflightOptions: {
        allowOrigins: [
          `https://${distribution.distributionDomainName}`,
          ...localDevOrigins,
        ],
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: apigw.Cors.DEFAULT_HEADERS,
        allowCredentials: true,
      },
    });
    this.api = api;

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, "JwtAuthorizer", {
      cognitoUserPools: [userPool],
      authorizerName: `${prefix}-authorizer`,
    });

    // ── Gateway Responses (authorizer/게이트웨이 단 4xx/5xx에 CORS 헤더 부착) ──
    // 문제: Cognito authorizer가 토큰 만료/부재로 요청을 거부하면 Lambda 도달 전에 API GW가
    //  직접 401/403을 반환하는데, 기본 Gateway Response에는 CORS 헤더가 없다. 그래서 브라우저는
    //  응답을 읽지 못하고 실제 401 대신 "CORS 에러"로 표시 → 프론트가 UNAUTHENTICATED를 인지 못함.
    // 해결: 게이트웨이 단 응답에도 Access-Control-Allow-Origin/Headers를 붙여 브라우저가 status를
    //  읽게 한다. (정상 응답·preflight CORS는 defaultCorsPreflightOptions와 Lambda 핸들러가 그대로 담당 —
    //  이 블록은 그 경로를 건드리지 않는다.)
    // 제약: Gateway Response 헤더 값은 정적 문자열이라 요청 Origin 에코(다중 오리진)가 불가하다.
    //  단일 정적값만 가능하므로 SPA CloudFront 도메인을 우선한다(spaOriginUrl, single-quote로 감쌈).
    //  ⇒ dev 로컬(http://localhost:5173)은 게이트웨이 단 401/403에서 여전히 CORS 표시가 남을 수 있으나
    //     수용한다(로컬 개발 편의보다 배포 도메인의 만료 UX가 우선). 정상 응답/preflight의 localhost는
    //     defaultCorsPreflightOptions·핸들러 CORS가 계속 지원한다.
    const gatewayCorsHeaders: { [key: string]: string } = {
      // 정적 문자열이어야 하므로 값 자체를 single-quote로 감싼다(`'https://...'`).
      "Access-Control-Allow-Origin": `'${spaOriginUrl}'`,
      "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
    };
    // authorizer 거부(401)와 인가 실패(403)가 핵심이고, 그 외 게이트웨이 단 4xx/5xx도 함께 커버한다.
    //  DEFAULT_4XX/5XX는 세부 타입이 지정되지 않은 응답의 폴백이라 UNAUTHORIZED/ACCESS_DENIED와 함께 둔다.
    const gatewayResponseTypes: Array<{ id: string; type: apigw.ResponseType }> = [
      { id: "GwRespUnauthorized", type: apigw.ResponseType.UNAUTHORIZED }, // 401 (토큰 만료/부재)
      { id: "GwRespAccessDenied", type: apigw.ResponseType.ACCESS_DENIED }, // 403 (인가 실패)
      { id: "GwRespDefault4xx", type: apigw.ResponseType.DEFAULT_4XX },
      { id: "GwRespDefault5xx", type: apigw.ResponseType.DEFAULT_5XX },
    ];
    for (const { id, type } of gatewayResponseTypes) {
      new apigw.GatewayResponse(this, id, {
        restApi: api,
        type,
        responseHeaders: gatewayCorsHeaders,
      });
    }

    // /{proxy+} 골격 — 실제 리소스/메서드 트리는 M3가 확장. 프록시로 모든 경로 위임.
    const proxy = api.root.addProxy({
      anyMethod: true,
      defaultIntegration: new apigw.LambdaIntegration(apiHandler),
      defaultMethodOptions: {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
      },
    });
    void proxy;

    // ── 플랫폼 자산 S3 버킷 (검증기 번들 · CDK 소스 tarball) ─────────────────
    // D-M5-06: deploy.sh가 이 버킷의 **고정 키**로 검증기/CDK소스를 업로드하고, provisioner·
    //  app-pipeline CodeBuild env(VALIDATOR_S3_URI/CDK_SOURCE_S3_URI)가 이를 가리킨다(신뢰 경계).
    //  버킷명 규약: apphub-{stage}-assets-{account}. dev는 DESTROY+autoDelete, prod는 RETAIN.
    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      bucketName: `${prefix}-assets-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: config.stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.stage !== "prod",
    });
    // 고정 키 → S3 URI. deploy.sh 업로드 키(3b 단계)와 정확히 일치해야 한다.
    //  D-M8: 검증기는 Python 2파일(dockerfile_validator.py + dockerfile.py)이므로 단일 파일이 아니라
    //  디렉토리 prefix(끝에 `/`)로 가리킨다. validate-build.yml 이 prefix 아래 두 파일을 명시 cp 한다.
    const validatorS3Uri = `s3://${assetsBucket.bucketName}/validator/`;
    const cdkSourceS3Uri = `s3://${assetsBucket.bucketName}/cdk-source/cdk-src.tgz`;

    // ── Kiro 설정 다운로드 정적 경로 (P-M7-01) ─────────────────────────────
    // "Kiro 설정 다운로드" 버튼은 자산 버킷의 `kiro-config/kiro-config.zip`(고정 키)을 받는다.
    //  API 왕복 없이(메인 서버 무부하) SPA CloudFront에 `/kiro-config/*` behavior를 붙여 자산 버킷을
    //  별도 오리진(OAC)으로 서빙한다. SPA 기본 origin은 그대로. 민감정보 없음(공개 다운로드).
    //  업로드는 scripts/build-kiro-bundle.sh --upload(또는 deploy.sh)가 동일 고정 키로 수행.
    distribution.addBehavior(
      "/kiro-config/*",
      origins.S3BucketOrigin.withOriginAccessControl(assetsBucket),
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
    );
    // 프론트 다운로드 고정 경로(config/문서용): https://{cloudFrontDomain}/kiro-config/kiro-config.zip
    const kiroConfigUrlPath = "/kiro-config/kiro-config.zip";

    // ── provisioner CodeBuild (앱 스택 cdk deploy용) ────────────────────────
    // D-M5-06: 실 buildspec(provisioner.yml)로 app-pipeline/runtime을 원격 배포한다.
    //  ProvisionApp 상태 기계(provision-task)가 StartBuild env override로 트리거.
    const provisionerLogGroup = new logs.LogGroup(this, "ProvisionerLogs", {
      logGroupName: `/apphub/${config.stage}/provisioner`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const provisioner = new codebuild.Project(this, "Provisioner", {
      projectName: `${prefix}-provisioner`,
      description: "Remote app stack runner (cdk deploy app-*) via provisioner.yml",
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
      },
      environmentVariables: {
        // 프로젝트 고정 env(buildspec-contract 7장). StartBuild override로 APP_ID/APP_STACK_KIND/... 추가.
        STAGE: { value: config.stage },
        TABLE_NAME: { value: table.tableName },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_DEFAULT_REGION: { value: this.region },
        VALIDATOR_S3_URI: { value: validatorS3Uri },
        CDK_SOURCE_S3_URI: { value: cdkSourceS3Uri },
      },
      logging: { cloudWatch: { logGroup: provisionerLogGroup } },
      buildSpec: codebuild.BuildSpec.fromAsset(
        path.join(__dirname, "..", "buildspec", "provisioner.yml"),
      ),
    });
    this.provisioner = provisioner;

    // provisioner 역할 IAM (buildspec-contract 7장, ARN 범위 — Resource:"*" 금지).
    this.grantProvisionerPermissions(provisioner, config.stage, prefix, assetsBucket);

    // 자산 버킷 참조 발행(Output+SSM). deploy.sh(3b)가 Output으로 버킷명을 읽어 고정 키로 업로드.
    this.output("AssetsBucketName", assetsBucket.bucketName);
    // P-M7-01: Kiro 설정 다운로드 정적 경로. 프론트는 `https://{CloudFrontDomain}{KiroConfigUrlPath}`.
    this.output("KiroConfigUrlPath", kiroConfigUrlPath);

    // ── Step Functions (ProvisionApp / DeleteApp) — 실 ASL (D-M5-01) ────────
    // 단일 task Lambda + step 디스패치. ASL은 Task 나열 + Wait/Choice(폴링) + Catch(실패 전이) 봉투.
    //  task Lambda(backend/src/orchestration/{provision,delete}.ts 번들)는 event.step으로 분기하고,
    //  "메인 서버 무부하" 원칙대로 CodeBuild/Pipeline/DeleteStack을 시작만 하고 폴링한다.
    const { provisionStateMachine, deleteStateMachine } = this.buildStateMachines(config.stage, prefix);
    this.provisionStateMachine = provisionStateMachine;
    this.deleteStateMachine = deleteStateMachine;

    // API 핸들러가 상태 기계를 시작할 수 있게(M3~M5 소비) 최소 권한 부여.
    provisionStateMachine.grantStartExecution(apiHandler);
    deleteStateMachine.grantStartExecution(apiHandler);
    apiHandler.addEnvironment("PROVISION_SM_ARN", provisionStateMachine.stateMachineArn);
    apiHandler.addEnvironment("DELETE_SM_ARN", deleteStateMachine.stateMachineArn);

    // ── [Notify] deploy-notify Lambda + EventBridge 규칙 2개 (DESIGN 3.3) ────
    // DESIGN.md 3.3 배포 파이프라인의 마지막 단계:
    //   [Notify] EventBridge(CodePipeline 상태 변경) → Lambda → DDB Deployment 레코드 갱신.
    // 이 단계가 없으면 배포 진행 상황이 영원히 PENDING에 머문다(파이프라인이 성공/실패해도
    //  Deployment.status 전이가 안 됨). backend가 `app.orchestration.deploy_notify.handle`을 구현하고
    //  build.sh가 자산(infra/lambda/deploy-notify: handler.py shim + app/)을 산출한다.
    //
    // 소속: **platform 스택**(컨트롤 플레인). DDB 테이블·파이프라인·Step Functions와 동일 층위.
    //  (network의 wake Lambda 3종과 로그/함수 스타일은 같으나, 앱 트래픽이 아닌 컨트롤 플레인 이벤트다.)
    // 앱별 아님: EventBridge 규칙은 파이프라인명 prefix(`${prefix}-app-`) 패턴으로 모든 앱 파이프라인을
    //  단일 규칙으로 커버한다 → 앱 삭제 시 platform에 잔여 리소스 없음(network wake-restore 규칙과 동일 원칙).
    const deployNotifyLogGroup = new logs.LogGroup(this, "DeployNotifyLogs", {
      logGroupName: `/apphub/${config.stage}/deploy-notify`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const deployNotify = new lambda.Function(this, "DeployNotifyFn", {
      functionName: `${prefix}-deploy-notify`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      // D-M8: backend(Python)가 진실. build.sh가 app/ + handler.py shim(app.orchestration.deploy_notify.handle
      //  재노출)을 infra/lambda/deploy-notify로 동기화한다(다른 task/wake 자산 5종과 동일 방식).
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "deploy-notify")),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: deployNotifyLogGroup,
      // 데이터 계층(app.data.client.table)이 요구하는 TABLE_NAME(폴백 없음) + STAGE.
      //  테이블명은 결정론적(`${prefix}-main`)이라 크로스스택/SSM 없이 직접 주입(task Lambda와 동일 규약).
      environment: { STAGE: config.stage, TABLE_NAME: `${prefix}-main` },
      description: "CodePipeline state -> DDB Deployment update ([Notify], DESIGN 3.3)",
    });
    this.deployNotifyFunction = deployNotify;

    // ── deploy-notify IAM (ARN 범위 — conventions 7장, Resource:"*" 금지) ────
    // (1) DDB — Deployment 레코드 갱신(App 조회 포함). network-stack ddbRw 패턴(테이블 + index/*).
    deployNotify.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeployNotifyTableRw",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
        resources: [
          this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${prefix}-main` }),
          this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${prefix}-main/index/*` }),
        ],
      }),
    );
    // (2) codepipeline — 파이프라인 실행/액션 상세 조회로 배포 단계·실패 정보를 얻는다.
    //     GetPipelineExecution/ListActionExecutions는 파이프라인 ARN(리소스 레벨) 지원 → 앱 파이프라인(`${prefix}-app-*`)으로 한정.
    deployNotify.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeployNotifyPipelineRead",
        actions: ["codepipeline:GetPipelineExecution", "codepipeline:ListActionExecutions"],
        resources: [this.formatArn({ service: "codepipeline", resource: `${prefix}-app-*` })],
      }),
    );
    // (3) codebuild — 빌드 상세(실패 phase 등) 조회. BatchGetBuilds는 project ARN(리소스 레벨) 지원 →
    //     앱 파이프라인의 CodeBuild 프로젝트(`project/${prefix}-app-*`)로 한정.
    //     CodeBuild 프로젝트 ARN은 슬래시 구분(`project/name`) — 기본 arnFormat(provisionerBuildArn과 동일).
    //     콜론(`project:name`)으로 지정하면 라이브 IAM 매칭이 실패한다(AccessDenied).
    deployNotify.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeployNotifyBuildRead",
        actions: ["codebuild:BatchGetBuilds"],
        resources: [
          this.formatArn({ service: "codebuild", resource: "project", resourceName: `${prefix}-app-*` }),
        ],
      }),
    );

    // EventBridge 규칙 2개 — 앱 파이프라인(`${prefix}-app-*`) prefix 패턴 공유 규칙(앱별 아님).
    //  둘 다 target = deploy-notify Lambda. CodePipeline은 두 종류의 상태 이벤트를 발행하므로 각각 구독한다:
    //   (1) Stage Execution State Change — 단계(Source/Validate/Build/Deploy) 진입·성공·실패 → Deployment.status 세분 전이.
    //   (2) Pipeline Execution State Change — 파이프라인 전체 성공/실패 → SUCCEEDED/FAILED 종결.
    const deployNotifyStageRule = new events.Rule(this, "DeployNotifyStageRule", {
      ruleName: `${prefix}-deploy-notify-stage`,
      description: "CodePipeline stage state change (app-*) -> deploy-notify ([Notify], DESIGN 3.3)",
      eventPattern: {
        source: ["aws.codepipeline"],
        detailType: ["CodePipeline Stage Execution State Change"],
        detail: { pipeline: [{ prefix: `${prefix}-app-` }] },
      },
    });
    deployNotifyStageRule.addTarget(new events_targets.LambdaFunction(deployNotify));

    const deployNotifyExecRule = new events.Rule(this, "DeployNotifyExecRule", {
      ruleName: `${prefix}-deploy-notify-exec`,
      description: "CodePipeline execution state change (app-*) -> deploy-notify ([Notify], DESIGN 3.3)",
      eventPattern: {
        source: ["aws.codepipeline"],
        detailType: ["CodePipeline Pipeline Execution State Change"],
        detail: { pipeline: [{ prefix: `${prefix}-app-` }] },
      },
    });
    deployNotifyExecRule.addTarget(new events_targets.LambdaFunction(deployNotify));

    // ── CloudWatch 대시보드(관리자 관측성) 최소 ─────────────────────────────
    // DESIGN.md 9: 파이프라인 성공률, Step Functions 실패, ALB 규칙 사용량, 앱 수.
    //  M2에서는 존재하는 리소스(API Lambda, provisioner, SFN) 지표만. 나머지는 후속 확장.
    const dashboard = new cw.Dashboard(this, "AdminDashboard", {
      dashboardName: `${prefix}-admin`,
    });
    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "API 핸들러 호출/오류",
        left: [apiHandler.metricInvocations(), apiHandler.metricErrors()],
      }),
      new cw.GraphWidget({
        title: "ProvisionApp / DeleteApp 실패",
        left: [
          provisionStateMachine.metricFailed(),
          deleteStateMachine.metricFailed(),
        ],
      }),
    );

    // ── 공유 참조 SSM 파라미터 (Export 대신) ────────────────────────────────
    this.publishSsm(config.stage, {
      "table-name": table.tableName,
      "table-arn": table.tableArn,
      "user-pool-id": userPool.userPoolId,
      "user-pool-arn": userPool.userPoolArn,
      "user-pool-client-id": userPoolClient.userPoolClientId,
      // D16 ALB authenticate-cognito(app-runtime, M4)용:
      "app-auth-client-id": appAuthClient.userPoolClientId,
      "user-pool-domain": `${hostedUiDomainPrefix}.auth.${this.region}.amazoncognito.com`,
      "api-url": api.url,
      "api-id": api.restApiId,
      "spa-bucket-name": spaBucket.bucketName,
      "cloudfront-domain": distribution.distributionDomainName,
      "cloudfront-distribution-id": distribution.distributionId,
      "provisioner-project-name": provisioner.projectName,
      "provision-sm-arn": provisionStateMachine.stateMachineArn,
      "delete-sm-arn": deleteStateMachine.stateMachineArn,
      // D-M5-06: 플랫폼 자산(검증기·CDK소스) 고정 URI. deploy.sh 업로드 키와 일치.
      "assets-bucket-name": assetsBucket.bucketName,
      "validator-s3-uri": validatorS3Uri,
      "cdk-source-s3-uri": cdkSourceS3Uri,
      // P-M7-01: Kiro 설정 다운로드 정적 경로(CloudFront behavior). 프론트가 이 경로로 직접 링크.
      "kiro-config-url-path": kiroConfigUrlPath,
    });

    // ── CloudFormation Outputs (deploy.sh / 문서 소비용) ────────────────────
    this.output("TableName", table.tableName);
    this.output("UserPoolId", userPool.userPoolId);
    this.output("UserPoolClientId", userPoolClient.userPoolClientId);
    this.output("ApiUrl", api.url);
    this.output("SpaBucketName", spaBucket.bucketName);
    this.output("CloudFrontDomain", distribution.distributionDomainName);
    this.output("CloudFrontDistributionId", distribution.distributionId);
    this.output("ProvisionerProjectName", provisioner.projectName);
    this.output("ProvisionStateMachineArn", provisionStateMachine.stateMachineArn);
    this.output("DeleteStateMachineArn", deleteStateMachine.stateMachineArn);
    // DESIGN 3.3 [Notify]: deploy-notify Lambda ARN(관측/운영 참고, SSM 발행은 소비자 없어 생략).
    this.output("DeployNotifyFunctionArn", deployNotify.functionArn);
  }

  private publishSsm(stage: string, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      new ssm.StringParameter(this, `Ssm-${key}`, {
        parameterName: `/apphub/${stage}/platform/${key}`,
        stringValue: value,
      });
    }
  }

  private output(id: string, value: string): void {
    new CfnOutput(this, id, { value });
  }

  // ── 공유 ARN 상수 (API 역할 · task Lambda가 같은 값을 소비) ────────────────
  // secret CRUD/삭제·codebuild:StartBuild 는 API 역할(constructor)과 task Lambda(buildStateMachines)
  //  양쪽이 쓰므로 단일 소스로 만든다. 결정론적(prefix/stage 기반)이라 부수효과 없이 재호출 가능.

  /**
   * 앱 시크릿 ARN(범위). backend가 만드는 이름 규약 `apphub/{stage}/app/{appId}/{KEY}`(슬래시)를
   * 커버한다. path 스타일 `apphub/{stage}/app/*` 의 뒤 `*`가 하위 경로(`{appId}/{KEY}`)와
   * Secrets Manager가 자동으로 붙이는 하이픈+6자 랜덤 suffix(`-a1b2c3`)를 모두 매칭한다
   * (AWS 문서 "Access all secrets in a path" — `TestEnv/*` 예시와 동일). 별도 suffix 불필요.
   *  ⚠ 이전 하이픈 규약(`apphub-{stage}-*`)은 슬래시 이름을 커버하지 못해 delete-task의
   *    DeleteSecret이 라이브에서 AccessDenied 났다 → path 규약으로 통일(delete-task·API 역할 공용).
   */
  private appSecretArn(stage: string): string {
    return this.formatArn({
      service: "secretsmanager",
      resource: "secret",
      resourceName: `apphub/${stage}/app/*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
  }

  /** provisioner CodeBuild 프로젝트 ARN(`${prefix}-provisioner`). 롤백 runtime 재배포·롤백 트리거. */
  private provisionerBuildArn(prefix: string): string {
    return this.formatArn({ service: "codebuild", resource: "project", resourceName: `${prefix}-provisioner` });
  }

  /**
   * provisioner CodeBuild 역할 권한 (buildspec-contract 7장, D-M5-06).
   *
   * provisioner는 `cdk deploy apphub-{stage}-app-*-{pipeline|runtime}` 을 원격 실행한다.
   * CDK 배포는 bootstrap 역할(cdk-*)을 AssumeRole해 수행되므로 CFN + sts:AssumeRole + 자산 S3
   * GetObject + DDB GetItem이 핵심이다. 리소스 레벨 미지원 조회(Describe / List)만 계정 스코프
   * 예외로 두고 주석을 단다. 나머지 배포 권한(ECS/ELB/ECR/Route53/IAM/scheduler/logs)은 CFN이
   * 생성하는 앱 리소스(apphub-{stage}-app-*) 범위로 좁힌다.
   */
  private grantProvisionerPermissions(
    provisioner: codebuild.Project,
    stage: StageConfig["stage"],
    prefix: string,
    assetsBucket: s3.Bucket,
  ): void {
    // (1) CloudFormation — 앱 스택(app-*) 생성/갱신/삭제만.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppStackCfn",
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:GetTemplate",
          "cloudformation:CreateChangeSet",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:DescribeChangeSet",
          "cloudformation:DeleteChangeSet",
        ],
        resources: [
          this.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${prefix}-app-*` }),
        ],
      }),
    );
    // (2) CDK bootstrap 역할 assume(deploy/publish/lookup/file/image). 계정 role path로 한정.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkRoles",
        actions: ["sts:AssumeRole"],
        resources: [this.formatArn({ service: "iam", region: "", resource: "role", resourceName: "cdk-*" })],
      }),
    );
    // (3) 자산 S3 GetObject — 검증기 번들 · CDK 소스 tarball(고정 키). 버킷 범위.
    assetsBucket.grantRead(provisioner);
    // (4) DDB GetItem — 앱/프리셋/권한 템플릿 조회(app-ctx 조립). 단일 테이블만.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppTableRead",
        actions: ["dynamodb:GetItem"],
        resources: [this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${prefix}-main` })],
      }),
    );
    // (5) 앱 리소스 배포 권한 — CFN이 만드는 앱 리소스(apphub-{stage}-app-*) 범위로 한정.
    //     bootstrap 역할 assume 경로(2)가 주 경로지만, 직접 배포 대비 앱 리소스 범위로도 부여한다.
    const appArn = (service: string, resource: string, opts?: { sep?: "colon" | "slash" }): string =>
      this.formatArn({
        service,
        resource,
        resourceName: `${prefix}-app-*`,
        arnFormat: opts?.sep === "colon" ? ArnFormat.COLON_RESOURCE_NAME : ArnFormat.SLASH_RESOURCE_NAME,
      });
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppEcsElbEcrDeploy",
        actions: [
          // ECS 서비스/태스크정의 — 클러스터는 D18로 network 스택 소유(공유), 앱 배포가 만들지 않는다.
          "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService",
          "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition",
          "ecs:TagResource",
          // ELB v2 target group/리스너 규칙
          "elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:ModifyRule", "elasticloadbalancing:AddTags",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          // ECR 리포
          "ecr:CreateRepository", "ecr:DeleteRepository", "ecr:PutLifecyclePolicy",
          "ecr:SetRepositoryPolicy", "ecr:TagResource",
          // EventBridge Scheduler(가동 스케줄)
          "scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:UpdateSchedule",
          "scheduler:GetSchedule", "scheduler:TagResource",
          // 로그 그룹
          "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:TagResource",
        ],
        resources: [
          // ECS 서비스 ARN은 신형식 `service/{cluster}/{service}` — 공유 클러스터(D18) 하위 앱 서비스로 한정.
          this.formatArn({ service: "ecs", resource: "service", resourceName: `${prefix}-cluster/${prefix}-app-*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME }),
          appArn("ecs", "task-definition"),
          appArn("elasticloadbalancing", "targetgroup"), appArn("elasticloadbalancing", "listener-rule"),
          appArn("ecr", "repository"),
          appArn("scheduler", "schedule"),
          this.formatArn({ service: "logs", resource: "log-group", resourceName: `/apphub/${stage}/app/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
        ],
      }),
    );
    // (6) 앱 IAM 역할(태스크/실행/스케줄러) 생성·정책 부착 — 앱 역할 이름 범위로 한정 + PassRole.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppIamRoles",
        actions: [
          "iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:TagRole", "iam:GetRole",
          "iam:PassRole", "iam:CreatePolicy", "iam:DeletePolicy",
        ],
        resources: [
          this.formatArn({ service: "iam", region: "", resource: "role", resourceName: `${prefix}-app-*` }),
          this.formatArn({ service: "iam", region: "", resource: "policy", resourceName: `${prefix}-app-*` }),
        ],
      }),
    );
    // (7) Route53 앱 레코드 upsert — hosted zone 범위(config zone은 계정 리소스, zone id 미상이라 zone/*).
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppRoute53Records",
        actions: ["route53:ChangeResourceRecordSets", "route53:GetHostedZone", "route53:ListResourceRecordSets"],
        resources: [this.formatArn({ service: "route53", region: "", account: "", resource: "hostedzone", resourceName: "*" })],
      }),
    );
    // (8) 리소스 레벨 미지원 조회 — Describe*/List*는 계정 스코프 * (정당 예외, 주석).
    //     ELB/ECS/EC2 Describe*, Route53 ListHostedZones, ECR GetAuthorizationToken 등은 * 만 허용.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadOnlyDescribeStar",
        actions: [
          "elasticloadbalancing:Describe*",
          "ecs:Describe*", "ecs:ListTasks", "ecs:ListServices",
          "ecr:DescribeRepositories", "ecr:GetAuthorizationToken",
          "ec2:Describe*", // VPC/subnet/SG lookup(fromVpcAttributes는 SSM이나 CFN이 SG 생성 시 Describe 필요)
          "route53:ListHostedZones",
          "logs:DescribeLogGroups",
          "scheduler:ListSchedules",
          "cloudformation:ListStacks",
        ],
        // 위 액션 전부 리소스 레벨 미지원(Describe*/List*/GetAuthorizationToken)이라 * 예외.
        resources: ["*"],
      }),
    );
    // (8b) [QA M-2 축소] EC2 SG 생성/변경 — 앱 태스크 SG(app-runtime construct 소유)를 만들려면 필요하나
    //      생성 시점에 SG ID를 알 수 없어 리소스 ARN 한정이 실무상 불가하다(CreateSecurityGroup은 대상이 미생성).
    //      리소스 ARN 대신 aws:RequestedRegion 조건으로 배포 리전에 한정해 최소권한을 좁힌다(다른 리전 SG 조작 차단).
    //      배포는 항상 이 스택 리전에서 일어나므로 정상 동작에 영향 없음.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppSecurityGroupManageInRegion",
        actions: [
          "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress",
          "ec2:CreateTags", "ec2:DeleteTags",
        ],
        resources: ["*"], // SG는 배포 시점 생성 → ARN 미상. 아래 리전 조건으로 범위 한정.
        conditions: { StringEquals: { "aws:RequestedRegion": this.region } },
      }),
    );
    // (9) SSM 읽기 — app-runtime construct가 network/platform 공유값(SSM)을 읽어 배포한다.
    provisioner.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadSharedSsm",
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: `apphub/${stage}/network/*` }),
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: `apphub/${stage}/platform/*` }),
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: `cdk-bootstrap/*` }),
        ],
      }),
    );
  }

  /**
   * ProvisionApp / DeleteApp 상태 기계를 실제 ASL로 조립한다(D-M5-01).
   *
   * 설계(D-M5-01): 각 워크플로는 하나의 task Lambda(step 디스패치)를 반복 호출하고,
   *  ASL은 Task 나열 + Wait/Choice(빌드/스택 폴링 루프) + Catch(실패 → finalize → Fail)만 담당한다.
   *  task Lambda 반환을 `$`(전체 교체)로 받아 다음 Task가 appId/buildId 등을 이어 쓴다.
   *  step은 각 Task의 payload에서 명시 주입(결과의 step 값은 무시).
   */
  private buildStateMachines(
    stage: StageConfig["stage"],
    prefix: string,
  ): { provisionStateMachine: sfn.StateMachine; deleteStateMachine: sfn.StateMachine } {
    // ── task Lambda 2개 (PYTHON_3_13, handler.handler, STAGE + TABLE_NAME env) ──
    const tableArn = this.formatArn({ service: "dynamodb", resource: "table", resourceName: `${prefix}-main` });
    // provisionerBuildArn·appSecretArn 은 API 역할과 공유하는 단일 소스(private 메서드) 사용.
    //  delete-task의 DeleteSecret이 API 역할과 정확히 같은 ARN(`apphub/{stage}/app/*`)을 쓰게 통일한다.
    const provisionerBuildArn = this.provisionerBuildArn(prefix);
    const appPipelineArn = this.formatArn({ service: "codepipeline", resource: `${prefix}-app-*` });
    const appStackArn = this.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${prefix}-app-*` });
    const appSecretArn = this.appSecretArn(stage);
    const platformSsmArn = this.formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: `apphub/${stage}/platform/*`,
    });
    const networkSsmArn = this.formatArn({
      service: "ssm",
      resource: "parameter",
      resourceName: `apphub/${stage}/network/*`,
    });

    const taskLog = (name: string): logs.LogGroup =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/apphub/${stage}/${name}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    // provision-task — allocate-slot / deploy-pipeline / poll-build / first-deploy / finalize.
    const provisionTask = new lambda.Function(this, "ProvisionTask", {
      functionName: `${prefix}-provision-task`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "provision-task")),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: taskLog("provision-task"),
      // TABLE_NAME: 데이터 계층(app.data.client.table)이 요구(폴백 없음 — config.table_name).
      //  테이블명은 결정론적(`${prefix}-main`)이라 크로스스택/SSM 없이 직접 주입한다(D-M8 P2 요청).
      environment: { STAGE: stage, TABLE_NAME: `${prefix}-main` },
      description: "ProvisionApp step dispatch (D-M5-01)",
    });
    // IAM(ARN 범위, Resource:"*" 금지):
    provisionTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppTableRW",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [tableArn],
      }),
    );
    provisionTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadPlatformNetworkSsm",
        actions: ["ssm:GetParameter"],
        resources: [platformSsmArn, networkSsmArn],
      }),
    );
    provisionTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "StartPollProvisioner",
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [provisionerBuildArn],
      }),
    );
    provisionTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "StartAppPipeline",
        actions: ["codepipeline:StartPipelineExecution"],
        resources: [appPipelineArn],
      }),
    );

    // delete-task — delete-runtime / poll-runtime / delete-pipeline / poll-pipeline / cleanup / finalize.
    const deleteTask = new lambda.Function(this, "DeleteTask", {
      functionName: `${prefix}-delete-task`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "delete-task")),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: taskLog("delete-task"),
      // TABLE_NAME: 데이터 계층 요구(폴백 없음). 결정론적 테이블명 직접 주입(D-M8 P2 요청).
      environment: { STAGE: stage, TABLE_NAME: `${prefix}-main` },
      description: "DeleteApp step dispatch (D-M5-01)",
    });
    deleteTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppTableRW",
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [tableArn],
      }),
    );
    deleteTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeleteAppStacks",
        actions: ["cloudformation:DeleteStack", "cloudformation:DescribeStacks"],
        resources: [appStackArn],
      }),
    );
    deleteTask.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeleteAppSecrets",
        actions: ["secretsmanager:DeleteSecret"],
        resources: [appSecretArn],
      }),
    );

    // ── ProvisionApp ASL ──────────────────────────────────────────────────
    // allocate-slot → deploy-pipeline → poll-build(Choice+Wait30s 루프) → first-deploy → finalize(success).
    //  Catch(모든 Task) → finalize(failure) → Fail.
    //  각 Task payload는 { appId, [buildId], step, [outcome] }로 명시 구성하고, 결과($.Payload)를
    //  resultPath "$"로 전체 교체해 다음 Task가 appId/buildId/buildStatus/stackDeleteState를 이어 쓴다.
    const provFinalizeFail = new sfn_tasks.LambdaInvoke(this, "ProvisionFinalizeFailure", {
      lambdaFunction: provisionTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "finalize", outcome: "failure" }),
      payloadResponseOnly: true,
      resultPath: "$.finalizeResult",
    }).next(new sfn.Fail(this, "ProvisionFailed", { cause: "ProvisionApp 실패", error: "ProvisionFailed" }));

    const catchToFail: sfn.CatchProps = {
      errors: ["States.ALL"],
      resultPath: "$.error",
    };

    const allocateSlot = new sfn_tasks.LambdaInvoke(this, "AllocateSlot", {
      lambdaFunction: provisionTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "allocate-slot" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(provFinalizeFail, catchToFail);

    const deployPipeline = new sfn_tasks.LambdaInvoke(this, "DeployPipeline", {
      lambdaFunction: provisionTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "deploy-pipeline" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(provFinalizeFail, catchToFail);

    const pollBuild = new sfn_tasks.LambdaInvoke(this, "PollBuild", {
      lambdaFunction: provisionTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", "buildId.$": "$.buildId", step: "poll-build" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(provFinalizeFail, catchToFail);

    const waitBuild = new sfn.Wait(this, "WaitBuild", {
      time: sfn.WaitTime.duration(Duration.seconds(30)),
    });

    const firstDeploy = new sfn_tasks.LambdaInvoke(this, "FirstDeploy", {
      lambdaFunction: provisionTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "first-deploy" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(provFinalizeFail, catchToFail);

    const provFinalizeOk = new sfn_tasks.LambdaInvoke(this, "ProvisionFinalizeSuccess", {
      lambdaFunction: provisionTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "finalize", outcome: "success" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).next(new sfn.Succeed(this, "ProvisionDone"));

    // poll-build 결과의 buildStatus로 분기: SUCCEEDED → first-deploy, 그 외(IN_PROGRESS) → Wait → 재폴링.
    const buildChoice = new sfn.Choice(this, "BuildDone?")
      .when(sfn.Condition.stringEquals("$.buildStatus", "SUCCEEDED"), firstDeploy.next(provFinalizeOk))
      .otherwise(waitBuild.next(pollBuild));
    pollBuild.next(buildChoice);

    const provisionDefinition = allocateSlot.next(deployPipeline).next(pollBuild);

    const provisionStateMachine = new sfn.StateMachine(this, "ProvisionApp", {
      stateMachineName: `${prefix}-provision-app`,
      definitionBody: sfn.DefinitionBody.fromChainable(provisionDefinition),
      timeout: Duration.hours(1),
    });
    provisionTask.grantInvoke(provisionStateMachine);

    // ── DeleteApp ASL ─────────────────────────────────────────────────────
    // delete-runtime → poll-runtime(Wait20s 루프) → delete-pipeline → poll-pipeline(Wait20s 루프)
    //  → cleanup → finalize(success). Catch → finalize(failure) → Fail.
    const delFinalizeFail = new sfn_tasks.LambdaInvoke(this, "DeleteFinalizeFailure", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "finalize", outcome: "failure" }),
      payloadResponseOnly: true,
      resultPath: "$.finalizeResult",
    }).next(new sfn.Fail(this, "DeleteFailed", { cause: "DeleteApp 실패", error: "DeleteFailed" }));

    const delCatch: sfn.CatchProps = { errors: ["States.ALL"], resultPath: "$.error" };

    const deleteRuntime = new sfn_tasks.LambdaInvoke(this, "DeleteRuntime", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "delete-runtime" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(delFinalizeFail, delCatch);

    const pollRuntime = new sfn_tasks.LambdaInvoke(this, "PollRuntime", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "poll-runtime" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(delFinalizeFail, delCatch);

    const waitRuntime = new sfn.Wait(this, "WaitRuntime", {
      time: sfn.WaitTime.duration(Duration.seconds(20)),
    });

    const deletePipeline = new sfn_tasks.LambdaInvoke(this, "DeletePipeline", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "delete-pipeline" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(delFinalizeFail, delCatch);

    const pollPipeline = new sfn_tasks.LambdaInvoke(this, "PollPipeline", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "poll-pipeline" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(delFinalizeFail, delCatch);

    const waitPipeline = new sfn.Wait(this, "WaitPipeline", {
      time: sfn.WaitTime.duration(Duration.seconds(20)),
    });

    const cleanup = new sfn_tasks.LambdaInvoke(this, "Cleanup", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "cleanup" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).addCatch(delFinalizeFail, delCatch);

    const delFinalizeOk = new sfn_tasks.LambdaInvoke(this, "DeleteFinalizeSuccess", {
      lambdaFunction: deleteTask,
      payload: sfn.TaskInput.fromObject({ "appId.$": "$.appId", step: "finalize", outcome: "success" }),
      payloadResponseOnly: true,
      resultPath: "$",
    }).next(new sfn.Succeed(this, "DeleteDone"));

    // runtime 스택 삭제 폴링: DELETE_COMPLETE → delete-pipeline, 그 외 → Wait → 재폴링.
    const runtimeChoice = new sfn.Choice(this, "RuntimeDeleted?")
      .when(sfn.Condition.stringEquals("$.stackDeleteState", "DELETE_COMPLETE"), deletePipeline)
      .otherwise(waitRuntime.next(pollRuntime));
    pollRuntime.next(runtimeChoice);

    // pipeline 스택 삭제 폴링: DELETE_COMPLETE → cleanup, 그 외 → Wait → 재폴링.
    const pipelineChoice = new sfn.Choice(this, "PipelineDeleted?")
      .when(sfn.Condition.stringEquals("$.stackDeleteState", "DELETE_COMPLETE"), cleanup.next(delFinalizeOk))
      .otherwise(waitPipeline.next(pollPipeline));
    pollPipeline.next(pipelineChoice);

    deletePipeline.next(pollPipeline);

    const deleteDefinition = deleteRuntime.next(pollRuntime);

    const deleteStateMachine = new sfn.StateMachine(this, "DeleteApp", {
      stateMachineName: `${prefix}-delete-app`,
      definitionBody: sfn.DefinitionBody.fromChainable(deleteDefinition),
      timeout: Duration.hours(1),
    });
    deleteTask.grantInvoke(deleteStateMachine);

    return { provisionStateMachine, deleteStateMachine };
  }
}
