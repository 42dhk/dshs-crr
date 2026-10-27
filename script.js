// 화면 전환 + subjects.js의 과목 데이터를 이용한 시간표 추천 로직입니다.

// 관심 분야 칩 → 과목 영역/키워드 매핑 (interestScore 계산에 사용)
const INTEREST_MAP = {
  "수학": { areas: ["수학"] },
  "물리": { areas: ["과학"], keyword: "물리" },
  "화학": { areas: ["과학", "AI융합"], keyword: "화학" },
  "생명과학": { areas: ["과학"], keyword: ["생명", "생물"] },
  "정보과학": { areas: ["정보과학", "AI융합"] },
  "인문사회": { areas: ["국어", "사회"] },
  "예술": { areas: ["예술교양"] },
  "체육": { areas: ["체육"] },
};

// 비선호 입력어 동의어(사용자가 줄여 쓰는 표현 보정용)
const DISLIKE_SYNONYMS = { "생물": "생명과학", "지학": "지구과학" };

function normalizeName(str) {
  return str.replace(/[ⅠⅡ]/g, "").replace(/\(.+?\)/g, "").replace(/\s+/g, "");
}

// 사용자가 입력한 비선호 단어와 과목명이 "유사한지" 판단.
// 정확 일치가 아니라, 서로 포함 관계면 유사한 과목으로 간주한다.
// 예: "화학" 입력 -> 일반화학Ⅰ, 일반화학실험Ⅰ, 화학토픽Ⅰ, 첨단화학 모두 매칭
function isSimilarToDislike(subjectName, dislikeTerms) {
  const norm = normalizeName(subjectName);
  return dislikeTerms.some((term) => {
    const mapped = DISLIKE_SYNONYMS[term] || term;
    const nt = normalizeName(mapped);
    return nt.length > 0 && (norm.includes(nt) || nt.includes(norm));
  });
}

function interestScore(subjectItem, interests) {
  let score = 0;
  interests.forEach((tag) => {
    const rule = INTEREST_MAP[tag];
    if (!rule || !rule.areas.includes(subjectItem.area)) return;
    if (!rule.keyword) {
      score += 2;
      return;
    }
    const keywords = Array.isArray(rule.keyword) ? rule.keyword : [rule.keyword];
    score += keywords.some((k) => subjectItem.name.includes(k)) ? 2 : 0.5;
  });
  return score;
}

// 과목 데이터: 기본은 subjects.js(대비용). Supabase에서 불러오기에 성공하면 DB 데이터로 교체한다.
let subjectData = SUBJECTS;
let subjectSource = "로컬(subjects.js)";

async function loadSubjectsFromDb() {
  try {
    const { data, error } = await supabaseClient.from("subjects").select("*").order("id");
    if (error || !data || data.length === 0) throw error || new Error("빈 결과");
    subjectData = data.map((r) => ({
      id: `db${r.id}`,
      name: r.name,
      credit: r.credit,
      ap: r.ap,
      area: r.area,
      grade: r.grade,
      term: r.term,
      group: r.grp,
      mandatory: r.mandatory,
      requires: r.requires,
    }));
    subjectSource = "Supabase DB";
  } catch (e) {
    console.warn("DB에서 과목을 불러오지 못해 로컬 데이터를 사용합니다:", e);
  }
}
const subjectsReady = loadSubjectsFromDb();

// 과목별 평균 별점: 과목명 -> { avg, count }. 불러오지 못하면 비어 있고, 추천에는 영향을 주지 않는다.
let subjectRatings = {};

async function loadRatings() {
  try {
    let rows;
    const view = await supabaseClient.from("subject_ratings").select("*");
    if (!view.error && view.data) {
      rows = view.data.map((r) => ({ name: r.subject_name, avg: Number(r.avg_rating), count: Number(r.review_count) }));
    } else {
      // 평균 뷰(supabase/ratings.sql)를 아직 안 만들었다면 reviews 테이블을 직접 읽어서 계산한다.
      const raw = await supabaseClient.from("reviews").select("subject_name,rating").limit(5000);
      if (raw.error) throw raw.error;
      const agg = {};
      raw.data.forEach((x) => {
        (agg[x.subject_name] ||= { sum: 0, count: 0 });
        agg[x.subject_name].sum += x.rating;
        agg[x.subject_name].count += 1;
      });
      rows = Object.entries(agg).map(([name, a]) => ({ name, avg: a.sum / a.count, count: a.count }));
    }
    subjectRatings = Object.fromEntries(rows.map((r) => [r.name, { avg: r.avg, count: r.count }]));
  } catch (e) {
    console.warn("별점을 불러오지 못했어요(추천은 별점 없이 계산합니다):", e);
  }
}
const ratingsReady = loadRatings();

// 별점 → 추천 가산점. 후기가 적으면 중립(3점)에 가깝게 끌어당겨서(가상의 3점 후기 3개를 섞는 방식)
// 후기 1~2개로 추천이 크게 흔들리지 않게 하고, 별점이 없으면 0(중립)이다.
const RATING_PRIOR = 3;
const RATING_PRIOR_WEIGHT = 3;
function ratingBonus(name) {
  const r = subjectRatings[name];
  if (!r || !r.count) return 0;
  const adjusted = (r.avg * r.count + RATING_PRIOR * RATING_PRIOR_WEIGHT) / (r.count + RATING_PRIOR_WEIGHT);
  return adjusted - RATING_PRIOR;
}

// 졸업 최소이수학점 기준에 등장하는 4개 전공 영역. buildPlan이 이 영역들을
// "담을 수 있었는데 0학점으로 비워뒀는지" 판정하는 데 사용한다.
const MAJOR_AREAS = ["과학", "정보과학", "수학", "AI융합"];

// 관심분야/비선호/AP 선호/선이수 과목을 반영해 학년·학기에 맞는 시간표 한 안을 구성한다.
// completed: 이전 학기에 이미 들은 과목명 Set (Ⅱ과목·실험과목의 선이수 조건 확인용)
// hourCap: 주당 시수 상한(학기별 27학점 이내 권장 기준).
// balanceMode: true면 졸업 기준에 들어가는 4개 영역(과학/정보과학/수학/AI융합) 중
//   이번 학기에 들을 수 있는 과목이 하나라도 있는 영역은 먼저 1개씩 담아 놓고 나머지를 채운다.
//   이렇게 만든 안이 졸업 기준과 어긋나면(담을 수 있었는데 안 담았으면) 그 안은 폐기 대상이 된다.
function buildPlan(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled, hourCap, balanceMode) {
  // 이미 들은 과목(이름 기준이라 다른 학기에 같은 과목이 열려도 함께 제외)과
  // 이번 학기에 폐강된 과목은 필수·택N·자유선택 구분 없이 후보에서 아예 뺀다.
  // 단, 들은 과목은 아래 isEligible에서 선이수 조건을 충족한 것으로 계속 인정한다.
  const pool = subjectData.filter(
    (s) => s.grade === grade && s.term === term && !completed.has(s.name) && !cancelled.has(s.name)
  );

  const scored = pool.map((s) => {
    const disliked = isSimilarToDislike(s.name, dislikeTerms);
    const alreadyTaken = false;
    return {
      ...s,
      hours: s.credit + (s.ap ? 1 : 0),
      disliked,
      alreadyTaken,
      score:
        interestScore(s, interests) - (disliked ? 3 : 0) + (apPreferred && s.ap ? 1 : 0) + ratingBonus(s.name),
    };
  });

  const picked = [];
  const pickedNames = new Set();
  let totalHours = 0;

  function add(s) {
    picked.push(s);
    pickedNames.add(s.name);
    totalHours += s.hours;
  }

  // 이미 이수한 과목은 다시 추천하지 않되, 선이수 조건을 확인할 때는 "이수한 과목"으로 취급한다.
  function isEligible(s) {
    if (!s.requires) return true;
    return completed.has(s.requires) || pickedNames.has(s.requires);
  }

  // 1) 필수 과목은 무조건 포함
  scored.filter((s) => s.mandatory).forEach(add);

  // 2) 택N 그룹: 그룹 안에서 점수 높은 순으로 N개 선택
  const groups = {};
  scored.filter((s) => s.group).forEach((s) => {
    (groups[s.group] ||= []).push(s);
  });
  Object.entries(groups).forEach(([groupId, options]) => {
    const pickCount = GROUP_PICK[groupId] || 1;
    [...options]
      .sort((a, b) => b.score - a.score)
      .slice(0, pickCount)
      .forEach(add);
  });

  // 3) 자유 선택 풀(과학/정보과학/수학/AI융합): 점수 높은 순으로 상한까지 채운다.
  // Ⅱ과목·실험과목은 "선이수 과목이 이미 완료되었거나 이번 학기에 함께 선택될 때만" 담을 수 있어서,
  // 전체 목록을 여러 번 훑으며(한 번 돌 때마다 새로 조건이 풀리는 과목이 없을 때까지) 채운다.
  const freePool = scored.filter((s) => !s.mandatory && !s.group && !s.alreadyTaken && !s.disliked);
  const freePoolByScore = [...freePool].sort((a, b) => b.score - a.score);

  function fillLoop(candidates) {
    let addedSomething = true;
    while (addedSomething) {
      addedSomething = false;
      for (const s of candidates) {
        if (pickedNames.has(s.name)) continue;
        if (!isEligible(s)) continue;
        if (totalHours + s.hours > hourCap) continue;
        add(s);
        addedSomething = true;
      }
    }
  }

  if (balanceMode) {
    // 영역별로 가장 시수가 적은(=담기 쉬운) 과목을 먼저 하나씩 확보해 편중을 막는다.
    MAJOR_AREAS.forEach((area) => {
      const cheapest = freePool
        .filter((s) => s.area === area)
        .sort((a, b) => a.hours - b.hours || b.score - a.score)[0];
      if (cheapest) fillLoop([cheapest]);
    });
  }

  fillLoop(freePoolByScore);

  const totalCredits = picked.reduce((sum, s) => sum + s.credit, 0);
  const areaCredits = {};
  picked.forEach((s) => {
    areaCredits[s.area] = (areaCredits[s.area] || 0) + s.credit;
  });

  // 이 학기에 자리가 있었는데도 0학점으로 남은 전공 영역을 찾는다(= 졸업 기준 위반 후보).
  const violations = MAJOR_AREAS.filter((area) => {
    if (areaCredits[area] > 0) return false;
    return freePool.some((s) => s.area === area && isEligible(s) && s.hours <= hourCap);
  });

  return {
    subjects: picked,
    totalHours,
    totalCredits,
    freeHours: 36 - totalHours,
    areaCredits,
    violations,
  };
}

// 여러 후보 시간표를 만들어 졸업 기준 위반이 없는 안만 골라낸다.
// 위반이 있는 안은 폐기하고, 남는 자리가 부족하면 균형 모드로 다시 만든 안으로 채운다.
function generatePlans(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled) {
  const attempts = [
    { label: "균형 잡힌 시간표", hourCap: 27, balanceMode: true },
    { label: "관심 집중형 시간표", hourCap: 27, balanceMode: false },
    { label: "여유로운 시간표", hourCap: 23, balanceMode: true },
    { label: "여유로운 시간표", hourCap: 20, balanceMode: true },
  ];

  const candidates = attempts.map((a) => ({
    ...a,
    plan: buildPlan(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled, a.hourCap, a.balanceMode),
  }));

  const seen = new Set();
  const accepted = [];
  for (const c of candidates) {
    const key = c.plan.subjects.map((s) => s.name).sort().join("|");
    if (seen.has(key)) continue;
    if (c.plan.violations.length > 0) continue; // 졸업 기준을 어기는 안은 폐기
    seen.add(key);
    accepted.push(c);
    if (accepted.length === 2) break;
  }

  // 위반 없는 안이 2개가 안 모이면(관심분야가 특정 영역에 너무 쏠려 있는 등),
  // 위반이 가장 적은 안이라도 골라서 채우고 왜 남았는지 알 수 있게 violations를 그대로 들고 있는다.
  if (accepted.length < 2) {
    const rest = candidates
      .filter((c) => !seen.has(c.plan.subjects.map((s) => s.name).sort().join("|")))
      .sort((a, b) => a.plan.violations.length - b.plan.violations.length);
    for (const c of rest) {
      const key = c.plan.subjects.map((s) => s.name).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(c);
      if (accepted.length === 2) break;
    }
  }

  return accepted;
}

function renderGraduationRef() {
  const rows = GRADUATION_MIN_CREDITS.map((rule) => {
    const optionsText = rule.options.map((opt) => opt.join("+")).join(" 또는 ");
    return `
      <div class="grad-row">
        <div class="grad-row__label">${rule.label}</div>
        <div class="grad-row__target">기준: ${optionsText}학점 (2학년1학기~3학년2학기 4개 학기 누적)</div>
      </div>
    `;
  }).join("");

  return `
    <div class="plan-card grad-card">
      <div class="plan-card__header">
        <span class="plan-card__title">졸업 최소이수학점 기준</span>
      </div>
      ${rows}
      <p class="grad-footnote">아래 추천안들은 이번 학기에 담을 수 있는 과목이 있는데도 특정 영역이 0학점으로 비지 않도록 걸러낸 안입니다.</p>
    </div>
  `;
}

function renderPlan(plan, label) {
  const byArea = {};
  plan.subjects.forEach((s) => {
    (byArea[s.area] ||= []).push(s);
  });

  const areaOrder = ["과학", "정보과학", "수학", "AI융합", "사회", "국어", "영어", "제2외국어", "체육", "예술교양"];
  const areaHtml = areaOrder
    .filter((area) => byArea[area])
    .map((area) => {
      const subjectsHtml = byArea[area]
        .map((s) => {
          const r = subjectRatings[s.name];
          const star = r ? `<span class="star-tag" title="후기 ${r.count}개">★${r.avg.toFixed(1)}</span>` : "";
          return `<span class="plan-subject${s.ap ? " is-ap" : ""}">${s.name}(${s.credit})${s.ap ? '<span class="ap-tag">AP</span>' : ""}${star}</span>`;
        })
        .join("");
      return `<div class="plan-area"><div class="plan-area__name">${area}</div><div class="plan-subject-list">${subjectsHtml}</div></div>`;
    })
    .join("");

  const violationHtml = plan.violations.length
    ? `<div class="grad-warn">⚠ ${plan.violations.join(", ")} 학점을 이번 학기에 하나도 못 담았어요 (선택 가능한 과목이 전부 비선호이거나 선이수 조건 때문일 수 있어요).</div>`
    : "";

  // 안 전체 평균 별점: 별점이 있는 과목들의 평균만 계산한다(없으면 "-").
  const rated = plan.subjects.filter((s) => subjectRatings[s.name]);
  const avgRating = rated.length
    ? (rated.reduce((sum, s) => sum + subjectRatings[s.name].avg, 0) / rated.length).toFixed(1)
    : "-";

  return `
    <div class="plan-card">
      <div class="plan-card__header">
        <span class="plan-card__title">${label}</span>
        <span class="plan-card__badge">추천안</span>
      </div>
      <div class="plan-stats">
        <div class="plan-stat"><strong>${plan.totalCredits}</strong><span>이수학점</span></div>
        <div class="plan-stat"><strong>${plan.totalHours}</strong><span>주당 시수</span></div>
        <div class="plan-stat"><strong>${plan.freeHours}</strong><span>공강 시수</span></div>
        <div class="plan-stat"><strong>${avgRating === "-" ? "-" : "★" + avgRating}</strong><span>평균 별점</span></div>
      </div>
      ${violationHtml}
      ${areaHtml}
    </div>
  `;
}

const screens = {
  start: document.getElementById("screen-start"),
  upload: document.getElementById("screen-upload"),
  write: document.getElementById("screen-write"),
  reviews: document.getElementById("screen-reviews"),
  input: document.getElementById("screen-input"),
  loading: document.getElementById("screen-loading"),
  result: document.getElementById("screen-result"),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove("active"));
  screens[name].classList.add("active");
}

// 화면1 -> 화면2(수강신청표 업로드)
document.getElementById("btn-start").addEventListener("click", () => {
  showScreen("upload");
});

// 화면2: 수강신청표 사진 업로드 (여러 장 가능)
// 지금은 사진을 미리보기로 보여주기만 하고, 사진 속 과목을 실제로 인식하는 것은
// 이후 서버/AI 연동 단계에서 붙일 예정입니다. 지금은 subjects.js의 과목 데이터로 추천을 계산합니다.
const photoInput = document.getElementById("photo-input");
const photoGrid = document.getElementById("photo-grid");
const uploadNextBtn = document.getElementById("btn-upload-next");
const uploadHint = document.getElementById("upload-hint");
const photos = [];
let photoSeq = 0;

function updateUploadState() {
  const hasPhotos = photos.length > 0;
  uploadNextBtn.disabled = !hasPhotos;
  uploadHint.classList.toggle("hidden", hasPhotos);
}

function renderPhotoGrid() {
  photoGrid.innerHTML = photos
    .map(
      (p, i) => `
        <div class="photo-thumb" data-id="${p.id}">
          <img src="${p.dataUrl}" alt="수강신청표 사진 ${i + 1}">
          <span class="photo-thumb__badge">${i + 1}</span>
          <button type="button" class="photo-thumb__remove" data-id="${p.id}" aria-label="사진 ${i + 1} 삭제">×</button>
        </div>
      `
    )
    .join("");
}

photoGrid.addEventListener("click", (e) => {
  const btn = e.target.closest(".photo-thumb__remove");
  if (!btn) return;
  const id = btn.dataset.id;
  const idx = photos.findIndex((p) => p.id === id);
  if (idx !== -1) photos.splice(idx, 1);
  renderPhotoGrid();
  updateUploadState();
});

document.getElementById("btn-add-photo").addEventListener("click", () => {
  photoInput.click();
});

photoInput.addEventListener("change", () => {
  const files = Array.from(photoInput.files || []);
  files.forEach((file) => {
    const id = `p${++photoSeq}`;
    const reader = new FileReader();
    reader.onload = () => {
      photos.push({ id, dataUrl: reader.result });
      renderPhotoGrid();
      updateUploadState();
    };
    reader.readAsDataURL(file);
  });
  photoInput.value = "";
});

uploadNextBtn.addEventListener("click", () => {
  if (uploadNextBtn.disabled) return;
  showScreen("input");
});

document.getElementById("btn-skip-upload").addEventListener("click", () => {
  showScreen("input");
});

// 화면3: 관심 분야 칩 다중 선택
const submitBtn = document.getElementById("btn-submit");
const submitHint = document.getElementById("submit-hint");

function updateSubmitState() {
  const anySelected = document.querySelectorAll(".chip.selected").length > 0;
  submitBtn.disabled = !anySelected;
  submitHint.classList.toggle("hidden", anySelected);
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    chip.classList.toggle("selected");
    updateSubmitState();
  });
});

// 화면2: AP 선호 스위치
const apToggle = document.getElementById("toggle-ap");
apToggle.addEventListener("click", () => {
  const isOn = apToggle.classList.toggle("on");
  apToggle.setAttribute("aria-checked", String(isOn));
});

// 화면2: 비선호 과목/분야 태그 입력
const dislikeInput = document.getElementById("dislike-input");
const dislikeList = document.getElementById("dislike-list");
const dislikes = new Set();

function addDislike() {
  const value = dislikeInput.value.trim();
  if (!value || dislikes.has(value)) {
    dislikeInput.value = "";
    return;
  }
  dislikes.add(value);

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.dataset.value = value;
  tag.innerHTML = `${value} <button type="button" class="tag-remove" aria-label="${value} 삭제">×</button>`;
  tag.querySelector(".tag-remove").addEventListener("click", () => {
    dislikes.delete(value);
    tag.remove();
  });
  dislikeList.appendChild(tag);

  dislikeInput.value = "";
  dislikeInput.focus();
}

document.getElementById("btn-add-dislike").addEventListener("click", addDislike);
dislikeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addDislike();
  }
});

// 화면3: 수강신청표 — 이전 학기 과목은 클릭(들은 과목), 이번 학기 과목은 우클릭(폐강)
const catalogEl = document.getElementById("catalog");
const takenNames = new Set(); // 들은 과목: 이름 기준(다른 학기에 같은 과목이 열려도 함께 적용)
const cancelledKeys = new Set(); // 폐강: "학년-학기|과목명" 기준(폐강은 그 학기에만 해당)

function selectedGradeTerm() {
  return {
    grade: document.getElementById("select-grade").value === "2학년" ? 2 : 3,
    term: document.getElementById("select-term").value === "1학기" ? 1 : 2,
  };
}
const termIndex = (grade, term) => (grade - 2) * 2 + term;
const cancelKey = (grade, term, name) => `${grade}-${term}|${name}`;

function renderCatalog() {
  const { grade: selGrade, term: selTerm } = selectedGradeTerm();
  const selIdx = termIndex(selGrade, selTerm);
  const areaOrder = ["과학", "정보과학", "수학", "AI융합", "사회", "국어", "영어", "제2외국어", "체육", "예술교양"];
  let html = "";

  for (const [g, t] of [[2, 1], [2, 2], [3, 1], [3, 2]]) {
    const idx = termIndex(g, t);
    if (idx > selIdx) continue;
    const isCurrent = idx === selIdx;
    const inTerm = subjectData.filter((s) => s.grade === g && s.term === t);
    const chips = areaOrder
      .map((area) => {
        const items = inTerm.filter((s) => s.area === area);
        if (!items.length) return "";
        const chipHtml = items
          .map((s) => {
            const taken = !isCurrent && takenNames.has(s.name);
            const cancelled = isCurrent && cancelledKeys.has(cancelKey(g, t, s.name));
            const cls = `cat-chip${taken ? " is-taken" : ""}${cancelled ? " is-cancelled" : ""}`;
            return `<button type="button" class="${cls}" data-grade="${g}" data-term="${t}" data-name="${s.name}" data-current="${isCurrent}">${s.name}(${s.credit})${s.ap ? "*" : ""}</button>`;
          })
          .join("");
        return `<div class="cat-area"><span class="cat-area__name">${area}</span><div class="cat-chips">${chipHtml}</div></div>`;
      })
      .join("");
    const label = isCurrent ? `${g}학년 ${t}학기 · 이번 학기 (폐강 과목은 우클릭)` : `${g}학년 ${t}학기 · 들은 과목은 클릭`;
    html += `<div class="cat-term${isCurrent ? " is-current" : ""}"><div class="cat-term__title">${label}</div>${chips}</div>`;
  }
  catalogEl.innerHTML = html;
}

function toggleCancelled(chip) {
  const { grade, term, name } = chip.dataset;
  const key = cancelKey(grade, term, name);
  if (cancelledKeys.has(key)) cancelledKeys.delete(key);
  else cancelledKeys.add(key);
  chip.classList.toggle("is-cancelled");
}

catalogEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".cat-chip");
  if (!chip || chip.dataset.current === "true") return;
  if (takenNames.has(chip.dataset.name)) takenNames.delete(chip.dataset.name);
  else takenNames.add(chip.dataset.name);
  renderCatalog(); // 같은 이름의 과목이 다른 학기 칸에도 있으면 함께 표시를 바꾼다
});

catalogEl.addEventListener("contextmenu", (e) => {
  const chip = e.target.closest(".cat-chip");
  if (!chip || chip.dataset.current !== "true") return;
  e.preventDefault();
  toggleCancelled(chip);
});

// 모바일은 우클릭이 없으므로 길게 누르면 폐강 표시 (contextmenu와 중복되지 않도록 시간 간격으로 막는다)
let pressTimer = null;
let lastToggleAt = 0;
catalogEl.addEventListener("touchstart", (e) => {
  const chip = e.target.closest(".cat-chip");
  if (!chip || chip.dataset.current !== "true") return;
  pressTimer = setTimeout(() => {
    if (Date.now() - lastToggleAt > 800) {
      lastToggleAt = Date.now();
      toggleCancelled(chip);
    }
  }, 500);
}, { passive: true });
["touchend", "touchmove", "touchcancel"].forEach((ev) =>
  catalogEl.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true })
);

document.getElementById("select-grade").addEventListener("change", renderCatalog);
document.getElementById("select-term").addEventListener("change", renderCatalog);
subjectsReady.then(renderCatalog);
renderCatalog();

// 화면4 -> 화면5(로딩) -> 실제 추천 계산 -> 결과
const resultContent = document.getElementById("result-content");
const resultPlaceholderHtml = resultContent.innerHTML;

submitBtn.addEventListener("click", () => {
  if (submitBtn.disabled) return;
  showScreen("loading");

  const { grade, term } = selectedGradeTerm();
  const interests = Array.from(document.querySelectorAll(".chip.selected")).map((c) => c.dataset.tag);
  const dislikeTerms = Array.from(dislikes);
  const apPreferred = apToggle.classList.contains("on");

  // 들은 과목은 "이전 학기 칸에 보이는 과목"만 인정한다(학기를 바꿔서 안 보이는 체크는 무시).
  const selIdx = termIndex(grade, term);
  const priorNames = new Set(
    subjectData.filter((s) => termIndex(s.grade, s.term) < selIdx).map((s) => s.name)
  );
  const completed = new Set([...takenNames].filter((n) => priorNames.has(n)));
  const cancelled = new Set(
    [...cancelledKeys].filter((k) => k.startsWith(`${grade}-${term}|`)).map((k) => k.split("|")[1])
  );

  // 실제 계산은 짧게 지연시켜 로딩 화면이 보이도록 한다.
  Promise.all([subjectsReady, ratingsReady, new Promise((r) => setTimeout(r, 900))]).then(() => {
    // 여러 안을 만들어보고 졸업 기준(담을 수 있었는데 0학점인 영역)을 어기는 안은 버린 뒤,
    // 기준을 통과한 안 중에서 최종 2개를 고른다.
    const plans = generatePlans(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled);

    resultContent.innerHTML =
      renderGraduationRef() +
      plans.map((c, i) => renderPlan(c.plan, `추천안 ${i + 1} · ${c.label}`)).join("");

    showScreen("result");
  });
});

// 화면5 -> 화면1 (처음으로, 입력값 초기화)
document.getElementById("btn-restart").addEventListener("click", () => {
  document.querySelectorAll(".chip.selected").forEach((chip) => {
    chip.classList.remove("selected");
  });
  apToggle.classList.remove("on");
  apToggle.setAttribute("aria-checked", "false");
  dislikes.clear();
  dislikeList.innerHTML = "";
  takenNames.clear();
  cancelledKeys.clear();
  renderCatalog();
  photos.length = 0;
  renderPhotoGrid();
  updateUploadState();
  resultContent.innerHTML = resultPlaceholderHtml;
  updateSubmitState();
  showScreen("start");
});

updateSubmitState();
updateUploadState();

// ── 넓은 화면 양옆 패널: 입력 요약 / 과목 검색 ──────────────────────
const stepNames = { "screen-start": "시작", "screen-upload": "① 사진 업로드", "screen-input": "② 정보 입력", "screen-loading": "추천 계산 중", "screen-result": "③ 추천 결과", "screen-write": "후기 남기기", "screen-reviews": "후기 열람" };

function tagsHtml(list, bad) {
  if (!list.length) return '<span class="summary__empty">없음</span>';
  return list.map((t) => `<span class="summary__tag${bad ? " is-bad" : ""}">${t}</span>`).join("");
}

function updateSummary() {
  const { grade, term } = selectedGradeTerm();
  const selIdx = termIndex(grade, term);
  const active = document.querySelector(".screen.active");
  const priorNames = new Set(subjectData.filter((s) => termIndex(s.grade, s.term) < selIdx).map((s) => s.name));
  const takenCount = [...takenNames].filter((n) => priorNames.has(n)).length;
  const cancelledCount = [...cancelledKeys].filter((k) => k.startsWith(`${grade}-${term}|`)).length;

  document.getElementById("sum-step").textContent = stepNames[active && active.id] || "-";
  document.getElementById("sum-term").textContent = `${grade}학년 ${term}학기`;
  document.getElementById("sum-photos").textContent = `${photos.length}장`;
  document.getElementById("sum-taken").textContent = `${takenCount}개`;
  document.getElementById("sum-cancelled").textContent = `${cancelledCount}개`;
  document.getElementById("sum-ap").textContent = apToggle.classList.contains("on") ? "켜짐" : "꺼짐";
  document.getElementById("sum-interests").innerHTML = tagsHtml(
    Array.from(document.querySelectorAll(".chip.selected")).map((c) => c.dataset.tag)
  );
  document.getElementById("sum-dislikes").innerHTML = tagsHtml(Array.from(dislikes), true);
}

// 클릭·입력·화면 전환이 일어난 직후마다 요약을 새로 그린다.
["click", "change", "input", "contextmenu", "transitionend"].forEach((ev) =>
  document.addEventListener(ev, () => setTimeout(updateSummary, 0))
);

const searchInput = document.getElementById("search-input");
const searchArea = document.getElementById("search-area");
const searchResults = document.getElementById("search-results");
const searchStatus = document.getElementById("search-status");
const AREA_ORDER = ["과학", "정보과학", "수학", "AI융합", "사회", "국어", "영어", "제2외국어", "체육", "예술교양"];

function renderSearch() {
  const q = normalizeName(searchInput.value.trim());
  const area = searchArea.value;

  // 같은 과목이 여러 학기에 열리면 하나로 묶어서 "개설 학기"를 나열한다.
  const byName = new Map();
  subjectData.forEach((s) => {
    const key = `${s.area}|${s.name}`;
    if (!byName.has(key)) byName.set(key, { ...s, terms: [] });
    byName.get(key).terms.push(`${s.grade}-${s.term}`);
  });

  const hits = [...byName.values()].filter(
    (s) => (!area || s.area === area) && (!q || normalizeName(s.name).includes(q))
  );
  searchStatus.textContent = `${hits.length}개 과목` + (hits.length > 40 ? " (위에서 40개만 표시)" : "");
  searchResults.innerHTML = hits
    .slice(0, 40)
    .map(
      (s) => `<div class="search-item"><div class="search-item__name">${s.name}${s.ap ? ' <span class="search-item__ap">AP</span>' : ""}</div>
        <div class="search-item__meta">${s.area} · ${s.credit}학점${s.ap ? ` (시수 ${s.credit + 1})` : ""} · 개설 ${s.terms.join(", ")}${subjectRatings[s.name] ? ` · <span class="star-tag">★${subjectRatings[s.name].avg.toFixed(1)} (${subjectRatings[s.name].count})</span>` : ""}${s.requires ? `<br>선이수: ${s.requires}` : ""}${s.group ? "<br>택일 과목" : ""}${s.mandatory ? "<br>필수 과목" : ""}</div></div>`
    )
    .join("");
}

function initSidePanels() {
  if (searchArea.options.length === 1) {
    AREA_ORDER.forEach((a) => searchArea.add(new Option(a, a)));
  }
  document.getElementById("side-grad").innerHTML = GRADUATION_MIN_CREDITS.map(
    (r) => `<div><b>${r.label}</b><br>${r.options.map((o) => o.join("+")).join(" 또는 ")}학점</div>`
  ).join("<div style='height:6px'></div>");
  document.getElementById("data-source").textContent = `과목 데이터: ${subjectSource} (${subjectData.length}과목)`;
  document.getElementById("data-dot").classList.toggle("is-on", subjectSource === "Supabase DB");
  renderSearch();
  updateSummary();
}

searchInput.addEventListener("input", renderSearch);
searchArea.addEventListener("change", renderSearch);
subjectsReady.then(initSidePanels);
initSidePanels();

// ── 별점 남기기 ────────────────────────────────────────────────
const rateSheet = document.getElementById("rate-sheet");
const rateList = document.getElementById("rate-list");
const openRateBtn = document.getElementById("btn-open-rate");
const RATED_KEY = "dshs_rated";

// 같은 브라우저에서 같은 과목을 여러 번 평가하는 걸 막는 간단한 장치(로그인이 없어서 완벽하진 않다).
function getRated() {
  try {
    return new Set(JSON.parse(localStorage.getItem(RATED_KEY) || "[]"));
  } catch (e) {
    return new Set();
  }
}
function saveRated(set) {
  try {
    localStorage.setItem(RATED_KEY, JSON.stringify([...set]));
  } catch (e) {
    /* 저장이 막힌 브라우저에서는 이번 접속 동안만 막지 못한다 */
  }
}

// 평가할 수 있는 과목 = 현재 학기보다 이전 학기에 "들은 과목"으로 표시한 과목(이름 기준, 중복 제거)
function ratableNames() {
  const { grade, term } = selectedGradeTerm();
  const selIdx = termIndex(grade, term);
  const names = [];
  subjectData.forEach((s) => {
    if (termIndex(s.grade, s.term) < selIdx && takenNames.has(s.name) && !names.includes(s.name)) names.push(s.name);
  });
  return names;
}

function updateRateButton() {
  const n = ratableNames().length;
  openRateBtn.hidden = n === 0;
  openRateBtn.textContent = `★ 들은 과목 평가하기 (${n}개)`;
}

function renderRateList() {
  const rated = getRated();
  const names = ratableNames();
  rateList.innerHTML = names.length
    ? names
        .map((name) => {
          const done = rated.has(name);
          const r = subjectRatings[name];
          const avg = r ? `<span class="rate-item__avg">평균 ★${r.avg.toFixed(1)} (${r.count}명)</span>` : "";
          return `<div class="rate-item${done ? " is-done" : ""}" data-name="${name}" data-value="0">
            <div class="rate-item__name">${name}${avg}</div>
            <div class="rate-stars">${[1, 2, 3, 4, 5].map((v) => `<button type="button" class="star" data-v="${v}" aria-label="${v}점" ${done ? "disabled" : ""}>★</button>`).join("")}</div>
            <input class="text-input rate-teacher" list="teacher-suggest" maxlength="20" placeholder="담당 선생님 (선택)" ${done ? "disabled" : ""}>
            <textarea class="rate-comment" maxlength="500" placeholder="한 줄 후기 (선택)" ${done ? "disabled" : ""}></textarea>
            <div class="rate-actions"><span class="rate-msg">${done ? "이미 평가했어요 ✓" : ""}</span>
              <button type="button" class="rate-submit" ${done ? "disabled" : ""}>등록</button></div>
          </div>`;
        })
        .join("")
    : '<p class="field-note">수강신청표에서 들은 과목을 먼저 클릭해 주세요.</p>';
}

function setStars(item, value) {
  item.dataset.value = String(value);
  item.querySelectorAll(".star").forEach((s) => s.classList.toggle("is-on", Number(s.dataset.v) <= value));
}

function showRateMsg(item, text, isError) {
  const msg = item.querySelector(".rate-msg");
  msg.textContent = text;
  msg.classList.toggle("is-error", !!isError);
}

rateList.addEventListener("click", async (e) => {
  const item = e.target.closest(".rate-item");
  if (!item) return;

  const star = e.target.closest(".star");
  if (star && !star.disabled) {
    setStars(item, Number(star.dataset.v));
    showRateMsg(item, "");
    return;
  }

  const submit = e.target.closest(".rate-submit");
  if (!submit || submit.disabled) return;

  const rating = Number(item.dataset.value);
  const name = item.dataset.name;
  if (!rating) {
    showRateMsg(item, "별점(★)을 먼저 골라주세요.", true);
    return;
  }

  submit.disabled = true;
  showRateMsg(item, "저장하는 중...");
  const result = await saveReview(
    name,
    rating,
    item.querySelector(".rate-comment").value.trim(),
    item.querySelector(".rate-teacher").value
  );

  if (!result.ok) {
    submit.disabled = false;
    showRateMsg(item, "저장에 실패했어요. 잠시 후 다시 시도해 주세요.", true);
    return;
  }
  renderRateList();
});

// 선생님 이름 통일: "김철수 선생님", "김 철수쌤", "김철수" 가 모두 "김철수"로 저장·검색되게 한다.
function cleanTeacher(str) {
  return String(str || "")
    .replace(/\s+/g, "")
    .replace(/(선생님|선생|교수님|교수|쌤|샘)$/, "")
    .slice(0, 20);
}

// 별점 저장(공통): DB에 넣고, 성공하면 화면의 평균과 "이미 평가함" 기록을 갱신한다.
async function saveReview(name, rating, comment, teacherInput) {
  const teacher = cleanTeacher(teacherInput) || null;
  const row = { subject_name: name, rating, comment: comment || null, teacher };
  let { error } = await supabaseClient.from("reviews").insert(row);

  // DB에 teacher 열이 아직 없으면(supabase/teacher.sql 실행 전) 선생님 이름만 빼고 다시 저장한다.
  if (error && /teacher/i.test(`${error.message} ${error.details || ""}`)) {
    console.warn("teacher 열이 아직 없어 선생님 이름 없이 저장합니다:", error.message);
    const { teacher: _omit, ...withoutTeacher } = row;
    ({ error } = await supabaseClient.from("reviews").insert(withoutTeacher));
  }
  if (error) {
    console.warn("별점 저장 실패:", error);
    return { ok: false, error };
  }

  // 다음 접속 때는 DB 값으로 다시 계산되지만, 지금 화면에도 바로 반영한다.
  const prev = subjectRatings[name] || { avg: 0, count: 0 };
  const count = prev.count + 1;
  subjectRatings[name] = { avg: (prev.avg * prev.count + rating) / count, count };

  const rated = getRated();
  rated.add(name);
  saveRated(rated);
  renderSearch();
  return { ok: true };
}

openRateBtn.addEventListener("click", () => {
  renderRateList();
  rateSheet.hidden = false;
});
document.getElementById("rate-close").addEventListener("click", () => {
  rateSheet.hidden = true;
});
rateSheet.addEventListener("click", (e) => {
  if (e.target === rateSheet) rateSheet.hidden = true; // 바깥(어두운 부분)을 누르면 닫기
});

["click", "change", "contextmenu"].forEach((ev) => document.addEventListener(ev, () => setTimeout(updateRateButton, 0)));
subjectsReady.then(updateRateButton);
updateRateButton();
ratingsReady.then(renderSearch);

// ── 첫 화면 3갈래 + 후기 남기기 / 후기 열람하기 ─────────────────
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.querySelectorAll("[data-go]").forEach((b) =>
  b.addEventListener("click", () => showScreen(b.dataset.go))
);

// 후기 남기기: 과목 고르기 → 별점 + 후기 → 등록
const writeSearch = document.getElementById("write-search");
const writePick = document.getElementById("write-pick");
const writeForm = document.getElementById("write-form");
const writeMsg = document.getElementById("write-msg");
const writeSubmit = document.getElementById("write-submit");
const writeStars = document.getElementById("write-stars");
let writeSelected = null;
let writeRating = 0;

function uniqueSubjectNames() {
  return [...new Set(subjectData.map((s) => s.name))];
}

function renderWritePick() {
  const q = normalizeName(writeSearch.value.trim());
  const names = uniqueSubjectNames().filter((n) => !q || normalizeName(n).includes(q));
  writePick.innerHTML = names.length
    ? names
        .map((n) => `<button type="button" class="pick-item${n === writeSelected ? " is-selected" : ""}" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
        .join("")
    : '<span class="summary__empty">검색된 과목이 없어요</span>';
}

function setWriteStars(v) {
  writeRating = v;
  writeStars.querySelectorAll(".star").forEach((s) => s.classList.toggle("is-on", Number(s.dataset.v) <= v));
}

function selectWriteSubject(name) {
  writeSelected = name;
  const done = getRated().has(name);
  const r = subjectRatings[name];
  document.getElementById("write-name").textContent = name;
  document.getElementById("write-avg").textContent = r ? `평균 ★${r.avg.toFixed(1)} (${r.count}명)` : "아직 후기가 없어요";
  document.getElementById("write-comment").value = "";
  document.getElementById("write-comment").disabled = done;
  document.getElementById("write-teacher").value = "";
  document.getElementById("write-teacher").disabled = done;
  updateTeacherSuggest(name);
  writeStars.querySelectorAll(".star").forEach((s) => (s.disabled = done));
  setWriteStars(0);
  writeSubmit.disabled = done;
  writeMsg.textContent = done ? "이미 평가했어요 ✓" : "";
  writeMsg.classList.remove("is-error");
  writeForm.hidden = false;
  renderWritePick();
}

function openWriteScreen() {
  writeSelected = null;
  writeForm.hidden = true;
  writeSearch.value = "";
  renderWritePick();
  showScreen("write");
  if (!reviewsLoaded) loadReviews();
}

writePick.addEventListener("click", (e) => {
  const b = e.target.closest(".pick-item");
  if (b) selectWriteSubject(b.dataset.name);
});
writeSearch.addEventListener("input", renderWritePick);
writeStars.addEventListener("click", (e) => {
  const s = e.target.closest(".star");
  if (s && !s.disabled) {
    setWriteStars(Number(s.dataset.v));
    writeMsg.textContent = "";
  }
});
writeSubmit.addEventListener("click", async () => {
  if (writeSubmit.disabled || !writeSelected) return;
  if (!writeRating) {
    writeMsg.textContent = "별점(★)을 먼저 골라주세요.";
    writeMsg.classList.add("is-error");
    return;
  }
  writeSubmit.disabled = true;
  writeMsg.classList.remove("is-error");
  writeMsg.textContent = "저장하는 중...";
  const result = await saveReview(
    writeSelected,
    writeRating,
    document.getElementById("write-comment").value.trim(),
    document.getElementById("write-teacher").value
  );
  if (!result.ok) {
    writeSubmit.disabled = false;
    writeMsg.textContent = "저장에 실패했어요. 잠시 후 다시 시도해 주세요.";
    writeMsg.classList.add("is-error");
    return;
  }
  reviewsLoaded = false; // 열람 화면은 다음에 열 때 새로 불러온다
  selectWriteSubject(writeSelected);
  writeMsg.textContent = "등록됐어요. 고마워요! ✓";
});

// 후기 열람하기: 최신순 목록 + 과목명/영역 필터
const reviewsSearch = document.getElementById("reviews-search");
const reviewsArea = document.getElementById("reviews-area");
const reviewsTeacher = document.getElementById("reviews-teacher");
const reviewsBreakdown = document.getElementById("reviews-breakdown");
const reviewsList = document.getElementById("reviews-list");
const reviewsSummary = document.getElementById("reviews-summary");
let reviewsData = [];
let reviewsLoaded = false;

async function loadReviews() {
  reviewsSummary.textContent = "후기를 불러오는 중...";
  reviewsList.innerHTML = "";
  const query = (cols) =>
    supabaseClient.from("reviews").select(cols).order("created_at", { ascending: false }).limit(300);

  let { data, error } = await query("subject_name,rating,comment,teacher,created_at");
  // teacher 열이 아직 없으면(supabase/teacher.sql 실행 전) 선생님 없이 읽는다.
  if (error && /teacher/i.test(`${error.message} ${error.details || ""}`)) {
    ({ data, error } = await query("subject_name,rating,comment,created_at"));
  }
  if (error) {
    console.warn("후기 불러오기 실패:", error);
    reviewsData = [];
    reviewsSummary.textContent = "후기를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.";
    return;
  }
  // 수강신청표에 실제로 있는 과목의 후기만 보여준다.
  const valid = new Set(subjectData.map((s) => s.name));
  reviewsData = data.filter((r) => valid.has(r.subject_name));
  reviewsLoaded = true;
  updateTeacherSuggest(writeSelected);
  renderReviews();
}

// 선생님 이름 자동완성: 고른 과목에 후기가 있던 선생님을 먼저, 없으면 전체 선생님을 보여준다.
function updateTeacherSuggest(subjectName) {
  const all = [...new Set(reviewsData.map((r) => r.teacher).filter(Boolean))].sort();
  const ofSubject = subjectName
    ? [...new Set(reviewsData.filter((r) => r.subject_name === subjectName).map((r) => r.teacher).filter(Boolean))]
    : [];
  const list = ofSubject.length ? ofSubject : all;
  document.getElementById("teacher-suggest").innerHTML = list.map((t) => `<option value="${escapeHtml(t)}">`).join("");
  document.getElementById("teacher-suggest-all").innerHTML = all.map((t) => `<option value="${escapeHtml(t)}">`).join("");
}

function starsHtml(n) {
  return `${"★".repeat(n)}<span style="color:#d8d2df">${"★".repeat(5 - n)}</span>`;
}

function renderReviews() {
  if (reviewsArea.options.length === 1) AREA_ORDER.forEach((a) => reviewsArea.add(new Option(a, a)));
  const q = normalizeName(reviewsSearch.value.trim());
  const t = cleanTeacher(reviewsTeacher.value);
  const area = reviewsArea.value;
  const areaOf = {};
  subjectData.forEach((s) => (areaOf[s.name] = areaOf[s.name] || s.area));

  const rows = reviewsData.filter(
    (r) =>
      (!q || normalizeName(r.subject_name).includes(q)) &&
      (!t || (r.teacher || "").includes(t)) &&
      (!area || areaOf[r.subject_name] === area)
  );

  const names = new Set(rows.map((r) => r.subject_name));
  const teachers = new Set(rows.map((r) => r.teacher).filter(Boolean));
  reviewsBreakdown.innerHTML = "";
  if (!rows.length) {
    reviewsSummary.textContent = "";
  } else {
    const avg = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
    const scope = [t ? `${escapeHtml(t)} 선생님` : "", names.size > 1 ? `과목 ${names.size}개` : ""].filter(Boolean).join(" · ");
    reviewsSummary.innerHTML = `<b>★${avg.toFixed(1)}</b> · 후기 ${rows.length}개${scope ? " · " + scope : ""}`;

    // 한 과목만 보고 있고 선생님이 둘 이상이면 선생님별 평균을 칩으로 보여준다(누르면 그 선생님만 보기).
    if (names.size === 1 && teachers.size > 1 && !t) {
      const byTeacher = {};
      rows.forEach((r) => {
        const key = r.teacher || "";
        if (!key) return;
        (byTeacher[key] ||= { sum: 0, n: 0 });
        byTeacher[key].sum += r.rating;
        byTeacher[key].n += 1;
      });
      reviewsBreakdown.innerHTML = Object.entries(byTeacher)
        .sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)
        .map(([name, v]) => `<button type="button" class="teacher-chip" data-teacher="${escapeHtml(name)}">${escapeHtml(name)} ★${(v.sum / v.n).toFixed(1)} (${v.n})</button>`)
        .join("");
    }
  }

  reviewsList.innerHTML = rows.length
    ? rows
        .map((r) => {
          const date = new Date(r.created_at).toLocaleDateString("ko-KR");
          const comment = r.comment ? `<p class="review-card__comment">${escapeHtml(r.comment)}</p>` : "";
          const teacher = r.teacher ? `<span class="review-card__teacher">${escapeHtml(r.teacher)} 선생님</span>` : "";
          return `<div class="review-card"><div class="review-card__top"><span class="review-card__name">${escapeHtml(r.subject_name)}${teacher}</span>
            <span class="review-card__stars">${starsHtml(r.rating)}</span></div>${comment}
            <div class="review-card__date">${date}</div></div>`;
        })
        .join("")
    : '<p class="reviews-empty">조건에 맞는 후기가 아직 없어요.</p>';
}

reviewsSearch.addEventListener("input", renderReviews);
reviewsTeacher.addEventListener("input", renderReviews);
reviewsBreakdown.addEventListener("click", (e) => {
  const chip = e.target.closest(".teacher-chip");
  if (!chip) return;
  reviewsTeacher.value = chip.dataset.teacher;
  renderReviews();
});
reviewsArea.addEventListener("change", renderReviews);

function openReviewsScreen() {
  showScreen("reviews");
  if (!reviewsLoaded) loadReviews();
  else renderReviews();
}

document.getElementById("btn-go-write").addEventListener("click", () => subjectsReady.then(openWriteScreen));
document.getElementById("btn-go-read").addEventListener("click", () => subjectsReady.then(openReviewsScreen));
