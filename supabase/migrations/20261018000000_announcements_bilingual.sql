-- Bilingual announcements. `title` / `message` hold the English text and
-- `title_vi` / `message_vi` the Vietnamese. The site shows the visitor's
-- language and falls back to the other one, field by field, when it's blank,
-- so an announcement written in one language only still shows to everyone.

alter table public.announcements
  add column title_vi text,
  add column message_vi text not null default '';

-- Content rules now accept either language.
alter table public.announcements
  drop constraint announcements_banner_has_message,
  drop constraint announcements_popup_has_content;

alter table public.announcements
  add constraint announcements_banner_has_message
    check (kind <> 'banner' or length(btrim(message)) > 0 or length(btrim(message_vi)) > 0),
  add constraint announcements_popup_has_content
    check (
      kind <> 'popup'
      or length(btrim(message)) > 0
      or length(btrim(message_vi)) > 0
      or length(btrim(coalesce(title, ''))) > 0
      or length(btrim(coalesce(title_vi, ''))) > 0
      or image_path is not null
    );
