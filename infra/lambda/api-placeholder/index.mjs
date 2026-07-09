// [M2 placeholder] 플랫폼 REST API 핸들러 진입점.
//
// 실제 CRUD 라우팅/인가/DDB 접근은 M3에서 backend-engineer가 채운다.
// 이 스택 단계에서는 API Gateway ↔ Lambda 통합 골격만 확정하고, 여기서는
// 헬스 응답만 반환하는 최소 구현을 둔다(컴파일/호출 가능해야 함).
//
// 계약(apphub-conventions 3장): 성공 { data: ... }, 실패 { error: { code, message } }.
export const handler = async (event) => {
  const path = event?.rawPath ?? event?.path ?? "/";
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      data: { ok: true, path, note: "M2 placeholder — M3에서 실제 핸들러로 교체" },
    }),
  };
};
