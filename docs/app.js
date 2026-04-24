(() => {
  const DATA_URL = "./data/index.json";

  const state = {
    tab: "soon",
    query: "",
    data: null,
  };

  const $ = (sel) => document.querySelector(sel);

  function fmtKoreanDateTime(iso) {
    if (!iso) return "-";
    try {
      const d = new Date(iso);
      if (isNaN(d)) return iso;
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${y}-${mo}-${da} ${hh}:${mm}`;
    } catch {
      return iso;
    }
  }

  function fmtRemaining(hours) {
    if (hours === null || hours === undefined) return { text: "마감일 미상", cls: "expired" };
    if (hours < 0) return { text: "마감됨", cls: "expired" };
    if (hours < 1) return { text: `${Math.round(hours * 60)}분 남음`, cls: "danger" };
    if (hours < 24) return { text: `${hours.toFixed(1)}시간 남음`, cls: "danger" };
    const days = hours / 24;
    if (days < 3) return { text: `${days.toFixed(1)}일 남음`, cls: "warn" };
    return { text: `${days.toFixed(0)}일 남음`, cls: "ok" };
  }

  function fmtKrw(s) {
    if (!s) return "";
    const n = Number(String(s).replace(/[^\d.-]/g, ""));
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(0)}만`;
    return n.toLocaleString();
  }

  function buildBidUrl(item) {
    if (item.bidNtceDtlUrl) return item.bidNtceDtlUrl;
    if (item.bidNtceNo) {
      return `https://www.g2b.go.kr:8101/ep/invitation/publish/bidInfoDtl.do?bidno=${encodeURIComponent(item.bidNtceNo)}&bidseq=${encodeURIComponent(item.bidNtceOrd || "")}`;
    }
    return "#";
  }

  function cardHtml(item) {
    const hours = item._hours_remaining;
    const remaining = fmtRemaining(hours);
    const url = buildBidUrl(item);
    const title = item.bidNtceNm || "(제목 없음)";
    const org = item.ntceInsttNm || item.dminsttNm || "";
    const demander = item.dminsttNm && item.dminsttNm !== item.ntceInsttNm ? item.dminsttNm : "";
    const budget = fmtKrw(item.asignBdgtAmt) || fmtKrw(item.presmptPrce);
    const method = [item.bidMethdNm, item.cntrctCnclsMthdNm].filter(Boolean).join(" / ");
    const kind = item.ntceKindNm && item.ntceKindNm !== "일반" ? item.ntceKindNm : "";

    let cardCls = "card";
    if (remaining.cls === "danger" || remaining.cls === "warn") cardCls += " soon";
    if (remaining.cls === "expired" && hours !== null && hours < 0) cardCls += " overdue";

    return `
      <article class="${cardCls}">
        <h3 class="card-title"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(title)}</a></h3>
        <div class="card-meta">
          ${kind ? `<span class="tag">${escapeHtml(kind)}</span>` : ""}
          ${org ? `<span><strong>공고기관</strong> ${escapeHtml(org)}</span>` : ""}
          ${demander ? `<span><strong>수요기관</strong> ${escapeHtml(demander)}</span>` : ""}
          ${method ? `<span><strong>입찰방식</strong> ${escapeHtml(method)}</span>` : ""}
          <span><strong>공고번호</strong> ${escapeHtml(item.bidNtceNo || "")}${item.bidNtceOrd ? "-" + escapeHtml(item.bidNtceOrd) : ""}</span>
        </div>
        <div class="card-bottom">
          <span class="remaining ${remaining.cls}">${remaining.text}</span>
          <span class="budget">
            ${item.bidClseDt ? `마감 <strong>${escapeHtml(item.bidClseDt)}</strong>` : ""}
            ${budget ? ` · 예산 <strong>${budget}원</strong>` : ""}
          </span>
        </div>
      </article>
    `;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function render() {
    const listEl = $("#list");
    if (!state.data) {
      listEl.innerHTML = '<p class="empty">데이터를 불러오는 중…</p>';
      return;
    }

    const bucket = state.data[state.tab] || [];
    const q = state.query.trim().toLowerCase();
    const filtered = q
      ? bucket.filter((it) => {
          const hay = [it.bidNtceNm, it.ntceInsttNm, it.dminsttNm, it.bsnsDivNm]
            .filter(Boolean).join(" ").toLowerCase();
          return hay.includes(q);
        })
      : bucket;

    if (filtered.length === 0) {
      const msg = q
        ? `"${escapeHtml(state.query)}" 에 매치되는 공고가 없습니다.`
        : "해당하는 공고가 없습니다.";
      listEl.innerHTML = `<p class="empty">${msg}</p>`;
      return;
    }

    listEl.innerHTML = filtered.map(cardHtml).join("");
  }

  function updateMeta() {
    const d = state.data;
    if (!d) return;
    $("#generated-at").textContent = `갱신: ${fmtKoreanDateTime(d.generated_at)}`;
    const kws = (d.config?.keywords || []).join(", ") || "없음";
    const mode = d.config?.match_mode === "all" ? "(모두 포함)" : "(하나라도 포함)";
    $("#keywords").textContent = `키워드 ${mode}: ${kws}`;
    $("#stat-soon").textContent = d.stats?.closing_soon ?? "-";
    $("#stat-open").textContent = d.stats?.open ?? "-";
    $("#stat-closed").textContent = d.stats?.closed ?? "-";
    $("#stat-total").textContent = d.stats?.total ?? "-";
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.tab = btn.dataset.tab;
        render();
      });
    });
    $("#search").addEventListener("input", (e) => {
      state.query = e.target.value;
      render();
    });
  }

  async function load() {
    try {
      const r = await fetch(DATA_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.data = await r.json();
      updateMeta();
      render();
    } catch (e) {
      $("#list").innerHTML = `<p class="empty">데이터를 불러오지 못했습니다: ${escapeHtml(String(e))}<br>워크플로우가 한 번 이상 실행되어야 <code>docs/data/index.json</code>이 생성됩니다.</p>`;
    }
  }

  bindEvents();
  load();
})();
