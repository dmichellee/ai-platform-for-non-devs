/**
 * Kiro 설정 다운로드 페이지 — 비개발자가 Kiro 설정 번들(.zip)을 받아 자기 프로젝트에
 * 넣고 쓸 수 있게 친절·단계적으로 안내한다. 로그인한 모든 사용자(user/admin) 공통.
 *
 * 다운로드 URL: OS별 2개(Mac / Windows).
 *   Mac: config.kiroConfigUrlMac ?? DEFAULT_KIRO_CONFIG_URL_MAC
 *   Windows: config.kiroConfigUrlWindows ?? DEFAULT_KIRO_CONFIG_URL_WINDOWS
 *   CloudFront가 SPA와 같은 오리진에서 `/kiro-config/*`를 서빙하므로(platform Output
 *   KiroConfigUrlPath) 기본값은 SPA-상대 경로다. API 왕복 없음(정적 다운로드).
 *   현재 사용자 OS를 추정해 해당 버튼을 기본 강조(primary)하고, 다른 OS 버튼은 보조로 둔다.
 *   단 둘 다 항상 받을 수 있다(감지 실패 시 무해한 기본값 Mac 강조).
 *
 * 번들 구성(확정 설계): git pre-commit hook 방식. OS별 설치기 2종 포함.
 *   zip = `.kiro/steering/deployment-standard.md` + `hooks/pre-commit`
 *       + `install-hooks.sh`(Mac/Linux) + `install-hooks.ps1`(Windows) + README.
 *   설치 스크립트를 한 번 실행하면 커밋할 때마다 pre-commit 훅이 배포 표준을 자동 검사한다
 *   (Dockerfile 존재, EXPOSE 8080 하나만, 금지 항목, 위험한 비밀값 패턴). 권장 항목(non-root)과
 *   코드 수준 항목(/health)은 훅이 아니라 Kiro(steering)+플랫폼 검증이 담당.
 *
 * 용어 사전(apphub-conventions §6): AWS 인프라 용어 노출 금지.
 *   예외(사용자가 실제로 다뤄야 하는 단어) — Kiro, Dockerfile, .kiro 폴더, 8080 포트.
 *   이 페이지 한정 예외 — git/커밋/터미널(실제로 다뤄야 하는 개념), 그리고 Windows 사용자가
 *   실제로 다뤄야 하는 도구명 PowerShell. 단 최대한 풀어쓴다.
 * 이모지 금지 → 전부 Lucide.
 */
import {
  Apple,
  Copy,
  Download,
  FileCheck2,
  FolderTree,
  ListOrdered,
  MonitorCheck,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { InfoNotice, TopBar } from "../../components/common.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import {
  DEFAULT_KIRO_CONFIG_URL_MAC,
  DEFAULT_KIRO_CONFIG_URL_WINDOWS,
  getCachedConfig,
} from "../../lib/config.js";

/**
 * 현재 사용자 OS 추정. navigator가 없는 SSR/테스트 환경에서도 안전하게 동작하며,
 * 판별이 애매하면 무해한 기본값 "mac"을 돌려준다(둘 다 항상 다운로드 가능하므로 안전).
 */
function detectOs(): "mac" | "windows" {
  if (typeof navigator === "undefined") return "mac";
  const hint = `${navigator.userAgent ?? ""} ${navigator.platform ?? ""}`.toLowerCase();
  if (hint.includes("win")) return "windows";
  if (hint.includes("mac") || hint.includes("iphone") || hint.includes("ipad")) return "mac";
  // 리눅스 등 그 외: Mac/Linux 공용 설치기(sh)를 쓰므로 Mac 쪽을 기본 강조한다.
  return "mac";
}

export function KiroSetup(): JSX.Element {
  const { session, logout } = useAuth();
  const userInitial = sessionInitial(session);
  const cfg = getCachedConfig();
  // config.json에 override가 있으면 그 값을, 없으면 SPA-상대 기본 경로를 쓴다.
  const macUrl = cfg?.kiroConfigUrlMac ?? DEFAULT_KIRO_CONFIG_URL_MAC;
  const windowsUrl = cfg?.kiroConfigUrlWindows ?? DEFAULT_KIRO_CONFIG_URL_WINDOWS;
  // 감지된 OS를 기본 강조(primary), 다른 OS는 보조(ghost)로 배치한다.
  const os = detectOs();
  const macPrimary = os === "mac";

  return (
    <div className="wrap">
      <TopBar userInitial={userInitial} onLogout={logout} />

      {/* 헤더 + OS별 다운로드 버튼 2개(Mac / Windows) */}
      <div className="kiro-hero">
        <div className="lead">
          <h2>
            <Download size={24} className="icon" style={{ color: "var(--primary)" }} />
            Kiro 설정 다운로드
          </h2>
          <p className="desc">
            Kiro로 앱을 만들 때 이 설정을 넣으면, 배포 가능한 형태로 코드가 만들어져요. 쓰시는 컴퓨터에
            맞는 파일을 받아 내 프로젝트에 한 번만 넣어두면 됩니다.
          </p>
        </div>
        <div className="kiro-downloads" role="group" aria-label="운영체제별 설정 파일 다운로드">
          <a
            className={`btn row ${macPrimary ? "btn-download" : "btn-download-alt"}`}
            href={macUrl}
            download
            data-testid="kiro-download-mac"
            aria-label="Mac 또는 리눅스용 설정 파일 다운로드"
          >
            <Apple size={20} className="icon" aria-hidden="true" />
            <span className="stack" style={{ gap: 2, alignItems: "flex-start" }}>
              Mac / 리눅스용 받기
              <span className="fname">
                kiro-config-mac.zip
                {macPrimary ? <span className="os-hint"> · 이 컴퓨터에 맞아요</span> : null}
              </span>
            </span>
          </a>
          <a
            className={`btn row ${macPrimary ? "btn-download-alt" : "btn-download"}`}
            href={windowsUrl}
            download
            data-testid="kiro-download-windows"
            aria-label="Windows용 설정 파일 다운로드"
          >
            <MonitorCheck size={20} className="icon" aria-hidden="true" />
            <span className="stack" style={{ gap: 2, alignItems: "flex-start" }}>
              Windows용 받기
              <span className="fname">
                kiro-config-windows.zip
                {!macPrimary ? <span className="os-hint"> · 이 컴퓨터에 맞아요</span> : null}
              </span>
            </span>
          </a>
        </div>
      </div>

      {/* 왜 필요한가 */}
      <div className="panel">
        <h4>
          <Sparkles size={18} className="icon" style={{ color: "var(--primary)" }} />
          왜 필요한가요?
        </h4>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.65 }}>
          이 플랫폼은 앱이 몇 가지 표준(예: 8080 포트에서 열기, 상태 확인 경로 <code>/health</code>,
          Dockerfile 같은 준비 파일)을 지켜야 배포할 수 있어요. 이 설정을 Kiro에 넣어두면, Kiro가 코드를
          만들 때 그 표준을 알아서 지켜줍니다. 그래서 처음부터 배포가 잘 되는 앱을 더 쉽게 만들 수 있어요.
        </p>
      </div>

      {/* 설치 4단계 */}
      <div className="panel">
        <h4>
          <FileCheck2 size={18} className="icon" style={{ color: "var(--primary)" }} />
          설치하는 법 (4단계)
        </h4>
        <div className="step-cards">
          <div className="step-card">
            <div className="badge-num" aria-hidden="true">
              1
            </div>
            <div className="t">받은 파일 압축 풀기</div>
            <div className="d">
              위에서 받은 <code>.zip</code> 파일을 더블클릭해 압축을 풀어요. 안에 <code>.kiro</code> 폴더와{" "}
              <code>hooks</code> 폴더, 설치 파일(<code>install-hooks.sh</code>,{" "}
              <code>install-hooks.ps1</code>)이 들어 있어요.
            </div>
          </div>
          <div className="step-card">
            <div className="badge-num" aria-hidden="true">
              2
            </div>
            <div className="t">프로젝트 맨 위에 복사</div>
            <div className="d">
              풀어서 나온 <code>.kiro</code> 폴더와 <code>hooks</code> 폴더, 설치 파일들을, 내 프로젝트
              폴더의 맨 위(가장 바깥)에 그대로 복사해 넣어요.
            </div>
          </div>
          <div className="step-card">
            <div className="badge-num" aria-hidden="true">
              3
            </div>
            <div className="t">검사 설치 한 번 실행</div>
            <div className="d">
              쓰시는 컴퓨터에 맞는 방법으로 한 번만 실행해요. 직접 하기 어렵다면 Kiro에게{" "}
              <b>"커밋 검사 설치해줘"</b>라고 요청해도 됩니다.
              <div className="os-runs">
                <div className="os-run">
                  <div className="os-run-h">
                    <Apple size={14} className="icon" aria-hidden="true" />
                    Mac / 리눅스
                  </div>
                  <div className="os-run-b">
                    터미널(명령을 입력하는 검은 창)에서 <code>sh install-hooks.sh</code>
                  </div>
                </div>
                <div className="os-run">
                  <div className="os-run-h">
                    <MonitorCheck size={14} className="icon" aria-hidden="true" />
                    Windows
                  </div>
                  <div className="os-run-b">
                    프로젝트 폴더 안의 빈 곳에서 Shift 키를 누른 채 마우스 오른쪽 클릭 →{" "}
                    <b>"여기에 PowerShell 창 열기"</b>를 고른 뒤, 아래를 붙여넣어요.
                    <code className="cmd">
                      powershell -ExecutionPolicy Bypass -File install-hooks.ps1
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="step-card">
            <div className="badge-num" aria-hidden="true">
              4
            </div>
            <div className="t">이제부터 자동 검사</div>
            <div className="d">
              설치가 끝나면, 코드를 저장(커밋)할 때마다 배포 표준에 맞는지 자동으로 검사돼요. 따로 켜거나
              누를 필요가 없어요.
            </div>
          </div>
        </div>

        {/* 폴더 구조 시각화 */}
        <div className="mt4">
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            이렇게 놓이면 정상이에요:
          </div>
          <pre className="tree" aria-label="폴더 구조 예시">
            <span className="root">내-프로젝트-폴더/</span>
            {"\n"}├─ <span className="dir">.kiro/</span>
            {"\n"}│ └─ <span className="dir">steering/</span>
            {"\n"}│ └─ deployment-standard.md
            {"\n"}├─ <span className="dir">hooks/</span>
            {"\n"}│ └─ pre-commit
            {"\n"}├─ install-hooks.sh <span className="tree-note"># Mac / 리눅스용</span>
            {"\n"}├─ install-hooks.ps1 <span className="tree-note"># Windows용</span>
            {"\n"}└─ (내 앱 코드…)
          </pre>
        </div>
      </div>

      {/* 뭐가 들어있나 */}
      <div className="panel">
        <h4>
          <FolderTree size={18} className="icon" style={{ color: "var(--primary)" }} />
          무엇이 들어있나요?
        </h4>
        <div className="grid-3">
          <div className="kiro-file">
            <span className="fico" aria-hidden="true">
              <FileCheck2 size={20} className="icon" />
            </span>
            <div>
              <div className="t">배포 표준 지침 (steering)</div>
              <div className="d">
                Kiro가 코드를 만들 때 배포 표준을 항상 지키도록 알려주는 안내서예요. 포트, 상태 확인,
                준비 파일 같은 규칙이 담겨 있어요.
              </div>
            </div>
          </div>
          <div className="kiro-file">
            <span className="fico" aria-hidden="true">
              <ShieldCheck size={20} className="icon" />
            </span>
            <div>
              <div className="t">커밋 검사 (pre-commit)</div>
              <div className="d">
                코드를 저장(커밋)하는 순간 표준에 맞는지 자동으로 확인해요. 어긋나면 저장을 멈추고 무엇이
                문제인지 알려줘서, 문제가 있는 코드가 배포로 넘어가지 않게 막아줘요.
              </div>
            </div>
          </div>
          <div className="kiro-file">
            <span className="fico" aria-hidden="true">
              <Terminal size={20} className="icon" />
            </span>
            <div>
              <div className="t">설치 스크립트 (install-hooks.sh / .ps1)</div>
              <div className="d">
                위 커밋 검사를 내 프로젝트에 붙여주는 준비 파일이에요. Mac·리눅스는{" "}
                <code>install-hooks.sh</code>, Windows는 <code>install-hooks.ps1</code>을 처음 한 번만
                실행하면 돼요.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 사용 팁 */}
      <div className="panel">
        <h4>
          <Sparkles size={18} className="icon" style={{ color: "var(--primary)" }} />
          알아두면 좋은 팁
        </h4>
        <div className="stack">
          <InfoNotice>
            <b>
              <ListOrdered size={15} className="icon" aria-hidden="true" /> 코드를 저장·반영하는 기본
              순서
            </b>{" "}
            — 아래 세 줄을 터미널에 차례로 입력하면 돼요(Mac·Windows 공통).
            <ol className="git-flow" aria-label="코드를 저장하고 원격 저장소에 올리는 순서">
              <li>
                <code className="cmd">git add --all</code>
                <span className="git-flow-note">바뀐 내용 모으기</span>
              </li>
              <li>
                <code className="cmd">git commit -m "무엇을 바꿨는지 짧게"</code>
                <span className="git-flow-note">저장하기 — 이때 배포 표준 검사가 자동으로 돌아요</span>
              </li>
              <li>
                <code className="cmd">git push</code>
                <span className="git-flow-note">원격 저장소에 올리기(반영)</span>
              </li>
            </ol>
          </InfoNotice>
          <InfoNotice>
            <b>커밋이 멈췄을 때</b> — 검사에 걸리면 저장(커밋)이 멈추고 이유가 화면에 나와요. 그 안내를
            그대로 복사해 Kiro에게 붙여넣으면, Kiro가 무엇이 문제인지 이해하고 고쳐줍니다.
          </InfoNotice>
          <InfoNotice>
            <b>배포가 실패했을 때</b> — 화면에 나오는 안내 문구를 그대로 복사해 Kiro에게 붙여넣으면,
            Kiro가 무엇이 문제인지 이해하고 고쳐줍니다.
          </InfoNotice>
          <InfoNotice>
            <b>표준에 안 맞을 때</b> — Kiro에게 <b>"배포 표준에 맞춰줘"</b>라고 말하면, 위 설정에 따라
            빠진 부분(예: 8080 포트, <code>/health</code>, Dockerfile)을 알아서 맞춰줍니다.
          </InfoNotice>
          <div className="row muted" style={{ fontSize: 13, gap: 8 }}>
            <Copy size={15} className="icon" />
            안내 문구는 길어도 괜찮아요. 나온 내용의 마지막 부분까지 함께 붙여넣을수록 Kiro가 더 정확히
            고쳐줍니다.
          </div>
        </div>
      </div>
    </div>
  );
}
