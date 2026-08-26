/**
 * Captures the LaunchDarkly flag values the browser actually evaluated.
 *
 * Every UI surface this script drives is flag-gated, and a flag flipping
 * underneath a run looks exactly like a broken selector — the login OTP step
 * and the offers page both cost a debugging round before anyone thought to
 * check a flag. Logging the evaluated values up front turns that into a glance.
 *
 * Read off the wire rather than out of the page: the LaunchDarkly JS client
 * fetches its flag map over HTTP at init, so intercepting the response needs no
 * API token, no LD credentials and no reach into React context.
 */

// The flags this script's selectors and step sequence actually depend on.
// Anything else LaunchDarkly returns is captured but not printed.
const FLAGS_OF_INTEREST = [
  'OFFER_PAGE_VERSION',          // "new" -> AmountSlider offers page
  'ENABLE_AUTO_PAY_DISCOUNT',    // renders the autopay toggle on offers
  'ENABLE_SMS_OTP',              // login OTP step field label
  'ENABLE_SMS_OTP_VERIFICATION', // the in-funnel SMS OTP step
  'ENABLE_MAGIC_LINK',           // OTP step button wording
  'ENABLE_APPLICATION_SELECTION',// >1 application -> /apply/application-selection
  'DYNAMIC_VERIFICATION',        // doc-upload checklist layout
];

/**
 * Attaches a response listener and returns a live map that fills in as the LD
 * client evaluates. Call before the first navigation.
 */
function watchFeatureFlags(page) {
  const flags = {};
  // Every LaunchDarkly URL seen, so "none captured" can say WHICH endpoint was
  // used rather than leaving you guessing whether LD ran at all.
  const endpoints = new Set();
  Object.defineProperty(flags, '__endpoints', { value: endpoints, enumerable: false });

  page.on('response', async (res) => {
    const url = res.url();
    if (!/launchdarkly\.com/.test(url)) return;
    endpoints.add(url.split('?')[0]);

    // The JS client evaluates over /sdk/evalx/... (polling) or /eval/...
    // (streaming). Don't hardcode either — just try to parse anything from the
    // LD hosts and keep whatever looks like a flag map.
    let body;
    try {
      body = await res.json();
    } catch {
      return; // SSE streams and event-ingest posts are not JSON flag maps
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    for (const [key, entry] of Object.entries(body)) {
      // evalx returns { value, version, ... } per flag; older shapes return the
      // bare value. Accept both, and ignore anything that is neither.
      if (entry && typeof entry === 'object') {
        if ('value' in entry) flags[key] = entry.value;
      } else {
        flags[key] = entry;
      }
    }
  });

  return flags;
}

function reportFeatureFlags(flags) {
  const captured = Object.keys(flags).length;
  if (!captured) {
    const seen = [...(flags.__endpoints || [])];
    console.log(
      'Feature flags: none captured — flag-dependent UI is unverified this run.' +
      (seen.length
        ? `\n  LaunchDarkly endpoints seen (none returned a parseable flag map):\n    ${seen.join('\n    ')}`
        : '\n  No LaunchDarkly request observed at all. Flags may be served from a proxy or bootstrapped server-side.')
    );
    return;
  }
  const shown = FLAGS_OF_INTEREST
    .map((name) => `${name}=${name in flags ? JSON.stringify(flags[name]) : '(absent)'}`)
    .join('  ');
  console.log(`Feature flags (${captured} evaluated): ${shown}`);
}

module.exports = { watchFeatureFlags, reportFeatureFlags, FLAGS_OF_INTEREST };
