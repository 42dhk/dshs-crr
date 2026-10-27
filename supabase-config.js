// Supabase 공개 접속 정보입니다. publishable 키는 브라우저에서 쓰도록 만든 공개 키라 코드에 넣어도 안전합니다.
// 대신 접근 제어는 DB의 RLS 정책(supabase/schema.sql)이 담당합니다. secret/service_role 키는 절대 넣지 마세요.
const SUPABASE_URL = "https://lrcrnamsgpblduibcjaq.supabase.co";
const SUPABASE_KEY = "sb_publishable_RbX-4JxOOwsuWItpgyUU6w_Km2VjFjA";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
