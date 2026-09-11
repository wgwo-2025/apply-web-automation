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

### Skipping document upload with a `fraud_pass` test email

The identity documents have two independent triggers, and the test email only
turns off one of them. Both were measured in orig-sandbox.

**Social Security Card** is required when the last four digits the borrower
types do not match the bureau's SSN -- see the `ssnLast4` section below. That is
data, not a flag, and no email changes it.

**Government Issued ID** is required by `FraudService.applyFc3EmailAndKountRule`,
which fires when fraud check 3 runs *and* Oscilar's email/Kount rule triggers:

```java
if (!Objects.equals(fraudCheckInput.getFraudCheckIndex(), 3)
    || !fraudCheckResponse.isEmailAndKountRuleTriggered()) {
    return;
}
```

`isEmailAndKountRuleTriggered` is an Oscilar verdict, and Oscilar's mocked
response is steered by the borrower's email address. Applications where it fires
carry sub-portfolio **141 "Email and Kount"** -- that tag is the tell.

Use an address of this exact shape:

```
test+dev.offers.approved.fraud_pass.<digits>@happymoney.com
```

Every segment earns its place, because the grammar has TWO consumers:

| Consumer | Grammar | Effect |
|---|---|---|
| Oscilar workflow steering | loose; documented on Confluence pageId 9936797715 | picks the mocked offers/fraud outcome |
| `underwriting-srv` `TestEmailPatternConfig` | strict: literal `test+`, env segment required, `offers.approved` only, pure-digit trailing id | stops underwriting-srv applying its own fraud bypass, so the mocked result flows through unchanged |

Miss the strict regex and Oscilar still steers, but underwriting-srv keeps its
bypass on and the mocked fraud result does not survive. Emails are single-use --
a repeated address is rejected at Cognito signup and the new application ends up
orphaned from the login.

**Measured over applications created since 2026-06-01:** 0 of 270 `fraud_pass`
applications carry sub-portfolio 141, so that path is reliably off.

54 of 199 do still show Government Issued ID at status Required -- but read that
row before believing it, because **it is usually written after the funnel has
already passed the checklist.** On application 69951, LoanPro rule 280
("Document Automation - Government Issued ID (Fraud)") wrote it at 21:48:50; the
application had reached Approved at 21:48:49, one second earlier. Of those 54,
nine reached **Originated** and three more Allocated, which is only possible if
the requirement landed after the gate it appears to control.

The page never reads that field anyway:

```js
const noRequiredDocUpload = documentVerifications?.length === 0
```

`documentVerifications` comes from `applicationById.documents`, not from the
checklist item's `status_catalog_id`. So a "Required" row in LoanPro and a
checklist that auto-passed are not in conflict; they are different signals.

One visible side effect: a browser left sitting on the checklist flips out of
the auto-pass loader into the "Let's Wrap This Up!" view on its next 30-second
reload, because that reload now sees the document. The application is already
approved by then; the view is a late re-render, not a gate.

Two other writers can require the ID genuinely, before the checklist:
`buildGovernmentIdChecklist` (bureau name or DOB match fails) and
`FraudCheckUnderwritingHandler` (`Fraud Detection ID` blank). Neither is steered
by the email.

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
| `fundingAccount.routingNumber` / `.accountNumber` | Bank pair entered on the funding-account page; must pass GIACT |
| `loanpro.enabled` | `true` clears the underwriting blockers via the LoanPro API after an upload, so the run continues past sub-status 64. Needs `LOANPRO_TOKEN`. Default `false` |

Copy `test-data.json` to a new file per scenario (e.g. `scenarios/high-income.json`)
and pass it with `--data=`.

## Past approved: funding account and autopay

Three more pages are driven after the approved page, read from the deployed
`fund-mfe-ui`:

| Page | What the script does | Gate it satisfies |
|---|---|---|
| `/fund/approved/:id` | click **Continue** | `confirmPartner` -> `Capital Partner Privacy Policy Consent Date (cf233)` |
| `/fund/funding-account/:id` | "Linked account(s)" -> **Link other account**; fill Routing / Account / Retype; the group's Continue runs **GIACT**; once it passes the page's Continue appears; **Confirm & continue** | a payment account, active and visible |
| `/fund/autopay/:id` | pick the just-linked account; Continue; **Confirm & continue** | `Autopay Capture Date (cf235)` |

It stops on `/fund/truth-in-lending/:id`. Direct card payoff is skipped because
`SKIP_DIRECT_CARD_PAYOFF` is ON in dev.

**The bank pair matters.** `fundingAccount` in `test-data.json` is the data
factory's auto-pass persona's (`routingNumber` 271081528, `accountNumber`
2710815280016, `plaidUser: custom_plaid_and_giact`), which its own description
says passes bank verification. GIACT is a real external check; other numbers
turn the run into a GIACT experiment. If it fails the error names the routing
number, the group's button text and any alert or dialog on screen.

**The funding-account fields are inline, not in a modal.** `BankLinkingInputGroup`
renders on the page; its only `Modal` is the "How do I find it?" help. While it is
shown and GIACT has not passed, the page-level Continue is not rendered at all --
so the script waits for a *second* Continue button to appear rather than for
text, which is the signal that `isAccountPass` flipped.

**Still unmapped:** Truth in Lending needs a real generated TIL PDF on checklist
item 96 (`loanpro_docgen`, a backend step), e-sign is an embedded DocuSign flow
with a callback, and the funded page is `/fund/funded/:id`. Every existing
funded-page test account in the team's recipes was *seeded* at sub-status 67,
not walked through e-sign.

## Selectors track a deployed build, not a branch

go-dev serves whatever was last dispatched to it, which is not `main` and not
your local checkout. Deploys go out by manual `workflow_dispatch` only:

```sh
gh run list --repo HappyMoneyInc/apply-web --workflow pipeline.yml --limit 5
```

That skew is a real failure mode, not a hypothetical. The script sat untouched
from 2026-08-24 to 2026-09-09 while go-dev moved from `main` (Aug 26) to
`releases/release-092026`, and the first run after that broke on About You's
citizenship dropdown -- a selector that was correct when written.

The script prints `Deployed build: <semver>-<sha>` right after login (it reads
`<meta name="version">`); `git log -1 <sha>` in apply-web names the branch.
Check it first whenever a page that passed yesterday fails today.

### go-dev can be overwritten by anyone's feature branch

Measured 2026-09-11: application 70105 reached the offers page and landed on
`/error` ("Something went wrong!"). Nothing was wrong with the application --
its offers and `#attributionsurl` note were fine and identical in shape to
70104, which had passed the night before. What changed was go-dev: at 12:21 UTC
a developer dispatched `thuynh/ORIG-3357-post-hero-height-to-parent`
(`6a24435`, branched from the release on 2026-08-21) on top of the
`releases/release-092026` deploy. That branch still carries the legacy offers
page that ORIG-3324 deleted on 2026-09-06, selected by the LaunchDarkly flag
`OFFER_PAGE_VERSION`. Every dev deploy re-applies the LD flags from its own
branch's terraform into one shared state, so the day's alternating deploys
deleted and recreated that flag three times; after the last recreation the
client-side SDK stopped serving it at all, the app fell through to the legacy
page, and the legacy page throws on 5+ featured offers
(`getOfferCardStyles` returns 4 styles, ORIG-3073 raised the featured count
to 6): `TypeError: Cannot read properties of undefined (reading 'title')`.

None of that is reachable from this script. The fix is a redeploy of
`releases/release-092026` to dev (the `pipeline` workflow, `workflow_dispatch`),
and the application resumes from Offers Shown untouched once it is.

### Two dropdown implementations are live at once

ORIG-3005 migrated About You and Contact Details to `FormDropdown`, built on
ui-library's `Dropdown`. That wraps Radix's dropdown-**menu** primitive, so its
options are `role="menuitem"`. Financial Details was out of that ticket's scope
and still renders `FormSelect` -> `SelectDropdown`, whose options are
`<li role="option">`.

`selectDropdown()` matches both. When the remaining pages migrate, the
`li[role="option"]` half becomes dead and can go -- but not before.

## The funding-account page is the dev ceiling

GIACT runs against PRODUCTION credentials from every environment — there is no
dev stub and no TestMode account configured. The reference pair in
`test-data.json` (`271081528` / `2710815280016`) is a fabricated account, so
GIACT can confirm the routing number but holds no OWNER record for it.

Measured on application 70100, 2026-09-11 21:34 UTC:

| Field | Value | Meaning |
|---|---|---|
| `Bank 1 Giact Account Response Code (cf193)` | `ND00` | no data on the account — not itself a failure |
| `Bank 1 Giact Account Status (cf740)` | `1` | Pass |
| `Bank 1 Giact Ownership Status (cf745)` | `2` | **Fail** |
| `Bank 1 Giact Customer Response Code (cf192)` | empty | no ownership data, not an adverse mismatch |
| `Bank Account Validation 1 (cf610)` | `3` | Fail |

Consequences on the application: rule 248 `Bank Account Validation 1 - Fail`,
rule 278 `Document Review Process - Review Needed`, portfolios `GIACT (181)`,
`Document Review (162)` and `Ineligible Account (190)`, and a payment profile
created with `active = 0`.

**Uploading a document in the dialog does not rescue the run.** Continue is
gated on `isActivePaymentAccount` (`fund-mfe-ui/src/hooks/useAutoPayment.js`),
which requires `bank.active && !bank.giact_check_required`. Only an ops
document review flips those, so the upload path ends in a queue, not in autopay.

🔴 **A failed GIACT run also HIDES the account you already had.** The route
takes `hasFundingAccount` = some bank with `active && visible === 1`
(`fund-mfe-ui/src/utils/loanApplication.js:28`). On 70104 a seeded profile was
`active=1, visible=1` at 21:50; the script forced "Link other account" anyway,
GIACT failed at 22:02:51, and that same minute underwriting-srv flipped the
seeded profile to `visible=0`. So the page is not merely a dead end — entering
bank details there is destructive. `linkFundingAccount` now selects an account
already on file and only falls back to manual entry when the dropdown has none.

`visible` is not repairable over the API: a PUT setting it returns 200 and
changes nothing. Destroy the profile (`__destroy`) and create a fresh one — new
profiles come in `visible=1`.

By contrast the QA data factory never runs GIACT for its fund-stage templates —
it stamps `cf193='pass'`, `cf740=1`, `cf745=1`, `cf931=1`, `cf936=1`, `cf610=2`
and creates the payment profile `active=1` (see application 69467). That is how
autopay, TIL and e-sign get exercised.

So: this script walks the funnel end to end as far as the funding-account page,
which is as far as a synthetic borrower can go unattended. Anything past it
needs an application whose funding account was seeded that way.

## Truth in Lending needs a real document

The TIL page renders without one, but `Continue with E-sign` is
`disabled: isLoading || !temporaryTILPdfUrl` — and that URL comes from
`GET /documents/til-download`, which apply-bff serves out of **Smart Checklist
item 96**, keeping only items that actually carry an attachment. An application
that never had a TIL generated leaves the button dead forever, so a disabled
CTA here is a data problem, not a slow page.

Generate one (Halle has the LoanPro credentials; sandbox TIL template is 34):

```
python3.11 -c "
import sys; sys.path.insert(0,'tools'); sys.path.insert(0,'tools/doc_gen')
from loanpro_test_base import get_loanpro_config, parse_environment
import loanpro_docgen as dg
print(dg.generate_and_upload(get_loanpro_config(parse_environment('orig-sandbox')), <loanId>, 'til', 'orig-sandbox'))"
```

**Clicking is one-shot.** It PUTs `/til/accept` (writes `TIL Acknowledged Date
(cf236)`), rule 228 advances the application to sub-status 105, and the page
then hands off to DocuSign through `window.location`. There is no way back —
build a fresh application rather than trying to rewind one.

The script stops at that hand-off. Whether it lands on DocuSign itself or on
`/fund/docusign-callback/:id` (the fallback when `generateDocusignUrl` throws)
is reported, because the two mean very different things: the callback route
means no envelope was ever created.

## Reusing an account that is already past approval

`accounts.json` entries are consumed in order and marked `used` after login.
An entry whose application is ALLOCATED (sub-status 123) is still worth
running: apply-web resumes it in the **fund** stage, and the script now skips
apply, offers and verification and drives whatever fund page is on screen
(`walkFundSteps`). Set `"used": false` on such an entry to replay it.

Accounts whose application never left Started (60) replay the whole funnel,
which is what the pool was originally for.

## Applications need funnel identifiers or they cannot be allocated

An application created through the LoanPro API -- by `seed-account.js`, or by
happy-money-assistant's `test-user-manager --native` -- is a bare shell. The
real funnel assigns three identifiers at signup that the API path does not:

| Field | Example (from a manual walk) |
|---|---|
| `Application Guid (cf659)` | `3e0b7bd0-f678-4666-a0fe-c9ff9e85e358` |
| `Application ID (cf130)` | same value |
| `PayoffLoanId (cf696)` | `HMc9ff9e85e358` -- `HM` + the guid's last segment |

**Without them the application reaches Approved (95) and stops there
permanently.** On approval, underwriting-srv's `PartnerAllocationEventConsumer`
calls `assignInvestor(applicationId)`; the allocation engine finds no guid and
returns a null `leadGuid`, which fails Avro deserialization inside
`AllocationEngineClient`:

```
Call assignInvestor - Allocation Engine failed:
  Avro Error ... Field leadGuid type:STRING pos:1 does not accept null values
```

That throws before `getCapitalPartner()` runs, so `Capital Partner (cf231)` is
never written and the application never advances to Approved Received (124) or
Allocated (123). `getFundRoute` requires `ALLOCATED && capitalPartner`, so every
page past the verification checklist is unreachable in the browser -- the
approved page, autopay, TIL/esign, funded.

`seed-account.js` now writes all three in `stampFunnelIdentifiers()`, so
`mode: "auto"` produces applications that both decision AND allocate. This
requires `LOANPRO_TOKEN`, which that path already required.

**Applications from the pool are a different matter.** Anything seeded before
2026-09-10 -- the whole `[AWA]` batch, and anything from `test-user-manager
--native` -- lacks these fields and will stall at Approved. Check before
assuming an account is good:

```sh
python3.11 tools/execute-analytics-query.py --database orig-sandbox --format csv \
  "SELECT cf.custom_field_id, cf.custom_field_value FROM loan_settings_entity lse
   JOIN custom_field__entity cf ON lse.id=cf.entity_id AND cf.entity_type='Entity.LoanSettings'
   WHERE lse.loan_id=<appId> AND cf.custom_field_id IN (130,659,696)"
```

Three rows means it can allocate. No rows means it cannot, and the fields have
to be written before the run.

**Measured 2026-09-10.** Applications 69951, 69953 and 69954 all stalled at
Approved with no capital partner. Application 70089 was given these three fields
before its run and allocated to FTCU within seconds of Approved. The only
variable changed was the stamp. The same limitation is documented for the
sibling path in `test-user-manager.py`, whose native builder deliberately
creates "the minimum an identity needs and nothing more".

## Known gap

**Where the script stops is not where the application stops.** On a clean run
the script's last act is `uploadDocuments()` returning false, after which it
prints and closes the browser -- so the browser is still sitting on
`/verify/check-list/<id>` when the run ends. The application meanwhile keeps
going on its own.

Measured on application 69951 (2026-09-09), a `fraud_pass` run that requested no
documents. From offer selection to Approved took 65 seconds, unattended:

```
21:47:44  Offers Shown
21:47:46  Offer Selected
21:47:58  Rule: Fraud Check 3 (246)
21:48:16  Automated Underwriting Requested
21:48:24  Automated Underwriting Completed
21:48:27  Underwriting
21:48:30  Underwriting Complete            (132)
21:48:33  Stacker Check Requested
21:48:45  Stacker Check Completed
21:48:49  Approved                         (95)
```

So Stacker Check needs no help from the script, and Underwriting Complete is no
longer the ceiling.

### RESOLVED: the runs now allocate, and the walk reaches the approved page

The blocker below was allocation, not navigation. It is fixed -- seeded
applications are now stamped with the funnel identifiers (see the section above)
and allocate normally, and `reachApprovedPage()` drives the browser the rest of
the way. Application 70089 was the first: stamped, walked, allocated to FTCU.

The history is kept because the failure mode is worth recognising if it recurs.

**The page is genuinely unreachable when the application has no capital
partner:**

```js
isApplicationApproved = (app) => app?.loanSubStatus === ALLOCATED && !!app?.capitalPartner
```

`getFundRoute` requires one, so with none there is no fund route to navigate to.

Measured across three applications with the same email shape, the same
`test-data.json` values and the same deployed build:

| | 70020 (manual walk) | 69951, 69953 (Playwright) |
|---|---|---|
| `Allocation Status (cf496)` | 1 | 1 |
| `Capital Partner (cf231)` | **MERRICK** | empty |
| `Capital Partner Allocation Date (cf232)` | 2026-09-09 23:54:09 | empty |
| Final sub-status | Allocated (123) | stuck at Approved (95) |

On 70020, underwriting-srv wrote all three in one second and the status moved to
Allocated three seconds later. On the automated runs that block never fired: the
allocation ENGINE ran (cf496 = 1 everywhere) but no partner was written back.

The cause was the missing `Application Guid` -- the allocation engine had no
`leadGuid` to return. Both earlier theories (polling interference, a skipped
step) were wrong.

`reachApprovedPage()` goes DIRECT to `/fund/approved/<id>`, not through
`/apply/route/application/<id>`: `RouteApplication` evaluates `getVerifyRoute`
before `getFundRoute`, and `getVerifyRoute` claims the route whenever
`isInVerificationStatus` -- which includes Approved. The fund MFE's own
`useIsValidRoute` consults `getFundRoute` alone, so a direct hit is accepted once
the application is Allocated. Before that it bounces, which is the retry signal.

To check after any run:

```sh
transaction-log.py <appId> --database orig-sandbox --format timeline
```

A `Capital Partner` value means it allocated. Empty means it stalled at 95, and
nothing downstream -- approved, autopay, TIL/esign, funded -- is reachable.

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

## `ssnLast4` tracks the sandbox bureau, and it goes stale

The verify step's field is last-four only (`SharedSsn.js`, `maxLength: 4`,
"Last 4 Digits of Social Security Number (SSN)"). The borrower confirms four
digits against the SSN the credit bureau already returned -- they do not supply
the SSN. `FraudService.isLastFourSsnMatched` compares
`Last 4 of SSN (cf283)` against the last four of `Bureau SSN (cf174)`, and a
mismatch is enough on its own to flip the application off the bureau-passed
path and mark Social Security Card required, even when name, DOB, suffix and
address all pass.

**The value is not a property of the persona -- it is a property of the sandbox
bureau mock, and that mock changes.** For ZENAIDA ACHURRA it returned
`666646481` through Jan 2026, crossed over during Feb-Mar 2026, and has
returned `223344556` (last four **4556**) ever since. `666646481` is still
hardcoded as this persona's canonical SSN in happy-money-assistant's
`data_factory_models.py`; that value predates the cutover.

Re-derive it rather than trusting this file, from `happy-money-assistant`:

```sh
python3.11 tools/execute-analytics-query.py --database orig-sandbox --format table \
  "SELECT cf.custom_field_value FROM loan_settings_entity lse
   JOIN custom_field__entity cf ON lse.id=cf.entity_id AND cf.entity_type='Entity.LoanSettings'
   WHERE lse.loan_id=<a recently decisioned app> AND cf.custom_field_id=174"
```

The durable fix is to read cf174 over the LoanPro API mid-run and type its last
four, which survives the next cutover. That needs `LOANPRO_TOKEN`; the
hardcoded value does not.

## A note on the test persona

`test-data.json` carries a name, DOB, full street address, phone number and SSN
last-4 in a public repo. It's a shared synthetic QA persona rather than a real
customer, but that's still a poor shape to publish. Worth moving the persona
fields into a gitignored local file (or a private scenarios repo) and committing
a sanitized `test-data.example.json` in its place.
