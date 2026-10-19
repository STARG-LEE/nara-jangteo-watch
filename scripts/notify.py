"""
새로 올라온 공고를 텔레그램 단톡방에 묶어서 알린다. run.sh 가 수집·인덱스 생성이 성공한 뒤에 부른다.

환경변수(.env):
    TELEGRAM_BOT_TOKEN : @BotFather 에서 받은 봇 토큰
    TELEGRAM_CHAT_ID   : 알림 받을 단톡방 id (보통 -100 으로 시작)

상태 파일 state/notified.json 에 이미 알린 "공고번호-차수"를 적어 둔다.
- 상태 파일이 없을 때(첫 실행)는 지금 있는 공고를 전부 '알림 완료'로 기록만 하고 보내지 않는다.
  그러지 않으면 첫 실행에 공고 수백 건이 단톡방에 쏟아진다.
- 보내기에 실패하면 기록하지 않으므로 다음 실행 때 다시 보낸다.

알리지 않는 것: 취소공고, 이미 알린 공고의 변경공고, 이미 마감된 공고.
재공고는 차수가 바뀐 새 입찰이라 다시 알린다.

사용법:
    python scripts/notify.py              # 인덱스를 읽어 새 공고를 보낸다
    python scripts/notify.py --dry-run    # 보내지 않고 메시지만 출력 (상태도 안 바꿈)
    python scripts/notify.py --test       # 단톡방에 연결 확인 메시지 한 통
"""
import argparse
import html
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

import requests

from build_index import KST, OUT_PATH, parse_bid_dt
from crawl import ROOT, _load_dotenv

_load_dotenv(ROOT / ".env")

STATE_PATH = ROOT / "state" / "notified.json"
DASHBOARD_URL = "https://aiforalab.com/nara/"
MAX_CHARS = 3800          # 텔레그램 한 메시지 한도 4096자(링크 태그 제외 후)보다 여유 있게
MAX_MESSAGES = 2          # 한 번 실행에 보내는 최대 메시지 수. 넘치면 나머지는 대시보드로 안내
WEEKDAY = "월화수목금토일"


def fmt_won(item: dict) -> str:
    for key in ("asignBdgtAmt", "presmptPrce"):
        try:
            n = float(str(item.get(key) or "").replace(",", ""))
        except ValueError:
            continue
        if n >= 1e8:
            return f"{n / 1e8:.1f}".rstrip("0").rstrip(".") + "억원"
        if n >= 1e4:
            return f"{round(n / 1e4):,}만원"
    return "예산 미공개"


def fmt_due(close: datetime, now: datetime) -> str:
    days = (close.date() - now.date()).days
    left = f"{int((close - now).total_seconds() // 3600)}시간 남음" if days < 1 else f"D-{days}"
    return f"{close.month}.{close.day:02d}({WEEKDAY[close.weekday()]}) {close:%H:%M} 마감, {left}"


def item_block(item: dict, close: datetime, now: datetime) -> str:
    title = html.escape(item.get("bidNtceNm") or "(제목 없음)")
    url = item.get("bidNtceDtlUrl")
    head = f'<a href="{html.escape(url, quote=True)}">{title}</a>' if url else title
    if item.get("ntceKindNm") == "재공고":
        head += " [재공고]"
    org = html.escape(item.get("ntceInsttNm") or item.get("dminsttNm") or "")
    due = fmt_due(close, now) if close else "마감일 미상"
    kws = " ".join("#" + k for k in item.get("matched_keywords", []))
    return f"{head}\n{org} | {fmt_won(item)} | {due}\n{html.escape(kws)}"


def select_new(items: List[dict], notified: Dict[str, str], now: datetime) -> List[tuple]:
    """알릴 공고를 (item, close_dt) 로 고른다. 마감 빠른 순."""
    notified_nos = {k.rsplit("-", 1)[0] for k in notified}
    picked = []
    for it in items:
        no, ord_ = str(it.get("bidNtceNo") or ""), str(it.get("bidNtceOrd") or "000")
        key = f"{no}-{ord_}"
        kind = it.get("ntceKindNm")
        close = parse_bid_dt(it.get("bidClseDt", ""))
        if key in notified or kind == "취소공고" or (close and close < now):
            continue
        if kind == "변경공고" and no in notified_nos:
            continue
        picked.append((it, close))
    picked.sort(key=lambda p: p[1] or datetime.max.replace(tzinfo=KST))
    return picked


def build_messages(picked: List[tuple], now: datetime) -> List[Tuple[str, List[tuple]]]:
    """(메시지, 그 메시지에 담긴 공고들) 목록. 길면 여러 통으로 나눈다(각 MAX_CHARS 이내)."""
    footer = f'\n\n<a href="{DASHBOARD_URL}">대시보드에서 전체 보기</a>'
    title = f"<b>새 용역 공고 {len(picked)}건</b>"
    messages: List[Tuple[str, List[tuple]]] = []
    current: List[tuple] = []
    blocks: List[str] = []

    def flush() -> None:
        head = title if not messages else f"{title} (이어서)"
        messages.append(("\n\n".join([head] + blocks) + footer, list(current)))

    for pick in picked:
        block = item_block(pick[0], pick[1], now)
        if blocks and len("\n\n".join([title] + blocks + [block]) + footer) > MAX_CHARS:
            flush()
            current.clear()
            blocks.clear()
        current.append(pick)
        blocks.append(block)
    if blocks:
        flush()
    return messages


def send(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        raise RuntimeError("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 .env 에 없습니다.")
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
        timeout=20,
    )
    body = r.json() if r.headers.get("Content-Type", "").startswith("application/json") else {}
    if not body.get("ok"):
        # 응답 본문에는 토큰이 없지만 URL에는 있으므로 URL은 찍지 않는다.
        raise RuntimeError(f"텔레그램 전송 실패: HTTP {r.status_code} {body.get('description', '')}")


def load_state() -> Dict[str, str]:
    with STATE_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_state(state: Dict[str, str]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(str(tmp), str(STATE_PATH))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="보내지 않고 출력만")
    p.add_argument("--test", action="store_true", help="연결 확인 메시지 한 통")
    args = p.parse_args()

    if args.test:
        send(f"나라장터 용역 공고 알림이 연결됐습니다.\n새 공고가 수집되면 이 방으로 묶어서 보냅니다.\n{DASHBOARD_URL}")
        print("테스트 메시지 전송 완료")
        return 0

    with OUT_PATH.open(encoding="utf-8") as f:
        index = json.load(f)
    items = index.get("closing_soon", []) + index.get("open", []) + index.get("closed", [])
    now = datetime.now(tz=KST)
    stamp = now.isoformat(timespec="seconds")

    if not STATE_PATH.exists():
        seed = {f"{it.get('bidNtceNo')}-{it.get('bidNtceOrd') or '000'}": stamp for it in items}
        if not args.dry_run:
            save_state(seed)
        print(f"첫 실행: 기존 공고 {len(seed)}건을 알림 완료로 기록만 했습니다(전송 없음).")
        return 0

    notified = load_state()
    picked = select_new(items, notified, now)
    if not picked:
        print("새 공고 없음")
        return 0

    messages = build_messages(picked, now)
    if len(messages) > MAX_MESSAGES:
        # 서버가 며칠 멈췄다 돌아온 경우 등. 단톡방을 도배하지 않도록 앞부분만 보내고 나머지는
        # 대시보드로 안내한 뒤 알림 완료로 처리한다.
        rest = messages[MAX_MESSAGES:]
        left = sum(len(batch) for _, batch in rest)
        last_text, last_batch = messages[MAX_MESSAGES - 1]
        last_batch = last_batch + [p for _, batch in rest for p in batch]
        messages = messages[:MAX_MESSAGES - 1] + [
            (last_text + f"\n외 {left}건은 대시보드에서 볼 수 있습니다.", last_batch)
        ]
    for i, (text, batch) in enumerate(messages, 1):
        if args.dry_run:
            print(f"----- 메시지 {i}/{len(messages)} ({len(text)}자, {len(batch)}건) -----\n{text}\n")
            continue
        send(text)
        # 한 통 보낼 때마다 기록해서, 중간에 실패해도 이미 보낸 공고가 다시 나가지 않게 한다.
        for it, _ in batch:
            notified[f"{it.get('bidNtceNo')}-{it.get('bidNtceOrd') or '000'}"] = stamp
        save_state(notified)
    print(f"새 공고 {len(picked)}건, 메시지 {len(messages)}통" + (" (dry-run)" if args.dry_run else " 전송"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # cron 로그에 한 줄로 남기고 수집 결과에는 영향 없게
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(5)
