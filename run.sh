#!/bin/bash
# 학교 서버(aiforalab.com) cron 진입점: 공고 수집 → 대시보드 인덱스 생성.
# 키는 같은 폴더의 .env (NARA_SERVICE_KEY=...) 에서 crawl.py 가 읽는다.
cd "$(dirname "$0")" || exit 1
export TZ=Asia/Seoul
export NARA_INDEX_OUT=/var/www/html/nara/data/index.json

echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="
# 수집이 성공했을 때만 인덱스를 다시 만든다. 그래야 화면의 "갱신" 시각이 마지막 성공 수집을 가리킨다
# (남은 시간은 app.js 가 열람 시각 기준으로 다시 계산하므로 인덱스가 오래돼도 틀리지 않는다).
.venv/bin/python scripts/crawl.py && .venv/bin/python scripts/build_index.py || exit $?

# 텔레그램 단톡방 알림(.env 에 봇 토큰이 있을 때만). 새 공고를 한 메시지로 묶어 보낸다.
if grep -q '^TELEGRAM_BOT_TOKEN=.' .env 2>/dev/null; then
  .venv/bin/python scripts/notify.py
fi
