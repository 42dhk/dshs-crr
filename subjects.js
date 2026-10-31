// 2026학년도 최종 수강신청서(2학년1학기 ~ 3학년2학기) 사진을 옮겨 적은 과목 카탈로그입니다.
// * 표시 과목은 AP 과목이며, 학점보다 주당 1시수를 더 차지합니다(ap: true).
// group이 있는 과목은 "그 그룹 안에서 pick 개수만큼만 선택"하는 택1/택2 과목입니다.
// mandatory:true 인 과목은 선택지가 없어 무조건 포함되는 필수 과목입니다.
// mandatory:false, group:null 인 과목(과학/정보과학/수학/AI융합 대부분)은
// 학생이 자유롭게 고르는 "선택 풀"로, 추천 알고리즘이 여기서 조합을 고릅니다.
//
// 영역(area): 과학/정보과학/수학/AI융합 = 전문기본선택, 과학정보수학/AI융합(심화) = 전문심화선택(3학년), 나머지는 교양 영역입니다.
//
// 사진 해상도 때문에 특히 아래 구간은 다시 한 번 확인해 주세요:
// - 영어 3학년 1학기/2학기의 택1·택2 구성

let _id = 0;
function subject(name, credit, opts = {}) {
  return {
    id: `s${++_id}`,
    name,
    credit,
    ap: !!opts.ap,
    area: opts.area,
    grade: opts.grade,
    term: opts.term,
    group: opts.group || null,
    mandatory: !!opts.mandatory,
    // requires: 이 과목명을 "이전 학기에 이미 이수" 했거나 "이번 학기에 함께" 신청해야만
    // 들을 수 있는 과목(Ⅱ과목, 실험과목)에 설정한다. 생물학·지구과학 실험은 수강신청서
    // 안내문에 따라 선이수 조건이 없으므로 requires를 비워둔다.
    requires: opts.requires || null,
  };
}

// 수강신청서 하단 "이수학점" 표(굵은 상자 묶음)를 옮긴 졸업 최소이수학점 기준입니다. 2학년1학기~3학년2학기 4개 학기 누적 기준이고,
// options의 각 항목 [x, y]는 "첫째 영역 x학점 이상 AND 둘째 영역 y학점 이상" 중 하나를 채우면 된다는 뜻입니다(표의 19[15]/3[7] → (19,3) 또는 (15,7)).
//  - 전문기본선택: 과학(황토색) + 정보과학(보라색), 수학(하늘색) + AI융합(분홍색)
//  - 전문심화선택: 과학정보수학(3학년 세미나·토픽·대수학·고급프로그래밍·고급알고리즘) + AI융합(심화)(3학년 1학기 AI융합)
const GRADUATION_MIN_CREDITS = [
  { label: "과학 + 정보과학", tier: "기본", areas: ["과학", "정보과학"], options: [[19, 3], [15, 7]] },
  { label: "수학 + AI융합", tier: "기본", areas: ["수학", "AI융합"], options: [[12, 6], [9, 9]] },
  { label: "심화: 과학정보수학 + AI융합", tier: "심화", areas: ["과학정보수학", "AI융합(심화)"], options: [[12, 2], [10, 4]] },
];

const GROUP_PICK = {
  "국어-2-1": 1, "국어-2-2": 1, "국어-3-1": 1, "국어-3-2": 1,
  "영어-2-1": 1, "영어-2-2": 1, "영어-3-1a": 1, "영어-3-1b": 1, "영어-3-2": 2,
  "외국어-2-1": 1,
  "예술-2-1": 1, "예술-2-2": 1,
  "사회-3-2": 1,
};

const SUBJECTS = [
  // ── 과학 ──────────────────────────────
  subject("일반물리학Ⅰ", 3, { area: "과학", ap: true, grade: 2, term: 1 }),
  subject("일반물리학실험Ⅰ", 1, { area: "과학", ap: true, grade: 2, term: 1, requires: "일반물리학Ⅰ" }),
  subject("일반화학Ⅰ", 3, { area: "과학", ap: true, grade: 2, term: 1 }),
  subject("일반화학실험Ⅰ", 1, { area: "과학", ap: true, grade: 2, term: 1, requires: "일반화학Ⅰ" }),
  subject("일반생물학", 3, { area: "과학", ap: true, grade: 2, term: 1 }),
  subject("일반지구과학", 3, { area: "과학", grade: 2, term: 1 }),

  subject("일반물리학Ⅰ", 3, { area: "과학", ap: true, grade: 2, term: 2 }),
  subject("일반물리학실험Ⅰ", 1, { area: "과학", ap: true, grade: 2, term: 2, requires: "일반물리학Ⅰ" }),
  subject("일반화학Ⅰ", 3, { area: "과학", ap: true, grade: 2, term: 2 }),
  subject("일반화학실험Ⅰ", 1, { area: "과학", ap: true, grade: 2, term: 2, requires: "일반화학Ⅰ" }),
  subject("일반생물학", 3, { area: "과학", ap: true, grade: 2, term: 2 }),
  subject("일반생물학실험", 1, { area: "과학", grade: 2, term: 2 }),
  subject("일반지구과학", 3, { area: "과학", grade: 2, term: 2 }),
  subject("일반지구과학실험", 1, { area: "과학", grade: 2, term: 2 }),
  subject("일반물리학Ⅱ", 3, { area: "과학", ap: true, grade: 2, term: 2, requires: "일반물리학Ⅰ" }),
  subject("일반물리학실험Ⅱ", 1, { area: "과학", ap: true, grade: 2, term: 2, requires: "일반물리학Ⅱ" }),
  subject("일반화학Ⅱ", 3, { area: "과학", ap: true, grade: 2, term: 2, requires: "일반화학Ⅰ" }),
  subject("일반화학실험Ⅱ", 1, { area: "과학", ap: true, grade: 2, term: 2, requires: "일반화학Ⅱ" }),

  subject("일반물리학Ⅱ", 3, { area: "과학", ap: true, grade: 3, term: 1, requires: "일반물리학Ⅰ" }),
  subject("일반물리학실험Ⅱ", 1, { area: "과학", ap: true, grade: 3, term: 1, requires: "일반물리학Ⅱ" }),
  subject("일반화학Ⅱ", 3, { area: "과학", ap: true, grade: 3, term: 1, requires: "일반화학Ⅰ" }),
  subject("일반화학실험Ⅱ", 1, { area: "과학", ap: true, grade: 3, term: 1, requires: "일반화학Ⅱ" }),
  subject("심화생명과학", 3, { area: "과학", grade: 3, term: 1 }),
  subject("심화생명과학실험", 1, { area: "과학", grade: 3, term: 1 }),
  subject("심화지구과학", 3, { area: "과학", grade: 3, term: 1 }),
  subject("물리학토픽Ⅰ", 2, { area: "과학정보수학", grade: 3, term: 1 }),
  subject("화학토픽Ⅰ", 2, { area: "과학정보수학", grade: 3, term: 1 }),
  subject("생명과학세미나Ⅰ", 2, { area: "과학정보수학", grade: 3, term: 1 }),
  subject("지구과학토픽Ⅰ", 2, { area: "과학정보수학", grade: 3, term: 1 }),

  subject("대수학", 2, { area: "과학정보수학", grade: 3, term: 2 }),
  subject("물리학토픽Ⅱ", 2, { area: "과학정보수학", grade: 3, term: 2 }),
  subject("화학토픽Ⅱ", 2, { area: "과학정보수학", grade: 3, term: 2 }),
  subject("생명과학세미나Ⅱ", 2, { area: "과학정보수학", grade: 3, term: 2 }),
  subject("지구과학토픽Ⅱ", 2, { area: "과학정보수학", grade: 3, term: 2 }),

  // ── 정보과학 ──────────────────────────
  subject("객체지향프로그래밍", 3, { area: "정보과학", grade: 2, term: 1 }),
  subject("인공지능", 3, { area: "정보과학", grade: 2, term: 1 }),
  subject("자료구조와알고리즘", 3, { area: "정보과학", ap: true, grade: 2, term: 2 }),
  subject("정보과학프로젝트", 1, { area: "정보과학", grade: 2, term: 2 }),
  subject("고급프로그래밍", 2, { area: "과학정보수학", grade: 3, term: 1 }),
  subject("고급알고리즘", 2, { area: "과학정보수학", grade: 3, term: 2 }),

  // ── 수학 ──────────────────────────────
  subject("미적분학Ⅰ", 3, { area: "수학", ap: true, grade: 2, term: 1 }),
  subject("고급수학", 3, { area: "수학", grade: 2, term: 1 }),
  subject("미적분학Ⅰ", 3, { area: "수학", ap: true, grade: 2, term: 2 }),
  subject("응용수학", 3, { area: "수학", grade: 2, term: 2 }),
  subject("미적분학Ⅱ", 3, { area: "수학", ap: true, grade: 2, term: 2, requires: "미적분학Ⅰ" }),
  subject("선형대수학", 3, { area: "수학", ap: true, grade: 2, term: 2 }),
  subject("미적분학Ⅱ", 3, { area: "수학", ap: true, grade: 3, term: 1, requires: "미적분학Ⅰ" }),
  subject("선형대수학", 3, { area: "수학", ap: true, grade: 3, term: 1 }),
  subject("수학세미나Ⅰ", 2, { area: "과학정보수학", grade: 3, term: 1 }),
  subject("수학세미나Ⅱ", 2, { area: "과학정보수학", grade: 3, term: 2 }),

  // ── AI융합 ────────────────────────────
  subject("융합수학", 3, { area: "AI융합", grade: 2, term: 1 }),
  subject("인공지능과화학탐구", 3, { area: "AI융합", grade: 2, term: 1 }),
  subject("생활속의데이터과학", 3, { area: "AI융합", grade: 2, term: 1 }),
  subject("컴퓨터물리해석", 3, { area: "AI융합", grade: 2, term: 2 }),
  subject("AI와바이오테크놀로지", 3, { area: "AI융합", grade: 2, term: 2 }),
  subject("인공지능기반정보과학탐구", 3, { area: "AI융합", grade: 2, term: 2 }),
  subject("물리학과첨단기술", 2, { area: "AI융합(심화)", grade: 3, term: 1 }),
  subject("첨단화학", 2, { area: "AI융합(심화)", grade: 3, term: 1 }),
  subject("AI와디지털생물학", 2, { area: "AI융합(심화)", grade: 3, term: 1 }),
  subject("가상현실(VR)과과학콘텐츠", 2, { area: "AI융합(심화)", grade: 3, term: 1 }),
  subject("인공지능융합연구", 2, { area: "AI융합(심화)", grade: 3, term: 1 }),

  // ── 사회 ──────────────────────────────
  subject("생활속정치와법", 2, { area: "사회", grade: 2, term: 1, mandatory: true }),
  subject("세계시민과지리", 2, { area: "사회", grade: 2, term: 2, mandatory: true }),
  subject("여행지리", 2, { area: "사회", grade: 3, term: 1, mandatory: true }),
  subject("금융과경제생활", 2, { area: "사회", grade: 3, term: 2, group: "사회-3-2" }),
  subject("사회문제탐구", 2, { area: "사회", grade: 3, term: 2, group: "사회-3-2" }),

  // ── 국어 ──────────────────────────────
  subject("문학과디지털미디어", 3, { area: "국어", grade: 2, term: 1, group: "국어-2-1" }),
  subject("독서토론과글쓰기", 3, { area: "국어", grade: 2, term: 1, group: "국어-2-1" }),
  subject("화법과의사소통", 2, { area: "국어", grade: 2, term: 2, group: "국어-2-2" }),
  subject("매체와언어생활탐구", 2, { area: "국어", grade: 2, term: 2, group: "국어-2-2" }),
  subject("창의융합독서", 2, { area: "국어", grade: 3, term: 1, group: "국어-3-1" }),
  subject("문학과인문학", 2, { area: "국어", grade: 3, term: 1, group: "국어-3-1" }),
  subject("창의융합독서", 2, { area: "국어", grade: 3, term: 2, group: "국어-3-2" }),
  subject("문학과인문학", 2, { area: "국어", grade: 3, term: 2, group: "국어-3-2" }),

  // ── 영어 ──────────────────────────────
  subject("시사영어", 3, { area: "영어", grade: 2, term: 1, group: "영어-2-1" }),
  subject("세계문화와영어", 3, { area: "영어", grade: 2, term: 1, group: "영어-2-1" }),
  subject("비판적영어읽기와토론", 2, { area: "영어", grade: 2, term: 2, group: "영어-2-2" }),
  subject("학술영어세미나", 2, { area: "영어", grade: 2, term: 2, group: "영어-2-2" }),
  subject("미디어영어", 2, { area: "영어", grade: 3, term: 1, group: "영어-3-1a" }),
  subject("영어커뮤니케이션", 2, { area: "영어", grade: 3, term: 1, group: "영어-3-1a" }),
  subject("과학사및과학철학", 2, { area: "영어", grade: 3, term: 1, group: "영어-3-1b" }),
  subject("미래사회가치탐구", 2, { area: "영어", grade: 3, term: 1, group: "영어-3-1b" }),
  subject("미디어영어", 2, { area: "영어", grade: 3, term: 2, group: "영어-3-2" }),
  subject("과학사및과학철학", 2, { area: "영어", grade: 3, term: 2, group: "영어-3-2" }),
  subject("미래사회가치탐구", 2, { area: "영어", grade: 3, term: 2, group: "영어-3-2" }),

  // ── 제2외국어 ─────────────────────────
  subject("일본어", 2, { area: "제2외국어", grade: 2, term: 1, group: "외국어-2-1" }),
  subject("중국어", 2, { area: "제2외국어", grade: 2, term: 1, group: "외국어-2-1" }),

  // ── 체육 ──────────────────────────────
  subject("운동과건강", 1, { area: "체육", grade: 2, term: 1, mandatory: true }),
  subject("스포츠문화", 1, { area: "체육", grade: 2, term: 2, mandatory: true }),
  subject("스포츠과학", 1, { area: "체육", grade: 3, term: 1, mandatory: true }),
  subject("스포츠생활", 1, { area: "체육", grade: 3, term: 2, mandatory: true }),

  // ── 예술교양 ──────────────────────────
  subject("음악과미디어", 1, { area: "예술교양", grade: 2, term: 1, group: "예술-2-1" }),
  subject("미술창작", 1, { area: "예술교양", grade: 2, term: 1, group: "예술-2-1" }),
  subject("음악연주와창작", 1, { area: "예술교양", grade: 2, term: 2, group: "예술-2-2" }),
  subject("미술과매체", 1, { area: "예술교양", grade: 2, term: 2, group: "예술-2-2" }),
  subject("진로설계탐구", 1, { area: "예술교양", grade: 3, term: 1, mandatory: true }),
];
