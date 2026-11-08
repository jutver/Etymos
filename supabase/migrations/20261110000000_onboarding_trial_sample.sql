-- First-run onboarding: a 7-day Student trial, a sample document, and the
-- app tour.
--
-- 1. Free trial. A Free account can start one 7-day Student trial with
--    start_student_trial(). It is an ordinary Student plan with an end date
--    (plan_expires_at), so everything that already handles a lapsing plan
--    (expire_lapsed_plans, the backend's usage check, the web app's profile
--    read) ends it with no extra code. profiles.trial_started_at records that
--    the trial was used; it can't be started twice, by someone on a paid
--    plan, or by someone who has ever bought a plan. Student normally needs
--    student verification at checkout; the trial doesn't.
--
-- 2. Sample document. Every new account gets a ready-made report on a short
--    Vietnamese essay (documents.is_sample), with exact copies, a paraphrase
--    and a machine-written paragraph, so the tour can show each part of a
--    report. It's unlocked to Student features so a Free account sees them
--    too, and the backend refuses to re-check or unlock it (it's a demo, not
--    a check the user paid for). ensure_sample_document() brings it back for
--    a user who deleted it and restarts the tour. Accounts that existed before
--    this migration don't get one until they ask (the tour's restart).
--
-- 3. Tour. profiles.tour_completed_at is stamped when the user finishes or
--    skips the tour; null means the tour still opens. Existing accounts are
--    stamped here so only new sign-ups see it. The user writes it directly
--    (it isn't in the self-update guard: it only decides whether a tour shows).

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists trial_started_at timestamptz,
  add column if not exists tour_completed_at timestamptz;

comment on column public.profiles.trial_started_at is
  'When the user started their one free Student trial; null = never.';
comment on column public.profiles.tour_completed_at is
  'When the user finished or skipped the first-run app tour; null = show it.';

update public.profiles set tour_completed_at = now() where tour_completed_at is null;

alter table public.documents
  add column if not exists is_sample boolean not null default false;

comment on column public.documents.is_sample is
  'The ready-made sample report every new account gets (seed_sample_document).';

-- ---------------------------------------------------------------------------
-- 2. Guards: let the trial and the sample through, nothing else
-- ---------------------------------------------------------------------------
-- Re-declared in full from 20261104000000_security_hardening.sql, plus
-- trial_started_at, and the etymos.trial_grant switch that only
-- start_student_trial() sets (for its own transaction; a PostgREST caller
-- can't set it).
create or replace function public.prevent_profile_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or public.is_admin(auth.uid()) then
    return new;
  end if;

  if coalesce(current_setting('etymos.trial_grant', true), '') = 'on' then
    return new;
  end if;

  if new.role is distinct from old.role
     or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at
     or new.plan_tier is distinct from old.plan_tier
     or new.billing_cycle is distinct from old.billing_cycle
     or new.plan_expires_at is distinct from old.plan_expires_at
     or new.standard_credits is distinct from old.standard_credits
     or new.premium_credits is distinct from old.premium_credits
     or new.checks_used_this_period is distinct from old.checks_used_this_period
     or new.plan_period_start is distinct from old.plan_period_start
     or new.student_verified is distinct from old.student_verified
     or new.access_status is distinct from old.access_status
     or new.access_requested_at is distinct from old.access_requested_at
     or new.access_reviewed_at is distinct from old.access_reviewed_at
     or new.access_reviewed_by is distinct from old.access_reviewed_by
     or new.access_note is distinct from old.access_note
     or new.banned_permanent is distinct from old.banned_permanent
     or new.banned_until is distinct from old.banned_until
     or new.ban_reason is distinct from old.ban_reason
     or new.banned_by is distinct from old.banned_by
     or new.deletion_requested_at is distinct from old.deletion_requested_at
     or new.deletion_requested_by is distinct from old.deletion_requested_by
     or new.trial_started_at is distinct from old.trial_started_at
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;

-- Re-declared from 20261018080000_document_unlocked_tier.sql, plus the
-- etymos.sample_seed switch that only seed_sample_document() sets, and
-- is_sample, which users can't set or clear either.
create or replace function public.prevent_document_tier_self_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' or public.is_admin(auth.uid()) then
    return new;
  end if;

  if coalesce(current_setting('etymos.sample_seed', true), '') = 'on' then
    return new;
  end if;

  if (tg_op = 'INSERT' and (new.unlocked_tier is not null or new.is_sample))
     or (tg_op = 'UPDATE' and (new.unlocked_tier is distinct from old.unlocked_tier
                               or new.is_sample is distinct from old.is_sample))
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. start_student_trial()
-- ---------------------------------------------------------------------------
-- Returns the trial's end. Errors carry a code the web app maps to a message:
--   TRIAL_ALREADY_USED, TRIAL_ON_PAID_PLAN, TRIAL_NOT_ELIGIBLE.
create or replace function public.start_student_trial()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_ends timestamptz := now() + interval '7 days';
begin
  if v_uid is null then
    raise exception 'Sign in to start a trial.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'TRIAL_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;

  if v_profile.trial_started_at is not null then
    raise exception 'TRIAL_ALREADY_USED' using errcode = 'P0001';
  end if;

  if v_profile.plan_tier <> 'free'
     and (v_profile.plan_expires_at is null or v_profile.plan_expires_at > now()) then
    raise exception 'TRIAL_ON_PAID_PLAN' using errcode = 'P0001';
  end if;

  if v_profile.access_status <> 'approved'
     or coalesce(v_profile.banned_permanent, false)
     or (v_profile.banned_until is not null and v_profile.banned_until > now())
     or exists (
       select 1 from public.checkout_events
       where user_id = v_uid and kind = 'plan' and status = 'success'
     ) then
    raise exception 'TRIAL_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;

  perform set_config('etymos.trial_grant', 'on', true);
  update public.profiles
  set plan_tier = 'student',
      billing_cycle = null,
      plan_expires_at = v_ends,
      plan_period_start = now(),
      checks_used_this_period = 0,
      trial_started_at = now()
  where id = v_uid;
  perform set_config('etymos.trial_grant', '', true);

  return v_ends;
end;
$$;

revoke all on function public.start_student_trial() from public, anon;
grant execute on function public.start_student_trial() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The sample document
-- ---------------------------------------------------------------------------
-- The essay, its report and its sources are illustrative: the sources are
-- labelled as examples, not real publications.
create or replace function public.seed_sample_document(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc uuid;
  v_m1 uuid := gen_random_uuid();
  v_m2 uuid := gen_random_uuid();
  v_m3 uuid := gen_random_uuid();
  p_intro text := 'Đồng bằng sông Cửu Long là vựa lúa lớn nhất của Việt Nam, đóng góp hơn một nửa sản lượng lúa gạo của cả nước. Tuy nhiên, khu vực này đang chịu tác động ngày càng rõ rệt của biến đổi khí hậu, từ nước biển dâng đến hạn hán kéo dài.';
  p_salt text := 'Xâm nhập mặn là thách thức nghiêm trọng nhất. Vào mùa khô năm 2020, nước mặn đã lấn sâu hơn 100 km vào đất liền, gây thiệt hại cho hàng chục nghìn hecta lúa. Nhiều hộ nông dân buộc phải bỏ vụ hoặc chuyển sang cây trồng khác.';
  p_adapt text := 'Để thích ứng, người dân đã chuyển đổi một phần diện tích sang mô hình lúa – tôm, vừa tận dụng được nước lợ vào mùa khô, vừa giữ được vụ lúa vào mùa mưa. Cách làm này giúp giảm rủi ro và tăng thu nhập cho nông hộ.';
  p_policy text := 'Bên cạnh nỗ lực của người dân, chính sách của Nhà nước giữ vai trò then chốt. Các công trình thủy lợi, hệ thống cống ngăn mặn và việc quy hoạch lại vùng sản xuất theo hướng thuận thiên đang từng bước được triển khai.';
  p_ai text := 'Nhìn chung, biến đổi khí hậu không chỉ là một thách thức mà còn là một cơ hội để tái cấu trúc nền nông nghiệp theo hướng bền vững hơn. Việc kết hợp hài hòa giữa tri thức truyền thống, khoa học công nghệ hiện đại và sự hỗ trợ từ chính sách sẽ tạo nên một nền tảng vững chắc, góp phần đảm bảo an ninh lương thực và nâng cao chất lượng cuộc sống cho người dân trong khu vực.';
  p_end text := 'Tương lai của Đồng bằng sông Cửu Long phụ thuộc vào việc mỗi người, từ nông dân đến nhà hoạch định chính sách, cùng hành động ngay từ hôm nay.';
  s1 text := 'đóng góp hơn một nửa sản lượng lúa gạo của cả nước';
  s2 text := 'Vào mùa khô năm 2020, nước mặn đã lấn sâu hơn 100 km vào đất liền, gây thiệt hại cho hàng chục nghìn hecta lúa.';
  s3 text := 'người dân đã chuyển đổi một phần diện tích sang mô hình lúa – tôm, vừa tận dụng được nước lợ vào mùa khô, vừa giữ được vụ lúa vào mùa mưa';
begin
  perform set_config('etymos.sample_seed', 'on', true);
  perform set_config('etymos.suppress_activity_log', 'on', true);

  insert into public.documents (
    user_id, title, file_name, language, word_count, status,
    similarity_score, similarity_score_free, web_sources_scanned, academic_sources_scanned,
    check_state, unlocked_tier, is_sample, ai_detection
  )
  values (
    p_user_id,
    'Bài luận mẫu: Biến đổi khí hậu và nông nghiệp Đồng bằng sông Cửu Long',
    null, 'vi', 312, 'low',
    24.6, 15.7, 1284, 362,
    'completed', 'student', true,
    jsonb_build_object(
      'available', true,
      'method', 'sample',
      'model', 'etymos-sample',
      'overall_score', 31,
      'level', 'possible',
      'confidence', 'normal',
      'language', 'vi',
      'analyzed_words', 312,
      'ai_share', 23,
      'segments', jsonb_build_array(
        jsonb_build_object('start', 0, 'end', 0, 'block_id', null, 'words', 72, 'score', 88,
                           'excerpt', left(p_ai, 80) || '…')
      ),
      'reasons', jsonb_build_array(
        'Câu văn đều đặn, ít thay đổi nhịp điệu.',
        'Dùng nhiều cụm từ khái quát thường gặp trong văn bản do AI viết.'
      ),
      'disclaimer', 'Đây là kết quả minh họa trong tài liệu mẫu. Kết quả phát hiện AI là ước tính, không phải bằng chứng.'
    )
  )
  returning id into v_doc;

  insert into public.document_matches (
    id, document_id, severity, detection_type, match_percent, source_title, source_author,
    source_kind, citation, user_snippet, source_snippet, explanation, rewrite_suggestions, source_year
  )
  values
    (v_m1, v_doc, 'high', 'traditional', 11.2,
     'Nguồn minh họa: Báo cáo nông nghiệp vùng Đồng bằng sông Cửu Long',
     'Nguồn ví dụ của Etymos', 'web',
     'Nguồn ví dụ của Etymos. (2023). Báo cáo nông nghiệp vùng Đồng bằng sông Cửu Long.',
     s2,
     'Vào mùa khô năm 2020, nước mặn đã lấn sâu hơn 100 km vào đất liền, gây thiệt hại cho hàng chục nghìn hecta lúa.',
     'Câu này trùng gần như nguyên văn với nguồn. Hãy đặt trong ngoặc kép và trích dẫn, hoặc viết lại bằng lời của bạn.',
     array['Theo báo cáo năm 2023, mùa khô 2020 chứng kiến nước mặn xâm nhập tới hơn 100 km, ảnh hưởng đến hàng chục nghìn hecta lúa.'],
     '2023'),
    (v_m2, v_doc, 'moderate', 'semantic', 8.9,
     'Nguồn minh họa: Mô hình lúa – tôm thích ứng với xâm nhập mặn',
     'Nguồn ví dụ của Etymos', 'academic',
     'Nguồn ví dụ của Etymos. (2021). Mô hình lúa – tôm thích ứng với xâm nhập mặn. Tạp chí minh họa, 12(3), 45–58.',
     s3,
     'Nông dân chuyển một phần ruộng sang canh tác luân canh lúa – tôm, nuôi tôm bằng nước lợ trong mùa khô và trồng lúa trong mùa mưa.',
     'Ý và trình tự lập luận giống nguồn dù câu chữ đã thay đổi (diễn đạt lại). Hãy ghi nguồn cho ý này.',
     array['Mô hình luân canh lúa – tôm (Nguồn ví dụ của Etymos, 2021) cho phép nuôi tôm bằng nước lợ trong mùa khô và quay lại trồng lúa khi mùa mưa đến.'],
     '2021'),
    (v_m3, v_doc, 'low', 'traditional', 4.5,
     'Nguồn minh họa: Bách khoa thư về nông nghiệp Việt Nam',
     'Nguồn ví dụ của Etymos', 'web',
     'Nguồn ví dụ của Etymos. (2022). Bách khoa thư về nông nghiệp Việt Nam.',
     s1,
     'Vùng này đóng góp hơn một nửa sản lượng lúa gạo của cả nước.',
     'Một cụm từ ngắn trùng với nguồn. Thông tin phổ biến như vậy thường chỉ cần trích dẫn.',
     array['chiếm trên 50% sản lượng lúa gạo cả nước'],
     '2022');

  insert into public.document_passages (document_id, text, severity, match_id, sort_order, block_type, level, page)
  values
    (v_doc, 'Biến đổi khí hậu và nông nghiệp Đồng bằng sông Cửu Long', null, null, 0, 'title', 1, 1),
    (v_doc, p_intro, 'low', v_m3, 1, 'paragraph', null, 1),
    (v_doc, 'Thách thức từ xâm nhập mặn', null, null, 2, 'heading', 2, 1),
    (v_doc, p_salt, 'high', v_m1, 3, 'paragraph', null, 1),
    (v_doc, 'Người dân thích ứng như thế nào', null, null, 4, 'heading', 2, 1),
    (v_doc, p_adapt, 'moderate', v_m2, 5, 'paragraph', null, 1),
    (v_doc, p_policy, null, null, 6, 'paragraph', null, 1),
    (v_doc, 'Kết luận', null, null, 7, 'heading', 2, 1),
    (v_doc, p_ai, null, null, 8, 'paragraph', null, 1),
    (v_doc, p_end, null, null, 9, 'paragraph', null, 1);

  perform set_config('etymos.suppress_activity_log', '', true);
  perform set_config('etymos.sample_seed', '', true);
  return v_doc;
end;
$$;

revoke all on function public.seed_sample_document(uuid) from public, anon, authenticated;

-- New accounts get the sample as their profile is created. A failure here
-- must never block a sign-up, so it only warns.
create or replace function public.seed_sample_document_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.seed_sample_document(new.id);
  exception when others then
    raise warning 'seed_sample_document failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists seed_sample_document_on_signup on public.profiles;
create trigger seed_sample_document_on_signup
  after insert on public.profiles
  for each row execute function public.seed_sample_document_on_signup();

-- The caller's sample, created again if they no longer have one (restarting
-- the tour after deleting it). A trashed sample is brought back.
create or replace function public.ensure_sample_document()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_doc uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select id into v_doc from public.documents
  where user_id = v_uid and is_sample
  order by is_trashed, uploaded_at desc
  limit 1;

  if v_doc is not null then
    update public.documents set is_trashed = false where id = v_doc and is_trashed;
    return v_doc;
  end if;

  return public.seed_sample_document(v_uid);
end;
$$;

revoke all on function public.ensure_sample_document() from public, anon;
grant execute on function public.ensure_sample_document() to authenticated;
