// Turns a raw job from Upwork's feed response into a verdict.
// Exposed on window.UWR for content.js and popup.js.

(() => {
  const FIXED = 1;
  const HOURLY = 2;

  const DEFAULT_RULES = {
    minFixedBudget: 1000, // you don't bid fixed-price under this
    minHourlyRate: 15, // ...or hourly under this, when a rate is stated
    minClientSpend: 2000, // client must have moved this much money, lifetime
    ringMinPerHire: 100, // spend/hires below this never rings (mill detector)
    eliteSpend: 10000, // an elite client can ring without a stated rate
    minRating: 4.0,
    minReviews: 3, // a 5.0 from one review is not a 5.0
  };

  const VERDICT = { RING: "RING", FEED: "FEED", HIDE: "HIDE" };

  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

  function normalize(raw) {
    const c = raw.client || {};
    const spent = num(c.totalSpent);
    const hires = num(c.totalHires) || 0;
    const hourly = raw.hourlyBudget || {};
    const hourlyMin = num(hourly.min) || 0;
    const hourlyMax = num(hourly.max) || 0;

    return {
      id: raw.uid || raw.id,
      ciphertext: raw.ciphertext,
      title: raw.title || "(untitled)",
      description: raw.description || "",
      type: raw.type,
      isHourly: raw.type === HOURLY,
      // Hourly jobs carry amount:0 -- the money is in hourlyBudget. Reading
      // `amount` for an hourly job and calling it the budget throws away the
      // best jobs on the board.
      fixedBudget: raw.type === FIXED ? num(raw.amount && raw.amount.amount) : null,
      hourlyMin,
      hourlyMax,
      hourlyStated: hourlyMin > 0 || hourlyMax > 0,
      postedAt: Date.parse(raw.publishedOn || raw.createdOn) || null,
      proposalsTier: raw.proposalsTier || "?",
      tier: raw.tierText || raw.tier || "",
      duration: raw.durationLabel || raw.duration || "",
      engagement: raw.engagement || "",
      skills: (raw.attrs || []).map((a) => a.prettyName || a.prefLabel).filter(Boolean),
      isApplied: !!raw.isApplied,
      country: (c.location && c.location.country) || "?",
      spent,
      hires,
      perHire: spent !== null && hires > 0 ? spent / hires : null,
      reviews: num(c.totalReviews) || 0,
      rating: num(c.totalFeedback),
      paymentVerified: c.paymentVerificationStatus === 1,
      isNewClient: spent === null || hires === 0,
    };
  }

  function evaluate(raw, rules) {
    const r = Object.assign({}, DEFAULT_RULES, rules || {});
    const j = normalize(raw);
    const kills = [];
    const flags = [];

    if (j.isApplied) kills.push("already applied");

    if (j.isHourly) {
      if (j.hourlyStated && j.hourlyMin > 0 && j.hourlyMin < r.minHourlyRate) {
        kills.push(`$${j.hourlyMin}/hr below $${r.minHourlyRate}`);
      }
      if (!j.hourlyStated) flags.push("rate unstated");
    } else if (j.fixedBudget !== null && j.fixedBudget < r.minFixedBudget) {
      kills.push(`fixed $${j.fixedBudget} below $${r.minFixedBudget}`);
    }

    if (j.spent === null) kills.push("client has never spent");
    else if (j.spent < r.minClientSpend) kills.push(`client spent only $${Math.round(j.spent)}`);

    if (!j.paymentVerified) flags.push("payment unverified");
    if (j.reviews > 0 && j.reviews < r.minReviews) flags.push(`only ${j.reviews} review(s)`);
    if (j.rating !== null && j.reviews >= r.minReviews && j.rating < r.minRating) {
      kills.push(`rated ${j.rating} over ${j.reviews} reviews`);
    }

    // Total spend proves volume, not generosity: a client can reach $50k by
    // paying 500 people $100 each. spend/hires is the closest the feed gets to
    // "what does one freelancer actually walk away with".
    if (j.perHire !== null && j.perHire < r.ringMinPerHire) {
      flags.push(`$${Math.round(j.perHire)}/hire -- unlikely to pay $${r.minFixedBudget}`);
    }

    let verdict;
    if (kills.length) {
      verdict = VERDICT.HIDE;
    } else if (j.perHire === null || j.perHire < r.ringMinPerHire) {
      verdict = VERDICT.FEED;
    } else if (j.isHourly && !j.hourlyStated) {
      // No stated rate: only an elite client earns a ring on history alone.
      verdict = j.spent >= r.eliteSpend ? VERDICT.RING : VERDICT.FEED;
    } else {
      verdict = VERDICT.RING;
    }

    return Object.assign(j, {
      verdict,
      kills,
      flags,
      score: rank(j),
      seenAt: Date.now(),
    });
  }

  // Ordering for the panel. Money the client actually pays per person dominates,
  // with lifetime spend and freshness as tiebreakers.
  function rank(j) {
    let s = 0;
    if (j.perHire !== null) s += Math.min(j.perHire, 1000) / 2;
    if (j.spent !== null) s += Math.min(j.spent / 1000, 60);
    if (j.rating !== null && j.reviews >= 3) s += (j.rating - 4) * 20;
    if (j.hourlyStated) s += Math.min(j.hourlyMax, 100) / 2;
    if (j.fixedBudget) s += Math.min(j.fixedBudget / 100, 50);
    if (j.paymentVerified) s += 15;
    const ageMin = j.postedAt ? (Date.now() - j.postedAt) / 60000 : 999;
    s += Math.max(0, 40 - ageMin / 3); // being early is worth real points
    return Math.round(s);
  }

  function money(n) {
    if (n === null || n === undefined) return "--";
    if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return `$${Math.round(n)}`;
  }

  function age(ts) {
    if (!ts) return "?";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  window.UWR = { DEFAULT_RULES, VERDICT, evaluate, money, age };
})();
