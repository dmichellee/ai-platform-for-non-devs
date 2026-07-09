# sample-ok — 배포 표준을 완전히 준수하는 Dockerfile.
#  C6 베이스 이미지: 관리자 허용 목록의 공식 이미지(node:22-slim, public.ecr.aws).
#  C2 EXPOSE 8080. C7 non-root(USER). 의존성 0이라 npm install 단계 없음.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY server.js ./

# C2: 컨테이너는 8080에서 리슨.
EXPOSE 8080

# C7: non-root 실행(node 이미지에 기본 제공되는 node 사용자).
USER node

CMD ["node", "server.js"]
