/**
 * 경량 SVG 영역 차트 — 외부 차트 라이브러리 없이 시계열을 그린다(번들 최소화 요구).
 * viewBox 기반이라 컨테이너 폭에 맞춰 늘어나고, 색은 시맨틱 토큰(currentColor)만 쓴다.
 * 값 포맷/단위는 상위(MonitoringTab)에서 라벨로 넘긴다 — 이 컴포넌트는 순수 렌더만 담당.
 */
import type { MetricPoint } from "../lib/types.js";

const W = 300; // viewBox 좌표계 폭 (실제 폭은 CSS가 100%로 늘림)
const H = 88; // viewBox 좌표계 높이
const PAD_TOP = 6;
const PAD_BOTTOM = 6;

export interface SparklineProps {
  points: MetricPoint[];
  /** y축 상한 고정(예: 사용률 100). 생략 시 데이터 최댓값에 맞춤. */
  max?: number;
  /** 툴팁/접근성 라벨 생성기 — 값(v)을 사람이 읽는 문자열로. */
  formatValue: (v: number) => string;
  /** 접근성 설명(차트 제목). */
  ariaLabel: string;
}

/**
 * 영역(area) + 라인 스파크라인. 점이 0개면 아무것도 그리지 않고 상위에서 빈 안내를 띄운다.
 * 점이 1개뿐이면 평평한 선으로 그린다(NaN path 방지).
 */
export function Sparkline({ points, max, formatValue, ariaLabel }: SparklineProps): JSX.Element {
  const vals = points.map((p) => p.v);
  const dataMax = vals.length ? Math.max(...vals) : 0;
  // 상한: 고정 max 우선, 없으면 데이터 최댓값(0이면 1로 나눗셈 0 방지). 살짝 여유(1.1배).
  const top = max ?? Math.max(1, Math.ceil(dataMax * 1.1));
  const usableH = H - PAD_TOP - PAD_BOTTOM;

  const x = (i: number): number =>
    points.length <= 1 ? W / 2 : (i / (points.length - 1)) * W;
  const y = (v: number): number => PAD_TOP + usableH - (v / top) * usableH;

  const linePath =
    points.length === 1
      ? `M0,${y(points[0]!.v)} L${W},${y(points[0]!.v)}`
      : points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const areaPath =
    points.length === 0
      ? ""
      : `${linePath} L${W},${H - PAD_BOTTOM} L0,${H - PAD_BOTTOM} Z`;

  const last = points.length ? points[points.length - 1]! : null;
  const gradId = `spark-grad-${ariaLabel.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg
      className="spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={
        last ? `${ariaLabel}. 최근 값 ${formatValue(last.v)}` : `${ariaLabel}. 데이터 없음`
      }
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {areaPath && <path className="spark-area" d={areaPath} fill={`url(#${gradId})`} />}
      {linePath && (
        <path
          className="spark-line"
          d={linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
