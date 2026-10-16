(() => {
  const DATA_URL = "./data/index.json";
  const PAGE = 150;              // 한 번에 그리는 행 수("더 보기"로 늘림)
  const SOON_MS = 7 * 864e5;     // 마감 임박 = 7일 이내 (build_index.py 와 같은 기준)
  const NEW_MS = 2 * 864e5;      // 새 공고 = 공고일시 48시간 이내
  const STALE_MS = 30 * 36e5;    // 마지막 수집이 30시간 넘으면 경고
  const STARS_KEY = "nara:stars";
  const VIEWS = ["soon", "open", "closed", "starred"];
  const SORTS = ["deadline", "posted", "budget"];
  const WEEKDAY = "일월화수목금토";

  const state = { view: "soon", kw: "", q: "", sort: "deadline", onlyNew: false, limit: PAGE };
  let items = [];
  let data = null;
  let stars = loadStars();

  const $ = (s) => document.querySelector(s);

  // ---------- 저장(관심) ----------
  function loadStars() {
    try { return new Set(JSON.parse(localStorage.getItem(STARS_KEY) || "[]")); }
    catch (e) { return new Set(); }
  }
  function saveStars() {
    try { localStorage.setItem(STARS_KEY, JSON.stringify([...stars])); } catch (e) { /* 사생활 보호 모드 등 */ }
  }

  // ---------- 형식 ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const pad = (n) => String(n).padStart(2, "0");
  const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const fmtDay = (t) => { const d = new Date(t); return `${d.getMonth() + 1}.${pad(d.getDate())} (${WEEKDAY[d.getDay()]})`; };
  const fmtDT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function toNum(s) {
    const n = Number(String(s == null ? "" : s).replace(/[^\d.]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function fmtWon(n) {
    if (!n) return "";
    if (n >= 1e8) return `${Number((n / 1e8).toFixed(n >= 1e10 ? 0 : 1))}억`;
    if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}만`;
    return `${n.toLocaleString()}원`;
  }
  function ago(ms) {
    const h = ms / 36e5;
    if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))}분 전`;
    if (h < 48) return `${Math.round(h)}시간 전`;
    return `${Math.round(h / 24)}일 전`;
  }

  // ---------- 데이터 ----------
  function enrich(raw) {
    const asign = toNum(raw.asignBdgtAmt);
    const presmpt = toNum(raw.presmptPrce);
    return Object.assign({}, raw, {
      matched_keywords: Array.isArray(raw.matched_keywords) ? raw.matched_keywords : [],
      close: raw._bidClseDt_iso ? Date.parse(raw._bidClseDt_iso) : NaN,
      posted: raw._bidNtceDt_iso ? Date.parse(raw._bidNtceDt_iso) : NaN,
      budget: asign || presmpt,
      budgetLabel: asign ? "배정예산" : presmpt ? "추정가격" : "",
      cancelled: raw.ntceKindNm === "취소공고",
      hay: [raw.bidNtceNm, raw.ntceInsttNm, raw.dminsttNm, raw.bidNtceNo].join(" ").toLowerCase(),
    });
  }

  // 분류는 열람 시각 기준(index.json 의 버킷은 수집 시각 기준이라 쓰지 않는다).
  function bucketOf(it, now) {
    if (it.cancelled) return "closed";
    if (isNaN(it.close)) return "open";
    if (it.close < now) return "closed";
    return it.close - now <= SOON_MS ? "soon" : "open";
  }
  function inView(it, view, now) {
    return view === "starred" ? stars.has(it.bidNtceNo) : bucketOf(it, now) === view;
  }

  function visible(now) {
    const q = state.q.trim().toLowerCase();
    return items.filter((it) =>
      inView(it, state.view, now) &&
      (!state.kw || it.matched_keywords.includes(state.kw)) &&
      (!q || it.hay.includes(q)) &&
      (!state.onlyNew || now - it.posted <= NEW_MS));
  }

  function sortItems(list) {
    const byClose = (a, b) => (isNaN(a.close) ? Infinity : a.close) - (isNaN(b.close) ? Infinity : b.close);
    const cmp = {
      deadline: state.view === "closed" ? (a, b) => byClose(b, a) : byClose,
      posted: (a, b) => (b.posted || 0) - (a.posted || 0),
      budget: (a, b) => b.budget - a.budget,
    }[state.sort];
    return list.sort((a, b) => cmp(a, b) || 0);
  }

  // ---------- 그리기 ----------
  function highlight(title, kws) {
    if (!kws.length) return esc(title);
    const pattern = kws.slice().sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(pattern, "g");
    let out = "";
    let last = 0;
    title.replace(re, (m, offset) => {
      out += esc(title.slice(last, offset)) + `<mark>${esc(m)}</mark>`;
      last = offset + m.length;
      return m;
    });
    return out + esc(title.slice(last));
  }

  function dueHtml(it, now) {
    if (it.cancelled) return `<div class="due past"><span class="due-main">취소</span></div>`;
    if (isNaN(it.close)) return `<div class="due"><span class="due-main">미상</span><span class="due-sub">마감일 없음</span></div>`;
    const ms = it.close - now;
    let main;
    let cls = "";
    if (ms < 0) { main = "마감"; cls = "past"; }
    else if (ms < 36e5) { main = `${Math.max(1, Math.round(ms / 6e4))}분`; cls = "urgent"; }
    else if (ms < 864e5) { main = `${Math.floor(ms / 36e5)}시간`; cls = "urgent"; }
    else {
      const days = Math.round((dayStart(it.close) - dayStart(now)) / 864e5);
      main = `D-${days}`;
      cls = days <= 3 ? "soon" : "";
    }
    return `<div class="due ${cls}"><span class="due-main">${main}</span><span class="due-sub">${fmtDT(it.close)}</span></div>`;
  }

  function rowHtml(it, now) {
    const badges = [];
    if (now - it.posted <= NEW_MS) badges.push(`<span class="badge new">새 공고</span>`);
    if (it.ntceKindNm && it.ntceKindNm !== "등록공고") {
      badges.push(`<span class="badge${it.cancelled ? " cancel" : ""}">${esc(it.ntceKindNm)}</span>`);
    }
    const title = highlight(it.bidNtceNm || "(제목 없음)", it.matched_keywords);
    const titleHtml = it.bidNtceDtlUrl
      ? `<a href="${esc(it.bidNtceDtlUrl)}" target="_blank" rel="noopener">${title}</a>`
      : title;
    const meta = [];
    if (it.ntceInsttNm) meta.push(`<li><b>${esc(it.ntceInsttNm)}</b></li>`);
    if (it.dminsttNm && it.dminsttNm !== it.ntceInsttNm) meta.push(`<li>수요 ${esc(it.dminsttNm)}</li>`);
    const method = [it.bidMethdNm, it.cntrctCnclsMthdNm].filter(Boolean).join(", ");
    if (method) meta.push(`<li>${esc(method)}</li>`);
    if (!isNaN(it.posted)) meta.push(`<li>공고 ${fmtDT(it.posted)}</li>`);
    meta.push(`<li>${esc(it.bidNtceNo)}-${esc(it.bidNtceOrd || "000")}</li>`);
    const starred = stars.has(it.bidNtceNo);
    const closed = bucketOf(it, now) === "closed";
    return `
      <article class="row${closed ? " is-closed" : ""}">
        ${dueHtml(it, now)}
        <div>
          <h2 class="title">${titleHtml}${badges.length ? `<span class="badges">${badges.join("")}</span>` : ""}</h2>
          <ul class="meta">${meta.join("")}</ul>
        </div>
        <div class="side">
          <div class="budget">${it.budget ? `${fmtWon(it.budget)}<small>${it.budgetLabel}</small>` : `<small>예산 미공개</small>`}</div>
          <button class="star" type="button" data-star="${esc(it.bidNtceNo)}" aria-pressed="${starred}"
            aria-label="${starred ? "관심 해제" : "관심 추가"}: ${esc(it.bidNtceNm)}">${starred ? "★" : "☆"}</button>
        </div>
      </article>`;
  }

  function groupLabel(it, now) {
    if (it.cancelled) return "취소된 공고";
    if (isNaN(it.close)) return "마감일 미상";
    const diff = Math.round((dayStart(it.close) - dayStart(now)) / 864e5);
    const prefix = diff === 0 ? "오늘 " : diff === 1 ? "내일 " : diff === -1 ? "어제 " : "";
    return `${prefix}${fmtDay(it.close)} 마감`;
  }

  function renderCounts(now) {
    const counts = { soon: 0, open: 0, closed: 0 };
    for (const it of items) counts[bucketOf(it, now)]++;
    $("#count-soon").textContent = counts.soon;
    $("#count-open").textContent = counts.open;
    $("#count-closed").textContent = counts.closed;
    $("#count-starred").textContent = items.filter((it) => stars.has(it.bidNtceNo)).length;
    document.querySelectorAll(".view").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === state.view)));
  }

  function renderChips(now) {
    const inThisView = items.filter((it) => inView(it, state.view, now));
    const counts = new Map();
    for (const it of inThisView) for (const k of it.matched_keywords) counts.set(k, (counts.get(k) || 0) + 1);
    const order = ((data.config && data.config.keywords) || []).filter((k) => counts.has(k) || k === state.kw);
    const chip = (kw, label, n) =>
      `<button class="chip" type="button" data-kw="${esc(kw)}" aria-pressed="${state.kw === kw}">${esc(label)} <span class="n">${n}</span></button>`;
    $("#chips").innerHTML = [chip("", "전체", inThisView.length)]
      .concat(order.map((k) => chip(k, k, counts.get(k) || 0))).join("");
  }

  function render() {
    if (!data) return;
    const now = Date.now();
    renderCounts(now);
    renderChips(now);
    if (document.activeElement !== $("#search")) $("#search").value = state.q;
    $("#sort").value = state.sort;
    $("#only-new").checked = state.onlyNew;
    $("#reset").hidden = !(state.kw || state.q || state.onlyNew);

    const list = sortItems(visible(now));
    $("#result-count").textContent = `${list.length.toLocaleString()}건`;
    const listEl = $("#list");
    listEl.setAttribute("aria-busy", "false");

    if (!list.length) {
      listEl.innerHTML = state.view === "starred" && !stars.size
        ? `<div class="empty"><strong>관심 공고가 없습니다</strong>목록에서 ☆ 버튼을 누르면 여기에 모입니다. 이 브라우저에만 저장됩니다.</div>`
        : `<div class="empty"><strong>조건에 맞는 공고가 없습니다</strong>검색어나 키워드 필터를 바꿔 보세요.</div>`;
      $("#more").hidden = true;
      return;
    }

    const shown = list.slice(0, state.limit);
    const grouped = state.sort === "deadline";
    const groupSize = new Map();
    if (grouped) for (const x of list) { const g = groupLabel(x, now); groupSize.set(g, (groupSize.get(g) || 0) + 1); }
    let html = "";
    let lastGroup = null;
    for (const it of shown) {
      if (grouped) {
        const g = groupLabel(it, now);
        if (g !== lastGroup) {
          html += `<h3 class="group">${esc(g)}<span class="n">${groupSize.get(g)}건</span></h3>`;
          lastGroup = g;
        }
      }
      html += rowHtml(it, now);
    }
    listEl.innerHTML = html;
    const rest = list.length - shown.length;
    $("#more").hidden = rest <= 0;
    $("#more").textContent = `더 보기 (${rest.toLocaleString()}건 남음)`;
  }

  function renderMeta() {
    const gen = Date.parse(data.generated_at);
    const age = Date.now() - gen;
    $("#updated").textContent = isNaN(gen) ? "" : `마지막 수집 ${fmtDT(gen)} (${ago(age)})`;
    const stale = $("#stale");
    stale.hidden = !(age > STALE_MS);
    stale.textContent = `마지막 수집이 ${ago(age)}입니다. 그 뒤에 올라온 공고는 아직 반영되지 않았습니다.`;
    const kws = (data.config && data.config.keywords) || [];
    $("#keywords").textContent = kws.length ? `키워드 ${kws.length}개: ${kws.join(", ")}` : "";
  }

  // ---------- URL 상태 (공유 가능한 주소) ----------
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.view = VIEWS.includes(p.get("view")) ? p.get("view") : "soon";
    state.sort = SORTS.includes(p.get("sort")) ? p.get("sort") : "deadline";
    state.kw = p.get("kw") || "";
    state.q = p.get("q") || "";
    state.onlyNew = p.get("new") === "1";
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.view !== "soon") p.set("view", state.view);
    if (state.sort !== "deadline") p.set("sort", state.sort);
    if (state.kw) p.set("kw", state.kw);
    if (state.q) p.set("q", state.q);
    if (state.onlyNew) p.set("new", "1");
    const s = p.toString();
    history.replaceState(null, "", s ? `#${s}` : location.pathname + location.search);
  }
  function update(patch) {
    Object.assign(state, patch, { limit: PAGE });
    writeHash();
    render();
  }

  // ---------- CSV ----------
  function downloadCsv() {
    const list = sortItems(visible(Date.now()));
    const cols = [
      ["공고번호", (it) => it.bidNtceNo], ["차수", (it) => it.bidNtceOrd], ["공고명", (it) => it.bidNtceNm],
      ["공고종류", (it) => it.ntceKindNm], ["공고기관", (it) => it.ntceInsttNm], ["수요기관", (it) => it.dminsttNm],
      ["입찰방식", (it) => it.bidMethdNm], ["계약방법", (it) => it.cntrctCnclsMthdNm],
      ["공고일시", (it) => it.bidNtceDt], ["마감일시", (it) => it.bidClseDt], ["개찰일시", (it) => it.opengDt],
      ["예산(원)", (it) => it.budget || ""], ["예산구분", (it) => it.budgetLabel],
      ["담당자", (it) => it.ntceInsttOfclNm], ["전화", (it) => it.ntceInsttOfclTelNo],
      ["키워드", (it) => it.matched_keywords.join(" ")], ["링크", (it) => it.bidNtceDtlUrl],
    ];
    const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => cell(c[0])).join(",")]
      .concat(list.map((it) => cols.map((c) => cell(c[1](it))).join(",")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const d = new Date();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `나라장터-${state.view}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 이벤트 ----------
  function bindEvents() {
    document.querySelectorAll(".view").forEach((b) => b.addEventListener("click", () => update({ view: b.dataset.view })));
    $("#chips").addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (c) update({ kw: c.dataset.kw });
    });
    let t = null;
    $("#search").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => update({ q: e.target.value }), 150);
    });
    $("#sort").addEventListener("change", (e) => update({ sort: e.target.value }));
    $("#only-new").addEventListener("change", (e) => update({ onlyNew: e.target.checked }));
    $("#reset").addEventListener("click", () => { $("#search").value = ""; update({ kw: "", q: "", onlyNew: false }); });
    $("#csv").addEventListener("click", downloadCsv);
    $("#more").addEventListener("click", () => { state.limit += PAGE; render(); });
    $("#list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-star]");
      if (!b) return;
      const no = b.dataset.star;
      if (stars.has(no)) stars.delete(no); else stars.add(no);
      saveStars();
      render();
    });
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); }
      if (e.key === "Escape" && document.activeElement === $("#search") && state.q) {
        $("#search").value = "";
        update({ q: "" });
      }
    });
    window.addEventListener("hashchange", () => { readHash(); render(); });
  }

  async function load() {
    try {
      const r = await fetch(DATA_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
      items = [].concat(data.closing_soon || [], data.open || [], data.closed || []).map(enrich);
      renderMeta();
      render();
    } catch (e) {
      $("#list").setAttribute("aria-busy", "false");
      $("#list").innerHTML = `<div class="empty"><strong>데이터를 불러오지 못했습니다</strong>${esc(String(e))}<br><button class="btn" type="button" onclick="location.reload()">다시 시도</button></div>`;
    }
  }

  readHash();
  bindEvents();
  load();
})();
