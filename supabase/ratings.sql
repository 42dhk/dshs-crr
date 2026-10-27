-- 별점 시스템용 DB 보강. Supabase 대시보드 > SQL Editor에 통째로 붙여넣어 실행하세요.
-- (실행하지 않아도 앱은 reviews 테이블을 직접 읽어서 동작하지만, 후기가 많아지면 이 뷰가 더 정확하고 빠릅니다.)

-- 1) 과목별 평균 별점·후기 수를 계산해 주는 뷰
create or replace view public.subject_ratings
with (security_invoker = true) as
select
  subject_name,
  round(avg(rating)::numeric, 2) as avg_rating,
  count(*) as review_count
from public.reviews
group by subject_name;

grant select on public.subject_ratings to anon;

-- 2) 후기 작성은 "subjects 테이블에 실제로 있는 과목 이름"에만 허용 (아무 글자나 넣는 것 방지)
drop policy if exists "reviews insert" on public.reviews;
create policy "reviews insert" on public.reviews
  for insert to anon
  with check (
    rating between 1 and 5
    and exists (select 1 from public.subjects s where s.name = subject_name)
  );
