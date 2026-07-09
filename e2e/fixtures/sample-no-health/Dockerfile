# sample-no-health — Dockerfile은 완전히 표준을 준수한다(정적 검증·빌드 통과).
#  결함은 앱 코드에 /health 라우트가 없다는 것뿐 → 스모크 단계에서 HEALTHCHECK_FAILED.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY server.js ./

EXPOSE 8080
USER node

CMD ["node", "server.js"]
