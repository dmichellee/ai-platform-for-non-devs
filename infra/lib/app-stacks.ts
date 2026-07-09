import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AppPipeline } from "./constructs/app-pipeline";
import { AppRuntime } from "./constructs/app-runtime";
import type { AppPipelineParams, AppRuntimeParams } from "./constructs/app-params";

/**
 * 앱별 독립 스택 래퍼 (DESIGN.md 3.1).
 *  - provisioner CodeBuild가 앱 파라미터를 컨텍스트로 넘겨 `apphub-{stage}-app-{appId}-{pipeline|runtime}`
 *    스택으로 synth/deploy 한다.
 *  - construct(app-pipeline/app-runtime)는 플랫폼 설치와 앱 배포 양쪽에서 같은 코드로 쓰이며,
 *    여기서는 그것을 독립 CloudFormation 스택 경계에 배치한다.
 */
export interface AppPipelineStackProps extends StackProps {
  readonly params: AppPipelineParams;
}

export class AppPipelineStack extends Stack {
  readonly pipeline: AppPipeline;
  constructor(scope: Construct, id: string, props: AppPipelineStackProps) {
    super(scope, id, props);
    this.pipeline = new AppPipeline(this, "Pipeline", { params: props.params });
  }
}

export interface AppRuntimeStackProps extends StackProps {
  readonly params: AppRuntimeParams;
}

export class AppRuntimeStack extends Stack {
  readonly runtime: AppRuntime;
  constructor(scope: Construct, id: string, props: AppRuntimeStackProps) {
    super(scope, id, props);
    this.runtime = new AppRuntime(this, "Runtime", { params: props.params });
  }
}
