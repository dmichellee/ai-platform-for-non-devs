# Kiro 설정 번들 (배포 표준 자동 준수)

이 번들을 **프로젝트 루트에 그대로 넣으면**, Kiro가 코드를 만들 때 사내 배포 플랫폼(AppHub)의
배포 표준을 자동으로 지키도록 돕는다.

## 넣는 법 (비개발자용 안내)
1. 플랫폼 웹 화면의 **"Kiro 설정 다운로드"** 버튼으로 zip을 받는다.
2. 압축을 풀면 나오는 `.kiro/` 폴더를 **여러분의 앱 프로젝트 최상위 폴더**에 넣는다.
3. 끝. 이제 Kiro가 배포 가능한 형태로 코드를 만들어준다.
4. 배포가 실패하면, 플랫폼 화면에 나온 안내 문구를 그대로 Kiro에게 전달하면 된다.

## 들어있는 파일
```
.kiro/
├── steering/
│   └── deployment-standard.md          # 항상 적용되는 배포 표준 지침 (inclusion: always)
└── hooks/
    └── validate-deploy-ready.kiro.hook # 저장/수동 실행 시 자기점검
```

- `deployment-standard.md` — Kiro가 코드를 생성·수정할 때 항상 참조하는 규칙
  (8080 포트, `GET /health`, Dockerfile 표준, 무상태, 시크릿=환경변수, stdout 로그).
- `validate-deploy-ready.kiro.hook` — 파일을 저장하거나 직접 실행하면 Kiro가 위 규칙을
  스스로 점검하고 미비점 수정을 제안한다.

## 훅 스키마에 대한 주의 (개발자/관리자용)
`validate-deploy-ready.kiro.hook`은 **현재 Kiro 버전이 UI로 생성하는 `.kiro.hook` 형식**
(`enabled` / `name` / `description` / `version` / `when{type,patterns}` / `then{type:"askAgent",prompt}`)
을 기준으로 작성했다.

- Kiro 버전에 따라 hook 스키마가 다를 수 있다. 일부 버전은 최상위에 `hooks: []` 배열로 감싸고
  `trigger`(예: `PostFileSave`) / `matcher`(정규식) / `action{type,command|prompt}` 필드를 쓴다.
  두 형태 모두 "저장/편집 시 트리거 → 배포 표준 자기점검"이라는 **동작 의도는 동일**하다.
- 만약 여러분의 Kiro에서 이 훅이 인식되지 않으면, Kiro의 훅 생성 UI로 새 훅을 만든 뒤
  프롬프트에 `deployment-standard.md`를 점검하라는 내용을 붙여넣으면 된다.
- **중요**: 이 훅은 보조 수단이다. **최종 강제는 플랫폼의 배포 전 검증**(Dockerfile 정적 검증 +
  이미지 실행 스모크)이 담당한다. Kiro를 안 쓴 레포도 플랫폼에서 같은 기준으로 걸러진다
  (신뢰 경계 = 플랫폼 검증, KIRO-STANDARDS 3장).

## 이 번들은 어떻게 서빙되는가 (계약)
`_workspace/contracts/api-contract.md`의 "Kiro 설정 다운로드" 계약 참조.
zip은 `scripts/build-kiro-bundle.sh`로 생성하며, 플랫폼 자산 버킷의 고정 키
`s3://{assets}/kiro-config/kiro-config.zip`에 업로드된다.
