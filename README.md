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

### Document upload

`documentUpload.*` points at 3 files (SSN card, address verification, gov ID)
uploaded via Playwright's `setInputFiles` — no need to interact with the
dropzone UI. `generate-placeholder-docs.js` creates dummy images large enough
to pass the client-side 10KB minimum; apply-bff's automated image-quality
check will reject them as unreadable, so the script clicks through the
resulting "Keep File" override for each. Swap in real document images by
pointing the paths at your own files instead.

## test-data.json fields

| Key | Notes |
|---|---|
| `environment.baseUrl` | go-dev by default |
| `account.email` | New account email; must be unique per run |
| `loanDetails.desiredLoanAmount` | Initial ask, $5,000–$50,000 |
| `aboutYou.*` | Name / DOB / citizenship status |
| `contactDetails.*` | Address + phone (see OTP note above) |
| `financialDetails.*` | Income + housing |
| `verifyIdentity.*` | SSN last 4, occupation, employer |
| `offerSelection.loanAmount` | Adjust the final loan amount on the offers page (e.g. `"$5,500"`) — independent from the initial `loanDetails.desiredLoanAmount` ask |
| `offerSelection.applyAutopayDiscount` | `true`/`false` — toggles the Autopay discount switch on the offers page |
| `offerSelection.offerIndex` | Which of the 4 offer terms to pick (0 = lowest APR ... 3 = lowest payment) |
| `otp.mode` | `"skip"` (default) exhausts resend attempts and clicks the in-app Skip button; `"prompt"` waits for you to type a real code |
| `documentUpload.ssnCardPath` / `.addressVerificationPath` / `.govIdPath` | Paths to the 3 required documents, relative to this folder |

Copy `test-data.json` to a new file per scenario (e.g. `scenarios/high-income.json`)
and pass it with `--data=`.

## Known gap

The script currently stops once documents are submitted, when the
application reaches "Document Review in Progress" — an async `apply-bff`
queue with no frontend-controllable next step. Steps beyond that (final
approval, bank linking via Plaid/manual, funding) aren't mapped yet — extend
`apply-flow.js` once that part of the funnel is walked. No admin API or
override was found in any local repo (apply-web, member-react, point-break,
ai-documentation) to force document review to complete in dev; LoanPro is
unrelated — it's used only for post-funding servicing in member-react.
