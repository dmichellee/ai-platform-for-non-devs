/**
 * ALB 증설(D20) 공용 규약 — 이름·SSM 키 단일 원본 (계약 delta-2026-10-07 §0~§2).
 *
 *  - scheme(DDB/API 값): `internet-facing` | `internal`
 *  - schemeSlug(SSM 경로·스택명·리소스명): `internet` | `internal`
 *  - albIndex(n): 정수 ≥ 0. n=0 = network 스택의 기존 ALB 2대, n≥1 = 증설 스택(AlbShardStack).
 *
 * network 스택(n=0), AlbShardStack(n≥1), app-runtime(소비)이 모두 이 모듈로 경로를 만든다
 * (문자열 드리프트 방지). backend는 `app/integrations/ssm.py alb_param_name`이 같은 규약을 쓴다.
 */

export type SchemeSlug = "internet" | "internal";

/** ALB별 SSM 키(`/apphub/{stage}/network/alb/{slug}/{n}/{key}`) — 계약 §1.1. */
export const ALB_SSM_KEYS = [
  "alb-arn",
  "alb-full-name",
  "alb-dns",
  "alb-canonical-zone-id",
  "https-listener-arn",
  "waker-tg-arn",
] as const;
export type AlbSsmKey = (typeof ALB_SSM_KEYS)[number];

/** DDB/API scheme 값 또는 slug → slug. 알 수 없는 값은 throw(조용한 오배정 방지). */
export function schemeSlug(scheme: string): SchemeSlug {
  if (scheme === "internet-facing" || scheme === "internet") return "internet";
  if (scheme === "internal") return "internal";
  throw new Error(`알 수 없는 ALB scheme: ${JSON.stringify(scheme)} (internet-facing|internet|internal)`);
}

/** albIndex 검증 — 0 이상의 정수. */
export function assertAlbIndex(index: number, opts?: { min?: number }): number {
  const min = opts?.min ?? 0;
  if (!Number.isInteger(index) || index < min) {
    throw new Error(`albIndex 는 ${min} 이상의 정수여야 합니다(받은 값: ${String(index)}).`);
  }
  return index;
}

/** ALB별 SSM 파라미터 경로. */
export function albParamName(stage: string, slug: SchemeSlug, index: number, key: AlbSsmKey): string {
  return `/apphub/${stage}/network/alb/${slug}/${index}/${key}`;
}

/** 증설 스택명 `apphub-{stage}-alb-{slug}-{n}` (n≥1). */
export function albShardStackName(prefix: string, slug: SchemeSlug, index: number): string {
  return `${prefix}-alb-${slug}-${index}`;
}

/** ELBv2 물리명 제한(ALB/TG name 32자). 초과 시 synth 단계에서 실패시킨다(라이브 전용 실패 방지). */
function assertElbName(name: string, what: string): string {
  if (name.length > 32) {
    throw new Error(`${what} 이름이 32자를 초과합니다: ${name} (${name.length}자)`);
  }
  return name;
}

/** 증설 ALB 이름 `apphub-{stage}-{slug}-alb-{n}`. */
export function shardAlbName(prefix: string, slug: SchemeSlug, index: number): string {
  return assertElbName(`${prefix}-${slug}-alb-${index}`, "ALB");
}

/**
 * ALB별 Waker TG 이름 (계약 §1.2).
 *  - n=0 internet: 기존 `apphub-{stage}-waker-tg` (교체·삭제 금지 — 잠든 앱 규칙이 참조 중일 수 있음)
 *  - 그 외      : `apphub-{stage}-waker-{slug}-{n}`
 */
export function wakerTgName(prefix: string, slug: SchemeSlug, index: number): string {
  if (slug === "internet" && index === 0) return `${prefix}-waker-tg`;
  return assertElbName(`${prefix}-waker-${slug}-${index}`, "Waker TG");
}
