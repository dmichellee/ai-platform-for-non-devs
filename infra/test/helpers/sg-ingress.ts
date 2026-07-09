import { expect } from "vitest";
import { Template } from "aws-cdk-lib/assertions";

/**
 * D17 공통 단언 헬퍼 (PLATFORM-ENGINEERING.md 2장).
 *
 * 플랫폼 소유 SG의 **ingress**에 `0.0.0.0/0`·`::/0`가 없어야 한다.
 * 예외는 명시적 예외 목록(internet-facing 공유 ALB SG)의 SG뿐이며,
 * 예외 SG의 규칙조차 화이트리스트에 없는 다른 SG로 새어들지 않는지 확인한다.
 *
 * egress(`DestinationCidrBlock`)와 라우팅의 `0.0.0.0/0`은 대상이 아니다 — ingress만 본다.
 *
 * @param template  대상 스택의 합성 템플릿
 * @param exemptSgDescriptions  D17 예외로 허용된 SG의 GroupDescription 부분 문자열 목록.
 *   여기 해당하지 않는 모든 SG는 개방 대역 ingress가 0건이어야 한다.
 */
export function assertNoOpenIngress(
  template: Template,
  exemptSgDescriptions: readonly string[] = [],
): void {
  const OPEN_V4 = "0.0.0.0/0";
  const OPEN_V6 = "::/0";

  const json = template.toJSON() as {
    Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  };
  const resources = json.Resources ?? {};

  const isExempt = (description: unknown): boolean =>
    typeof description === "string" &&
    exemptSgDescriptions.some((d) => description.includes(d));

  const isOpen = (cidr: unknown, cidrV6: unknown): boolean =>
    cidr === OPEN_V4 || cidrV6 === OPEN_V6;

  // 1) 인라인 SecurityGroupIngress (AWS::EC2::SecurityGroup 안)
  //    GroupId → GroupDescription 매핑을 위해 SG 논리 ID로 예외 여부 판정.
  const sgDescById: Record<string, unknown> = {};
  for (const [logicalId, res] of Object.entries(resources)) {
    if (res.Type === "AWS::EC2::SecurityGroup") {
      sgDescById[logicalId] = (res.Properties ?? {})["GroupDescription"];
    }
  }

  for (const [logicalId, res] of Object.entries(resources)) {
    if (res.Type === "AWS::EC2::SecurityGroup") {
      const props = res.Properties ?? {};
      const exempt = isExempt(props["GroupDescription"]);
      const ingress = (props["SecurityGroupIngress"] as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
      for (const rule of ingress) {
        const open = isOpen(rule["CidrIp"], rule["CidrIpv6"]);
        if (open && !exempt) {
          expect.fail(
            `[D17] SG '${logicalId}'(desc=${JSON.stringify(props["GroupDescription"])})의 ingress에 ` +
              `개방 대역(${rule["CidrIp"] ?? rule["CidrIpv6"]})이 있습니다. 예외 목록에 없는 SG입니다.`,
          );
        }
      }
    }

    // 2) 독립 AWS::EC2::SecurityGroupIngress 리소스
    if (res.Type === "AWS::EC2::SecurityGroupIngress") {
      const props = res.Properties ?? {};
      const open = isOpen(props["CidrIp"], props["CidrIpv6"]);
      if (!open) continue;
      // 대상 SG의 논리 ID 추출(GroupId가 { Ref | Fn::GetAtt } 형태일 수 있음).
      const groupId = props["GroupId"] as unknown;
      let targetLogicalId: string | undefined;
      if (groupId && typeof groupId === "object") {
        const g = groupId as { Ref?: string; ["Fn::GetAtt"]?: [string, string] };
        targetLogicalId = g.Ref ?? g["Fn::GetAtt"]?.[0];
      }
      const targetDesc = targetLogicalId ? sgDescById[targetLogicalId] : undefined;
      if (!isExempt(targetDesc)) {
        expect.fail(
          `[D17] 독립 SecurityGroupIngress '${logicalId}'가 개방 대역을 대상 SG ` +
            `'${targetLogicalId ?? "?"}'에 부여합니다. 예외 목록에 없는 SG입니다.`,
        );
      }
    }
  }
}

/**
 * EC2 SecurityGroup의 GroupDescription은 CloudFormation/EC2 API에서 **ASCII만 허용**한다.
 * 한글/em-dash 등 비ASCII가 들어가면 `cdk synth`·템플릿 검증은 통과하지만 실제 배포에서
 * `Value (...) for parameter GroupDescription is invalid. Character sets beyond ASCII are
 * not supported` 로 거부된다(라이브에서만 터지는 클래스). 이 헬퍼는 그 클래스를 synth 단계로
 * 끌어와 잡는다.
 *
 * 합성 템플릿의 모든 `AWS::EC2::SecurityGroup`을 순회하며 GroupDescription이
 * 순수 ASCII(`/^[\x00-\x7F]*$/`)인지 단언한다.
 *
 * @param template  대상 스택의 합성 템플릿
 */
export function assertSgDescriptionsAscii(template: Template): void {
  const ASCII_ONLY = /^[\x00-\x7F]*$/;
  const json = template.toJSON() as {
    Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  };
  const resources = json.Resources ?? {};

  for (const [logicalId, res] of Object.entries(resources)) {
    if (res.Type !== "AWS::EC2::SecurityGroup") continue;
    const desc = (res.Properties ?? {})["GroupDescription"];
    // GroupDescription은 EC2 SG의 필수 리터럴 문자열(토큰이면 CFN 파라미터 참조 — 그 경우 skip).
    if (typeof desc !== "string") continue;
    expect(
      ASCII_ONLY.test(desc),
      `[EC2-ASCII] SG '${logicalId}'의 GroupDescription에 비ASCII 문자가 있습니다: ` +
        `${JSON.stringify(desc)}. EC2 SecurityGroup GroupDescription은 ASCII만 허용됩니다(라이브 배포 거부).`,
    ).toBe(true);
  }
}

/**
 * 예외 목록이 실제로 개방 대역을 갖는지 확인(예외가 오탈자로 무력화되지 않았는지).
 * internet-facing ALB SG가 실제로 존재하고 0.0.0.0/0 ingress를 갖는지 양성 단언.
 */
export function assertExemptSgIsActuallyOpen(
  template: Template,
  exemptSgDescription: string,
): void {
  const json = template.toJSON() as {
    Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  };
  const resources = json.Resources ?? {};
  let found = false;
  for (const res of Object.values(resources)) {
    if (res.Type !== "AWS::EC2::SecurityGroup") continue;
    const props = res.Properties ?? {};
    const desc = props["GroupDescription"];
    if (typeof desc !== "string" || !desc.includes(exemptSgDescription)) continue;
    const ingress = (props["SecurityGroupIngress"] as
      | Array<Record<string, unknown>>
      | undefined) ?? [];
    if (ingress.some((r) => r["CidrIp"] === "0.0.0.0/0")) found = true;
  }
  expect(found, `예외 SG '${exemptSgDescription}'가 0.0.0.0/0 ingress를 가져야 함`).toBe(true);
}
