# Remote access from a phone

Remote access lets a paired phone open Octo's interface in its browser, see your projects, answer approvals and send messages
while the agents keep working on your computer. It is **off after every start** and you turn it on on purpose.

**Verification.** Built and tested with a fake tunnel program. A real `cloudflared` tunnel, a real phone and Safari were never
tried, and **the installed app does not include the phone web app yet** (see "Setting it up").

## How it works

When you turn it on, Octo opens a second listener on your computer (loopback only) and runs Cloudflare's `cloudflared` program,
which makes a **quick tunnel**: a random address like `https://some-words.trycloudflare.com` that changes every time you turn it
on. Only that second listener is reachable through the tunnel. Octo's main service port never is, and a request that uses the
computer's own token is refused there.

Because the tunnel is Cloudflare's service, your phone's traffic passes through Cloudflare's network on its way to your
computer. Do not turn it on for work you may not send through a third party.

## Setting it up

1. Install `cloudflared`. Octo never downloads it. Octo shows the install line when it is missing (`brew install cloudflared` on
   macOS, `winget install --id Cloudflare.cloudflared` on Windows, Cloudflare's signed apt repository on Linux).
2. The phone needs Octo's web app. A build installed with `pnpm install:app` carries it and Octo serves it with no setup. If you
   set `HARNESS_REMOTE_WEB_DIR` in the harness's `harness.env` (in the [data folder](privacy-and-data.md#where-your-data-lives)),
   Octo serves that folder instead. Without a web app the phone sees a short "not installed" page; Settings → Remote access says
   so ("The phone's web app is not installed with this Octo") and `harness doctor` gives the reason.
3. **Settings → Remote access → turn on.** The first time you must read and confirm a warning.
4. **Pair.** Octo shows a QR code and a code like `ABCD-EFGH`. Scan the QR code, or open the address and type the code. The code is
   valid for 5 minutes and works once.
5. **Allow** the phone on the computer (Settings → Remote access lists it as waiting). A phone you do not allow within 5 minutes is dropped. Until then it can do nothing.

A wrong code is slowed down per source (after 5 wrong tries the wait grows from 30 seconds to 15 minutes), and many wrong tries
from everywhere lock the code until you make a new one.

## What a paired phone can do

| Can | Cannot |
| --- | --- |
| Read your projects, conversations, usage, sessions, search, and the **contents of your project files** | Change settings, run diagnostics, or pick folders |
| Send messages, attach files, ask side questions, edit the queue, start and message sessions | Create, change or delete projects, secrets, or the project's commands and runs |
| **Answer an approval with Allow or Deny, one request at a time**, answer a form, approve a plan | Choose **Always**, "for this request" or "Allow all": Octo refuses these (`remote_decision_forbidden`), and the phone does not offer them |
| Stop a running turn | Write files, revert changes, rewind, compact, `/clear`, edit memory or notes, delete rules or sessions |
| | Open the terminal or the Browser tab, switch branches, or post a review |

What a phone may do beyond reading can be narrowed: each device has a **read-only** switch in Settings → Remote access, and
`HARNESS_REMOTE_ALLOW` (default `send,answer,stop`) sets the default for every device (`none` = read only).

## Ending access

- **Remove** one phone (it loses access at once and can pair again), or **Remove all and turn off**.
- Turning remote access off stops the tunnel and drops the pairing code and pending phones.
- It turns itself off after 8 hours with no phone request (`HARNESS_REMOTE_IDLE_OFF_HOURS`, `0` = never), and a phone unused for 30
  days is removed (`HARNESS_REMOTE_DEVICE_IDLE_DAYS`).
- A new address on every start means the phone must pair again each time you turn it on.

A phone's token is stored on the phone (in the browser) and on your computer only as a hash.
