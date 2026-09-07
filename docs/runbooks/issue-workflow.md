# Working an issue

The convention, so that several agents and one human can work the same tree without colliding
and without anyone having to ask what is already claimed.

## Labels

Two of the labels describe *state*; the rest describe *kind*.

| Label | Meaning |
|---|---|
| `status: in progress` | Someone is working this **right now**. Apply before the first edit, remove when done. |
| `status: needs review` | Work is pushed and awaiting verification or a decision from Kiarash. |
| `blocked-on-kiarash` | Cannot proceed without him — a decision, a credential, a postal address, a phone test. |
| `launch-blocker` | The domain should not be attached while this is open. |

Everything else (`bug`, `security`, `legal`, `a11y`, `ops`, `design`, `good-first-session`) says
what kind of work it is and never changes as the work moves.

## The loop

1. **Before the first edit**, add `status: in progress` and comment on the issue saying you are
   starting and what you intend to change. This is the lock: if the label is already there, pick
   something else rather than working the same files.
2. **Work.** Reference the issue in every commit message — `Closes #12` for the commit that
   finishes it, `Refs #12` for partial work. A merge to `main` then closes it automatically and
   the history links back.
3. **When done**, comment with what actually changed, **how it was verified**, and anything left
   over. Then remove `status: in progress`, and add `status: needs review` if it needs Kiarash
   rather than being self-evidently finished.

## What the closing comment must contain

Not "done" — this project has repeatedly shipped checks that could not fail, so a claim of
success is worth less than the evidence for it:

- What changed, in a sentence.
- **How you proved it.** If you added a guard, say which test you broke to confirm the guard can
  fail, and what the failure looked like.
- What you did not do, and why.
- Anything a later session would otherwise have to rediscover.

## Branches — short-lived, merged the same session

**Branch from `main`, open a pull request, merge it before you stop.** A branch may carry a few
closely related issues, but not a whole session's work.

An earlier version of this document said the opposite: that one branch could carry a dozen issues,
and that labels rather than pull requests were the shared state. That was true while one session
worked the repo alone. It is wrong now, and the cost was measured:

- `give-flow-fixes` ran to sixteen commits while another session worked `main`. That session could
  not see a fix that existed only on the branch, so it wrote the same fix again, byte for byte.
- Reconciling the two took **eight conflicted files**, and one hand-resolution truncated a test
  block badly enough to stop the file parsing.
- The merge surfaced a content-security-policy bug that had been **live on `main`** and invisible
  to both sides: the policy never allowlisted the analytics and tag-manager hosts, so a visitor
  granting consent had the script refused by the browser. Nothing on either branch alone could
  have caught it.

That last point is the argument for merging often rather than merely the argument against
divergence. Branches meeting is where this class of bug becomes visible, so make it happen early
and cheaply instead of once and expensively.

Labels still say who is working what — that has not changed, and it remains the lock. What changed
is that the label is no longer a substitute for landing the code.

One more reason, mechanical rather than social: **the full suite only runs on a pull request.** A
branch that never opens one has never been tested the way `main` tests it.
