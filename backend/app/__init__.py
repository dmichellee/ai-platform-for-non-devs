"""AppHub 컨트롤 플레인 백엔드 공유 패키지 (Python 3.13, 순수 boto3).

Lambda API 핸들러(app.handler:handler)와 Dockerfile 검증기(app.validator)의 공유 소스.
DDB/API 경계의 키는 camelCase 유지(계약·프론트 불변, D-M8). 내부 로컬 변수만 snake_case.
"""
