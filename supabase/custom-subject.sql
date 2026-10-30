-- 수강신청표에 없는 과목 이름으로도 후기를 남길 수 있게 변경. Supabase 대시보드 > SQL Editor에서 실행하세요.
-- (실행 전에는 목록 밖 과목 후기가 저장되지 않습니다. 앱은 안 깨집니다.)

-- 과목 이름이 비어 있거나 너무 길면 거절 (이상한 데이터가 쌓이는 걸 최소한으로 막기)
alter table public.reviews drop constraint if exists reviews_subject_name_len;
alter table public.reviews
  add constraint reviews_subject_name_len check (char_length(subject_name) between 1 and 30);

-- 후기 작성 정책: 과목 이름이 목록에 있는지는 더 이상 검사하지 않는다.
drop policy if exists "reviews insert" on public.reviews;
create policy "reviews insert" on public.reviews
  for insert to anon
  with check (
    rating between 1 and 5
    and char_length(subject_name) between 1 and 30
  );
