# sample-build-error — Dockerfile은 정적 검증(C2 EXPOSE 8080, C6 베이스 이미지, C7 USER)을 통과한다.
#  그러나 `npm ci` 단계에서 package.json의 존재하지 않는 의존성 설치가 실패해
#  이미지 빌드가 깨진다 → 플랫폼 검증에서 BUILD_FAILED.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY package.json ./

# 의도적 결함: 존재하지 않는 패키지 버전 → 이 단계에서 non-zero 종료로 빌드 실패.
RUN npm ci || npm install

COPY server.js ./

EXPOSE 8080
USER node
CMD ["node", "server.js"]
