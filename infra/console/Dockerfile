# AppHub 플랫폼 콘솔 이미지 (D19 private 모드 — PLATFORM-ENGINEERING 4.1)
#
# 내용: SPA 정적 빌드 + Kiro 설정 zip(site/, deploy.sh가 cdk deploy 전에 준비) + nginx.
#  - CDK DockerImageAsset(platform-stack)이 이 디렉토리를 빌드·push 한다(내용 해시 → 멱등).
#  - config.json은 이미지에 넣지 않는다 — 컨테이너 시작 시 env(APPHUB_*)로 생성
#    (40-apphub-config.sh, 이미지↔스택 출력 순환 방지).
#  - non-root(nginx-unprivileged, uid 101), 8080 리스닝.
ARG BASE_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine
FROM ${BASE_IMAGE}

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY 40-apphub-config.sh /docker-entrypoint.d/40-apphub-config.sh
COPY site/ /usr/share/nginx/html/

USER root
RUN chmod 0755 /docker-entrypoint.d/40-apphub-config.sh \
 && rm -f /usr/share/nginx/html/config.json \
 && mkdir -p /tmp/apphub && chown 101:101 /tmp/apphub
USER 101

EXPOSE 8080
