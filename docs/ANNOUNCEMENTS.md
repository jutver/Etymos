# Announcements and maintenance mode

Admin app → **Announcements**. There are three kinds:

| Kind | Where it shows | Content |
|---|---|---|
| **Top bar** | A centred bar above every page of the site | Message, colour, optional icon, optional countdown |
| **Pop-up** | A dialog, shown once to each visitor (per browser) | Title, text, image: any mix |
| **Maintenance** | Replaces the whole site with a "We'll be back soon" page | Optional title and message (blank uses the standard text) |

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
  bottom of the screen. The maintenance page has an "Admin sign in" link, and
  `/login` stays reachable.
- It's a lock on the website only. The backend API keeps running, so
  checks already in progress still finish, and the payment webhook keeps working.

## Setup

Apply `supabase/migrations/20261017000000_announcements_overhaul.sql`
(`supabase db push`). It adds the new columns, turns existing announcements
into top bars, and creates the image bucket, which only admins can write to.
