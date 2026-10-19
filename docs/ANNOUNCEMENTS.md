# Announcements and maintenance mode

Admin app → **Announcements**. There are three kinds:

| Kind | Where it shows | Content |
|---|---|---|
| **Top bar** | A centred bar above every page of the site | Message, colour, optional icon, optional countdown |
| **Pop-up** | A dialog, shown once to each visitor (per browser) | Title, text, image: any mix |
| **Maintenance** | Replaces the whole site with a "We'll be back soon" page | Optional title and message (blank uses the standard text) |

## Languages

Each announcement has an **English** and a **Tiếng Việt** column for its title
and message. Visitors see the one that matches the site language they picked.
A blank box falls back to the other language, so an announcement written in one
language still reaches everyone. The editor warns when a box is filled in only one
language. The preview has an EN / VI switch, and clicking into a column switches
the preview to that language.

For maintenance, leaving both columns blank shows the standard "We'll be back
soon" page, in the visitor's language.

## Who sees it

Top bars and pop-ups have a **Who sees it** setting:

| Option | Shown to |
|---|---|
| **Everyone** (default) | Every visitor, signed in or not |
| **Signed-in users** | Anyone signed in |
| **Plans** | Signed-in people on the plans you tick (Free, Standard, Premium). A paid plan past its end date counts as Free |
| **Chosen people** | Signed-in people with one of the listed emails. An email without an account yet works once that account is made |

People outside the audience can't read the announcement at all: the
`announcements` table isn't public, and the site loads its announcements
through `my_announcements()`, which returns only the ones meant for the
viewer. The site reloads them when someone signs in or out. A change to a
user's plan reaches their open page on the next minute's refresh.

Maintenance has no audience setting: it locks the site for everyone except
admins and the people you let through.

## Editing

The form has a live preview. Each kind can start right away or at a set time.
Top bars and pop-ups can also end at a set time. A switched-off announcement
stays in the list, and you can switch it on again.

## Top bar

- If several are live, the newest one shows.
- **Countdown**: ticks next to the message, like "2d 04h 12m 33s". The bar
  disappears when it reaches zero, which suits a sale that ends.
- Visitors can close it with ×, and it stays closed in that browser.

## Pop-up

- The image is stored in the public `announcement-images` bucket. It must be a
  PNG, JPG, WebP or GIF up to 5 MB, and it shows full width above the text.
- It waits until any other dialog has closed (the closed-beta notice, for
  example), so two dialogs never stack.

## Maintenance

- **Immediately** locks the site as soon as you confirm. **At a set time**
  locks it at that time. Until then, visitors see a warning bar with a
  countdown to the start.
- It lasts until an admin ends it. To do that, use **End maintenance** in the
  red box at the top of the Announcements page, or switch it off in the list.
  Visitors' pages pick up the change within a minute.
- Admins signed in on the site still get through, with a reminder at the
  bottom of the screen.
- **Who can still use the site**: pick **Admins and chosen people** to let
  others through too. Add them by email (type, paste a list, or search
  accounts by email or name). They sign in as usual and use the site normally.
  An email without an account yet works once that account is made. The list
  is private: it's kept in the admin-only `announcement_emails` table, and the
  site only asks `my_maintenance_bypass()` whether the signed-in person is on
  it. Changing the list while maintenance is on reaches open pages within a
  minute.
- The maintenance page has a "Sign in" link, and
  `/login` stays reachable.
- It's a lock on the website only. The backend API keeps running, so
  checks already in progress still finish, and the payment webhook keeps working.

## Setup

Apply `supabase/migrations/20261017000000_announcements_overhaul.sql` and
`20261018000000_announcements_bilingual.sql`, then
`20261019000000_maintenance_bypass.sql` and `20261020000000_announcement_audience.sql`
for the bypass list and audiences (`supabase db push`). The first adds
the new columns, turns existing announcements into top bars, and creates the
image bucket, which only admins can write to. The second adds `title_vi` and
`message_vi`. Existing text is treated as English and shows to everyone until a
Vietnamese version is added.
