// 화면 전환 + subjects.js의 과목 데이터를 이용한 시간표 추천 로직입니다.

// 전체 영역 순서(화면 표시용). 과학/정보과학/수학/AI융합 = 전문기본선택, 과학정보수학/AI융합(심화) = 전문심화선택.
const AREA_ORDER = ["과학", "정보과학", "수학", "AI융합", "과학정보수학", "AI융합(심화)", "사회", "국어", "영어", "제2외국어", "체육", "예술교양"];

// 관심 분야 칩 → 과목 영역/키워드 규칙 (interestScore 계산에 사용)
// strict: true 이면 키워드가 맞는 과목만 가산하고, 같은 영역의 다른 과목에는 점수를 주지 않는다.
const INTEREST_MAP = {
  "수학": [
    { areas: ["수학"] },
    { areas: ["과학정보수학"], keyword: ["수학", "대수"], strict: true },
  ],
  "물리": [
    { areas: ["과학"], keyword: "물리" },
    { areas: ["AI융합", "과학정보수학", "AI융합(심화)"], keyword: "물리", strict: true },
  ],
  "화학": [
    { areas: ["과학"], keyword: "화학" },
    { areas: ["AI융합", "과학정보수학", "AI융합(심화)"], keyword: "화학", strict: true },
  ],
  "생명과학": [
    { areas: ["과학"], keyword: ["생명", "생물"] },
    { areas: ["AI융합", "과학정보수학", "AI융합(심화)"], keyword: ["생명", "생물", "바이오"], strict: true },
  ],
  "정보과학": [
    { areas: ["정보과학", "AI융합"] },
    { areas: ["과학정보수학"], keyword: ["프로그래밍", "알고리즘"], strict: true },
    { areas: ["AI융합(심화)"], keyword: ["인공지능", "AI", "가상현실"], strict: true },
  ],
  "인문사회": [{ areas: ["국어", "사회"] }],
  "예술": [{ areas: ["예술교양"] }],
  "체육": [{ areas: ["체육"] }],
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
    (INTEREST_MAP[tag] || []).forEach((rule) => {
      if (!rule.areas.includes(subjectItem.area)) return;
      if (!rule.keyword) {
        score += 2;
        return;
      }
      const keywords = Array.isArray(rule.keyword) ? rule.keyword : [rule.keyword];
      if (keywords.some((k) => subjectItem.name.includes(k))) score += 2;
      else if (!rule.strict) score += 0.5;
    });
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
    // DB의 과목 분류가 옛 버전(세미나·토픽이 과학/수학에 흩어진 상태)이면 맞지 않으므로 로컬 데이터를 쓴다.
    // supabase/reseed-subjects.sql 을 실행해 DB를 최신으로 맞추면 자동으로 DB 데이터를 쓴다.
    if (!data.some((r) => r.area === "과학정보수학")) throw new Error("DB 과목 분류가 최신이 아님(reseed-subjects.sql 필요)");
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

// 졸업 이수학점 기준에 쓰이는 6개 영역(전문기본선택 4개 + 전문심화선택 2개)
const GRAD_AREAS = ["과학", "정보과학", "수학", "AI융합", "과학정보수학", "AI융합(심화)"];

// 졸업 기준 계산에 필요한 현재 상황:
//  - earned: 지금까지 "들은 과목"으로 체크한 과목의 영역별 학점
//  - future: 이번 학기 이후 학기에 열리는 과목(이름 기준 중복 제거, 이미 들은 과목 제외) 영역별 {과목명 -> 학점}
//  - termsLeft: 이번 학기를 포함해 남은 학기 수
function gradContext(grade, term, completed) {
  const selIdx = termIndex(grade, term);
  const byName = {};
  subjectData.forEach((s) => (byName[s.name] ||= s));

  const earned = {};
  completed.forEach((n) => {
    const s = byName[n];
    if (s && GRAD_AREAS.includes(s.area)) earned[s.area] = (earned[s.area] || 0) + s.credit;
  });

  const future = {};
  subjectData.forEach((s) => {
    if (termIndex(s.grade, s.term) <= selIdx || !GRAD_AREAS.includes(s.area) || completed.has(s.name)) return;
    (future[s.area] ||= new Map()).set(s.name, s.credit);
  });

  return { earned, future, termsLeft: 5 - selIdx };
}

// 한 시간표 안이 졸업 기준(3개 묶음)에 어떤 상태인지 계산한다.
//  met: 이번 안까지 포함해 이미 기준 충족 / ok: 앞으로 학기들에서 채울 수 있음 / impossible: 남은 학기를 다 써도 불가능
function gradProgress(subjects, ctx) {
  const inPlan = new Set(subjects.map((s) => s.name));
  const have = {};
  const fut = {};
  GRAD_AREAS.forEach((a) => {
    have[a] = (ctx.earned[a] || 0) + subjects.filter((s) => s.area === a).reduce((t, s) => t + s.credit, 0);
    fut[a] = 0;
    (ctx.future[a] || new Map()).forEach((credit, name) => {
      if (!inPlan.has(name)) fut[a] += credit;
    });
  });

  return GRADUATION_MIN_CREDITS.map((rule) => {
    const [a, b] = rule.areas;
    const met = rule.options.some(([x, y]) => have[a] >= x && have[b] >= y);
    const possible = met || rule.options.some(([x, y]) => have[a] + fut[a] >= x && have[b] + fut[b] >= y);
    const best = rule.options
      .map(([x, y]) => ({ x, y, short: Math.max(0, x - have[a]) + Math.max(0, y - have[b]) }))
      .sort((p, q) => p.short - q.short)[0];
    return { rule, have: [have[a], have[b]], status: met ? "met" : possible ? "ok" : "impossible", best };
  });
}

// 이번 학기에 영역별로 최소 몇 학점은 담아야 졸업 기준을 따라갈 수 있는지 계산한다.
//  - 앞으로 학기들을 다 합쳐도 모자라는 만큼은 이번 학기에 반드시 채우고(mustNow),
//  - 그 외에는 남은 학기에 고르게 나눠 담는 속도(남은 학점 ÷ 남은 학기 수)를 맞춘다.
function gradTargetsThisTerm(ctx) {
  const need = {};
  GRADUATION_MIN_CREDITS.forEach((rule) => {
    const [a, b] = rule.areas;
    const ea = ctx.earned[a] || 0;
    const eb = ctx.earned[b] || 0;
    const best = rule.options
      .map(([x, y]) => ({ x, y, short: Math.max(0, x - ea) + Math.max(0, y - eb) }))
      .sort((p, q) => p.short - q.short)[0];
    [[a, best.x, ea], [b, best.y, eb]].forEach(([area, target, have]) => {
      const remaining = Math.max(0, target - have);
      let futureTotal = 0;
      (ctx.future[area] || new Map()).forEach((credit) => (futureTotal += credit));
      const mustNow = Math.max(0, remaining - futureTotal);
      need[area] = Math.max(mustNow, Math.floor(remaining / ctx.termsLeft));
    });
  });
  return need;
}

// 관심분야/비선호/AP 선호/선이수 과목을 반영해 학년·학기에 맞는 시간표 한 안을 구성한다.
// completed: 이전 학기에 이미 들은 과목명 Set (Ⅱ과목·실험과목의 선이수 조건 확인용)
// hourCap: 주당 시수 상한(학기별 27학점 이내 권장 기준).
// balanceMode: true면 졸업 기준(gradTargetsThisTerm)에서 요구하는 학점을 영역별로 먼저 채운 뒤 나머지를 관심 순으로 채운다.
function buildPlan(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled, hourCap, balanceMode, gradCtx) {
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
        interestScore(s, interests) - (disliked ? 3 : 0) + (apPreferred === true && s.ap ? 1 : 0) - (apPreferred === "avoid" && s.ap ? 1.5 : 0) + ratingBonus(s.name),
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

  // 3) 자유 선택 풀(과학/정보과학/수학/AI융합/과학정보수학/AI융합(심화)): 점수 높은 순으로 상한까지 채운다.
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

  if (balanceMode && gradCtx) {
    // 졸업 기준에서 이번 학기에 필요한 영역별 학점을, 점수가 높은 과목부터 한 과목씩 담아 채운다.
    const need = gradTargetsThisTerm(gradCtx);
    GRAD_AREAS.forEach((area) => {
      let got = 0;
      let progressed = true;
      while (got < (need[area] || 0) && progressed) {
        progressed = false;
        const next = freePoolByScore.find(
          (s) => s.area === area && !pickedNames.has(s.name) && isEligible(s) && totalHours + s.hours <= hourCap
        );
        if (next) {
          add(next);
          got += next.credit;
          progressed = true;
        }
      }
    });
  }

  fillLoop(freePoolByScore);

  const totalCredits = picked.reduce((sum, s) => sum + s.credit, 0);
  const areaCredits = {};
  picked.forEach((s) => {
    areaCredits[s.area] = (areaCredits[s.area] || 0) + s.credit;
  });

  const grad = gradCtx ? gradProgress(picked, gradCtx) : [];

  return {
    subjects: picked,
    totalHours,
    totalCredits,
    freeHours: 36 - totalHours,
    areaCredits,
    grad,
    infeasible: grad.some((g) => g.status === "impossible"),
  };
}

// 여러 후보 시간표를 만들어, 졸업 기준을 채울 수 없게 되는 안은 버리고 남은 안 중에서 고른다.
// 만족하는 안이 하나도 없으면 "불가능한 묶음이 가장 적은 안"을 경고와 함께 보여준다.
function generatePlans(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled) {
  const gradCtx = gradContext(grade, term, completed);
  const attempts = [
    { label: "균형 잡힌 시간표", hourCap: 27, balanceMode: true },
    { label: "관심 집중형 시간표", hourCap: 27, balanceMode: false },
    { label: "여유로운 시간표", hourCap: 24, balanceMode: true },
    { label: "여유로운 시간표", hourCap: 21, balanceMode: true },
  ];
  // AP 과목(주당 시수가 1 더 듦)을 원하지 않는 사용자에게는 AP 부담을 줄인 안도 후보에 넣는다.
  if (apPreferred !== true) {
    attempts.push({ label: "AP 부담을 줄인 시간표", hourCap: 27, balanceMode: true, ap: "avoid" });
    attempts.push({ label: "AP 부담을 줄인 시간표", hourCap: 24, balanceMode: true, ap: "avoid" });
  }

  const candidates = attempts.map((a) => ({
    ...a,
    plan: buildPlan(grade, term, interests, dislikeTerms, a.ap || apPreferred, completed, cancelled, a.hourCap, a.balanceMode, gradCtx),
  }));
  const keyOf = (c) => c.plan.subjects.map((s) => s.name).sort().join("|");

  const seen = new Set();
  const accepted = [];
  for (const c of candidates) {
    if (seen.has(keyOf(c))) continue;
    if (c.plan.infeasible) continue; // 졸업 기준을 채울 수 없게 되는 안은 폐기
    seen.add(keyOf(c));
    accepted.push(c);
    if (accepted.length === 2) break;
  }

  // 기준을 만족하는 안이 하나라도 있으면 그 안만 보여준다(미달 안으로 빈자리를 채우지 않는다).
  // 하나도 없을 때만 "불가능한 묶음이 가장 적은 안"을 경고와 함께 보여준다.
  if (accepted.length === 0) {
    const impossibleCount = (c) => c.plan.grad.filter((g) => g.status === "impossible").length;
    const rest = candidates.filter((c) => !seen.has(keyOf(c))).sort((a, b) => impossibleCount(a) - impossibleCount(b));
    for (const c of rest) {
      if (seen.has(keyOf(c))) continue;
      seen.add(keyOf(c));
      accepted.push(c);
      if (accepted.length === 2) break;
    }
  }

  return accepted;
}

// 졸업 기준 안내 카드: 기준표 + 지금까지 "들은 과목"으로 체크한 학점
function renderGraduationRef(ctx) {
  const rows = GRADUATION_MIN_CREDITS.map((rule) => {
    const optionsText = rule.options.map(([x, y]) => `${rule.areas[0]} ${x} + ${rule.areas[1]} ${y}`).join(" 또는 ");
    const [a, b] = rule.areas;
    return `
      <div class="grad-row">
        <div class="grad-row__label">${rule.label}</div>
        <div class="grad-row__target">기준: ${optionsText}</div>
        <div class="grad-row__current">지금까지: ${a} ${(ctx && ctx.earned[a]) || 0} · ${b} ${(ctx && ctx.earned[b]) || 0}학점</div>
      </div>
    `;
  }).join("");

  const earnedTotal = ctx ? Object.values(ctx.earned).reduce((t, v) => t + v, 0) : 0;
  const hint =
    ctx && ctx.termsLeft < 4 && earnedTotal === 0
      ? '<p class="grad-warn">⚠ 수강신청표에서 "들은 과목"을 체크하지 않아 지금까지 0학점으로 계산했어요. 체크하면 졸업 판정이 정확해져요.</p>'
      : "";

  return `
    <div class="plan-card grad-card">
      <div class="plan-card__header">
        <span class="plan-card__title">졸업 최소이수학점 기준</span>
      </div>
      ${rows}
      ${hint}
      <p class="grad-footnote">기준은 4개 학기(2학년1학기~3학년2학기) 누적이에요. 아래 안들은 "지금까지 들은 학점 + 이번 안 + 앞으로 들을 수 있는 학점"으로 졸업이 불가능해지는 경우를 걸러낸 거예요.</p>
    </div>
  `;
}

function renderPlan(plan, label) {
  const byArea = {};
  plan.subjects.forEach((s) => {
    (byArea[s.area] ||= []).push(s);
  });

  const areaHtml = AREA_ORDER
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

  const statusText = { met: "충족 ✓", ok: "진행 중", impossible: "불가능 ⚠" };
  const violationHtml = plan.grad.length
    ? `<div class="grad-lines">${plan.grad
        .map((g) => {
          const [a, b] = g.rule.areas;
          const more = g.status === "ok" ? ` · 가장 가까운 기준까지 ${g.best.short}학점 남음` : "";
          return `<div class="grad-line is-${g.status}"><span class="grad-line__name">${g.rule.label}</span>
            <span class="grad-line__num">${a} ${g.have[0]} · ${b} ${g.have[1]}${more}</span>
            <span class="grad-chip">${statusText[g.status]}</span></div>`;
        })
        .join("")}</div>`
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
        <span class="plan-card__badge${plan.infeasible ? " is-bad" : ""}">${plan.infeasible ? "졸업 기준 미달" : "추천안"}</span>
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
  const areaOrder = AREA_ORDER;
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
      renderGraduationRef(gradContext(grade, term, completed)) +
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

// 사용자가 친 과목명을 정리한다: 공백 정리 + 30자 제한 + (띄어쓰기/대소문자만 다르면) 목록의 과목명으로 맞춤
function canonicalSubjectName(raw) {
  const cleaned = String(raw).trim().replace(/\s+/g, " ").slice(0, 30);
  const key = cleaned.replace(/\s/g, "").toLowerCase();
  return uniqueSubjectNames().find((n) => n.replace(/\s/g, "").toLowerCase() === key) || cleaned;
}

function renderWritePick() {
  const raw = writeSearch.value.trim().replace(/\s+/g, " ");
  const q = normalizeName(raw);
  const all = uniqueSubjectNames();
  const names = all.filter((n) => !q || normalizeName(n).includes(q));
  let html = names
    .map((n) => `<button type="button" class="pick-item${n === writeSelected ? " is-selected" : ""}" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
    .join("");

  // 검색어와 똑같은 과목이 목록에 없으면 "직접 추가" 버튼을 보여준다.
  const canonical = raw ? canonicalSubjectName(raw) : "";
  if (raw && !all.includes(canonical)) {
    html += `<button type="button" class="pick-item pick-item--custom${canonical === writeSelected ? " is-selected" : ""}" data-custom="${escapeHtml(raw)}">+ '${escapeHtml(canonical)}' 직접 추가</button>`;
  }
  writePick.innerHTML = html || '<span class="summary__empty">과목 이름을 검색해 보세요</span>';
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
  const isCustom = !uniqueSubjectNames().includes(name);
  document.getElementById("write-avg").textContent =
    (r ? `평균 ★${r.avg.toFixed(1)} (${r.count}명)` : "아직 후기가 없어요") + (isCustom ? " · 목록에 없는 과목" : "");
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
  if (!b) return;
  selectWriteSubject(b.dataset.custom ? canonicalSubjectName(b.dataset.custom) : b.dataset.name);
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
    const rejected = result.error && result.error.code === "42501" && !uniqueSubjectNames().includes(writeSelected);
    writeMsg.textContent = rejected
      ? "목록에 없는 과목은 아직 저장할 수 없어요. (DB 설정이 필요해요)"
      : "저장에 실패했어요. 잠시 후 다시 시도해 주세요.";
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
  reviewsData = data; // 수강신청표에 없는 과목의 후기도 보여준다(카드에 "목록 외 과목" 표시)
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
          const extra = areaOf[r.subject_name] ? "" : '<span class="review-card__tag">목록 외 과목</span>';
          return `<div class="review-card"><div class="review-card__top"><span class="review-card__name">${escapeHtml(r.subject_name)}${extra}${teacher}</span>
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

// ── 모바일 사이드 패널(서랍): 화살표 탭 / 가장자리에서 밀어 열기 / 밀거나 바깥을 눌러 닫기 ──
const narrowQuery = window.matchMedia("(max-width: 1099px)");
const drawerEl = { left: document.querySelector(".side--left"), right: document.querySelector(".side--right") };
const handleEl = { left: document.getElementById("handle-left"), right: document.getElementById("handle-right") };
let drawerDrag = null;
let lastDragAt = 0;

function drawerIsOpen(side) {
  return document.body.classList.contains(`drawer-${side}-open`);
}

function setDrawer(side, open) {
  const other = side === "left" ? "right" : "left";
  document.body.classList.toggle(`drawer-${side}-open`, open);
  if (open) document.body.classList.remove(`drawer-${other}-open`);
  handleEl.left.setAttribute("aria-expanded", String(drawerIsOpen("left")));
  handleEl.right.setAttribute("aria-expanded", String(drawerIsOpen("right")));
  if (open) updateSummary();
}

function closeDrawers() {
  setDrawer("left", false);
  setDrawer("right", false);
}

function clearDragStyle(el) {
  el.style.transition = "";
  el.style.transform = "";
  el.style.visibility = "";
}

["left", "right"].forEach((side) => {
  handleEl[side].addEventListener("click", () => {
    if (Date.now() - lastDragAt < 350) return; // 드래그 직후에 생기는 클릭은 무시
    setDrawer(side, !drawerIsOpen(side));
  });
});
document.querySelectorAll(".side-close").forEach((b) => b.addEventListener("click", closeDrawers));
document.getElementById("side-backdrop").addEventListener("click", closeDrawers);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawers();
});

// 화면 폭이 넓어져 서랍이 필요 없어지면 열린 상태와 드래그 흔적을 정리한다.
narrowQuery.addEventListener("change", () => {
  if (!narrowQuery.matches) {
    closeDrawers();
    clearDragStyle(drawerEl.left);
    clearDragStyle(drawerEl.right);
  }
});

document.addEventListener("pointerdown", (e) => {
  if (!narrowQuery.matches || e.button > 0) return;
  const t = e.target;
  let side = null;
  let action = null;

  if (drawerIsOpen("left") && t.closest(".side--left")) [side, action] = ["left", "close"];
  else if (drawerIsOpen("right") && t.closest(".side--right")) [side, action] = ["right", "close"];
  else if (!drawerIsOpen("left") && !drawerIsOpen("right")) {
    if (t.closest("#edge-left, #handle-left")) [side, action] = ["left", "open"];
    else if (t.closest("#edge-right, #handle-right")) [side, action] = ["right", "open"];
  }
  if (!side) return;

  drawerDrag = { side, action, el: drawerEl[side], width: drawerEl[side].offsetWidth, x0: e.clientX, y0: e.clientY, offset: null, moved: false };
});

document.addEventListener("pointermove", (e) => {
  const d = drawerDrag;
  if (!d) return;
  const dx = e.clientX - d.x0;
  const dy = e.clientY - d.y0;

  if (!d.moved) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      drawerDrag = null; // 세로로 움직이면 스크롤로 보고 서랍 동작은 취소
      return;
    }
    d.moved = true;
    d.el.style.transition = "none";
    d.el.style.visibility = "visible";
    document.getElementById("side-backdrop").style.transition = "none";
  }

  // offset: 서랍이 닫힌 위치(왼쪽은 -width, 오른쪽은 +width)와 열린 위치(0) 사이의 현재 위치
  const closed = d.side === "left" ? -d.width : d.width;
  const base = d.action === "open" ? closed : 0;
  const raw = base + dx;
  d.offset = d.side === "left" ? Math.min(0, Math.max(closed, raw)) : Math.max(0, Math.min(closed, raw));
  d.el.style.transform = `translateX(${d.offset}px)`;
  document.getElementById("side-backdrop").style.opacity = String(1 - Math.abs(d.offset) / d.width);
  document.getElementById("side-backdrop").style.pointerEvents = "none";
});

function finishDrawerDrag() {
  const d = drawerDrag;
  drawerDrag = null;
  if (!d || !d.moved) return;
  lastDragAt = Date.now();
  const shown = 1 - Math.abs(d.offset) / d.width; // 얼마나 열려 있는지(0~1)
  const backdrop = document.getElementById("side-backdrop");
  clearDragStyle(d.el);
  backdrop.style.transition = "";
  backdrop.style.opacity = "";
  backdrop.style.pointerEvents = "";
  setDrawer(d.side, shown > 0.5);
}
document.addEventListener("pointerup", finishDrawerDrag);
document.addEventListener("pointercancel", finishDrawerDrag);
