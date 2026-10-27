-- 후기에 "담당 선생님" 열 추가. Supabase 대시보드 > SQL Editor에 붙여넣어 실행하세요.
-- (실행 전에도 앱은 동작하지만, 그때는 선생님 이름이 저장되지 않고 별점·후기만 저장됩니다.)

alter table public.reviews
  add column if not exists teacher text
  check (teacher is null or char_length(teacher) <= 20);

-- 선생님별 검색을 빠르게 하기 위한 인덱스
create index if not exists reviews_teacher_idx on public.reviews (teacher);
