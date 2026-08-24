# apply-web automation

Playwright script that walks the go-dev.happymoney.com apply funnel end to end,
driven entirely by a JSON file so scenarios can be swapped without touching code.

Lives in its own repo (sibling to `apply-web`), separate from the app's build
and the `e2e/` WebdriverIO suite there — standalone tooling for
manually-triggered QA/dev runs against go-dev, kept out of apply-web's git
history and CI on purpose.

## Setup

```sh
yarn install
yarn install-browsers          # one-time, downloads the Chromium build Playwright drives
node generate-placeholder-docs.js   # one-time (or whenever ./test-docs/ is missing) — makes 3 dummy documents for the upload step
```

## Run

```sh
yarn apply                           # uses ./test-data.json
yarn apply --data=./my-scenario.json # or any other file matching the schema
```

### SMS OTP

With `otp.mode: "skip"` (the default in `test-data.json`), the script resends
the code twice to hit the in-app retry limit, which surfaces a "Still waiting
on your code?" modal with a Skip button — no real phone needed. This is a
UI escape hatch, not a backend bypass; use it for QA runs where you just need
to get past this screen.

With `otp.mode: "prompt"`, the script instead pauses and asks you to type the
code in the terminal. For that to work, `contactDetails.phoneNumber` must be a
real, reachable number — go-dev sends live SMS. Alternatively, ask whoever
manages LaunchDarkly for this repo to set the `PHONE_FOR_SMS_OTP_DEV_TESTING`
flag in the dev environment to a number you control; when set, the app sends
the OTP there regardless of what's on the application.

### Account: log in, don't sign up

`account.mode` picks how the run starts.

| Mode | Behaviour |
|---|---|
| `auto` (default) | Seeds a fresh borrower via API immediately before the run, then logs in. Nothing to remember, nothing to run out of |
| `login` | Logs in as a pre-seeded borrower from `accounts.json` — the manual pool, kept as a fallback |
| `create` | The original path — creates an account at `/create-account` |

`auto` needs `LOANPRO_TOKEN` (copy `.env.example`). Each run mints a new
timestamped email, so runs never collide and there is no pool to top up.

**Use `login`.** `/create-account` is the only path covered by the Cloudflare rule
`WEB-ATTACK - Challenge Account Creation` (managed_challenge on go-dev, go-stage and
go), and Playwright cannot pass it: it launches a fresh profile with no `cf_clearance`
cookie and advertises automation via `navigator.webdriver`, so the challenge escalates
to the interactive checkbox and loops until the navigation times out. Being on VPN does
**not** exempt you — that rule is ordered ahead of the VPN allowlist. `/login` isn't
matched by the rule and runs clean.

You still need the VPN for everything else: a separate rule,
`BLACKLIST - Block URL Suffixes`, blocks all of `*dev.happymoney.com` outright, and the
VPN allowlist is the only reason go-dev is reachable at all.

### Seeding accounts

A seeded account is a Cognito-**confirmed** borrower linked to an empty LoanPro
application at sub-status 60 (Started), so login lands on `/apply/loan-details` — the
same place account creation would have. Accounts are single-use: once a run walks the
funnel, that application has moved past Started.

`seed-account.js` builds one on demand under `mode: "auto"`, so normally there is
nothing to do. `mode: "login"` reads a manual pool from `accounts.json` instead
(copy `accounts.example.json`); `accounts.js` claims the next unused entry and marks
it used *before* the run, since a half-walked application is spent either way.

To top up the manual pool, from the `happy-money-assistant` repo:

```sh
python3.11 tools/test-user-manager.py create --scope orig --native --tag <unique> --env dev --execute
```

That tool is the canonical implementation; `seed-account.js` is a port of it. If the
two ever disagree, the Python tool is right.

🔴 **Emails are single-use and the flow is one-shot.** `/no-auth/auth/signup` creates
an *unconfirmed* Cognito user, and the only thing that confirms it is
`PATCH /no-auth/borrowers/update-borrower-subscriber-id`, which needs an LOS
application and can only ever be called once per borrower. If a Cognito user already
exists for the email when the LoanPro customer is created, the `loanpro-cognito-sync`
Lambda claims the link first, the confirm call is refused, and the account is stranded
unconfirmed permanently — with no recovery through the public surface. Always use a
fresh `+tag`, and don't hand-roll this sequence; use the tool.

### Feature flags

Nearly every surface this script drives is flag-gated, so a flag flipping
underneath a run looks exactly like a broken selector. Each run prints the
values LaunchDarkly actually evaluated, read off the wire (no LD token needed):

```
Feature flags (N evaluated): OFFER_PAGE_VERSION="new"  ENABLE_AUTO_PAY_DISCOUNT=true  ...
```

**Check that line first when a selector breaks.** Values in `apply-web-internal`
/ dev as of 2026-08-24:

| Flag | dev | What it changes |
|---|---|---|
| `OFFER_PAGE_VERSION` | `"new"` @ 100% | AmountSlider offers page. Permanent direction; the original page is not handled |
| `ENABLE_AUTO_PAY_DISCOUNT` | ON | Renders the autopay toggle on offers |
| `ENABLE_SMS_OTP` | ON | Login OTP step labels its field "Email or US mobile number" |
| `ENABLE_SMS_OTP_VERIFICATION` | ON | The in-funnel SMS OTP step that `otp.mode` handles |
| `ENABLE_MAGIC_LINK` | OFF | ON changes the OTP button to "Continue without password" |
| `ENABLE_APPLICATION_SELECTION` | ON | A borrower with >1 application is routed to `/apply/application-selection` — another reason accounts are single-use |
| `DYNAMIC_VERIFICATION` | ON | Doc-upload checklist layout and required-action panel |

Also live: `ENABLE_REFI_FLOW` ON, `SKIP_DIRECT_CARD_PAYOFF` ON,
`ENABLE_CREDIBLE_AS_TURNDOWN_PARTNER` ON, `ENABLE_TRUSTAGE` OFF,
`SKIP_CHECKING_DEVICE_DETECTION` OFF, `PLAID_SKIP_ALLOWED_CHECK` OFF,
`SHOW_NOTIFICATION_BANNER` OFF.

Note `PHONE_FOR_SMS_OTP_DEV_TESTING` is OFF and its fallthrough is a `+84…`
number, so turning it on without setting your own would send codes somewhere you
cannot read them.

### Document upload is a branch, not a step

**A clean applicant never sees the document-upload screen.** LoanPro only
requests documents when identity or income verification fails. When it passes,
apply-web's `noRequiredDocUpload` goes true and the checklist auto-passes with
nothing to upload. Measured in LoanPro orig-sandbox: **55 of the 66**
applications that reached Originated last month uploaded no documents at all.

So `uploadDocuments()` is conditional — it counts the rendered file inputs and
skips the whole step when there are none. Which branch you get is decided by
your test data:

| Scenario | Data | What happens |
|---|---|---|
| Happy path | `test-data.json` (zip `66209`) | Verification passes, no documents requested, funnel continues |
| Doc upload | `scenarios/doc-upload.json` (zip `66206`) | Verification fails, documents requested, upload UI exercised |

The discriminator is the zip code. `4317 W 125TH ST, LEAWOOD, KS` matches the
bureau record at **66209**; at 66206 it does not, so Identity Address Match
(cf600) and Identity SSN Match (cf602) both land on Fail and identity documents
get requested.

When documents *are* requested, `documentUpload.*` points at 3 files uploaded
via Playwright's `setInputFiles` — no need to interact with the dropzone UI.
`generate-placeholder-docs.js` creates dummy images large enough to clear the
client-side 10KB minimum; the automated image-quality check still rejects them
as unreadable, so the script clicks through the resulting "Keep File" override
for each.

Be aware that "Keep File" only overrides the **frontend** check. The backend
verdict still lands as Ocrolus "Invalid document", which permanently blocks the
underwriting-complete automation rule — see below.

### Getting past underwriting (`loanpro.enabled`)

An application whose documents were uploaded stops at LoanPro sub-status 64
(Underwriting) — that is what the "Document Review in Progress" screen means.
Rule 259 moves it on to Underwriting Complete (132), but refuses while any
checklist item sits at a Rejected status, which the placeholder images
guarantee.

With `"loanpro": { "enabled": true }`, the script clears those blockers through
the LoanPro API after the upload step (see `loanpro.js`) and lets the run carry
on. It requires `LOANPRO_TOKEN` — copy `.env.example` and fill it in.

This is a backend state nudge for QA runs, in the same spirit as the OTP skip
above — not a product behavior, and off by default.

## test-data.json fields

| Key | Notes |
|---|---|
| `environment.baseUrl` | go-dev by default |
| `account.mode` | `login` (default) uses a seeded account from `accounts.json`; `create` signs up at `/create-account` — see "Account: log in, don't sign up" |
| `loanDetails.desiredLoanAmount` | Initial ask, $5,000–$50,000 |
| `aboutYou.*` | Name / DOB / citizenship status |
| `contactDetails.*` | Address + phone (see OTP note above) |
| `financialDetails.*` | Income + housing |
| `verifyIdentity.*` | SSN last 4, occupation, employer |
| `offerSelection.loanAmount` | Adjust the final loan amount on the offers page (e.g. `"$5,500"`) — independent from the initial `loanDetails.desiredLoanAmount` ask |
| `offerSelection.applyAutopayDiscount` | `true`/`false` — toggles the Autopay discount switch on the offers page |
| `offerSelection.offerIndex` | Which of the 4 offer terms to pick (0 = lowest APR ... 3 = lowest payment) |
| `otp.mode` | `"skip"` (default) exhausts resend attempts and clicks the in-app Skip button; `"prompt"` waits for you to type a real code |
| `documentUpload.ssnCardPath` / `.addressVerificationPath` / `.govIdPath` | Paths to the 3 documents, relative to this folder. Only used when the checklist actually requests documents |
| `loanpro.enabled` | `true` clears the underwriting blockers via the LoanPro API after an upload, so the run continues past sub-status 64. Needs `LOANPRO_TOKEN`. Default `false` |

Copy `test-data.json` to a new file per scenario (e.g. `scenarios/high-income.json`)
and pass it with `--data=`.

## Known gap

The script reaches Underwriting Complete (sub-status 132). Steps beyond that —
Stacker Check, Pre-Funding, TIL/esign, Originated — aren't mapped yet. Extend
`apply-flow.js` once that part of the funnel is walked.

Each of those is gated by another LoanPro automation rule. To find the next
gate, from the `happy-money-assistant` repo:

```sh
python3.11 tools/automation-rules-decoder.py --status <substatus> --database orig-sandbox
python3.11 tools/automation-rules-decoder.py <ruleId> --loan <appId> --database orig-sandbox
```

The second form shows which conditions are failing for a specific application.
Note it doesn't evaluate `let`-bound clauses and flattens ORs into ANDs, so read
the raw Clojure it prints rather than trusting the summary table.

> **Correction (2026-08-24).** An earlier version of this section claimed
> "LoanPro is unrelated — it's used only for post-funding servicing in
> member-react," and that no override existed to force document review to
> complete in dev. Both are wrong, and the first is what made the second look
> true. LoanPro **originations sandbox** (tenant 5203310, database `5203310_S`)
> is the system of record for the entire pre-funding funnel on go-dev —
> `los-reader` reads applications from it, `underwriting-srv` writes checklist
> items to it, and `apply-bff` maps its loan settings into the GraphQL layer.
> The override is the LoanPro API, not a frontend flag, which is why searching
> apply-web / member-react / point-break turned up nothing.

## A note on the test persona

`test-data.json` carries a name, DOB, full street address, phone number and SSN
last-4 in a public repo. It's a shared synthetic QA persona rather than a real
customer, but that's still a poor shape to publish. Worth moving the persona
fields into a gitignored local file (or a private scenarios repo) and committing
a sanitized `test-data.example.json` in its place.
