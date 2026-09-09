# Patched dependencies

## `wrangler@4.129.0`

Makes `"Error inside ProxyWorker"` non-fatal, so a dropped connection costs the
request it was on instead of the whole dev server.

`e2e/support/serve.mjs` exists because `wrangler dev` dies mid-suite, and #381
finally named why. Two defects in wrangler, both still present in 4.130.0 (the
latest at the time of writing) and both unchanged as far back as 4.120.0 — so
neither upgrading nor downgrading is a way out:

1. `ProxyWorker` cannot post an `Error` across the worker boundary, so it posts
   a plain `{name, message, stack, cause}`. `castErrorCause` sees a
   non-`Error` and wraps it in `new Error()` with **no message**, which is why
   the entire user-visible diagnostic is a bare `✘ [ERROR]` with nothing after
   it.
2. `DevEnv.handleErrorEvent` already treats two sibling ProxyController
   conditions as transient and logs them at debug — `"Failed to send message
to"` and `"Could not connect to InspectorProxyWorker"` — but
   `"Error inside ProxyWorker"` falls through to `this.emit("error", event)`
   and takes the process down.

This patch adds the third string to that same exemption, at both of the two
sites in the bundle that carry the condition. It is what
[cloudflare/workers-sdk#15317](https://github.com/cloudflare/workers-sdk/issues/15317)
recommends; that issue is open, with no maintainer response and no fix.

### What is verified, and what is not

Verified: the patch applies from a clean install, and a patched `wrangler dev`
serves normally — 200 listings created through the real API, 800 aborted image
loads, and 40 truncated uploads, with no crash and no change in behaviour.

**Not** verified by reproduction: that it stops the crash. The upstream trigger
is "a connection dropped mid-response, which we only ever see under contention
on a small runner", and it does not reproduce on a developer machine — patched
or unpatched, none of the loads above provoked a single death. The fix rests on
reading the code path, not on watching it fail and then not fail. The real
evidence will be the `e2e` failure rate on CI, which #381 measured at roughly
half of all runs.

### When to remove it

When upstream fixes #15317. `pnpm` fails loudly rather than silently skipping:
a wrangler bump makes the pinned `wrangler@4.129.0` key unused, and a patch
that no longer applies is `ERR_PNPM_PATCH_FAILED`. Either way the next person
is told, rather than quietly losing the fix.
