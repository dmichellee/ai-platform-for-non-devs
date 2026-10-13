"""데이터 계층 — DynamoDB 단일 테이블 접근.

규약(apphub-conventions 1장): 필드명 camelCase, DDB 저장 시에도 camelCase 유지(변환 계층 없음).
시크릿 값은 저장 금지 — Secrets Manager ARN(secretArn, 앱당 1개)과 KEY 목록(secretKeys)만 참조.
"""
