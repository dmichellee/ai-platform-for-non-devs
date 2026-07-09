"""외부 AWS 서비스 통합 (SFN 시작, CloudWatch Logs, Cognito, CodeConnections).

API 핸들러가 실제 호출하는 통합만 P1 범위. codebuild/codepipeline/cloudformation/secrets/ssm 등
task Lambda 전용 통합은 P2에서 추가한다.
"""
