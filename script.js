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

// 관심분야 태그별로 이 과목에 몇 점이 더해지는지(추천 사유 설명에도 쓴다)
function interestDetail(subjectItem, interests) {
  const out = [];
  interests.forEach((tag) => {
    let value = 0;
    (INTEREST_MAP[tag] || []).forEach((rule) => {
      if (!rule.areas.includes(subjectItem.area)) return;
      if (!rule.keyword) {
        value += 2;
        return;
      }
      const keywords = Array.isArray(rule.keyword) ? rule.keyword : [rule.keyword];
      if (keywords.some((k) => subjectItem.name.includes(k))) value += 2;
      else if (!rule.strict) value += 0.5;
    });
    if (value) out.push({ tag, value });
  });
  return out;
}

function interestScore(subjectItem, interests) {
  return interestDetail(subjectItem, interests).reduce((sum, d) => sum + d.value, 0);
}

// 과목 데이터: 기본은 subjects.js(대비용). Supabase에서 불러오기에 성공하면 DB 데이터로 교체한다.
//  - baseSubjects: 학교 원본(DB/로컬). 후기 화면처럼 "공식 과목 이름"이 필요한 곳에서 쓴다.
//  - subjectData : 사용자가 확인·수정한 "내 수강신청표". 추천은 이 목록으로 계산한다.
const cloneSubject = (s) => ({ ...s });
let baseSubjects = SUBJECTS.map(cloneSubject);
let subjectData = SUBJECTS.map(cloneSubject);
let subjectSource = "로컬(subjects.js)";
let catalogDeleted = 0; // 사용자가 목록에서 지운 과목 수
const catalogEditCount = () => subjectData.filter((s) => s._edit).length + catalogDeleted;

async function loadSubjectsFromDb() {
  try {
    const { data, error } = await supabaseClient.from("subjects").select("*").order("id");
    if (error || !data || data.length === 0) throw error || new Error("빈 결과");
    // DB의 과목 분류가 옛 버전(세미나·토픽이 과학/수학에 흩어진 상태)이면 맞지 않으므로 로컬 데이터를 쓴다.
    // supabase/reseed-subjects.sql 을 실행해 DB를 최신으로 맞추면 자동으로 DB 데이터를 쓴다.
    if (!data.some((r) => r.area === "과학정보수학")) throw new Error("DB 과목 분류가 최신이 아님(reseed-subjects.sql 필요)");
    const loaded = data.map((r) => ({
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
    baseSubjects = loaded;
    // 사용자가 이미 목록을 고쳤다면(네트워크가 아주 느린 경우) 고친 내용을 덮어쓰지 않는다.
    if (catalogEditCount() === 0) subjectData = loaded.map(cloneSubject);
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
function gradContext(grade, term, completed, never) {
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
    if (never && never.has(s.name)) return;
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

const fmtNum = (n) => String(Math.round(n * 10) / 10);

// 관심분야/비선호/AP 선호/선이수 과목을 반영해 학년·학기에 맞는 시간표 한 안을 구성한다.
// completed: 이전 학기에 이미 들은 과목명 Set (Ⅱ과목·실험과목의 선이수 조건 확인용)
// hourCap: 주당 시수 상한(학기별 27학점 이내 권장 기준).
// balanceMode: true면 졸업 기준(gradTargetsThisTerm)에서 요구하는 학점을 영역별로 먼저 채운 뒤 나머지를 관심 순으로 채운다.
function buildPlan(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled, hourCap, balanceMode, gradCtx, prefs) {
  // prefs.must: 꼭 들을 과목 이름 Set(모든 안에 넣는다) / prefs.never: 절대 안 들을 과목 이름 Set(후보에서 뺀다)
  const must = (prefs && prefs.must) || new Set();
  const never = (prefs && prefs.never) || new Set();

  // 이미 들은 과목(이름 기준이라 다른 학기에 같은 과목이 열려도 함께 제외)과
  // 이번 학기에 폐강된 과목, 절대 안 들을 과목은 택N·자유선택 구분 없이 후보에서 아예 뺀다.
  // 단, 선택지가 없는 필수 과목은 뺄 수 없고, 꼭 들을 과목으로도 지정했다면 꼭 들을 쪽이 이긴다.
  // 들은 과목은 아래 isEligible에서 선이수 조건을 충족한 것으로 계속 인정한다.
  const pool = subjectData.filter(
    (s) =>
      s.grade === grade &&
      s.term === term &&
      !completed.has(s.name) &&
      !cancelled.has(s.name) &&
      !(never.has(s.name) && !must.has(s.name) && !s.mandatory)
  );

  const scored = pool.map((s) => {
    const disliked = isSimilarToDislike(s.name, dislikeTerms);
    const alreadyTaken = false;
    const isMust = must.has(s.name);

    // 추천 사유로 보여줄 점수 구성(실제 점수 계산은 아래 score 식과 같은 항목이다)
    const parts = interestDetail(s, interests).map((d) => ({ label: `관심분야(${d.tag})`, value: d.value }));
    if (apPreferred === true && s.ap) parts.push({ label: "AP 선호", value: 1 });
    if (apPreferred === "avoid" && s.ap) parts.push({ label: "AP 부담 줄이기", value: -1.5 });
    const rb = ratingBonus(s.name);
    if (Math.abs(rb) >= 0.05) {
      const r = subjectRatings[s.name];
      parts.push({ label: `후기 평점 ★${r.avg.toFixed(1)}(${r.count}명)`, value: rb });
    }
    if (disliked) parts.push({ label: "비선호 단어와 비슷함", value: -3 });

    return {
      ...s,
      parts,
      hours: s.credit + (s.ap ? 1 : 0),
      disliked,
      alreadyTaken,
      must: isMust,
      score:
        (isMust ? 1000 : 0) + interestScore(s, interests) - (disliked ? 3 : 0) + (apPreferred === true && s.ap ? 1 : 0) - (apPreferred === "avoid" && s.ap ? 1.5 : 0) + ratingBonus(s.name),
    };
  });

  const picked = [];
  const pickedNames = new Set();
  let totalHours = 0;

  const why = {}; // 과목명 -> 이 안에 담은 이유 { kind, text, extra, details }
  function add(s, reason) {
    picked.push(s);
    pickedNames.add(s.name);
    totalHours += s.hours;
    why[s.name] = reason || { kind: "시수채움", text: "" };
  }

  // 이미 이수한 과목은 다시 추천하지 않되, 선이수 조건을 확인할 때는 "이수한 과목"으로 취급한다.
  function isEligible(s) {
    if (!s.requires) return true;
    return completed.has(s.requires) || pickedNames.has(s.requires);
  }

  // 1) 필수 과목은 무조건 포함
  scored
    .filter((s) => s.mandatory)
    .forEach((s) => add(s, { kind: "필수", text: "선택지가 없는 필수 과목이라 모든 안에 자동으로 들어가요." }));

  // 2) 택N 그룹: 그룹 안에서 점수 높은 순으로 N개 선택
  const groups = {};
  scored.filter((s) => s.group).forEach((s) => {
    (groups[s.group] ||= []).push(s);
  });
  Object.entries(groups).forEach(([groupId, options]) => {
    const pickCount = GROUP_PICK[groupId] || 1;
    const sorted = [...options].sort((a, b) => b.score - a.score);
    const chosen = sorted.slice(0, pickCount);
    chosen.forEach((s) => {
      const others = sorted.filter((o) => !chosen.includes(o));
      // 후보들의 점수가 같으면 "가장 높다"고 말하지 않고, 목록 앞쪽 과목을 골랐다고 솔직하게 적는다.
      const tied = others.some((o) => o.score === s.score);
      const head = `${s.area} 택${pickCount} 묶음(후보 ${options.length}개)`;
      add(s, {
        kind: s.must ? "꼭" : "택일",
        text: s.must
          ? "꼭 들을 과목으로 지정하셨어요. 같은 묶음에서 이 과목을 골랐어요."
          : tied
            ? `${head}: 후보들의 추천 점수가 같아서(관심분야·후기 차이가 없어요) 목록 앞쪽 과목을 골랐어요.`
            : pickCount === 1
              ? `${head}에서 추천 점수가 가장 높아요.`
              : `${head}에서 추천 점수가 높은 상위 ${pickCount}개 안에 들어요.`,
        extra: others.length
          ? `같은 묶음에서 밀린 후보: ${others.map((o) => `${o.name}(점수 ${fmtNum(o.score - (o.must ? 1000 : 0))})`).join(", ")}`
          : null,
      });
    });
  });

  // 2.5) 꼭 들을 과목: 시수 상한과 상관없이 먼저 담는다.
  // 선이수 과목이 이번 학기에 열려 있으면 같이 담고, 그럴 수 없으면 못 담은 이유를 알려준다.
  const notes = [];
  function forceAdd(s, depth, parent) {
    if (pickedNames.has(s.name)) return true;
    if (s.requires && !completed.has(s.requires) && !pickedNames.has(s.requires)) {
      const pre = scored.find((x) => x.name === s.requires && !x.group && !x.mandatory);
      if (!pre || depth >= 3 || !forceAdd(pre, depth + 1, s)) return false;
    }
    add(
      s,
      parent
        ? { kind: "선이수", text: `꼭 들을 과목 '${parent.name}'을 들으려면 먼저(또는 함께) 들어야 하는 선이수 과목이라 같이 담았어요.` }
        : { kind: "꼭", text: "꼭 들을 과목으로 지정하셨어요. 시수 한도와 상관없이 먼저 담았어요." }
    );
    return true;
  }
  scored
    .filter((s) => s.must && !s.mandatory && !s.group)
    .forEach((s) => {
      if (!forceAdd(s, 0))
        notes.push(`꼭 들을 과목 '${s.name}'은 선이수 과목(${s.requires})을 들은 적이 없고 이번 학기에 함께 들을 수도 없어서 담지 못했어요.`);
    });
  scored
    .filter((s) => s.must && s.group && !pickedNames.has(s.name))
    .forEach((s) => notes.push(`꼭 들을 과목 '${s.name}'은 같은 묶음에서 정해진 개수만 고를 수 있어서 담지 못했어요.`));

  // 3) 자유 선택 풀(과학/정보과학/수학/AI융합/과학정보수학/AI융합(심화)): 점수 높은 순으로 상한까지 채운다.
  // Ⅱ과목·실험과목은 "선이수 과목이 이미 완료되었거나 이번 학기에 함께 선택될 때만" 담을 수 있어서,
  // 전체 목록을 여러 번 훑으며(한 번 돌 때마다 새로 조건이 풀리는 과목이 없을 때까지) 채운다.
  const freePool = scored.filter((s) => !s.mandatory && !s.group && !s.alreadyTaken && !s.disliked);
  const freePoolByScore = [...freePool].sort((a, b) => b.score - a.score);

  // 점수순으로 채운 과목의 이유: 관심분야와 맞으면 "관심 일치", 아니면 "시수 채움"
  function fillReason(s) {
    const tags = s.parts.filter((p) => p.label.startsWith("관심분야") && p.value > 0).map((p) => p.label.slice(5, -1));
    return tags.length
      ? { kind: "관심", text: `관심분야(${tags.join("·")})와 맞는 과목이에요. 주당 시수 한도(${hourCap}) 안에서 점수가 높은 순으로 담았어요.` }
      : { kind: "시수채움", text: `관심분야에 직접 맞지는 않지만, 주당 시수 한도(${hourCap}) 안에서 추천 점수가 높은 순으로 남은 자리를 채웠어요.` };
  }

  function fillLoop(candidates) {
    let addedSomething = true;
    while (addedSomething) {
      addedSomething = false;
      for (const s of candidates) {
        if (pickedNames.has(s.name)) continue;
        if (!isEligible(s)) continue;
        if (totalHours + s.hours > hourCap) continue;
        add(s, fillReason(s));
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
          const rule = GRADUATION_MIN_CREDITS.find((r) => r.areas.includes(area));
          add(next, {
            kind: "졸업기준",
            text: `졸업 기준(${rule ? rule.label : area})을 따라가려면 이번 학기에 '${area}' 영역을 ${need[area]}학점 이상 담아야 해서, 이 영역 과목 중 점수가 높은 순으로 골랐어요.`,
          });
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
  const overloaded = totalHours > 36;
  if (overloaded) notes.push(`주당 시수가 ${totalHours}로 일주일 36시수를 넘어요. 꼭 들을 과목을 줄여보세요.`);

  // "자세히" 탭에 보여줄 세부 사유
  picked.forEach((s) => {
    const w = why[s.name] || { kind: "시수채움", text: "" };
    const d = [];
    if (s.mandatory) {
      d.push("선택지가 없는 필수 과목이라 점수와 상관없이 모든 안에 들어가요.");
    } else {
      const shown = s.score - (s.must ? 1000 : 0);
      if (s.must) d.push("꼭 들을 과목으로 지정해서 점수·시수 한도와 상관없이 넣었어요.");
      d.push(
        s.parts.length
          ? `추천 점수 ${fmtNum(shown)} = ${s.parts.map((p) => `${p.label} ${p.value > 0 ? "+" : ""}${fmtNum(p.value)}`).join(" · ")}`
          : `추천 점수 ${fmtNum(shown)} (관심분야·AP·후기에서 더해진 점수가 없어요)`
      );
    }
    d.push(`주당 시수 ${s.hours} = 학점 ${s.credit}${s.ap ? " + AP 1시수" : ""}`);
    if (s.requires) d.push(`선이수 ${s.requires}: ${completed.has(s.requires) ? "이전 학기에 들어서 충족돼요." : "이번 안에서 함께 들어서 충족돼요."}`);
    const r = subjectRatings[s.name];
    if (r) d.push(`후기 평균 ★${r.avg.toFixed(1)} (${r.count}명)`);
    GRADUATION_MIN_CREDITS.filter((g) => g.areas.includes(s.area)).forEach((g) =>
      d.push(`졸업 기준 '${g.label}'에 ${s.credit}학점이 보태져요.`)
    );
    if (w.extra) d.push(w.extra);
    w.details = d;
    why[s.name] = w;
  });

  return {
    subjects: picked,
    totalHours,
    totalCredits,
    freeHours: Math.max(0, 36 - totalHours),
    areaCredits,
    grad,
    notes,
    why,
    overloaded,
    infeasible: overloaded || grad.some((g) => g.status === "impossible"),
  };
}

// 여러 후보 시간표를 만들어, 졸업 기준을 채울 수 없게 되는 안은 버리고 남은 안 중에서 고른다.
// 만족하는 안이 하나도 없으면 "불가능한 묶음이 가장 적은 안"을 경고와 함께 보여준다.
function generatePlans(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled, prefs) {
  const gradCtx = gradContext(grade, term, completed, prefs && prefs.never);
  const attempts = [
    { label: "균형 잡힌 시간표", hourCap: 27, balanceMode: true, desc: "졸업 기준에서 이번 학기에 필요한 영역을 먼저 채우고, 남는 시수를 관심분야 점수가 높은 순으로 채운 안이에요." },
    { label: "관심 집중형 시간표", hourCap: 27, balanceMode: false, desc: "졸업 기준 영역을 따로 챙기지 않고 관심분야 점수가 높은 과목을 우선해서 담은 안이에요. 그래도 졸업 기준을 채울 수 없게 되는 안은 걸러요." },
    { label: "여유로운 시간표", hourCap: 24, balanceMode: true, desc: "주당 시수 한도를 24로 낮춰 공강을 늘린 안이에요. 졸업 기준에서 필요한 영역은 먼저 채워요." },
    { label: "여유로운 시간표", hourCap: 21, balanceMode: true, desc: "주당 시수 한도를 21로 낮춰 공강을 더 늘린 안이에요. 졸업 기준에서 필요한 영역은 먼저 채워요." },
  ];
  // AP 과목(주당 시수가 1 더 듦)을 원하지 않는 사용자에게는 AP 부담을 줄인 안도 후보에 넣는다.
  if (apPreferred !== true) {
    const apDesc = "AP 과목(학점보다 주 1시수가 더 듦)의 점수를 낮춰서 부담을 줄인 안이에요.";
    attempts.push({ label: "AP 부담을 줄인 시간표", hourCap: 27, balanceMode: true, ap: "avoid", desc: apDesc });
    attempts.push({ label: "AP 부담을 줄인 시간표", hourCap: 24, balanceMode: true, ap: "avoid", desc: apDesc });
  }

  const candidates = attempts.map((a) => ({
    ...a,
    plan: buildPlan(grade, term, interests, dislikeTerms, a.ap || apPreferred, completed, cancelled, a.hourCap, a.balanceMode, gradCtx, prefs),
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
    <details class="plan-card grad-card">
      <summary class="plan-card__header grad-summary">
        <span class="plan-card__title">졸업 최소이수학점 기준</span>
        <span class="grad-summary__hint">눌러서 보기</span>
      </summary>
      ${rows}
      ${hint}
      <p class="grad-footnote">기준은 4개 학기(2학년1학기~3학년2학기) 누적이에요. 위 안들은 "지금까지 들은 학점 + 이번 안 + 앞으로 들을 수 있는 학점"으로 졸업이 불가능해지는 경우를 걸러낸 거예요.</p>
    </details>
  `;
}

function renderPlan(plan, label, desc) {
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
          const mustTag = s.must ? '<span class="must-tag">꼭</span>' : "";
          return `<span class="plan-subject${s.ap ? " is-ap" : ""}${s.must ? " is-must" : ""}">${mustTag}${escapeHtml(s.name)}(${s.credit})${s.ap ? '<span class="ap-tag">AP</span>' : ""}${star}</span>`;
        })
        .join("");
      return `<div class="plan-area"><div class="plan-area__name">${area}</div><div class="plan-subject-list">${subjectsHtml}</div></div>`;
    })
    .join("");

  // "자세히" 탭: 과목마다 한 줄 이유 + 눌러서 펼치는 세부 항목
  const kindLabel = { 필수: "필수 과목", 꼭: "꼭 들을 과목", 선이수: "선이수 동반", 택일: "택일 선택", 졸업기준: "졸업 기준", 관심: "관심 일치", 시수채움: "시수 채움" };
  const kindClass = { 필수: "mandatory", 꼭: "must", 선이수: "prereq", 택일: "group", 졸업기준: "grad", 관심: "interest", 시수채움: "fill" };
  const detailRows = AREA_ORDER.filter((area) => byArea[area])
    .map((area) => {
      const rows = byArea[area]
        .map((s) => {
          const w = (plan.why && plan.why[s.name]) || { kind: "시수채움", text: "", details: [] };
          return `<details class="why-item"><summary><span class="why-item__head"><span class="why-item__name">${escapeHtml(s.name)}<small>${s.credit}학점${s.ap ? " · AP" : ""}</small></span><span class="why-kind is-${kindClass[w.kind] || "fill"}">${kindLabel[w.kind] || w.kind}</span></span><span class="why-item__text">${escapeHtml(w.text)}</span></summary><ul class="why-list">${(w.details || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></details>`;
        })
        .join("");
      return `<div class="plan-area"><div class="plan-area__name">${area}</div>${rows}</div>`;
    })
    .join("");
  const detailHtml = `<div class="why-intro">${escapeHtml(desc || "")}</div><button type="button" class="why-toggle-all">모두 펼치기</button>${detailRows}`;

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

  const notesHtml =
    plan.notes && plan.notes.length
      ? `<div class="plan-notes">${plan.notes.map((n) => `<div class="grad-warn">⚠ ${escapeHtml(n)}</div>`).join("")}</div>`
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
        <span class="plan-card__badge${plan.infeasible ? " is-bad" : ""}">${plan.overloaded ? "36시수 초과" : plan.infeasible ? "졸업 기준 미달" : "추천안"}</span>
      </div>
      <button type="button" class="plan-detail-btn" data-go="detail">🔍 과목별 추천 이유 자세히 보기</button>
      <div class="plan-stats">
        <div class="plan-stat"><strong>${plan.totalCredits}</strong><span>이수학점</span></div>
        <div class="plan-stat"><strong>${plan.totalHours}</strong><span>주당 시수</span></div>
        <div class="plan-stat"><strong>${plan.freeHours}</strong><span>공강 시수</span></div>
        <div class="plan-stat"><strong>${avgRating === "-" ? "-" : "★" + avgRating}</strong><span>평균 별점</span></div>
      </div>
      ${notesHtml}
      ${violationHtml}
      <div class="plan-tabs" role="tablist">
        <button type="button" class="plan-tab is-active" role="tab" aria-selected="true" data-pane="list">추천 과목</button>
        <button type="button" class="plan-tab" role="tab" aria-selected="false" data-pane="detail">자세히</button>
      </div>
      <div class="plan-pane" data-pane="list">${areaHtml}</div>
      <div class="plan-pane" data-pane="detail" hidden>${detailHtml}</div>
    </div>
  `;
}

const screens = {
  start: document.getElementById("screen-start"),
  upload: document.getElementById("screen-upload"),
  review: document.getElementById("screen-review"),
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
  if (pendingResume) {
    nudgeResume();
    return;
  }
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
  subjectsReady.then(openReviewScreen);
});

document.getElementById("btn-skip-upload").addEventListener("click", () => {
  subjectsReady.then(openReviewScreen);
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

// 화면3: 수강신청표
//  - 이전 학기 과목: 클릭하면 "들은 과목"으로 표시/해제
//  - 이번 학기 과목: 클릭할 때마다 폐강 → 꼭 들을 과목 → 절대 안 들을 과목 → 해제 순서로 바뀐다
const catalogEl = document.getElementById("catalog");
const takenNames = new Set(); // 들은 과목: 이름 기준(다른 학기에 같은 과목이 열려도 함께 적용)
const cancelledKeys = new Set(); // 폐강: "학년-학기|과목명" 기준(폐강은 그 학기에만 해당)
const mustKeys = new Set(); // 꼭 들을 과목: "학년-학기|과목명" 기준
const neverNames = new Set(); // 절대 안 들을 과목: 이름 기준(어느 학기든 추천하지 않는다)

function selectedGradeTerm() {
  return {
    grade: document.getElementById("select-grade").value === "2학년" ? 2 : 3,
    term: document.getElementById("select-term").value === "1학기" ? 1 : 2,
  };
}
const termIndex = (grade, term) => (grade - 2) * 2 + term;
const cancelKey = (grade, term, name) => `${grade}-${term}|${name}`;
const keyName = (k) => k.slice(k.indexOf("|") + 1);

// 칩 한 개의 현재 지정 상태. 폐강 > 꼭 들음 > 절대 안 들음 > 없음 순으로 보여준다.
function prefState(g, t, name) {
  const k = cancelKey(g, t, name);
  if (cancelledKeys.has(k)) return "cancelled";
  if (mustKeys.has(k)) return "must";
  if (neverNames.has(name)) return "never";
  return "none";
}

// 클릭 한 번마다 다음 상태로 넘어간다: 없음 → 폐강 → 꼭 들음 → 절대 안 들음 → 없음
// 선택지 없이 자동으로 들어가는 필수 과목은 "꼭/절대"가 의미 없어서 없음 ↔ 폐강만 오간다.
function nextPrefState(state, mandatory) {
  if (mandatory) return state === "cancelled" ? "none" : "cancelled";
  return { none: "cancelled", cancelled: "must", must: "never", never: "none" }[state];
}

function applyPrefState(g, t, name, state) {
  const k = cancelKey(g, t, name);
  cancelledKeys.delete(k);
  mustKeys.delete(k);
  if (state === "cancelled") cancelledKeys.add(k);
  else if (state === "must") mustKeys.add(k);
  else if (state === "never") neverNames.add(name);
  else neverNames.delete(name);
}

function renderCatalog() {
  const { grade: selGrade, term: selTerm } = selectedGradeTerm();
  const selIdx = termIndex(selGrade, selTerm);
  const priorNames = new Set(subjectData.filter((s) => termIndex(s.grade, s.term) < selIdx).map((s) => s.name));
  const stateCls = { cancelled: " is-cancelled", must: " is-must", never: " is-never", none: "" };
  const stateTitle = { cancelled: "폐강", must: "꼭 들을 과목", never: "절대 안 들을 과목", none: "" };
  let html = "";

  for (const [g, t] of [[2, 1], [2, 2], [3, 1], [3, 2]]) {
    const idx = termIndex(g, t);
    if (idx > selIdx) continue;
    const isCurrent = idx === selIdx;
    const inTerm = subjectData.filter((s) => s.grade === g && s.term === t);
    const chips = AREA_ORDER.map((area) => {
      const items = inTerm.filter((s) => s.area === area);
      if (!items.length) return "";
      const chipHtml = items
        .map((s) => {
          const taken = !isCurrent && takenNames.has(s.name);
          // 이전 학기에 이미 들은 과목이 이번 학기에 또 열려 있으면 어차피 추천에서 빠지므로 눌러도 바뀌지 않게 한다.
          const done = isCurrent && priorNames.has(s.name) && takenNames.has(s.name);
          const state = isCurrent && !done ? prefState(g, t, s.name) : "none";
          const cls = `cat-chip${taken ? " is-taken" : ""}${done ? " is-done" : ""}${stateCls[state]}`;
          const title = done ? "이미 들은 과목이라 추천에서 빠져요" : stateTitle[state];
          return `<button type="button" class="${cls}" data-grade="${g}" data-term="${t}" data-name="${escapeHtml(s.name)}" data-current="${isCurrent}" data-mandatory="${s.mandatory ? 1 : 0}"${title ? ` title="${title}"` : ""}>${escapeHtml(s.name)}(${s.credit})${s.ap ? "*" : ""}</button>`;
        })
        .join("");
      return `<div class="cat-area"><span class="cat-area__name">${area}</span><div class="cat-chips">${chipHtml}</div></div>`;
    }).join("");
    const label = isCurrent ? `${g}학년 ${t}학기 · 이번 학기` : `${g}학년 ${t}학기 · 들은 과목은 클릭`;
    html += `<div class="cat-term${isCurrent ? " is-current" : ""}"><div class="cat-term__title">${label}</div>${chips}</div>`;
  }
  catalogEl.innerHTML = html;
}

catalogEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".cat-chip");
  if (!chip || chip.classList.contains("is-done")) return;
  const { grade, term, name } = chip.dataset;
  if (chip.dataset.current === "true") {
    const g = Number(grade);
    const t = Number(term);
    applyPrefState(g, t, name, nextPrefState(prefState(g, t, name), chip.dataset.mandatory === "1"));
  } else if (takenNames.has(name)) {
    takenNames.delete(name);
  } else {
    takenNames.add(name);
  }
  renderCatalog(); // 같은 이름의 과목이 다른 학기 칸에도 있으면 함께 표시를 바꾼다
});

document.getElementById("select-grade").addEventListener("change", renderCatalog);
document.getElementById("select-term").addEventListener("change", renderCatalog);
subjectsReady.then(renderCatalog);
renderCatalog();

// 화면4 -> 화면5(로딩) -> 실제 추천 계산 -> 결과
const resultContent = document.getElementById("result-content");
const resultPlaceholderHtml = resultContent.innerHTML;

let runId = 0; // 홈으로 나가거나 다시 시작하면 값을 올려서, 계산 중이던 추천이 나중에 화면을 덮어쓰지 못하게 한다

function runRecommendation() {
  showScreen("loading");
  const myRun = ++runId;

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
  const prefix = `${grade}-${term}|`;
  const cancelled = new Set([...cancelledKeys].filter((k) => k.startsWith(prefix)).map(keyName));
  const must = new Set([...mustKeys].filter((k) => k.startsWith(prefix)).map(keyName).filter((n) => !completed.has(n)));
  const never = new Set(neverNames);

  // 실제 계산은 짧게 지연시켜 로딩 화면이 보이도록 한다.
  Promise.all([subjectsReady, ratingsReady, new Promise((r) => setTimeout(r, 900))]).then(() => {
    if (myRun !== runId) return; // 그 사이에 홈으로 나갔거나 다시 시작했다면 결과를 띄우지 않는다
    // 여러 안을 만들어보고 졸업 기준(담을 수 있었는데 0학점인 영역)을 어기는 안은 버린 뒤,
    // 기준을 통과한 안 중에서 최종 2개를 고른다.
    const plans = generatePlans(grade, term, interests, dislikeTerms, apPreferred, completed, cancelled, { must, never });

    resultContent.innerHTML =
      plans.map((c, i) => renderPlan(c.plan, `추천안 ${i + 1} · ${c.label}`, c.desc)).join("") +
      renderGraduationRef(gradContext(grade, term, completed));

    showScreen("result");
    // 추천안이 바로 보이도록 맨 위로
    document.querySelectorAll("#screen-result, #screen-result .screen__body, #result-content").forEach((el) => (el.scrollTop = 0));
  });
}

submitBtn.addEventListener("click", () => {
  if (submitBtn.disabled) return;
  runRecommendation();
});

updateSubmitState();
updateUploadState();

// ── 넓은 화면 양옆 패널: 입력 요약 / 과목 검색 ──────────────────────
const stepNames = { "screen-start": "시작", "screen-upload": "① 사진 업로드", "screen-review": "② 수강신청표 확인", "screen-input": "③ 정보 입력", "screen-loading": "추천 계산 중", "screen-result": "④ 추천 결과", "screen-write": "후기 남기기", "screen-reviews": "후기 열람" };

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
  document.getElementById("sum-must").textContent = `${[...mustKeys].filter((k) => k.startsWith(`${grade}-${term}|`)).length}개`;
  document.getElementById("sum-never").textContent = `${neverNames.size}개`;
  document.getElementById("sum-edits").textContent = `${catalogEditCount()}건`;
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
            ${interestBoxHtml(done)}
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
    item.querySelector(".rate-teacher").value,
    readInterestBox(item.querySelector(".interest-box"))
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

// ── 후기에 함께 남기는 "내 흥미/관심 분야" ─────────────────────────────
// 후기를 읽는 사람이 "이 사람은 이 과목에 흥미가 있던 사람인지, 어떤 분야를 좋아하는 사람인지"를 참고할 수 있게 한다.
const INTEREST_TAGS = ["수학", "물리", "화학", "생명과학", "정보과학", "인문사회", "예술", "체육"];
const MY_INTERESTS_KEY = "dshs_my_interests";

// 처음 후기를 쓸 때는 추천 입력에서 고른 관심분야를 미리 체크해 주고, 한 번 남긴 뒤에는 마지막으로 고른 값을 기억한다.
function getMyInterests() {
  try {
    const saved = JSON.parse(localStorage.getItem(MY_INTERESTS_KEY) || "null");
    if (Array.isArray(saved)) return saved.filter((t) => INTEREST_TAGS.includes(t));
  } catch (e) {
    /* 저장소가 막힌 브라우저 */
  }
  return Array.from(document.querySelectorAll(".chip.selected")).map((c) => c.dataset.tag);
}

function saveMyInterests(list) {
  try {
    localStorage.setItem(MY_INTERESTS_KEY, JSON.stringify(list));
  } catch (e) {
    /* 저장소가 막힌 브라우저 */
  }
}

function interestBoxHtml(disabled, checked, interested) {
  // 이미 평가한 과목은 무엇을 골랐었는지 다시 보여줄 수 없으니(오해 방지) 체크란을 아예 숨긴다.
  if (disabled) return "";
  const on = checked || getMyInterests();
  const dis = "";
  return `<div class="interest-box">
    <label class="interest-flag-row"><input type="checkbox" class="interest-flag" ${interested ? "checked" : ""} ${dis}> 이 과목에 원래 흥미가 있었어요</label>
    <div class="interest-box__label">내 관심 분야 <span>후기를 읽는 사람이 참고해요</span></div>
    <div class="interest-chips">${INTEREST_TAGS.map(
      (t) => `<label class="int-chip"><input type="checkbox" class="interest-tag" value="${t}" ${on.includes(t) ? "checked" : ""} ${dis}><span>${t}</span></label>`
    ).join("")}</div>
  </div>`;
}

function readInterestBox(box) {
  return {
    interested: box.querySelector(".interest-flag").checked,
    interests: [...box.querySelectorAll(".interest-tag:checked")].map((c) => c.value),
  };
}

// DB에 아직 없는 선택 열(teacher / interested / interests)은 오류 문구에서 찾아내 빼고 다시 시도하는 데 쓴다.
const OPTIONAL_REVIEW_COLUMNS = ["teacher", "interested", "interests"];
function missingOptionalColumns(error, cols) {
  const text = `${error.message || ""} ${error.details || ""}`;
  return cols.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
}

// 별점 저장(공통): DB에 넣고, 성공하면 화면의 평균과 "이미 평가함" 기록을 갱신한다.
async function saveReview(name, rating, comment, teacherInput, extra) {
  const teacher = cleanTeacher(teacherInput) || null;
  const interests = ((extra && extra.interests) || []).filter((t) => INTEREST_TAGS.includes(t));
  const row = {
    subject_name: name,
    rating,
    comment: comment || null,
    teacher,
    interested: !!(extra && extra.interested),
    interests: interests.length ? interests.join(",") : null,
  };
  let { error } = await supabaseClient.from("reviews").insert(row);

  // DB에 새 열이 아직 없으면(supabase/teacher.sql, interest.sql 실행 전) 없는 열만 빼고 다시 저장한다.
  for (let tries = 0; error && tries < 3; tries++) {
    const missing = missingOptionalColumns(error, OPTIONAL_REVIEW_COLUMNS).filter((c) => c in row);
    if (!missing.length) break;
    console.warn(`DB에 ${missing.join(", ")} 열이 아직 없어 그 항목 없이 저장합니다:`, error.message);
    missing.forEach((c) => delete row[c]);
    ({ error } = await supabaseClient.from("reviews").insert(row));
  }
  if (error) {
    console.warn("별점 저장 실패:", error);
    return { ok: false, error };
  }
  saveMyInterests(interests);

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
const writeInterest = document.getElementById("write-interest");
let writeSelected = null;
let writeRating = 0;

function uniqueSubjectNames() {
  return [...new Set(baseSubjects.map((s) => s.name))];
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
  writeInterest.innerHTML = interestBoxHtml(done);
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
    document.getElementById("write-teacher").value,
    readInterestBox(writeInterest.querySelector(".interest-box"))
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
const reviewsInterest = document.getElementById("reviews-interest");
const reviewsCompare = document.getElementById("reviews-compare");
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

  let cols = ["subject_name", "rating", "comment", "teacher", "interested", "interests", "created_at"];
  let { data, error } = await query(cols.join(","));
  // 새 열이 아직 없으면(teacher.sql, interest.sql 실행 전) 없는 열만 빼고 다시 읽는다.
  for (let tries = 0; error && tries < 3; tries++) {
    const missing = missingOptionalColumns(error, OPTIONAL_REVIEW_COLUMNS).filter((c) => cols.includes(c));
    if (!missing.length) break;
    cols = cols.filter((c) => !missing.includes(c));
    ({ data, error } = await query(cols.join(",")));
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
  const interest = reviewsInterest.value;
  const areaOf = {};
  baseSubjects.forEach((s) => (areaOf[s.name] = areaOf[s.name] || s.area));
  const interestsOf = (r) => (r.interests ? r.interests.split(",").filter(Boolean) : []);

  const rows = reviewsData.filter(
    (r) =>
      (!q || normalizeName(r.subject_name).includes(q)) &&
      (!t || (r.teacher || "").includes(t)) &&
      (!area || areaOf[r.subject_name] === area) &&
      (!interest || interestsOf(r).includes(interest))
  );

  const names = new Set(rows.map((r) => r.subject_name));
  const teachers = new Set(rows.map((r) => r.teacher).filter(Boolean));
  reviewsBreakdown.innerHTML = "";
  reviewsCompare.innerHTML = "";
  if (!rows.length) {
    reviewsSummary.textContent = "";
  } else {
    const avg = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
    const scope = [t ? `${escapeHtml(t)} 선생님` : "", interest ? `관심 ${escapeHtml(interest)}` : "", names.size > 1 ? `과목 ${names.size}개` : ""].filter(Boolean).join(" · ");
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

    // 한 과목만 보고 있을 때, 그 과목에 흥미가 있던 사람과 아닌 사람의 평균을 나란히 보여줘서 후기를 해석하는 데 참고하게 한다.
    if (names.size === 1) {
      const keen = rows.filter((r) => r.interested === true);
      const rest = rows.filter((r) => r.interested === false);
      const mean = (list) => (list.reduce((sum, r) => sum + r.rating, 0) / list.length).toFixed(1);
      if (keen.length) {
        reviewsCompare.innerHTML = `흥미가 있던 사람 <b>★${mean(keen)}</b> (${keen.length}명)${rest.length ? ` · 그 외 <b>★${mean(rest)}</b> (${rest.length}명)` : ""}`;
      }
    }
  }

  reviewsList.innerHTML = rows.length
    ? rows
        .map((r) => {
          const date = new Date(r.created_at).toLocaleDateString("ko-KR");
          const comment = r.comment ? `<p class="review-card__comment">${escapeHtml(r.comment)}</p>` : "";
          const teacher = r.teacher ? `<span class="review-card__teacher">${escapeHtml(r.teacher)} 선생님</span>` : "";
          const extra = areaOf[r.subject_name] ? "" : '<span class="review-card__tag">목록 외 과목</span>';
          const keen = r.interested === true ? '<span class="review-card__tag is-interest">흥미 있었음</span>' : "";
          const tags = interestsOf(r);
          const mine = tags.length
            ? `<div class="review-card__interest">작성자 관심 분야 · ${tags.map((x) => escapeHtml(x)).join(" · ")}</div>`
            : "";
          return `<div class="review-card"><div class="review-card__top"><span class="review-card__name">${escapeHtml(r.subject_name)}${extra}${keen}${teacher}</span>
            <span class="review-card__stars">${starsHtml(r.rating)}</span></div>${comment}${mine}
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
INTEREST_TAGS.forEach((t) => reviewsInterest.add(new Option(`관심 분야: ${t}`, t)));
reviewsInterest.addEventListener("change", renderReviews);

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

// ── 수강신청표 확인·수정 화면 ──────────────────────────────────
// 추천을 만들기 전에 과목 목록을 사용자가 한 번 확인하고 틀린 곳을 직접 고치게 해서, 잘못 옮겨진 과목이 추천에 섞이는 걸 막는다.
// (지금은 사진 글자를 자동으로 읽지 않고 학교 수강신청표 데이터를 불러와 보여준다. 자동 인식이 붙어도 이 화면에서 같은 방식으로 고친다.)
const TERM_LIST = [[2, 1], [2, 2], [3, 1], [3, 2]];
const rvTabs = document.getElementById("review-tabs");
const rvList = document.getElementById("review-list");
const rvSummary = document.getElementById("review-summary");
const rvPhotos = document.getElementById("review-photos");
let rvTerm = "2-1";
let uidSeq = 0;

function resetCatalogToBase() {
  subjectData = baseSubjects.map(cloneSubject);
  catalogDeleted = 0;
}

// 선이수 입력칸 자동완성에 쓰는 과목 이름 목록
function refreshNameList() {
  const names = [...new Set(subjectData.map((s) => s.name))];
  document.getElementById("subject-names").innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join("");
}

function refreshAfterCatalogChange() {
  refreshNameList();
  renderReviewTabs();
  renderReviewList();
  renderSearch();
  renderCatalog();
  updateSummary();
}

function renderReviewPhotos() {
  rvPhotos.hidden = photos.length === 0;
  rvPhotos.innerHTML = photos.length
    ? photos
        .map((p, i) => `<button type="button" class="review-photo" data-id="${p.id}" aria-label="사진 ${i + 1} 크게 보기"><img src="${p.dataUrl}" alt="수강신청표 사진 ${i + 1}"><span>${i + 1}</span></button>`)
        .join("") + '<span class="review-photos__hint">눌러서 크게 보면서<br>목록과 비교해 보세요</span>'
    : "";
}

function renderReviewTabs() {
  rvTabs.innerHTML = TERM_LIST.map(([g, t]) => {
    const key = `${g}-${t}`;
    const n = subjectData.filter((s) => s.grade === g && s.term === t).length;
    return `<button type="button" class="term-tab${key === rvTerm ? " is-active" : ""}" data-term="${key}">${g}학년 ${t}학기<span>${n}</span></button>`;
  }).join("");
}

function renderReviewList() {
  const [g, t] = rvTerm.split("-").map(Number);
  const items = subjectData.filter((s) => s.grade === g && s.term === t);
  const credits = items.reduce((sum, s) => sum + s.credit, 0);
  const edits = catalogEditCount();
  rvSummary.textContent = `${items.length}과목 · 학점 합계 ${credits}` + (edits ? ` · 지금까지 고친 곳 ${edits}건` : "");

  const body = AREA_ORDER.map((area) => {
    const rows = items.filter((s) => s.area === area);
    if (!rows.length) return "";
    const rowsHtml = rows
      .map((s) => {
        const badge =
          s._edit === "added" ? '<span class="rv-badge is-new">추가됨</span>' : s._edit === "edited" ? '<span class="rv-badge">수정됨</span>' : "";
        const meta = [
          `${s.credit}학점`,
          s.ap ? `AP(시수 ${s.credit + 1})` : "",
          s.requires ? `선이수 ${escapeHtml(s.requires)}` : "",
          s.mandatory ? "필수" : "",
          s.group ? "택일" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<button type="button" class="rv-row" data-id="${escapeHtml(s.id)}"><span class="rv-row__main"><span class="rv-row__name">${escapeHtml(s.name)}</span>${badge}</span><span class="rv-row__meta">${meta}</span><span class="rv-row__edit">고치기 ›</span></button>`;
      })
      .join("");
    return `<div class="rv-area"><div class="rv-area__name">${area}</div>${rowsHtml}</div>`;
  }).join("");
  rvList.innerHTML = body || '<p class="reviews-empty">이 학기에는 과목이 없어요. "+ 과목 추가"로 넣어주세요.</p>';
}

function openReviewScreen() {
  refreshNameList();
  renderReviewPhotos();
  renderReviewTabs();
  renderReviewList();
  showScreen("review");
}

rvTabs.addEventListener("click", (e) => {
  const b = e.target.closest(".term-tab");
  if (!b) return;
  rvTerm = b.dataset.term;
  renderReviewTabs();
  renderReviewList();
});
rvList.addEventListener("click", (e) => {
  const r = e.target.closest(".rv-row");
  if (r) openEditor(r.dataset.id);
});
document.getElementById("review-add").addEventListener("click", () => openEditor(null));
document.getElementById("btn-review-next").addEventListener("click", () => {
  renderCatalog();
  showScreen("input");
});
document.getElementById("btn-edit-catalog").addEventListener("click", () => subjectsReady.then(openReviewScreen));

// 사진 크게 보기(수강신청표와 목록을 비교할 때 쓴다)
const lightbox = document.getElementById("photo-lightbox");
const lightboxImg = document.getElementById("lightbox-img");
function openLightbox(src) {
  lightboxImg.src = src;
  lightboxImg.classList.remove("is-zoom");
  lightbox.hidden = false;
}
function closeLightbox() {
  lightbox.hidden = true;
}
rvPhotos.addEventListener("click", (e) => {
  const b = e.target.closest(".review-photo");
  const p = b && photos.find((x) => x.id === b.dataset.id);
  if (p) openLightbox(p.dataUrl);
});
lightboxImg.addEventListener("click", () => lightboxImg.classList.toggle("is-zoom"));
document.getElementById("lightbox-close").addEventListener("click", closeLightbox);

// 과목 고치기 / 추가 / 삭제
const edSheet = document.getElementById("ed-sheet");
const edDeleteBtn = document.getElementById("ed-delete");
const edMsg = document.getElementById("ed-msg");
let edTarget = null; // 고치는 과목의 id (null이면 새로 추가)
let edDeleteArmed = false;
let edDeleteTimer = null;

AREA_ORDER.forEach((a) => document.getElementById("ed-area").add(new Option(a, a)));

function setEdMsg(text, isError) {
  edMsg.textContent = text;
  edMsg.classList.toggle("is-error", !!isError);
}

function disarmDelete() {
  edDeleteArmed = false;
  clearTimeout(edDeleteTimer);
  edDeleteBtn.textContent = "삭제";
  edDeleteBtn.classList.remove("is-armed");
}

function openEditor(id) {
  const s = id ? subjectData.find((x) => x.id === id) : null;
  edTarget = s ? s.id : null;
  const [tg, tt] = rvTerm.split("-").map(Number);
  document.getElementById("ed-title").textContent = s ? "과목 고치기" : "과목 추가";
  document.getElementById("ed-name").value = s ? s.name : "";
  document.getElementById("ed-credit").value = String(s ? s.credit : 2);
  document.getElementById("ed-area").value = s ? s.area : AREA_ORDER[0];
  document.getElementById("ed-grade").value = String(s ? s.grade : tg);
  document.getElementById("ed-term").value = String(s ? s.term : tt);
  document.getElementById("ed-requires").value = s && s.requires ? s.requires : "";
  document.getElementById("ed-ap").checked = !!(s && s.ap);
  document.getElementById("ed-info").textContent = s
    ? [s.mandatory ? "필수 과목: 선택지 없이 모든 안에 자동으로 들어가요." : "", s.group ? "택일 과목: 같은 묶음에서 정해진 개수만 골라요." : ""].filter(Boolean).join(" ")
    : "새로 추가한 과목은 자유롭게 고르는 과목으로 들어가요.";
  setEdMsg("");
  disarmDelete();
  edDeleteBtn.hidden = !s;
  edSheet.hidden = false;
}

function closeEditor() {
  edSheet.hidden = true;
  edTarget = null;
  disarmDelete();
}

function readEditor() {
  const clean = (v) => v.trim().replace(/\s+/g, " ");
  const d = {
    name: clean(document.getElementById("ed-name").value),
    credit: Number(document.getElementById("ed-credit").value),
    area: document.getElementById("ed-area").value,
    grade: Number(document.getElementById("ed-grade").value),
    term: Number(document.getElementById("ed-term").value),
    requires: clean(document.getElementById("ed-requires").value),
    ap: document.getElementById("ed-ap").checked,
    msg: "",
  };
  if (!d.name) d.msg = "과목 이름을 적어주세요.";
  else if (/[<>"'&|`\\]/.test(d.name)) d.msg = "이름에 쓸 수 없는 문자(< > \" ' & | ` \\)가 있어요.";
  else if (subjectData.some((s) => s.id !== edTarget && s.grade === d.grade && s.term === d.term && s.name === d.name))
    d.msg = "같은 학기에 이미 있는 과목이에요.";
  else if (d.requires && d.requires === d.name) d.msg = "자기 자신을 선이수 과목으로 둘 수 없어요.";
  else if (d.requires && !subjectData.some((s) => s.id !== edTarget && s.name === d.requires))
    d.msg = "선이수 과목이 목록에 없어요. 목록에 있는 이름을 골라주세요.";
  return d;
}

// 과목 이름을 바꿨을 때 들은 과목·폐강·꼭/절대 표시·선이수가 새 이름을 따라가게 한다.
// (같은 이름의 과목이 다른 학기에 남아 있으면 그 과목은 그대로이니 건드리지 않는다.)
function renameRefs(oldName, newName) {
  if (subjectData.some((s) => s.name === oldName)) return;
  if (takenNames.delete(oldName)) takenNames.add(newName);
  if (neverNames.delete(oldName)) neverNames.add(newName);
  [cancelledKeys, mustKeys].forEach((set) => {
    [...set].forEach((k) => {
      if (keyName(k) === oldName) {
        set.delete(k);
        set.add(`${k.slice(0, k.indexOf("|"))}|${newName}`);
      }
    });
  });
  subjectData.forEach((s) => {
    if (s.requires === oldName) s.requires = newName;
  });
}

function saveEditor() {
  const d = readEditor();
  if (d.msg) {
    setEdMsg(d.msg, true);
    return;
  }
  const target = edTarget ? subjectData.find((x) => x.id === edTarget) : null;
  if (target) {
    const old = { name: target.name, grade: target.grade, term: target.term };
    // 다른 학기로 옮겼다면 옛 학기에 걸어 둔 폐강/꼭 들음 표시는 지운다.
    if (old.grade !== d.grade || old.term !== d.term) {
      cancelledKeys.delete(cancelKey(old.grade, old.term, old.name));
      mustKeys.delete(cancelKey(old.grade, old.term, old.name));
    }
    Object.assign(target, { name: d.name, credit: d.credit, ap: d.ap, area: d.area, grade: d.grade, term: d.term, requires: d.requires || null });
    if (target._edit !== "added") target._edit = "edited";
    if (old.name !== d.name) renameRefs(old.name, d.name);
  } else {
    subjectData.push({
      id: `u${++uidSeq}`,
      name: d.name,
      credit: d.credit,
      ap: d.ap,
      area: d.area,
      grade: d.grade,
      term: d.term,
      group: null,
      mandatory: false,
      requires: d.requires || null,
      _edit: "added",
    });
  }
  rvTerm = `${d.grade}-${d.term}`; // 고친 과목이 있는 학기 탭으로 보여준다
  closeEditor();
  refreshAfterCatalogChange();
}

function deleteSubject(id) {
  const idx = subjectData.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [s] = subjectData.splice(idx, 1);
  if (s._edit !== "added") catalogDeleted++;
  cancelledKeys.delete(cancelKey(s.grade, s.term, s.name));
  mustKeys.delete(cancelKey(s.grade, s.term, s.name));
  if (!subjectData.some((x) => x.name === s.name)) {
    takenNames.delete(s.name);
    neverNames.delete(s.name);
    // 지운 과목이 더는 없다면, 그 과목을 선이수로 걸어 둔 과목이 영원히 못 들어가지 않도록 선이수를 비운다.
    subjectData.forEach((x) => {
      if (x.requires === s.name) {
        x.requires = null;
        x._edit ||= "edited";
      }
    });
  }
}

document.getElementById("ed-save").addEventListener("click", saveEditor);
document.getElementById("ed-close").addEventListener("click", closeEditor);
edSheet.addEventListener("click", (e) => {
  if (e.target === edSheet) closeEditor();
});
edSheet.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type === "text") {
    e.preventDefault();
    saveEditor();
  }
});
edDeleteBtn.addEventListener("click", () => {
  if (!edTarget) return;
  if (!edDeleteArmed) {
    edDeleteArmed = true;
    edDeleteBtn.textContent = "한 번 더 누르면 삭제돼요";
    edDeleteBtn.classList.add("is-armed");
    clearTimeout(edDeleteTimer);
    edDeleteTimer = setTimeout(disarmDelete, 3000);
    return;
  }
  deleteSubject(edTarget);
  closeEditor();
  refreshAfterCatalogChange();
});

// 목록 전체를 처음 상태(학교 원본)로 되돌리기: 실수로 누르지 않도록 한 번 더 확인한다.
const rvResetBtn = document.getElementById("review-reset");
let rvResetArmed = false;
let rvResetTimer = null;
function disarmReset() {
  rvResetArmed = false;
  clearTimeout(rvResetTimer);
  rvResetBtn.textContent = "원래대로 되돌리기";
}
rvResetBtn.addEventListener("click", () => {
  if (!rvResetArmed) {
    rvResetArmed = true;
    rvResetBtn.textContent = "고친 내용이 모두 사라져요. 한 번 더 누르세요";
    clearTimeout(rvResetTimer);
    rvResetTimer = setTimeout(disarmReset, 3000);
    return;
  }
  disarmReset();
  resetCatalogToBase();
  refreshAfterCatalogChange();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeEditor();
  closeLightbox();
});

// ── 홈 버튼 · 진행 상황 저장 · 이어서 하기 / 다시 시작하기 ─────────────────
// 입력하는 동안 진행 상황을 브라우저에 저장해 두고(사진은 용량이 커서 IndexedDB에), 홈 버튼으로 첫 화면에 갔다가
// "이어서 하기"로 그 자리에서 다시 시작할 수 있게 한다. "다시 시작하기"는 저장된 내용까지 모두 지운다.
const PROGRESS_KEY = "dshs_progress_v1";
const PHOTO_DB = "dshs_crr";
let lastSavedPhotoSig = "";
let pendingResume = false; // 저장된 작업이 있는데 아직 이어서/다시 시작을 고르지 않은 상태(이때는 새 입력으로 덮어쓰지 않는다)

const STEP_LABELS = {
  upload: "① 사진 업로드",
  review: "② 수강신청표 확인",
  input: "③ 정보 입력",
  result: "④ 추천 결과",
  write: "후기 남기기",
  reviews: "후기 열람",
};

function currentScreenName() {
  return document.querySelector(".screen.active").id.replace("screen-", "");
}

// 사진 저장(IndexedDB). 사파리 사생활 보호 모드 등에서 막혀 있으면 조용히 건너뛴다.
function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbRun(mode, fn) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbSet = (k, v) => idbRun("readwrite", (s) => s.put(v, k));
const idbGet = (k) => idbRun("readonly", (s) => s.get(k));
const idbDel = (k) => idbRun("readwrite", (s) => s.delete(k));

const photoSig = () => photos.map((p) => `${p.id}:${p.dataUrl.length}`).join("|");

function collectSnapshot(screen) {
  const draft = {
    search: writeSearch.value,
    selected: writeSelected,
    rating: writeRating,
    teacher: document.getElementById("write-teacher").value,
    comment: document.getElementById("write-comment").value,
    interest: writeInterest.querySelector(".interest-box") ? readInterestBox(writeInterest.querySelector(".interest-box")) : null,
  };
  const hasDraft = !!draft.selected; // 후기는 과목을 고른 뒤에만 "작성 중"으로 본다
  return {
    v: 1,
    savedAt: Date.now(),
    screen,
    grade: document.getElementById("select-grade").value,
    term: document.getElementById("select-term").value,
    interests: Array.from(document.querySelectorAll(".chip.selected")).map((c) => c.dataset.tag),
    dislikes: Array.from(dislikes),
    ap: apToggle.classList.contains("on"),
    taken: [...takenNames],
    cancelled: [...cancelledKeys],
    must: [...mustKeys],
    never: [...neverNames],
    rvTerm,
    catalog: catalogEditCount() > 0 ? { items: subjectData, deleted: catalogDeleted } : null,
    photoCount: photos.length,
    write: hasDraft ? draft : null,
    filters: { q: reviewsSearch.value, teacher: reviewsTeacher.value, area: reviewsArea.value, interest: reviewsInterest.value },
  };
}

// "작성 중인 내용"이라고 부를 만한 게 있는지(아무것도 안 한 채 화면만 둘러본 경우는 저장하지 않는다)
function hasProgress(s) {
  return !!(
    s.photoCount || s.interests.length || s.dislikes.length || s.ap || s.taken.length || s.cancelled.length ||
    s.must.length || s.never.length || s.catalog || (s.write && (s.write.selected || s.write.comment || s.write.teacher)) ||
    s.screen === "input" || s.screen === "result"
  );
}

function readSnapshot() {
  try {
    const s = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null");
    return s && s.v === 1 && STEP_LABELS[s.screen] ? s : null;
  } catch (e) {
    return null;
  }
}

// 진행 상황 저장. 저장했으면 true.
function saveProgress(screen) {
  if (screen === "start" || pendingResume) return false;
  const snap = collectSnapshot(screen === "loading" ? "input" : screen);
  if (!hasProgress(snap)) return false;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(snap));
  } catch (e) {
    console.warn("진행 상황을 저장하지 못했어요:", e);
    return false;
  }
  const sig = photoSig();
  if (sig !== lastSavedPhotoSig) {
    lastSavedPhotoSig = sig;
    (photos.length ? idbSet("photos", photos.map((p) => ({ id: p.id, dataUrl: p.dataUrl }))) : idbDel("photos")).catch((e) =>
      console.warn("사진을 저장하지 못했어요:", e)
    );
  }
  return true;
}

function clearProgress() {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch (e) {
    /* 저장소가 막힌 브라우저 */
  }
  idbDel("photos").catch(() => {});
  lastSavedPhotoSig = photoSig();
}

// 입력값을 전부 처음 상태로 되돌린다(화면 이동은 하지 않는다).
function resetAllInputs() {
  document.querySelectorAll(".chip.selected").forEach((chip) => chip.classList.remove("selected"));
  apToggle.classList.remove("on");
  apToggle.setAttribute("aria-checked", "false");
  dislikes.clear();
  dislikeList.innerHTML = "";
  dislikeInput.value = "";
  takenNames.clear();
  cancelledKeys.clear();
  mustKeys.clear();
  neverNames.clear();
  resetCatalogToBase();
  rvTerm = "2-1";
  document.getElementById("select-grade").selectedIndex = 0;
  document.getElementById("select-term").selectedIndex = 0;
  photos.length = 0;
  renderPhotoGrid();
  updateUploadState();
  resultContent.innerHTML = resultPlaceholderHtml;
  writeSelected = null;
  writeRating = 0;
  writeForm.hidden = true;
  writeSearch.value = "";
  document.getElementById("write-teacher").value = "";
  document.getElementById("write-comment").value = "";
  setWriteStars(0);
  renderWritePick();
  reviewsSearch.value = "";
  reviewsTeacher.value = "";
  reviewsArea.value = "";
  reviewsInterest.value = "";
  writeInterest.innerHTML = "";
  refreshNameList();
  renderCatalog();
  updateSubmitState();
  updateSummary();
}

function closeOverlays() {
  closeEditor();
  closeLightbox();
  rateSheet.hidden = true;
  closeDrawers();
}

// 알림 글(토스트)
const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add("is-show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("is-show");
    setTimeout(() => (toastEl.hidden = true), 300);
  }, 3400);
}

// 첫 화면의 "작성 중인 내용" 카드
const resumeCard = document.getElementById("resume-card");
function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 60 / 24)}일 전`;
}
function refreshResumeCard() {
  const s = readSnapshot();
  resumeCard.hidden = !s;
  if (!s) return;
  const bits = [];
  if (s.photoCount) bits.push(`사진 ${s.photoCount}장`);
  if (s.taken.length) bits.push(`들은 과목 ${s.taken.length}개`);
  if (s.interests.length) bits.push(`관심 ${s.interests.slice(0, 3).join("·")}${s.interests.length > 3 ? " 외" : ""}`);
  if (s.write && s.write.selected) bits.push(`후기 작성 중(${s.write.selected})`);
  document.getElementById("resume-step").textContent = STEP_LABELS[s.screen];
  document.getElementById("resume-meta").textContent = `${timeAgo(s.savedAt)} 저장${bits.length ? " · " + bits.join(" · ") : ""}`;
}

// 홈: 진행 상황을 저장하고 첫 화면으로
function goHome() {
  const name = currentScreenName();
  let saved = false;
  if (name !== "start") {
    runId++; // 계산 중이었다면 취소해서 나중에 결과 화면이 끼어들지 않게 한다
    saved = saveProgress(name);
  }
  closeOverlays();
  showScreen("start");
  refreshResumeCard();
  if (saved) showToast("진행 상황을 저장했어요. '이어서 하기'로 계속할 수 있어요.");
}
document.querySelectorAll("[data-home]").forEach((b) => b.addEventListener("click", goHome));

// 이어서 하기: 저장된 내용을 되살리고 저장했던 화면으로 간다
async function applySnapshot(s) {
  resetAllInputs();
  if (s.catalog) {
    subjectData = s.catalog.items.map(cloneSubject);
    catalogDeleted = s.catalog.deleted || 0;
  }
  s.taken.forEach((n) => takenNames.add(n));
  s.cancelled.forEach((k) => cancelledKeys.add(k));
  s.must.forEach((k) => mustKeys.add(k));
  s.never.forEach((n) => neverNames.add(n));
  document.getElementById("select-grade").value = s.grade;
  document.getElementById("select-term").value = s.term;
  s.interests.forEach((tag) => {
    const c = document.querySelector(`.chip[data-tag="${tag}"]`);
    if (c) c.classList.add("selected");
  });
  s.dislikes.forEach((v) => {
    dislikeInput.value = v;
    addDislike();
  });
  dislikeInput.blur();
  if (s.ap) {
    apToggle.classList.add("on");
    apToggle.setAttribute("aria-checked", "true");
  }
  rvTerm = s.rvTerm || "2-1";
  if (s.photoCount) {
    try {
      const list = await idbGet("photos");
      if (Array.isArray(list)) {
        photos.push(...list);
        photoSeq = Math.max(photoSeq, ...list.map((p) => Number(String(p.id).replace(/\D/g, "")) || 0));
      }
    } catch (e) {
      console.warn("저장된 사진을 불러오지 못했어요:", e);
    }
  }
  lastSavedPhotoSig = photoSig();
  renderPhotoGrid();
  updateUploadState();
  refreshNameList();
  renderCatalog();
  updateSubmitState();
  renderSearch();
  updateSummary();
}

async function resumeProgress() {
  const s = readSnapshot();
  if (!s) return;
  await subjectsReady;
  await applySnapshot(s);
  pendingResume = false;
  closeOverlays();

  if (s.screen === "upload") showScreen("upload");
  else if (s.screen === "review") openReviewScreen();
  else if (s.screen === "input") showScreen("input");
  else if (s.screen === "result") {
    if (document.querySelector(".chip.selected")) runRecommendation();
    else showScreen("input");
  } else if (s.screen === "write") {
    openWriteScreen();
    const d = s.write;
    if (d) {
      writeSearch.value = d.search || "";
      renderWritePick();
      if (d.selected) {
        selectWriteSubject(d.selected);
        if (!writeSubmit.disabled) {
          setWriteStars(d.rating || 0);
          document.getElementById("write-teacher").value = d.teacher || "";
          document.getElementById("write-comment").value = d.comment || "";
          if (d.interest) writeInterest.innerHTML = interestBoxHtml(false, d.interest.interests, d.interest.interested);
        }
      }
    }
  } else if (s.screen === "reviews") {
    const f = s.filters || {};
    reviewsSearch.value = f.q || "";
    reviewsTeacher.value = f.teacher || "";
    reviewsArea.value = f.area || "";
    reviewsInterest.value = f.interest || "";
    openReviewsScreen();
  }
  showToast("저장해 둔 곳에서 이어서 시작해요.");
}

// 다시 시작하기: 입력한 내용과 저장된 진행 상황을 모두 지운다
function restartAll() {
  runId++;
  resetAllInputs();
  clearProgress();
  pendingResume = false;
  closeOverlays();
  showScreen("start");
  refreshResumeCard();
  showToast("처음부터 다시 시작해요.");
}

// 실수로 누르지 않도록 한 번 더 눌러야 실행되는 버튼
function armedButton(btn, idleText, armedText, onConfirm) {
  let armed = false;
  let timer = null;
  const reset = () => {
    armed = false;
    clearTimeout(timer);
    btn.textContent = idleText;
    btn.classList.remove("is-armed");
  };
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.textContent = armedText;
      btn.classList.add("is-armed");
      clearTimeout(timer);
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    onConfirm();
  });
}
armedButton(document.getElementById("btn-restart-start"), "다시 시작하기", "정말 지울까요? 한 번 더", restartAll);
armedButton(document.getElementById("btn-restart-all"), "처음부터 다시 시작", "입력한 내용이 모두 지워져요. 한 번 더", restartAll);
document.getElementById("btn-resume").addEventListener("click", resumeProgress);

// 저장된 작업이 있는데 고르지 않고 새로 시작하려 하면, 먼저 고르도록 알려준다.
function nudgeResume() {
  resumeCard.classList.remove("is-nudge");
  void resumeCard.offsetWidth; // 애니메이션 다시 재생
  resumeCard.classList.add("is-nudge");
  showToast("작성 중인 내용이 있어요. '이어서 하기' 또는 '다시 시작하기'를 먼저 골라주세요.");
}

// 자동 저장: 입력이 멈춘 뒤 잠깐 있다가, 그리고 창을 닫거나 다른 탭으로 갈 때
let autosaveTimer = null;
function autosaveNow() {
  clearTimeout(autosaveTimer);
  if (!pendingResume) saveProgress(currentScreenName());
}
["click", "input", "change"].forEach((ev) =>
  document.addEventListener(ev, () => {
    if (pendingResume) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 600);
  })
);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") autosaveNow();
});
window.addEventListener("pagehide", autosaveNow);

pendingResume = !!readSnapshot();
lastSavedPhotoSig = "";
refreshResumeCard();

// ── 추천안 카드의 "추천 과목 / 자세히" 탭과 "모두 펼치기" ─────────────────
resultContent.addEventListener("click", (e) => {
  const go = e.target.closest(".plan-detail-btn");
  if (go) {
    const card = go.closest(".plan-card");
    const target = card.querySelector(`.plan-tab[data-pane="${go.dataset.go}"]`);
    if (target) target.click();
    card.querySelector(".plan-tabs").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const tab = e.target.closest(".plan-tab");
  if (tab) {
    const card = tab.closest(".plan-card");
    card.querySelectorAll(".plan-tab").forEach((t) => {
      const on = t === tab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    card.querySelectorAll(".plan-pane").forEach((pane) => (pane.hidden = pane.dataset.pane !== tab.dataset.pane));
    return;
  }
  const all = e.target.closest(".why-toggle-all");
  if (all) {
    const items = [...all.closest(".plan-pane").querySelectorAll(".why-item")];
    const open = !items.every((d) => d.open);
    items.forEach((d) => (d.open = open));
    all.textContent = open ? "모두 접기" : "모두 펼치기";
  }
});
