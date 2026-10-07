import { describe, it, expect, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { AdminInfra, albNameFromArn } from "../src/screens/admin/AdminInfra.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { AlbRegistry } from "../src/lib/types.js";
import { renderWithProviders, seedSession } from "./harness.js";

/** 관리자 인프라 현황 — delta §8: ALB별 index·status(PROVISIONING 포함)·ruleCount/ruleLimit. */

class StubClient extends MockApiClient {
  constructor(private readonly items: AlbRegistry[]) {
    super();
  }
  override async adminAlbRegistry(): Promise<AlbRegistry[]> {
    return this.items;
  }
}

const ARN = (name: string): string =>
  `arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/${name}/abc123`;

const ITEMS: AlbRegistry[] = [
  // 일부러 순서를 섞는다 — 화면은 scheme(internet-facing → internal) → index 오름차순.
  { scheme: "internet-facing", schemeSlug: "internet", index: 1, status: "PROVISIONING", ruleCount: 0, ruleLimit: 90 },
  { albArn: ARN("apphub-dev-internal-alb"), scheme: "internal", schemeSlug: "internal", index: 0, status: "ACTIVE", ruleCount: 12, ruleLimit: 90, vpcId: "vpc-1" },
  { albArn: ARN("apphub-dev-internet-alb"), scheme: "internet-facing", schemeSlug: "internet", index: 0, status: "ACTIVE", ruleCount: 90, ruleLimit: 90, vpcId: "vpc-1" },
  { albArn: ARN("apphub-dev-internal-alb-1"), scheme: "internal", schemeSlug: "internal", index: 1, status: "ACTIVE", ruleCount: 82, ruleLimit: 90, vpcId: "vpc-1" },
];

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  return within(table).getAllByRole("row").slice(1);
}

describe("관리자 인프라 현황 — ALB 레지스트리", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("ALB별 index·이름·사용량(ruleCount/ruleLimit)·상태를 scheme→index 순으로 보여준다", async () => {
    renderWithProviders(<AdminInfra />, new StubClient(ITEMS));
    await screen.findByText("apphub-dev-internet-alb");
    const rows = bodyRows();
    expect(rows).toHaveLength(4);

    // 1) internet-facing #0 — 90/90 가득 참
    expect(within(rows[0]!).getByText("0")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("90 / 90")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("가득 참")).toBeInTheDocument();
    // 2) internet-facing #1 — 증설 중(PROVISIONING), ARN 없음
    expect(within(rows[1]!).getByText("1")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/증설 중 \(PROVISIONING\)/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("(생성 중)")).toBeInTheDocument();
    // 3) internal #0 — 여유
    expect(within(rows[2]!).getByText("apphub-dev-internal-alb")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("12 / 90")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("여유")).toBeInTheDocument();
    // 4) internal #1 — 82/90 증설 임박(여유 ≤ 10)
    expect(within(rows[3]!).getByText("82 / 90")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("증설 임박")).toBeInTheDocument();
  });

  it("scheme별 ACTIVE 대수·남은 규칙·증설 진행 여부를 요약한다", async () => {
    renderWithProviders(<AdminInfra />, new StubClient(ITEMS));
    const internet = await screen.findByTestId("alb-summary-internet-facing");
    expect(internet).toHaveTextContent("ACTIVE 1대 · 남은 규칙 0개 · 증설 진행 중");
    expect(screen.getByTestId("alb-summary-internal")).toHaveTextContent("ACTIVE 2대 · 남은 규칙 86개");
    expect(screen.getByTestId("alb-summary-internal")).not.toHaveTextContent("증설 진행 중");
  });

  it("목 레지스트리(기본 픽스처)도 렌더된다 — PROVISIONING 항목 포함", async () => {
    renderWithProviders(<AdminInfra />, new MockApiClient());
    await screen.findByText("apphub-dev-internet-alb");
    expect(screen.getByText(/증설 중 \(PROVISIONING\)/)).toBeInTheDocument();
  });

  it("빈 레지스트리 안내", async () => {
    renderWithProviders(<AdminInfra />, new StubClient([]));
    await screen.findByText(/등록된 로드밸런서가 없습니다/);
  });

  it("albNameFromArn: loadbalancer/app/{name}/{id} → name", () => {
    expect(albNameFromArn(ARN("apphub-dev-internet-alb-2"))).toBe("apphub-dev-internet-alb-2");
    expect(albNameFromArn("arn:mock:alb/x")).toBe("x");
  });
});
