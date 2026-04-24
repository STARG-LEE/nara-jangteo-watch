# 나라장터 용역 공고 트래커

공공데이터포털의 **조달청\_나라장터 입찰공고정보서비스** API를 이용해
관심 키워드가 포함된 **용역(서비스) 입찰공고**를 매일 자동으로 수집하고,
마감일이 남은 공고를 GitHub Pages 대시보드에서 볼 수 있게 정리하는 작은 자동화입니다.

## 구성

```
├── config.json                 # 키워드/조회옵션 (여기만 수정하면 됨)
├── scripts/
│   ├── crawl.py                # API 호출 + 키워드 필터 → data/YYYY-MM-DD.json
│   └── build_index.py          # data/*.json 병합 → docs/data/index.json
├── data/                       # 날짜별 수집 원본 (자동 생성, 자동 커밋)
├── docs/                       # GitHub Pages 대시보드 (HTML/CSS/JS)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data/index.json         # 대시보드가 읽는 병합 데이터
├── .github/workflows/crawl.yml # 매일 KST 08:30 자동 실행
└── requirements.txt            # requests 만 필요
```

## 동작 개요

1. **매일 아침 08:30 KST** GitHub Actions가 [`crawl.py`](scripts/crawl.py)를 실행합니다.
2. `config.json`의 `keywords` 에 있는 각 단어로
   `getBidPblancListInfoServcPPSSrch` 오퍼레이션을 호출하여 공고명 부분검색을 수행합니다.
3. 결과를 중복 제거(`bidNtceNo`+`bidNtceOrd` 기준)한 뒤
   `exclude_keywords` 필터를 적용하고 `data/YYYY-MM-DD.json`에 저장합니다.
4. [`build_index.py`](scripts/build_index.py)가 최근 `keep_days`일치 `data/*.json`을 합쳐
   마감일 기준으로 **마감임박(24시간 이내) / 진행중 / 마감됨** 3개 버킷으로 분류해
   `docs/data/index.json`으로 씁니다.
5. 변경이 있으면 자동 커밋 후 GitHub Pages로 배포됩니다.

## 키워드 변경 방법

[`config.json`](config.json) 을 수정하고 push 하면 다음 크롤부터 반영됩니다.

```json
{
  "keywords": ["AI", "인공지능", "머신러닝", "LLM"],
  "exclude_keywords": ["교육", "연수"],
  "lookback_days": 1,
  "keep_days": 60,
  "match_mode": "any",
  "case_sensitive": false
}
```

- `match_mode: "any"` — 키워드 중 하나라도 공고명에 있으면 수집 (권장, 빠름)
- `match_mode: "all"` — 모든 키워드가 공고명에 들어가 있어야 수집 (매우 좁음)
- `exclude_keywords` — 공고명에 포함되면 제외할 단어
- `lookback_days` — 매 실행 시 최근 며칠치를 조회할지 (기본 1)
- `keep_days` — 대시보드에서 보여줄 데이터 보관 기간 (기본 60일)

## 초기 설정

### 1. 공공데이터포털 API 키 발급

1. [data.go.kr](https://www.data.go.kr) 회원가입 / 로그인
2. 상단 검색창에 **"나라장터 입찰공고정보서비스"**
3. [조달청\_나라장터 입찰공고정보서비스](https://www.data.go.kr/data/15129394/openapi.do) 상세 페이지로 이동
4. 우측 상단 **[활용신청]** 클릭 → 사용 목적 기재 → 신청
5. **마이페이지 → 오픈API → 활용신청 현황** 에서 상태가 "승인"이 되는지 확인
   - 대부분 자동 승인되지만 최대 2시간 정도 지연될 수 있습니다.
6. 승인된 후 **"일반 인증키(Decoding)"** 값을 복사해둡니다.

### 2. GitHub Secrets 등록

레포 페이지 → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `NARA_SERVICE_KEY`
- Secret: 위에서 복사한 **Decoding** 키 (공백/개행 없이 붙여넣기)

### 3. GitHub Pages 활성화

레포 **Settings → Pages** → Source를 **GitHub Actions**로 설정
(워크플로우가 한 번 성공적으로 실행되면 `https://<사용자명>.github.io/<레포명>/` 에서 확인할 수 있습니다.)

### 4. 수동 실행으로 첫 데이터 생성

**Actions 탭 → "나라장터 용역 공고 수집" → Run workflow** 로 수동 실행

## 로컬에서 돌려보기

```bash
# .env 파일 생성 (레포에 커밋되지 않음)
echo "NARA_SERVICE_KEY=복사한_Decoding_키" > .env

# 의존성 설치
pip install -r requirements.txt

# 드라이런: 저장하지 않고 결과만 출력
python scripts/crawl.py --dry-run --days 3

# 실제 실행 + 인덱스 빌드
python scripts/crawl.py
python scripts/build_index.py

# 대시보드 로컬 확인
python -m http.server 8080 --directory docs
# → http://localhost:8080
```

## 트러블슈팅

### `401 Unauthorized`

API 키는 형식상 문제없지만 **해당 서비스에 대한 활용신청이 아직 승인되지 않았거나 반영 전**일 때 나타납니다.

1. data.go.kr → 마이페이지 → 오픈API → 활용신청 현황에서 **"조달청\_나라장터 입찰공고정보서비스"** 가 **승인** 상태인지 확인
2. 승인 직후면 최대 2시간까지 기다리기
3. 승인/대기 둘 다 아니면 해당 서비스에 활용신청이 안 되어 있는 것 — 다시 활용신청

### `Unexpected errors` (500)

구 엔드포인트(`/1230000/BidPublicInfoService`, `/ad/` 미포함)에 접근했을 때 나옵니다.
이 프로젝트는 이미 최신 `/ad/` 엔드포인트를 사용하므로 `config.json`을 변경하지 않았다면 발생하지 않습니다.

### API 응답은 오는데 공고가 0건

- 키워드가 너무 좁은 경우가 많습니다. `match_mode: "any"`로 두고 비슷한 단어를 여러 개 넣는 게 유리합니다.
- 최근 공고가 없는 키워드일 수 있습니다. 수동 실행에 `--days 7` 같이 주면 더 넓게 확인할 수 있어요.

## 데이터 출처

- [나라장터(국가종합전자조달)](https://www.g2b.go.kr)
- [조달청\_나라장터 입찰공고정보서비스 (data.go.kr)](https://www.data.go.kr/data/15129394/openapi.do)

이 페이지의 정보는 참고용이며 공식 공고 내용과 다를 수 있습니다.
입찰 전 반드시 나라장터 공식 공고를 확인하세요.
