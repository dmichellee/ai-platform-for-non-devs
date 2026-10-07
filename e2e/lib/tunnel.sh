#!/usr/bin/env bash
#
# e2e internal 앱 접속용 SSM 포트 포워딩 터널 — common.sh 가 source 한다. 단독 실행용 아님.
#
# 왜: E2E 는 테스트 앱을 scheme=internal 로 만든다. internal ALB 는 VPC 안에서만 닿고
#     (SG 443 = VPC CIDR 만 허용) 노트북에서는 앱 URL(https://{sub}.{appsDomain})에 접속할 수 없다.
#     VPC 사설 서브넷에 임시 EC2(t4g.nano, 인그레스 없음)를 띄우고
#     AWS-StartPortForwardingSessionToRemoteHost 로 internal ALB:443 을 127.0.0.1:{port} 로 끌어온다.
#     curl 은 --connect-to 로 TCP 연결만 터널로 돌리므로 Host/SNI/인증서 검증은 실제 그대로다.
#
# 옵션(환경변수):
#   E2E_INTERNAL_TUNNEL=1     터널 사용(기본 꺼짐 — 꺼져 있으면 모든 함수가 no-op)
#   E2E_TUNNEL_PORT=8443      internal ALB n=0 의 로컬 포트(증설 ALB n 은 PORT+n)
#   E2E_TUNNEL_KEEP=1         종료 시 아무것도 지우지 않음(인스턴스/SG/역할 보존 — 디버깅용)
#   E2E_TUNNEL_DELETE_ROLE=1  종료 시 IAM 역할/인스턴스 프로파일까지 삭제(기본 유지 — 재생성 전파 지연 방지)
#
# 제공 함수:
#   e2e::tunnel_enabled            — 터널 옵션이 켜졌는지(0=켜짐)
#   e2e::tunnel_up                 — 역할/SG/인스턴스 준비 → SSM Online 대기 → n=0 포워딩 시작
#   e2e::tunnel_forward <slug> <n> — 추가 ALB(증설 등) 포워딩 시작, 로컬 포트 echo
#   e2e::tunnel_map_host <host> <port> — 특정 호스트를 다른 로컬 포트(증설 ALB)로 보냄
#   e2e::tunnel_port_for <host>    — 호스트가 터널 대상이면 로컬 포트 echo(아니면 빈 문자열)
#   e2e::tunnel_down               — 세션 종료 → 인스턴스 terminate(대기) → SG 삭제 → (옵션) 역할 삭제
#
# bash 3.2(macOS 기본) 호환: 연관 배열·mapfile 미사용.

E2E_TUNNEL_TOUCHED="false"     # tunnel_up 이 리소스 생성을 시도했는지(down 대상 여부)
E2E_TUNNEL_READY="false"       # n=0 포워딩이 열려 있는지(app_curl 이 터널을 쓸지)
E2E_TUNNEL_INSTANCE_ID=""
E2E_TUNNEL_PIDS=()             # 백그라운드 start-session 프로세스 PID
E2E_TUNNEL_HOST_MAP=""         # "host=port" 줄 목록(호스트별 포트 재지정)
E2E_TUNNEL_LOG_DIR=""

e2e::tunnel_enabled() { [[ "${E2E_INTERNAL_TUNNEL:-0}" == "1" ]]; }

e2e::_tunnel_name()    { echo "apphub-${STAGE}-e2e-tunnel"; }
e2e::_tunnel_role()    { echo "apphub-${STAGE}-e2e-tunnel-role"; }
e2e::_tunnel_sg_name() { echo "apphub-${STAGE}-e2e-tunnel-sg"; }
e2e::_tunnel_base_port() { echo "${E2E_TUNNEL_PORT:-8443}"; }

# 로컬 TCP 포트가 열려 있는지(bash /dev/tcp — nc 불필요).
e2e::_port_open() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
}

# ── (a) IAM 역할 + 인스턴스 프로파일(멱등) ───────────────────────────────────
e2e::_tunnel_ensure_role() {
  local role; role="$(e2e::_tunnel_role)"
  if ! aws iam get-role --role-name "${role}" >/dev/null 2>&1; then
    e2e::log "터널: IAM 역할 생성 ${role}"
    aws iam create-role --role-name "${role}" \
      --description "AppHub e2e SSM port-forward tunnel (temporary)" \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      >/dev/null \
      || { e2e::fail "터널: IAM 역할 생성 실패(${role}) — iam:CreateRole 권한 확인"; return 1; }
  fi
  # attach 는 이미 붙어 있어도 성공(멱등).
  aws iam attach-role-policy --role-name "${role}" \
    --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" >/dev/null \
    || { e2e::fail "터널: AmazonSSMManagedInstanceCore 연결 실패 — iam:AttachRolePolicy 권한 확인"; return 1; }

  if ! aws iam get-instance-profile --instance-profile-name "${role}" >/dev/null 2>&1; then
    e2e::log "터널: 인스턴스 프로파일 생성 ${role}"
    aws iam create-instance-profile --instance-profile-name "${role}" >/dev/null \
      || { e2e::fail "터널: 인스턴스 프로파일 생성 실패 — iam:CreateInstanceProfile 권한 확인"; return 1; }
  fi
  local attached
  attached="$(aws iam get-instance-profile --instance-profile-name "${role}" \
    --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null || true)"
  if [[ " ${attached} " != *" ${role} "* ]]; then
    aws iam add-role-to-instance-profile --instance-profile-name "${role}" --role-name "${role}" >/dev/null \
      || { e2e::fail "터널: 프로파일에 역할 추가 실패 — iam:AddRoleToInstanceProfile 권한 확인"; return 1; }
  fi
}

# ── (b) 보안 그룹(인그레스 없음, 기본 아웃바운드) ─────────────────────────────
# echo: sg-id
e2e::_tunnel_find_sg() {
  local vpc="$1"
  local id
  id="$(aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=group-name,Values=$(e2e::_tunnel_sg_name)" "Name=vpc-id,Values=${vpc}" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
  [[ "${id}" == "None" ]] && id=""
  echo "${id}"
}

e2e::_tunnel_ensure_sg() {
  local vpc="$1"
  local id; id="$(e2e::_tunnel_find_sg "${vpc}")"
  if [[ -z "${id}" ]]; then
    e2e::log "터널: 보안 그룹 생성 $(e2e::_tunnel_sg_name) (인그레스 없음)" >&2
    id="$(aws ec2 create-security-group --region "${REGION}" --vpc-id "${vpc}" \
      --group-name "$(e2e::_tunnel_sg_name)" \
      --description "AppHub e2e SSM tunnel - no ingress, egress only" \
      --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$(e2e::_tunnel_sg_name)},{Key=apphub:purpose,Value=e2e-tunnel}]" \
      --query 'GroupId' --output text)" \
      || { e2e::fail "터널: 보안 그룹 생성 실패 — ec2:CreateSecurityGroup 권한 확인"; return 1; }
  fi
  echo "${id}"
}

# ── (c) EC2 인스턴스(재사용 또는 생성) ───────────────────────────────────────
# 상태 목록(콤마)에 해당하는 터널 태그 인스턴스 ID들(공백 구분).
e2e::_tunnel_instances() {
  local states="$1"
  local ids
  ids="$(aws ec2 describe-instances --region "${REGION}" \
    --filters "Name=tag:Name,Values=$(e2e::_tunnel_name)" "Name=tag:apphub:purpose,Values=e2e-tunnel" \
              "Name=instance-state-name,Values=${states}" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)"
  [[ "${ids}" == "None" ]] && ids=""
  echo "${ids}"
}

e2e::_tunnel_ensure_instance() {
  local sg="$1" subnet="$2"
  local existing; existing="$(e2e::_tunnel_instances "pending,running")"
  if [[ -n "${existing}" ]]; then
    local id="${existing%%[[:space:]]*}"
    e2e::log "터널: 기존 인스턴스 재사용 ${id}" >&2
    echo "${id}"
    return 0
  fi
  local ami; ami="$(e2e::_ssm "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64")"
  if [[ -z "${ami}" || "${ami}" == "None" ]]; then
    e2e::fail "터널: AL2023 arm64 AMI 공개 파라미터 조회 실패"; return 1
  fi
  local name; name="$(e2e::_tunnel_name)"
  local errf; errf="$(mktemp)"
  local id="" attempt
  # 새로 만든 인스턴스 프로파일은 EC2 에 전파되기까지 수~수십 초 걸린다 → 재시도.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    id="$(aws ec2 run-instances --region "${REGION}" \
      --image-id "${ami}" --instance-type t4g.nano --count 1 \
      --subnet-id "${subnet}" --security-group-ids "${sg}" \
      --iam-instance-profile "Name=$(e2e::_tunnel_role)" \
      --no-associate-public-ip-address \
      --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1" \
      --instance-initiated-shutdown-behavior terminate \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${name}},{Key=apphub:purpose,Value=e2e-tunnel}]" \
      --query 'Instances[0].InstanceId' --output text 2>"${errf}" || true)"
    if [[ -n "${id}" && "${id}" != "None" ]]; then break; fi
    id=""
    if grep -qiE "instance profile|iamInstanceProfile|InvalidParameterValue" "${errf}"; then
      e2e::log "터널: 인스턴스 프로파일 전파 대기 중… (${attempt}/12)" >&2
      sleep 10
      continue
    fi
    e2e::fail "터널: run-instances 실패: $(head -c 400 "${errf}" | tr '\n' ' ')"
    rm -f "${errf}"; return 1
  done
  rm -f "${errf}"
  if [[ -z "${id}" ]]; then
    e2e::fail "터널: 인스턴스 프로파일 전파 대기 타임아웃(2분) — 잠시 뒤 재실행하세요"; return 1
  fi
  e2e::log "터널: 인스턴스 생성 ${id} (t4g.nano, 퍼블릭 IP 없음, IMDSv2)" >&2
  echo "${id}"
}

# ── (d) SSM 관리 인스턴스 Online 대기 ────────────────────────────────────────
e2e::_tunnel_ssm_online() {
  local st
  st="$(aws ssm describe-instance-information --region "${REGION}" \
    --filters "Key=InstanceIds,Values=${E2E_TUNNEL_INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [[ "${st}" == "Online" ]]
}

# ── (e) 포트 포워딩 세션 ─────────────────────────────────────────────────────
# 사용: e2e::tunnel_forward <slug> <n>; port="${E2E_TUNNEL_LAST_PORT}"  — 로컬 포트 = E2E_TUNNEL_PORT + n.
# 같은 포트가 이미 이 실행의 터널로 열려 있으면 재사용.
# 주의: PID 를 전역 배열에 저장하므로 $( ) 안에서 부르지 말 것(재연결 경로 tunnel_ensure_port 는 예외 — 위 설명).
E2E_TUNNEL_LAST_PORT=""
E2E_TUNNEL_OPEN_PORTS=" "
e2e::tunnel_forward() {
  local slug="$1" n="$2"
  local base; base="$(e2e::_tunnel_base_port)"
  local port=$(( base + n ))
  E2E_TUNNEL_LAST_PORT="${port}"
  if [[ "${E2E_TUNNEL_OPEN_PORTS}" == *" ${port} "* ]] && e2e::_port_open "${port}"; then
    return 0
  fi
  if [[ -z "${E2E_TUNNEL_INSTANCE_ID}" ]]; then
    e2e::fail "터널: 인스턴스가 없습니다(e2e::tunnel_up 먼저)"; return 1
  fi
  local dns; dns="$(e2e::alb_param "${slug}" "${n}" alb-dns)"
  if [[ -z "${dns}" && "${n}" == "0" ]]; then
    dns="$(e2e::_ssm "/apphub/${STAGE}/network/${slug}-alb-dns")"   # 구 키 폴백
    [[ "${dns}" == "None" ]] && dns=""
  fi
  if [[ -z "${dns}" ]]; then
    e2e::fail "터널: ALB DNS(SSM /apphub/${STAGE}/network/alb/${slug}/${n}/alb-dns) 조회 실패"; return 1
  fi
  if e2e::_port_open "${port}"; then
    e2e::fail "터널: 로컬 포트 ${port} 가 이미 사용 중입니다(이전 실행의 세션?). E2E_TUNNEL_PORT 를 바꾸거나 해당 프로세스를 종료하세요."
    return 1
  fi
  [[ -z "${E2E_TUNNEL_LOG_DIR}" ]] && E2E_TUNNEL_LOG_DIR="$(mktemp -d)"
  local logf="${E2E_TUNNEL_LOG_DIR}/session-${slug}-${n}.log"
  e2e::log "터널: 포트 포워딩 시작 127.0.0.1:${port} → ${dns}:443 (via ${E2E_TUNNEL_INSTANCE_ID})"
  aws ssm start-session --region "${REGION}" --target "${E2E_TUNNEL_INSTANCE_ID}" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"${dns}\"],\"portNumber\":[\"443\"],\"localPortNumber\":[\"${port}\"]}" \
    </dev/null >"${logf}" 2>&1 &
  local pid=$!
  E2E_TUNNEL_PIDS+=("${pid}")
  local waited=0
  while ! e2e::_port_open "${port}"; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      e2e::fail "터널: 세션 프로세스가 종료됨. 로그: $(head -c 600 "${logf}" | tr '\n' ' ')"
      return 1
    fi
    if [[ "${waited}" -ge 60 ]]; then
      e2e::fail "터널: 로컬 포트 ${port} 대기 타임아웃(60s). 로그: ${logf}"
      return 1
    fi
    sleep 2; waited=$(( waited + 2 ))
  done
  E2E_TUNNEL_OPEN_PORTS="${E2E_TUNNEL_OPEN_PORTS}${port} "
  e2e::ok "터널: 127.0.0.1:${port} 열림(${waited}s)"
  e2e::_tunnel_start_keepalive "${port}"
}

# Session Manager 유휴 타임아웃(기본 20분) 대비: 빌드 대기 중에도 주기적으로 터널에 요청을 흘린다.
#  루프는 메인 스크립트(PID $$)가 사라지면 스스로 끝난다(PID 를 놓쳐도 고아로 남지 않음).
e2e::_tunnel_start_keepalive() {
  local port="$1"
  local interval="${E2E_TUNNEL_KEEPALIVE:-240}"
  local probe="e2e-tunnel-probe.${APPS_DOMAIN:-invalid}"
  local parent=$$
  (
    while kill -0 "${parent}" 2>/dev/null; do
      sleep "${interval}"
      curl -s -o /dev/null --connect-timeout 5 --max-time 15 \
        --connect-to "${probe}:443:127.0.0.1:${port}" "https://${probe}/" >/dev/null 2>&1 || true
    done
  ) </dev/null >/dev/null 2>&1 &
  E2E_TUNNEL_PIDS+=("$!")
}

# 앱 호출 직전 터널 포트가 살아 있는지 확인하고, 세션이 끊겼으면(유휴/네트워크) 다시 연다.
#  $( ) 안에서 불려도 동작한다(새 세션 PID 는 부모가 모르지만 tunnel_down 이 인스턴스 ID 로 plugin 을 종료하고,
#  인스턴스 terminate 로 세션도 끝난다).
e2e::tunnel_ensure_port() {
  local port="$1"
  [[ "${E2E_TUNNEL_READY}" == "true" ]] || return 0
  e2e::_port_open "${port}" && return 0
  local n=$(( port - $(e2e::_tunnel_base_port) ))
  e2e::log "터널: 127.0.0.1:${port} 세션이 끊겨 재연결합니다" >&2
  e2e::tunnel_forward internal "${n}" >&2
}

e2e::tunnel_up() {
  e2e::tunnel_enabled || return 0
  command -v session-manager-plugin >/dev/null 2>&1 \
    || { e2e::fail "터널: 'session-manager-plugin' 이 필요합니다(AWS Session Manager plugin 설치)."; return 1; }
  E2E_TUNNEL_TOUCHED="true"
  local vpc; vpc="$(e2e::_ssm "/apphub/${STAGE}/network/vpc-id")"
  local subnet; subnet="$(e2e::_ssm "/apphub/${STAGE}/network/private-subnet-id-0")"
  if [[ -z "${vpc}" || "${vpc}" == "None" || -z "${subnet}" || "${subnet}" == "None" ]]; then
    e2e::fail "터널: SSM network/vpc-id 또는 private-subnet-id-0 조회 실패"; return 1
  fi
  e2e::log "터널: VPC=${vpc} subnet=${subnet}"

  e2e::_tunnel_ensure_role || return 1
  local sg; sg="$(e2e::_tunnel_ensure_sg "${vpc}")" || return 1
  [[ -n "${sg}" ]] || { e2e::fail "터널: 보안 그룹 ID 없음"; return 1; }
  E2E_TUNNEL_INSTANCE_ID="$(e2e::_tunnel_ensure_instance "${sg}" "${subnet}")" || return 1
  [[ -n "${E2E_TUNNEL_INSTANCE_ID}" ]] || { e2e::fail "터널: 인스턴스 ID 없음"; return 1; }

  aws ec2 wait instance-running --region "${REGION}" --instance-ids "${E2E_TUNNEL_INSTANCE_ID}" \
    || { e2e::fail "터널: 인스턴스 running 대기 실패"; return 1; }
  e2e::wait_for "터널 인스턴스 SSM Online" 300 10 e2e::_tunnel_ssm_online \
    || { e2e::fail "터널: SSM 에이전트 Online 실패 — 사설 서브넷 NAT/SSM 엔드포인트 경로 확인"; return 1; }

  e2e::tunnel_forward internal 0 || return 1
  E2E_TUNNEL_READY="true"
}

# 호스트를 특정 로컬 포트로(증설 ALB 앱 등).
e2e::tunnel_map_host() {
  local host="$1" port="$2"
  E2E_TUNNEL_HOST_MAP="${E2E_TUNNEL_HOST_MAP}${host}=${port}
"
}

# 터널 대상 호스트면 로컬 포트, 아니면 빈 문자열.
e2e::tunnel_port_for() {
  local host="$1"
  [[ "${E2E_TUNNEL_READY}" == "true" ]] || return 0
  [[ -n "${APPS_DOMAIN:-}" && "${host}" == *".${APPS_DOMAIN}" ]] || return 0
  local line
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    if [[ "${line%%=*}" == "${host}" ]]; then echo "${line#*=}"; return 0; fi
  done <<< "${E2E_TUNNEL_HOST_MAP}"
  e2e::_tunnel_base_port
}

# 세션 프로세스 종료(aws CLI 와 자식 session-manager-plugin 모두).
e2e::_tunnel_kill_sessions() {
  local pid
  for pid in ${E2E_TUNNEL_PIDS[@]+"${E2E_TUNNEL_PIDS[@]}"}; do
    pkill -TERM -P "${pid}" 2>/dev/null || true
    kill -TERM "${pid}" 2>/dev/null || true
  done
  if [[ -n "${E2E_TUNNEL_INSTANCE_ID}" ]]; then
    pkill -TERM -f "session-manager-plugin.*${E2E_TUNNEL_INSTANCE_ID}" 2>/dev/null || true
  fi
  sleep 1
  for pid in ${E2E_TUNNEL_PIDS[@]+"${E2E_TUNNEL_PIDS[@]}"}; do
    kill -0 "${pid}" 2>/dev/null && kill -KILL "${pid}" 2>/dev/null || true
  done
  E2E_TUNNEL_PIDS=()
  E2E_TUNNEL_OPEN_PORTS=" "
  E2E_TUNNEL_READY="false"
}

# 정리(멱등, 실패해도 계속 — EXIT trap 에서 호출). 항상 0 반환.
e2e::tunnel_down() {
  e2e::tunnel_enabled || return 0
  [[ "${E2E_TUNNEL_TOUCHED}" == "true" ]] || return 0
  E2E_TUNNEL_TOUCHED="false"   # 재진입 방지
  e2e::_tunnel_kill_sessions
  if [[ "${E2E_TUNNEL_KEEP:-0}" == "1" ]]; then
    e2e::log "터널: E2E_TUNNEL_KEEP=1 — 인스턴스/SG/역할 보존(${E2E_TUNNEL_INSTANCE_ID:-?}). 직접 정리하거나 다음 실행에서 재사용/정리됨."
    return 0
  fi
  e2e::log "터널 정리 시작"
  # 이 실행에서 만든 것뿐 아니라 같은 태그의 잔존 인스턴스도 함께 정리(이전 실행 누수 회수).
  local ids; ids="$(e2e::_tunnel_instances "pending,running,stopping,stopped")"
  if [[ -n "${ids}" ]]; then
    e2e::log "터널: 인스턴스 terminate ${ids}"
    # shellcheck disable=SC2086
    aws ec2 terminate-instances --region "${REGION}" --instance-ids ${ids} >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    if aws ec2 wait instance-terminated --region "${REGION}" --instance-ids ${ids} 2>/dev/null; then
      e2e::ok "터널: 인스턴스 terminated"
    else
      e2e::fail "터널: terminated 대기 실패 — 수동 확인: aws ec2 describe-instances --instance-ids ${ids}"
    fi
  fi
  local vpc; vpc="$(e2e::_ssm "/apphub/${STAGE}/network/vpc-id")"
  if [[ -n "${vpc}" && "${vpc}" != "None" ]]; then
    local sg; sg="$(e2e::_tunnel_find_sg "${vpc}")"
    if [[ -n "${sg}" ]]; then
      local i deleted="false"
      # ENI 해제가 terminated 직후 조금 늦을 수 있다 → 재시도.
      for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
        if aws ec2 delete-security-group --region "${REGION}" --group-id "${sg}" >/dev/null 2>&1; then
          deleted="true"; break
        fi
        sleep 10
      done
      if [[ "${deleted}" == "true" ]]; then e2e::ok "터널: 보안 그룹 ${sg} 삭제"
      else e2e::fail "터널: 보안 그룹 ${sg} 삭제 실패 — 수동 삭제: aws ec2 delete-security-group --group-id ${sg}"; fi
    fi
  fi
  if [[ "${E2E_TUNNEL_DELETE_ROLE:-0}" == "1" ]]; then
    local role; role="$(e2e::_tunnel_role)"
    aws iam remove-role-from-instance-profile --instance-profile-name "${role}" --role-name "${role}" >/dev/null 2>&1 || true
    aws iam delete-instance-profile --instance-profile-name "${role}" >/dev/null 2>&1 || true
    aws iam detach-role-policy --role-name "${role}" \
      --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" >/dev/null 2>&1 || true
    if aws iam delete-role --role-name "${role}" >/dev/null 2>&1; then
      e2e::ok "터널: IAM 역할/프로파일 ${role} 삭제"
    else
      e2e::log "터널: IAM 역할 ${role} 삭제 실패 또는 이미 없음"
    fi
  else
    e2e::log "터널: IAM 역할/프로파일 $(e2e::_tunnel_role) 유지(비용 없음, 삭제는 E2E_TUNNEL_DELETE_ROLE=1)"
  fi
  [[ -n "${E2E_TUNNEL_LOG_DIR}" ]] && rm -rf "${E2E_TUNNEL_LOG_DIR}"
  return 0
}
