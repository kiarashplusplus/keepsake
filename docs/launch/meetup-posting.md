# The first Keepsake meetup — Meetup posting

Copy for the Meetup event page, written 2026-11-17. The site's launch dialog
(`apps/web/src/features/launch/`) announces the same event and links here once the event exists.

## Before you post — four blanks

| Blank | Where it appears | Notes |
| --- | --- | --- |
| **City** | title, description | Written as `[CITY]` below. |
| **Venue** | Meetup's location field | Posting it as "Location TBD" is fine; Meetup lets you publish without one and notifies RSVPs when you add it. A café with a big table, a library community room or a park pavilion all suit it — somewhere public, free to enter, with a surface to lay things out on. |
| **Time** | Meetup's time field | Suggested: **2:00–4:00 PM**. Saturday afternoon after Thanksgiving catches people who are still in town and already out. |
| **Event URL** | the site | After publishing, paste the event link into `MEETUP_URL` in `apps/web/src/features/launch/launchPlan.ts`. The dialog then shows an **RSVP on Meetup** button instead of "RSVP soon on Meetup". The dialog does not show the venue; the Meetup page does. |

## Event title

> **Keepsake Launch Meetup: Bring One Thing With a Story, Leave With Someone Else's 🎉**

Shorter alternative, if the title field truncates:

> **Keepsake Launch Party — A Free Swap of Things With Stories**

## Date and place

- **Date:** Saturday, November 28, 2026
- **Time:** `[TIME — suggested 2:00–4:00 PM]`
- **Location:** TBD — `[CITY]`. We'll update this page and message everyone who has RSVP'd as soon as
  it's set.
- **Cost:** Free. Nothing is for sale, including by us.

## Description

> **Keepsake launched yesterday. Today we do it in person.**
>
> You know that thing you can't throw out? The camera your grandfather carried. The mixing bowl
> that made every birthday cake. The denim jacket that went to every concert. It's too full of
> memories for the donation bin — and too good to sit in a closet for another ten years.
>
> **Bring it.**
>
> Keepsake (keepsake.ing) is a brand-new, completely free way to hand a sentimental object to a
> neighbor who'll love it next. You photograph it, you tell its story, someone nearby raises their
> hand, and you meet to hand it over. No money. No accounts. No shipping. Just the thing and its
> story, going on to a second life.
>
> We opened to the public the day after Thanksgiving — while everyone else was out buying new
> things — and this is our launch party: the whole idea, live, on one big table.
>
> **How it works**
>
> 🎁 **Bring one thing with a story.** Small enough to carry, loved enough to matter. (Empty-handed
> is fine too — come listen, and go home with something.)
>
> 🗣️ **Tell it out loud.** Everyone gets a minute: what it is, where it's been, why it's time.
> This is the best part. Expect to laugh. Possibly to tear up over a stranger's teapot.
>
> 🤝 **Hand it on.** If someone lights up at your story, it's theirs. If two people do, you choose —
> that's how Keepsake works online, too.
>
> 📸 **Post what's left.** Anything that doesn't find its person in the room, we'll help you put on
> Keepsake in about two minutes, so the whole neighborhood can see it.
>
> **Who should come**
>
> Anyone clearing out a parent's house. Anyone moving. Anyone who has ever said "I can't just
> *throw it away*." Anyone who likes old things with a past, or likes hearing people talk about
> what they love. Anyone curious about what we're building — the person who made Keepsake will be
> there and wants to hear exactly what you think.
>
> **The schedule (loosely)**
>
> - **First 30 minutes** — arrive, set your thing on the table, meet people
> - **Next hour** — the stories, one at a time
> - **Last 30 minutes** — handoffs, photos, and posting whatever's still looking for a home
>
> **Good to know**
>
> - It's **free**, and nothing changes hands for money. Please don't bring things to sell.
> - **Adults only (18+)**, same as Keepsake itself.
> - Bring something you can **carry in one trip** and that's safe on a shared table — no weapons,
>   alcohol, medication, or anything alive.
> - We're meeting **somewhere public**, in daylight. That's how we suggest every Keepsake handoff
>   happens.
> - **Location is TBD** — RSVP and you'll get a message the moment it's set.
>
> Can't make it? The table's always open at **keepsake.ing**.

## Short version

For the Meetup summary field, a text message, or a social post (under 280 characters):

> Keepsake launches Nov 27 — a free way to hand a sentimental thing, and its story, to a neighbor.
> Nov 28 we do it in person: bring one thing with a story, tell it, leave with someone else's.
> Free. Location TBD. keepsake.ing

## Suggested Meetup settings

- **Topics:** Community Building · Sustainability · Decluttering & Minimalism · Storytelling ·
  Buy Nothing / Free Stuff · Vintage & Antiques
- **RSVP question:** "What are you thinking of bringing? (One line is plenty — or 'just
  listening'.)" The answers are a preview of the table, and worth sharing in a comment the day
  before.
- **Attendee limit:** set one once the venue is known; until then leave it open with a waitlist off.
- **Host note to send RSVPs when the venue is set:** "We have a table! `[VENUE, ADDRESS]`,
  Saturday at `[TIME]`. Bring your one thing. See you there."
