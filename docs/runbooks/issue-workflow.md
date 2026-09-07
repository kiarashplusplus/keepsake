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

## Branches

One branch can carry many issues. `give-flow-fixes` spans a dozen, and splitting it per issue
would slow the work more than it would help. That is why the state lives in labels rather than in
draft pull requests: the label tells you what is claimed, the commit message tells you what
closed it.
