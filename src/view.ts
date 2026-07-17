import { Decimal } from "decimal.js";
import { balancesReport, effectiveRate, foldTab, shareAmount, type FoldResult } from "./fold.js";
import { Ledger, Tab, TabEvent } from "./types.js";

/**
 * Server-rendered HTML for any tab. Everything is folded from the event log per request —
 * there is no snapshot to go stale — and nothing content-specific is hardcoded: no
 * participant, no currency, no narrative.
 *
 * Layout leads with the tab (rates in force, who owes what, the entries, settlements) and
 * keeps the per-person breakdown as a section you opt into, so the page reads the same for
 * a wedding pool, a trip, or a house project.
 *
 * Formatting rule: the currency ALWAYS leads the figure — ₦1,234 / £45 / XYZ 1,234 — and
 * a minus leads the symbol (−₦292, never ₦−292). No bare numbers anywhere.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const SYMBOLS: Record<string, string> = {
  NGN: "₦", GBP: "£", USD: "$", EUR: "€", JPY: "¥", INR: "₹", KES: "KSh", GHS: "₵", ZAR: "R",
};

/** Thousands-grouped magnitude; trailing .00 dropped — ledger figures, not accounting output. */
function group(d: Decimal): string {
  const neg = d.isNegative();
  const [int, frac] = d.abs().toFixed(2).split(".");
  const withSep = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = frac === "00" ? withSep : `${withSep}.${frac}`;
  return (neg ? "−" : "") + body;
}

/**
 * Anything under half the smallest displayed unit IS zero for display purposes.
 * Percentage shares divide into non-terminating decimals, so a fully-settled person can
 * carry a ±1e-3 residue — without this they'd render as a red "−₦0" marked "owes".
 */
const flat = (d: Decimal) => d.abs().lt("0.005");

/** Currency-led money. signed=true also prefixes + on positives. */
function money(d: Decimal, ccy: string, signed = false): string {
  const s = SYMBOLS[ccy];
  if (flat(d)) return s ? `${s}0` : `${ccy} 0`;
  const sign = d.isNegative() ? "−" : signed ? "+" : "";
  const mag = group(d.abs());
  return s ? `${sign}${s}${mag}` : `${sign}${ccy} ${mag}`;
}

/** A share chip's value: "20%" or the fixed amount with its currency. */
function shareLabel(s: { pct?: string; amount?: string }, ccy: string): string {
  return s.pct !== undefined ? `${s.pct}%` : money(new Decimal(s.amount!), ccy);
}

/** Rates can be tiny fractions; significant digits, not toFixed(2). */
function rateFigure(d: Decimal, ccy: string): string {
  const s = SYMBOLS[ccy];
  const mag = d.toSignificantDigits(6).toString();
  const grouped = mag.includes(".")
    ? mag.replace(/^(\d+)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ","))
    : mag.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return s ? `${s}${grouped}` : `${ccy} ${grouped}`;
}

/**
 * A human-readable quote between the base and a foreign currency. Quoted in whichever
 * direction reads ≥ 1, so an NGN-based tab shows "£1 = ₦1,862.9", never "₦1 = £0.000537".
 * `foreignPerBase` is units of foreign per 1 base.
 */
function rateQuote(base: string, ccy: string, foreignPerBase: Decimal): string {
  if (foreignPerBase.gte(1)) {
    return `${rateFigure(new Decimal(1), base)} = ${rateFigure(foreignPerBase, ccy)}`;
  }
  return `${rateFigure(new Decimal(1), ccy)} = ${rateFigure(new Decimal(1).div(foreignPerBase), base)}`;
}

/** Rounds a magnitude up to a readable axis bound (2.9M -> 3M, 292 -> 300). */
function niceBound(v: Decimal): Decimal {
  if (v.isZero()) return new Decimal(0);
  const abs = v.abs();
  const mag = new Decimal(10).pow(Decimal.floor(Decimal.log10(abs)));
  const scaled = abs.div(mag);
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (scaled.lte(step)) return mag.times(step).times(v.isNegative() ? -1 : 1);
  }
  return mag.times(10).times(v.isNegative() ? -1 : 1);
}

const href = (tab: Tab, extra = "") => `?tab=${encodeURIComponent(tab.name)}${extra}`;

// ── Rates in force ─────────────────────────────────────────────────────────────

/** Every non-base currency any event touches, whether or not it can be valued yet. */
function foreignCurrencies(tab: Tab): string[] {
  const all = new Set<string>();
  for (const ev of tab.events) {
    if (ev.kind === "expense" || ev.kind === "settlement") all.add(ev.currency);
    else if (ev.kind === "conversion") { all.add(ev.from_currency); all.add(ev.to_currency); }
    else all.add(ev.currency);
  }
  all.delete(tab.base_currency);
  return [...all].sort();
}

function renderRates(tab: Tab, fold: FoldResult): string {
  const ccys = foreignCurrencies(tab);
  if (ccys.length === 0) return "";
  const cards = ccys
    .map((ccy) => {
      const eff = effectiveRate(fold.rates, ccy);
      if (eff === undefined) {
        return `
        <article class="rate is-missing">
          <div class="rate-ccy">${esc(ccy)}</div>
          <div class="rate-fig">no rate yet</div>
          <div class="rate-src">${esc(ccy)} amounts sit unvalued until a conversion is logged or a rate declared</div>
        </article>`;
      }
      const nConv = tab.events.filter(
        (e) => e.kind === "conversion" && (e.from_currency === ccy || e.to_currency === ccy)
      ).length;
      const src =
        eff.source === "declared"
          ? "declared rate — overrides the conversions average"
          : `average of ${nConv} real conversion${nConv === 1 ? "" : "s"}`;
      return `
        <article class="rate">
          <div class="rate-ccy">${esc(ccy)}</div>
          <div class="rate-fig">${rateQuote(tab.base_currency, ccy, new Decimal(1).div(eff.rate))}</div>
          <div class="rate-src">${esc(src)}</div>
        </article>`;
    })
    .join("");
  return `
  <section class="sec">
    <div class="sec-head"><h2>Rates in force</h2><div class="sec-note">How foreign amounts are valued in ${esc(tab.base_currency)} right now</div></div>
    <div class="rates">${cards}</div>
  </section>`;
}

// ── Who owes what ──────────────────────────────────────────────────────────────

function renderWhoOwesWhat(tab: Tab, who: string | undefined): string {
  const report = balancesReport(tab);
  if (report.balances.length === 0) {
    return `<div class="empty"><div class="empty-fig">0</div><div class="empty-t">Nobody has a position yet</div>
      <p class="empty-p">No entries, so no one owes anyone anything.</p></div>`;
  }
  // Currencies that genuinely cannot be valued keep their own column; everything else is
  // already folded into the base figure.
  const unpriced = [...new Set(report.balances.flatMap((b) => Object.keys(b.unvalued)))].sort();
  const sorted = [...report.balances].sort((a, b) =>
    new Decimal(b.net).abs().comparedTo(new Decimal(a.net).abs())
  );

  const rows = sorted
    .map((b) => {
      const net = new Decimal(b.net);
      const cls = flat(net) ? "flat" : net.isPositive() ? "owed" : "owes";
      const cols = unpriced
        .map((c) => {
          const raw = b.unvalued[c];
          if (raw === undefined) return `<td class="r net flat">—</td>`;
          const d = new Decimal(raw);
          return `<td class="r net ${flat(d) ? "flat" : d.isPositive() ? "owed" : "owes"}">${money(d, c, true)}</td>`;
        })
        .join("");
      const standing = flat(net) && Object.keys(b.unvalued).length === 0
        ? "Settled"
        : flat(net)
          ? `Settled in ${esc(tab.base_currency)}`
          : net.isPositive()
            ? "Is owed"
            : "Owes";
      return `<tr${b.participant === who ? ' class="is-focus"' : ""}>
        <td><a class="plink" href="${href(tab, `&who=${encodeURIComponent(b.participant)}`)}#breakdown"><strong>${esc(b.participant)}</strong></a></td>
        <td class="r net ${cls}">${money(net, tab.base_currency, true)}</td>
        ${cols}
        <td class="standing">${standing}</td>
        <td class="r"><a class="lnk" href="${href(tab, `&who=${encodeURIComponent(b.participant)}`)}#breakdown">breakdown →</a></td>
      </tr>`;
    })
    .join("");

  return `<div class="scroll"><table>
    <thead><tr>
      <th>Person</th>
      <th class="r">Net (${esc(tab.base_currency)})</th>
      ${unpriced.map((c) => `<th class="r">Unvalued ${esc(c)}</th>`).join("")}
      <th>Standing</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ── Entries ────────────────────────────────────────────────────────────────────

function renderEntries(tab: Tab): string {
  if (tab.events.length === 0) {
    return `<div class="empty"><div class="empty-fig">0</div><div class="empty-t">No entries yet</div>
      <p class="empty-p">Nothing has been recorded on this tab.</p></div>`;
  }
  const note = (n?: string) => (n ? `<small>${esc(n)}</small>` : "");
  const rows = tab.events
    .map((ev, i) => {
      const lead = `<td class="idx">${i + 1}</td><td class="date">${esc(ev.date)}</td>`;
      // People chips are real links to that person's breakdown — a chip that looks
      // tappable and isn't is an affordance lie.
      const person = (name: string, cls: string, extra = "") =>
        `<a class="${cls}" href="${href(tab, `&who=${encodeURIComponent(name)}`)}#breakdown">${esc(name)}${extra}</a>`;
      if (ev.kind === "expense") {
        const chips = ev.shares
          .map((s) => person(s.participant, "who", ` <span class="chip-val">${esc(shareLabel(s, ev.currency))}</span>`))
          .join("");
        return `<tr>${lead}
          <td class="desc">${esc(ev.description)}${note(ev.note)}</td>
          <td>${person(ev.paid_by, "who is-payer")}</td>
          <td class="r amt">${money(new Decimal(ev.amount), ev.currency)}</td>
          <td><div class="chips">${chips}</div></td></tr>`;
      }
      if (ev.kind === "settlement") {
        return `<tr>${lead}
          <td class="desc">Settlement — ${esc(ev.from)} paid ${esc(ev.to)}${note(ev.note)}</td>
          <td>${person(ev.from, "who is-payer")}</td>
          <td class="r amt">${money(new Decimal(ev.amount), ev.currency)}</td>
          <td><div class="chips">${person(ev.to, "who", ' <span class="chip-val">received</span>')}</div></td></tr>`;
      }
      if (ev.kind === "conversion") {
        return `<tr>${lead}
          <td class="desc">Conversion${note(ev.note)}</td>
          <td><span class="tag">fx</span></td>
          <td class="r amt">${money(new Decimal(ev.from_amount), ev.from_currency)}</td>
          <td><div class="chips"><span class="who">became <span class="chip-val">${money(new Decimal(ev.to_amount), ev.to_currency)}</span></span></div></td></tr>`;
      }
      return `<tr>${lead}
        <td class="desc">${ev.foreign_per_base !== undefined ? `Declared rate for ${esc(ev.currency)}` : `Cleared the declared ${esc(ev.currency)} rate`}${note(ev.note)}</td>
        <td><span class="tag">fx</span></td>
        <td class="r amt">${ev.foreign_per_base !== undefined
          ? rateQuote(tab.base_currency, ev.currency, new Decimal(ev.foreign_per_base))
          : "—"}</td>
        <td><div class="chips"><span class="who">${ev.foreign_per_base !== undefined ? "overrides the average" : "back to the conversions average"}</span></div></td></tr>`;
    })
    .join("");

  return `<div class="scroll"><table>
    <thead><tr><th style="width:26px"></th><th>Date</th><th>Entry</th><th>Paid by</th><th class="r">Amount</th><th>Split between</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ── Settlements ────────────────────────────────────────────────────────────────

function renderSettlements(tab: Tab, fold: FoldResult): string {
  const settlements = tab.events.filter(
    (e): e is Extract<TabEvent, { kind: "settlement" }> => e.kind === "settlement"
  );
  if (settlements.length === 0) {
    return `<div class="empty">
      <div class="empty-fig">0</div>
      <div class="empty-t">No money has actually moved yet</div>
      <p class="empty-p">Every figure above is an obligation, not a receipt — nothing has been settled between anyone on this tab.</p>
    </div>`;
  }
  const person = (name: string, cls: string) =>
    `<a class="${cls}" href="${href(tab, `&who=${encodeURIComponent(name)}`)}#breakdown">${esc(name)}</a>`;
  const rows = settlements
    .map((ev) => {
      const locked = fold.settlementValues.get(ev.id);
      return `<tr>
        <td class="date">${esc(ev.date)}</td>
        <td>${person(ev.from, "who is-payer")}</td>
        <td>${person(ev.to, "who")}</td>
        <td class="r amt">${money(new Decimal(ev.amount), ev.currency)}</td>
        <td class="r amt">${locked ? money(locked, tab.base_currency) : "—"}</td>
        <td class="desc">${ev.note ? esc(ev.note) : '<span class="dim">—</span>'}</td>
      </tr>`;
    })
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th>Date</th><th>From</th><th>To</th><th class="r">Amount</th><th class="r">Value in ${esc(tab.base_currency)}</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ── Per-person breakdown (opt-in) ──────────────────────────────────────────────

interface Step {
  name: string;
  note?: string;
  delta: Decimal;
}

/**
 * The signed steps that build one participant's position in one currency, in log order.
 * Mirrors foldTab's own decomposition: expenses float in their own currency, settlements
 * lock into the base at the rate in force when they happened — so settlements only ever
 * appear on the base-currency track.
 */
function stepsFor(tab: Tab, fold: FoldResult, who: string, ccy: string): Step[] {
  const isBase = ccy === tab.base_currency;
  const steps: Step[] = [];
  for (const ev of tab.events) {
    if (ev.kind === "expense" && ev.currency === ccy) {
      if (ev.paid_by === who) {
        steps.push({ name: `${ev.description} — paid in full`, note: ev.note, delta: new Decimal(ev.amount) });
      }
      const share = ev.shares.find((s) => s.participant === who);
      if (share) {
        steps.push({
          name: `${ev.description} — their ${shareLabel(share, ccy)} share`,
          note: ev.note,
          delta: shareAmount(new Decimal(ev.amount), share).neg(),
        });
      }
    } else if (ev.kind === "settlement" && isBase && (ev.from === who || ev.to === who)) {
      const value = fold.settlementValues.get(ev.id);
      if (value === undefined) continue;
      const foreign = ev.currency !== ccy ? ` (${money(new Decimal(ev.amount), ev.currency)} locked)` : "";
      steps.push({
        name: ev.from === who ? `paid ${ev.to}${foreign}` : `received from ${ev.from}${foreign}`,
        note: ev.note,
        delta: ev.from === who ? value : value.neg(),
      });
    }
  }
  return steps;
}

function track(steps: Step[]) {
  let running = new Decimal(0);
  const spans = steps.map((s) => {
    const from = running;
    running = running.plus(s.delta);
    return { step: s, from, to: running };
  });
  const closing = running;
  const values = [new Decimal(0), closing, ...spans.map((s) => s.to)];
  const lo = niceBound(Decimal.min(...values));
  const hi = niceBound(Decimal.max(...values));
  const span = hi.minus(lo);
  const pct = (d: Decimal) => (span.isZero() ? 0 : d.minus(lo).div(span).times(100).toNumber());
  return { spans, closing, lo, hi, pct };
}

function renderTrack(tab: Tab, fold: FoldResult, who: string, ccy: string): string {
  const steps = stepsFor(tab, fold, who, ccy);
  if (steps.length === 0) return "";
  const { spans, closing, lo, hi, pct } = track(steps);
  const zeroAt = pct(new Decimal(0));
  const zeroRule = lo.isNegative() ? `<div class="zero" style="left:${zeroAt.toFixed(2)}%"></div>` : "";

  const bars = spans
    .map(({ step, from, to }) => {
      const up = step.delta.isPositive();
      const left = Math.min(pct(from), pct(to));
      const width = Math.abs(pct(to) - pct(from));
      const tip = `${step.name}: ${money(step.delta, ccy, true)}`;
      return `
        <div class="step">
          <div class="step-top">
            <span class="step-name">${esc(step.name)}</span>
            <span class="step-val num">${money(step.delta, ccy, true)}</span>
          </div>
          <div class="track" title="${esc(tip)}">${zeroRule}<div class="bar ${up ? "up" : "down"}" style="left:${left.toFixed(2)}%; width:${width.toFixed(2)}%"></div></div>
        </div>`;
    })
    .join("");

  const good = flat(closing) || !closing.isNegative();
  const closeLeft = Math.min(pct(new Decimal(0)), pct(closing));
  const closeWidth = Math.abs(pct(closing) - pct(new Decimal(0)));
  return `
    <article class="fall">
      <div class="fall-h">${esc(ccy)} position</div>
      <div class="fall-sub">Scale ${money(lo, ccy)} → ${money(hi, ccy)}${lo.isNegative() ? " · the vertical rule marks zero" : ""}</div>
      ${bars}
      <div class="step is-net">
        <div class="step-top">
          <span class="step-name">Closing</span>
          <span class="step-val num ${good ? "good" : "bad"}">${money(closing, ccy, true)}</span>
        </div>
        <div class="track" title="${esc(`Closing: ${money(closing, ccy, true)}`)}">${zeroRule}<div class="bar ${good ? "net-good" : "net-bad"}" style="left:${closeLeft.toFixed(2)}%; width:${closeWidth.toFixed(2)}%"></div></div>
      </div>
    </article>`;
}

/** Currencies this participant actually has a position in, base first. */
function currenciesFor(tab: Tab, who: string): string[] {
  const all = new Set<string>();
  for (const ev of tab.events) {
    if (ev.kind === "expense" && (ev.paid_by === who || ev.shares.some((s) => s.participant === who))) {
      all.add(ev.currency);
    } else if (ev.kind === "settlement" && (ev.from === who || ev.to === who)) {
      all.add(tab.base_currency);
    }
  }
  return [...all].sort((a, b) =>
    a === tab.base_currency ? -1 : b === tab.base_currency ? 1 : a.localeCompare(b)
  );
}

function renderPositionCards(tab: Tab, fold: FoldResult, who: string): string {
  const ccys = currenciesFor(tab, who);
  if (ccys.length === 0) {
    return `<div class="empty"><div class="empty-fig">0</div><div class="empty-t">${esc(who)} has no entries on this tab</div>
      <p class="empty-p">Nothing here touches them — they owe nothing and are owed nothing.</p></div>`;
  }
  const cards = ccys
    .map((ccy) => {
      const steps = stepsFor(tab, fold, who, ccy);
      const closing = steps.reduce((a, s) => a.plus(s.delta), new Decimal(0));
      const inflow = steps.filter((s) => s.delta.isPositive()).reduce((a, s) => a.plus(s.delta), new Decimal(0));
      const outflow = steps.filter((s) => s.delta.isNegative()).reduce((a, s) => a.plus(s.delta.abs()), new Decimal(0));
      const good = flat(closing) || !closing.isNegative();
      const state = flat(closing) ? "● Settled — nothing owed either way" : good ? "● Is owed this" : "● Owes this";
      return `
        <article class="pos ${good ? "is-good" : "is-critical"}">
          <div class="pos-label">${esc(ccy)} position</div>
          <div class="pos-fig">${money(closing, ccy, true)}</div>
          <div class="pos-sub">${money(inflow, ccy)} in · ${money(outflow, ccy)} out · ${steps.length} step${steps.length === 1 ? "" : "s"}</div>
          <div class="pill ${good ? "is-good" : "is-critical"}">${state}</div>
        </article>`;
    })
    .join("");
  return `<div class="positions"${ccys.length === 1 ? ' style="grid-template-columns:1fr"' : ""}>${cards}</div>`;
}

/**
 * A combined cross-currency figure is only stated when every currency involved has a real
 * rate behind it; otherwise the missing rate is named instead of assumed.
 */
function renderCombined(tab: Tab, fold: FoldResult, who: string): string {
  const ccys = currenciesFor(tab, who);
  if (ccys.length < 2) return "";
  const unpriced = ccys.filter((c) => c !== tab.base_currency && effectiveRate(fold.rates, c) === undefined);
  if (unpriced.length > 0) {
    return `
      <div class="combined is-open">
        <div class="combined-t">
          <strong>These positions can't be added up yet.</strong> There is no rate for
          ${unpriced.map((c) => `<code>${esc(c)}</code>`).join(", ")} on this tab, so
          ${esc(who)}'s ${esc(unpriced.join("/"))} position can't be expressed in ${esc(tab.base_currency)}.
          Log a real conversion, or declare a rate, and this becomes a single number.
        </div>
        <div class="combined-fig dim">—</div>
      </div>`;
  }
  const net = fold.balances.get(who) ?? new Decimal(0);
  const good = flat(net) || !net.isNegative();
  // The figure reports in the tab's base like every other net on the page — but when a
  // STRONGER currency is in play (1 unit worth more than 1 base), gauge it there too.
  const strongest = ccys
    .filter((c) => c !== tab.base_currency)
    .map((c) => ({ ccy: c, eff: effectiveRate(fold.rates, c)! }))
    .filter((r) => r.eff.rate.gt(1))
    .sort((a, b) => b.eff.rate.comparedTo(a.eff.rate))[0];
  const gloss =
    strongest && !flat(net)
      ? `<div class="combined-gloss">≈ ${money(net.div(strongest.eff.rate), strongest.ccy, true)} at the ${esc(strongest.ccy)} rate in force</div>`
      : "";
  return `
    <div class="combined ${good ? "is-good" : "is-critical"}">
      <div class="combined-t">
        <strong>All currencies together.</strong> Every currency here has a rate behind it,
        so ${esc(who)}'s whole position folds into one ${esc(tab.base_currency)} figure.
      </div>
      <div class="combined-r"><div class="combined-fig ${good ? "good" : "bad"}">${money(net, tab.base_currency, true)}</div>${gloss}</div>
    </div>`;
}

function renderBreakdown(tab: Tab, fold: FoldResult, who: string | undefined): string {
  const people = [...fold.balances.keys()].sort((a, b) => a.localeCompare(b));
  if (people.length === 0) return "";

  const selector = people
    .map((p) => `<a class="chip ${p === who ? "is-on" : ""}" href="${href(tab, `&who=${encodeURIComponent(p)}`)}#breakdown">${esc(p)}</a>`)
    .join("");

  const detail = who
    ? `
    ${renderPositionCards(tab, fold, who)}
    ${renderCombined(tab, fold, who)}
    ${currenciesFor(tab, who).length > 0 ? `
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--in)"></span> Toward being owed</span>
      <span class="key"><span class="swatch" style="background:var(--out)"></span> Toward owing</span>
      <span class="key"><span class="swatch" style="background:var(--good)"></span> Closing — is owed</span>
      <span class="key"><span class="swatch" style="background:var(--critical)"></span> Closing — owes</span>
    </div>
    <div class="falls">${currenciesFor(tab, who).map((c) => renderTrack(tab, fold, who, c)).join("")}</div>` : ""}`
    : `<p class="hint">Pick a person to see their position built step by step from the entries.</p>`;

  return `
  <section class="sec" id="breakdown">
    <div class="sec-head"><h2>${who ? `${esc(who)}'s breakdown` : "Breakdown by person"}</h2>
      <div class="sec-note">Every step is an entry above — nothing is typed in by hand</div></div>
    <div class="chips selector">${selector}</div>
    ${detail}
  </section>`;
}

// ── Pages ──────────────────────────────────────────────────────────────────────

export function renderTabPage(tab: Tab, requested: string | undefined, generatedAt: string): string {
  const fold = foldTab(tab);
  const people = [...fold.balances.keys()];
  const who = requested && people.includes(requested) ? requested : undefined;
  // Tolerance, not exact: pct shares divide into non-terminating decimals, so a healthy
  // ledger can carry ~1e-14 of precision residue. Only a real imbalance should warn.
  const zeroSum = flat([...fold.balances.values()].reduce((a, b) => a.plus(b), new Decimal(0)));
  const nSettle = tab.events.filter((e) => e.kind === "settlement").length;

  const body = `
  <header class="masthead">
    <div class="eyebrow"><a class="lnk" href="/view">whoowes</a> · live ledger · base ${esc(tab.base_currency)}</div>
    <h1>${esc(tab.name)}</h1>
    <p class="dek">Folded from the event log on every request — there is no snapshot to go stale. Every figure is derived; nothing is typed in.</p>
    <div class="asof">
      <span class="num">${tab.events.length}</span> ${tab.events.length === 1 ? "entry" : "entries"} ·
      <span class="num">${people.length}</span> ${people.length === 1 ? "participant" : "participants"} ·
      <span class="num">${nSettle}</span> ${nSettle === 1 ? "settlement" : "settlements"} ·
      tab is <strong>${esc(tab.status)}</strong> · as of <span class="num">${esc(generatedAt)}</span>
    </div>
  </header>

  ${renderRates(tab, fold)}

  <section class="sec">
    <div class="sec-head"><h2>Who owes what</h2>
      <div class="sec-note">Net per person in ${esc(tab.base_currency)} · a currency with no rate keeps its own column</div></div>
    ${renderWhoOwesWhat(tab, who)}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>Entries</h2>
      <div class="sec-note"><span class="num">${tab.events.length}</span> · balances refold on every read</div></div>
    ${renderEntries(tab)}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>Settlements</h2>
      <div class="sec-note">Money that has actually moved between people</div></div>
    ${renderSettlements(tab, fold)}
  </section>

  ${renderBreakdown(tab, fold, who)}

  <footer>
    <span>Folded live from <code>whoowes</code> · tab <code>${esc(tab.name)}</code></span>
    <span>${zeroSum ? "Balances sum to zero ✓" : "⚠ Balances do not sum to zero"}</span>
  </footer>`;

  return page(`${tab.name} — whoowes`, body);
}

export function renderTabList(ledger: Ledger, generatedAt: string): string {
  const rows = ledger.tabs
    .map(
      (t) => `<tr>
        <td><a class="plink" href="?tab=${encodeURIComponent(t.name)}"><strong>${esc(t.name)}</strong></a></td>
        <td>${esc(t.status)}</td>
        <td>${esc(t.base_currency)}</td>
        <td class="r num">${t.events.length}</td>
        <td class="r"><a class="lnk" href="?tab=${encodeURIComponent(t.name)}">open →</a></td>
      </tr>`
    )
    .join("");
  const body = `
  <header class="masthead">
    <div class="eyebrow">whoowes · live ledger</div>
    <h1>Tabs</h1>
    <p class="dek">Pick a tab to see who owes what, every entry with its split, and what has actually been settled.</p>
    <div class="asof">as of <span class="num">${esc(generatedAt)}</span></div>
  </header>
  <section class="sec">
    ${
      ledger.tabs.length === 0
        ? `<div class="empty"><div class="empty-fig">0</div><div class="empty-t">No tabs yet</div>
           <p class="empty-p">Create one with the <code>create_tab</code> tool.</p></div>`
        : `<div class="scroll"><table><thead><tr><th>Tab</th><th>Status</th><th>Base currency</th><th class="r">Entries</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    }
  </section>`;
  return page("whoowes — tabs", body);
}

export function renderError(message: string): string {
  return page(
    "whoowes",
    `<header class="masthead"><div class="eyebrow">whoowes</div><h1>Nothing to show</h1></header>
     <section class="sec"><div class="empty"><div class="empty-fig">—</div>
     <div class="empty-t">${esc(message)}</div>
     <p class="empty-p"><a class="lnk" href="/view">Back to all tabs</a></p></div></section>`
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────────

/**
 * Design system: editorial serif for page headings only; every DATA figure is sans
 * (a serif hero figure is a dataviz anti-pattern) with proportional digits, tabular
 * only inside tables where columns align. Series pair (--in/--out) and status inks are
 * validator-passed in both modes (CVD ΔE 96.7 light / 97.3 dark; text ≥ 4.5:1).
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<style>
  :root {
    --surface:#F5F6FA; --card:#FFFFFF; --card-sunk:#EEF0F6;
    --rule:#DCDFEA; --rule-strong:#B9BFD2;
    --ink:#171B26; --ink-2:#4A5165; --ink-3:#687085;
    --in:#2a78d6; --out:#eb6834; --good:#0ca30c; --critical:#d03b3b;
    --good-bg:#E7F6E7; --critical-bg:#FBE9E9; --good-ink:#067006; --critical-ink:#A62A2A;
    --shadow:0 1px 2px rgba(23,27,38,.06),0 4px 14px rgba(23,27,38,.05);
    --display:Georgia,"Iowan Old Style","Times New Roman",serif;
    --body:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --data:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;
    color-scheme:light dark;
  }
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
    --surface:#101319; --card:#171B24; --card-sunk:#1E232E;
    --rule:#2B313F; --rule-strong:#414960;
    --ink:#E9EBF1; --ink-2:#A7AEC1; --ink-3:#8890A6;
    --in:#3987e5; --out:#d95926;
    --good-bg:#102A12; --critical-bg:#2E1414; --good-ink:#4FC24F; --critical-ink:#E97878;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3);
  }}
  :root[data-theme="dark"]{
    --surface:#101319; --card:#171B24; --card-sunk:#1E232E;
    --rule:#2B313F; --rule-strong:#414960;
    --ink:#E9EBF1; --ink-2:#A7AEC1; --ink-3:#8890A6;
    --in:#3987e5; --out:#d95926;
    --good-bg:#102A12; --critical-bg:#2E1414; --good-ink:#4FC24F; --critical-ink:#E97878;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--surface);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1060px;margin:0 auto;padding:40px 24px 96px}
  @media (max-width:600px){.wrap{padding:28px 16px 64px}}
  .num{font-variant-numeric:tabular-nums}
  .dim{color:var(--ink-3)}
  a.lnk{color:var(--in);text-decoration:none}
  a.lnk:hover{text-decoration:underline}
  a.plink{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--rule-strong)}
  a.plink:hover{border-bottom-color:var(--in);color:var(--in)}

  .masthead{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:8px}
  .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
  h1{font-family:var(--display);font-weight:400;font-size:clamp(30px,5vw,44px);margin:6px 0 4px;letter-spacing:-.01em;text-wrap:balance}
  .dek{color:var(--ink-2);max-width:62ch;margin:0}
  .asof{margin-top:12px;font-size:13px;color:var(--ink-3)}
  .asof .num,.asof strong{color:var(--ink-2)}
  h2{font-family:var(--display);font-weight:400;font-size:22px;margin:0;letter-spacing:-.01em}
  .sec{margin-top:44px}
  .sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--rule);padding-bottom:8px}
  .sec-note{font-size:13px;color:var(--ink-3)}
  .hint{font-size:13px;color:var(--ink-2);margin:14px 0 0}

  /* Rates strip */
  .rates{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  .rate{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:14px 16px;box-shadow:var(--shadow)}
  .rate.is-missing{border-style:dashed;box-shadow:none}
  .rate-ccy{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
  .rate-fig{font-weight:650;font-size:19px;margin:4px 0 2px}
  .rate.is-missing .rate-fig{color:var(--ink-3);font-weight:600}
  .rate-src{font-size:12px;color:var(--ink-3)}

  /* Selector chips */
  .selector{margin-bottom:6px}
  .chip{display:inline-flex;align-items:center;font-size:13px;padding:4px 11px;border-radius:999px;
    background:var(--card);border:1px solid var(--rule);color:var(--ink-2);text-decoration:none;line-height:1.4}
  .chip:hover{border-color:var(--in);color:var(--in)}
  .chip.is-on{background:var(--in);border-color:var(--in);color:#fff;font-weight:600}

  /* Position cards — sans, proportional figures (never serif, never tabular at display size).
     auto-fit so 3 currencies make 3 columns instead of stranding an orphan card. */
  .positions{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:18px}
  @media (max-width:720px){.positions{grid-template-columns:1fr !important}}
  .pos{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:20px;box-shadow:var(--shadow);position:relative;overflow:hidden}
  .pos::before{content:"";position:absolute;inset:0 auto 0 0;width:3px}
  .pos.is-good::before{background:var(--good)}
  .pos.is-critical::before{background:var(--critical)}
  .pos-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
  .pos-fig{font-weight:650;font-size:clamp(26px,4.5vw,34px);letter-spacing:-.01em;margin:6px 0 2px;line-height:1.15}
  .pos.is-good .pos-fig{color:var(--good-ink)}
  .pos.is-critical .pos-fig{color:var(--critical-ink)}
  .pos-sub{font-size:13px;color:var(--ink-2)}
  .pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:999px;margin-top:10px}
  .pill.is-good{background:var(--good-bg);color:var(--good-ink)}
  .pill.is-critical{background:var(--critical-bg);color:var(--critical-ink)}

  .combined{margin-top:16px;background:var(--card);border:1px solid var(--rule);border-left-width:3px;
    border-radius:10px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;box-shadow:var(--shadow)}
  .combined.is-good{border-left-color:var(--good)}
  .combined.is-critical{border-left-color:var(--critical)}
  .combined.is-open{border-left-color:var(--rule-strong)}
  .combined-t{font-size:13px;color:var(--ink-2);max-width:66ch}
  .combined-r{text-align:right}
  .combined-fig{font-weight:650;font-size:26px;white-space:nowrap}
  .combined-fig.good{color:var(--good-ink)}
  .combined-fig.bad{color:var(--critical-ink)}
  .combined-gloss{font-size:12px;color:var(--ink-3);margin-top:2px}

  /* Waterfall */
  .falls{display:grid;grid-template-columns:1fr 1fr;gap:28px}
  @media (max-width:860px){.falls{grid-template-columns:1fr}}
  .fall{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:18px 20px 14px;box-shadow:var(--shadow)}
  .fall-h{font-weight:700;font-size:13px;letter-spacing:.02em}
  .fall-sub{font-size:12px;color:var(--ink-3);margin-bottom:14px}
  .step{display:grid;grid-template-columns:1fr;gap:3px;margin-bottom:11px}
  .step-top{display:flex;justify-content:space-between;gap:12px;font-size:13px;align-items:baseline}
  .step-name{color:var(--ink-2)}
  /* Values wear ink, not the series color — the bar carries direction, the sign carries it in text. */
  .step-val{font-variant-numeric:tabular-nums;font-size:12px;color:var(--ink);white-space:nowrap}
  .track{position:relative;height:13px;background:var(--card-sunk);border-radius:4px}
  .bar{position:absolute;top:0;bottom:0;border-radius:4px;min-width:3px}
  .bar.up{background:var(--in)}
  .bar.down{background:var(--out)}
  .bar.net-good{background:var(--good)}
  .bar.net-bad{background:var(--critical)}
  .zero{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--rule-strong)}
  .step.is-net{margin-top:14px;padding-top:13px;border-top:2px double var(--rule-strong)}
  .step.is-net .step-name{font-weight:700;color:var(--ink)}
  .step.is-net .step-val{font-weight:700;font-size:13px}
  .step.is-net .step-val.good{color:var(--good-ink)}
  .step.is-net .step-val.bad{color:var(--critical-ink)}
  .legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--ink-2);margin:16px 0 18px}
  .key{display:inline-flex;align-items:center;gap:6px}
  .swatch{width:11px;height:11px;border-radius:3px}

  /* Tables */
  .scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:10px;background:var(--card);box-shadow:var(--shadow)}
  table{border-collapse:collapse;width:100%;font-size:13px;min-width:720px}
  thead th{text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:700;
    padding:11px 14px;border-bottom:1px solid var(--rule-strong);white-space:nowrap;background:var(--card)}
  td{padding:11px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:var(--card-sunk)}
  tbody tr.is-focus td{background:var(--card-sunk)}
  td.r,th.r{text-align:right}
  .idx{color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:12px}
  .date{color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap}
  .desc{color:var(--ink)}
  .desc small{display:block;color:var(--ink-3);font-size:12px;margin-top:2px;max-width:44ch}
  .amt{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
  .standing{white-space:nowrap;color:var(--ink-2)}
  .who{display:inline-flex;align-items:center;gap:5px;font-size:12px;background:var(--card-sunk);border:1px solid var(--rule);color:var(--ink);text-decoration:none;
    padding:2px 7px;border-radius:4px;white-space:nowrap}
  .who .chip-val{font-size:11px;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .who.is-payer{background:transparent;border-color:var(--in);color:var(--in);font-weight:600}
  a.who:hover{border-color:var(--in)}
  .chips{display:flex;flex-wrap:wrap;gap:5px}
  a.lnk:focus-visible,a.plink:focus-visible,a.who:focus-visible,.chip:focus-visible{
    outline:2px solid var(--in);outline-offset:2px;border-radius:4px}
  @media (max-width:600px){.chip{padding:8px 14px}.selector{gap:7px}}
  .net{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
  .net.owes{color:var(--critical-ink)}
  .net.owed{color:var(--good-ink)}
  .net.flat{color:var(--ink-3)}
  .tag{font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--card-sunk);color:var(--ink-3)}

  .empty{background:var(--card);border:1px dashed var(--rule-strong);border-radius:10px;padding:32px 24px;text-align:center}
  .empty-fig{font-weight:650;font-size:32px;color:var(--ink-3)}
  .empty-t{font-weight:600;margin:4px 0 4px}
  .empty-p{font-size:13px;color:var(--ink-2);max-width:60ch;margin:0 auto}

  footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);font-size:12px;color:var(--ink-3);
    display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  code{font-family:var(--data);font-size:12px;background:var(--card-sunk);padding:1px 5px;border-radius:4px;color:var(--ink-2)}
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}
