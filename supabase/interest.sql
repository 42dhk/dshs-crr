-- 후기에 "작성자의 흥미/관심 분야" 열 추가. Supabase 대시보드 > SQL Editor에 붙여넣어 실행하세요.
-- (실행 전에도 앱은 동작하지만, 그때는 흥미 체크·관심 분야가 저장되지 않고 별점·후기·선생님만 저장됩니다.)

-- 이 과목에 원래 흥미가 있었는지 (예전 후기는 비어 있음 = 알 수 없음)
alter table public.reviews
  add column if not exists interested boolean;

-- 작성자의 관심 분야. 쉼표로 이은 글자(예: '수학,물리'). 앱이 정해진 8개 분야만 보냅니다.
alter table public.reviews
  add column if not exists interests text
  check (interests is null or char_length(interests) <= 60);
