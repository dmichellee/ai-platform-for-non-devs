# sample-wrong-port — 의도적 결함: EXPOSE 3000 (계약 C2는 8080).
#  베이스 이미지·USER는 정상이라, 실패 사유가 오직 "포트 불일치"임을 확인할 수 있다.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY server.js ./

# 의도적 결함: 8080이 아니라 3000을 EXPOSE — DOCKERFILE_INVALID 유발.
EXPOSE 3000

USER node

CMD ["node", "server.js"]
