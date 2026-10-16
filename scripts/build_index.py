"""
data/*.json 에 쌓인 일별 수집 결과를 하나의 대시보드용 인덱스로 합친다.

산출물:
    docs/data/index.json
        {
          "generated_at": ...,
          "config": {...},
          "stats": {"open": N, "closing_soon": N, "closed": N, "total": N},
          "open": [...],            # 아직 마감 안 된 공고 (마감 임박순)
          "closing_soon": [...],    # 24시간 이내 마감
          "closed": [...]           # 이미 마감 (최근순)
        }

config.keep_days 보다 오래된 data/ 파일은 스킵한다.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
    KST = ZoneInfo("Asia/Seoul")
except Exception:
    KST = timezone(timedelta(hours=9))

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
DATA_DIR = ROOT / "data"
# 학교 서버에서는 NARA_INDEX_OUT 으로 웹 디렉터리(/var/www/html/nara/data/index.json)에 바로 쓴다.
OUT_PATH = Path(os.environ.get("NARA_INDEX_OUT") or ROOT / "docs" / "data" / "index.json")


def parse_bid_dt(s: str) -> Optional[datetime]:
    """나라장터 API의 날짜 문자열을 KST datetime으로 파싱.

    관측된 포맷: '2026-04-30 18:00:00', '202604301800', '2026-04-30 18:00'
    """
    if not s:
        return None
    s = s.strip()
    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y%m%d%H%M%S",
        "%Y%m%d%H%M",
        "%Y-%m-%d",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=KST)
        except ValueError:
            continue
    return None


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def iter_daily_files(keep_days: int) -> List[Path]:
    if not DATA_DIR.exists():
        return []
    cutoff = (datetime.now(tz=KST) - timedelta(days=keep_days)).date()
    kept: List[Path] = []
    for p in sorted(DATA_DIR.glob("*.json")):
        try:
            file_date = datetime.strptime(p.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if file_date >= cutoff:
            kept.append(p)
    return kept


def match_keywords(
    title: str, keywords: List[str], case_sensitive: bool, ignore_phrases: List[str] = (),
) -> List[str]:
    """제목에 매치되는 모든 키워드를 원본 순서대로 반환.

    ignore_phrases 는 키워드를 우연히 품은 다른 단어(리모델링⊃모델링, 전망대⊃전망 등)라서
    매칭 전에 제목에서 지운다. 제목에 진짜 키워드가 따로 있으면 그건 그대로 잡힌다.
    """
    if not title or not keywords:
        return []
    haystack = title if case_sensitive else title.lower()
    for phrase in ignore_phrases:
        haystack = haystack.replace(phrase if case_sensitive else phrase.lower(), " ")
    return [kw for kw in keywords if (kw if case_sensitive else kw.lower()) in haystack]


# 대시보드가 쓰는 필드만 남긴다(index.json 크기 절반 이하로).
KEEP_FIELDS = (
    "bidNtceNo", "bidNtceOrd", "bidNtceNm", "ntceKindNm", "ntceInsttNm", "dminsttNm",
    "bidMethdNm", "cntrctCnclsMthdNm", "bidNtceDt", "bidClseDt", "opengDt",
    "asignBdgtAmt", "presmptPrce", "bidNtceDtlUrl", "ntceInsttOfclNm", "ntceInsttOfclTelNo",
)


def merge_all(
    files: List[Path], keywords: List[str], case_sensitive: bool, ignore_phrases: List[str],
) -> List[dict]:
    """일별 파일을 합친다. 같은 공고번호의 변경·재공고(차수)는 가장 최신 차수 하나만 남긴다."""
    merged: Dict[str, dict] = {}
    for path in files:
        try:
            with path.open(encoding="utf-8") as f:
                payload = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        collected_at = payload.get("date") or path.stem
        for item in payload.get("items", []):
            key = str(item.get("bidNtceNo") or "")
            prev = merged.get(key)
            first_seen = min(prev["first_seen_date"], collected_at) if prev else collected_at
            if prev and str(prev.get("bidNtceOrd") or "") > str(item.get("bidNtceOrd") or ""):
                prev["first_seen_date"] = first_seen  # 더 오래된 차수가 늦게 들어온 경우
                continue
            merged_item = {k: item[k] for k in KEEP_FIELDS if item.get(k) not in (None, "")}
            merged_item["first_seen_date"] = first_seen
            merged_item["matched_keywords"] = match_keywords(
                str(item.get("bidNtceNm") or ""), keywords, case_sensitive, ignore_phrases,
            )
            merged[key] = merged_item
    return list(merged.values())


SOON_THRESHOLD_DAYS = 7


def classify(items: List[dict]) -> Tuple[List[dict], List[dict], List[dict]]:
    now = datetime.now(tz=KST)
    soon_cutoff = now + timedelta(days=SOON_THRESHOLD_DAYS)

    open_list: List[dict] = []
    soon_list: List[dict] = []
    closed_list: List[dict] = []

    for it in items:
        close_dt = parse_bid_dt(it.get("bidClseDt", ""))
        enriched = dict(it)
        ntce_dt = parse_bid_dt(it.get("bidNtceDt", ""))
        enriched["_bidNtceDt_iso"] = ntce_dt.isoformat() if ntce_dt else ""
        if close_dt is not None:
            enriched["_bidClseDt_iso"] = close_dt.isoformat()
            remaining = close_dt - now
            enriched["_hours_remaining"] = round(remaining.total_seconds() / 3600, 1)
        else:
            enriched["_bidClseDt_iso"] = ""
            enriched["_hours_remaining"] = None

        if close_dt is None:
            open_list.append(enriched)
        elif close_dt < now:
            closed_list.append(enriched)
        elif close_dt <= soon_cutoff:
            soon_list.append(enriched)
        else:
            open_list.append(enriched)

    def key_open(x: dict) -> float:
        h = x.get("_hours_remaining")
        return h if h is not None else float("inf")

    open_list.sort(key=key_open)
    soon_list.sort(key=key_open)
    closed_list.sort(key=lambda x: x.get("_bidClseDt_iso") or "", reverse=True)
    return open_list, soon_list, closed_list


def main() -> int:
    cfg = load_config()
    keep_days = int(cfg.get("keep_days", 60))
    keywords = [k.strip() for k in cfg.get("keywords", []) if k and k.strip()]
    case_sensitive = bool(cfg.get("case_sensitive", False))
    ignore_phrases = [p for p in cfg.get("ignore_phrases", []) if p]
    files = iter_daily_files(keep_days)
    print(f"사용할 일별 파일: {len(files)}개")

    merged = merge_all(files, keywords, case_sensitive, ignore_phrases)
    print(f"고유 공고 총합(최신 차수만): {len(merged)}건")
    if keywords:
        before = len(merged)
        merged = [it for it in merged if it["matched_keywords"]]
        print(f"키워드 오탐 제외: {before - len(merged)}건 → {len(merged)}건")

    open_list, soon_list, closed_list = classify(merged)

    payload = {
        "generated_at": datetime.now(tz=KST).isoformat(timespec="seconds"),
        "config": {
            "keywords": cfg.get("keywords", []),
            "exclude_keywords": cfg.get("exclude_keywords", []),
            "match_mode": cfg.get("match_mode", "any"),
            "keep_days": keep_days,
        },
        "stats": {
            "open": len(open_list),
            "closing_soon": len(soon_list),
            "closed": len(closed_list),
            "total": len(merged),
        },
        "closing_soon": soon_list,
        "open": open_list,
        "closed": closed_list,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 웹서버가 바로 서빙하는 파일이므로 임시 파일에 다 쓴 뒤 한 번에 바꿔치기한다.
    tmp_path = OUT_PATH.with_name(OUT_PATH.name + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(str(tmp_path), str(OUT_PATH))
    print(f"저장: {OUT_PATH}")
    print(f"  open={len(open_list)}  closing_soon={len(soon_list)}  closed={len(closed_list)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
