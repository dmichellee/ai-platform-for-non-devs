# sample-streaming — 배포 표준 준수(정상 성공 경로). SSE 스트리밍 앱.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY server.js ./

EXPOSE 8080
USER node

CMD ["node", "server.js"]
