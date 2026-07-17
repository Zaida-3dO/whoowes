import { Decimal } from "decimal.js";
import { balancesReport, effectiveRate, foldTab, shareAmount, type FoldResult } from "./fold.js";
import { Ledger, Tab, TabEvent } from "./types.js";

/**
 * Server-rendered HTML for a tab, ported from the hand-built "The Pool" artifact.
 *
 * The difference that matters: the artifact was typed out from a snapshot and went stale the
 * moment anything changed. Everything here is folded from the event log on each request, so
 * there is exactly one source of truth. Nothing is hardcoded — no participant, no currency,
 * no narrative. Where the artifact hand-waved (it combined naira and pounds at an assumed
 * ~1,850/GBP that exists nowhere in the ledger), this refuses and says why instead.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const SYMBOLS: Record<string, string> = {
  NGN: "₦", GBP: "£", USD: "$", EUR: "€", JPY: "¥", INR: "₹",
};
const sym = (ccy: string) => SYMBOLS[ccy] ?? "";

/** Thousands-grouped, trailing .00 dropped — these are ledger figures, not accounting output. */
function group(d: Decimal): string {
  const neg = d.isNegative();
  const [int, frac] = d.abs().toFixed(2).split(".");
  const withSep = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = frac === "00" ? withSep : `${withSep}.${frac}`;
  return (neg ? "−" : "") + body;
}

/** With the currency symbol where there is one, else a trailing code. */
function money(d: Decimal, ccy: string, signed = false): string {
  const s = sym(ccy);
  const sign = signed && d.isPositive() && !d.isZero() ? "+" : "";
  const body = group(d);
  // The minus has to lead the symbol, not the digits: −₦292, not ₦−292.
  if (s) return body.startsWith("−") ? `−${sign}${s}${body.slice(1)}` : `${sign}${s}${body}`;
  return `${sign}${body} ${ccy}`;
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

interface Step {
  name: string;
  note?: string;
  delta: Decimal;
}

/**
 * The signed steps that build one participant's position in one currency, in log order.
 *
 * This mirrors foldTab's own decomposition rather than inventing one: expenses float in the
 * currency they were incurred in, while settlements lock into the base currency at the rate in
 * force when they happened. So settlements only ever appear on the base-currency track.
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
        const label = share.pct !== undefined ? `${ev.description} — ${share.pct}% share` : `${ev.description} — share`;
        steps.push({ name: label, note: ev.note, delta: shareAmount(new Decimal(ev.amount), share).neg() });
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

/** A waterfall track: the steps, their running totals, and the axis they're drawn against. */
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
      return `
        <div class="step">
          <div class="step-top">
            <span class="step-name">${esc(step.name)}</span>
            <span class="step-val ${up ? "up" : "down"} num">${up ? "+" : "−"}${group(step.delta.abs())}</span>
          </div>
          <div class="track">${zeroRule}<div class="bar ${up ? "up" : "down"}" style="left:${left.toFixed(2)}%; width:${Math.max(width, 0.4).toFixed(2)}%"></div></div>
        </div>`;
    })
    .join("");

  const good = !closing.isNegative();
  const closeLeft = Math.min(pct(new Decimal(0)), pct(closing));
  const closeWidth = Math.abs(pct(closing) - pct(new Decimal(0)));
  return `
    <article class="fall">
      <div class="fall-h">${esc(ccy)} side</div>
      <div class="fall-sub">Scale ${money(lo, ccy)} → ${money(hi, ccy)}${lo.isNegative() ? " · the rule marks zero" : ""}</div>
      ${bars}
      <div class="step is-net">
        <div class="step-top">
          <span class="step-name">Closing</span>
          <span class="step-val ${good ? "good" : "bad"} num">${money(closing, ccy, true)}</span>
        </div>
        <div class="track">${zeroRule}<div class="bar ${good ? "net-good" : "net-bad"}" style="left:${closeLeft.toFixed(2)}%; width:${Math.max(closeWidth, 0.4).toFixed(2)}%"></div></div>
      </div>
    </article>`;
}

/** Currencies this participant actually has a position in, base first. */
function currenciesFor(tab: Tab, fold: FoldResult, who: string): string[] {
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

function renderPositions(tab: Tab, fold: FoldResult, who: string): string {
  const ccys = currenciesFor(tab, fold, who);
  if (ccys.length === 0) {
    return `<div class="empty"><div class="empty-fig num">0</div><div class="empty-t">${esc(who)} has no entries on this tab</div>
      <p class="empty-p">Nothing here touches them — they owe nothing and are owed nothing.</p></div>`;
  }

  const cards = ccys
    .map((ccy) => {
      const steps = stepsFor(tab, fold, who, ccy);
      const closing = steps.reduce((a, s) => a.plus(s.delta), new Decimal(0));
      const inflow = steps.filter((s) => s.delta.isPositive()).reduce((a, s) => a.plus(s.delta), new Decimal(0));
      const outflow = steps.filter((s) => s.delta.isNegative()).reduce((a, s) => a.plus(s.delta.abs()), new Decimal(0));
      const good = !closing.isNegative();
      const state = closing.isZero() ? "settled" : good ? "Holding" : "Short";
      return `
        <article class="pos ${good ? "is-good" : "is-critical"}">
          <div class="pos-label">${esc(ccy)} side</div>
          <div class="pos-fig num">${money(closing, ccy, true)}</div>
          <div class="pos-sub">${money(inflow, ccy)} in · ${money(outflow, ccy)} out across ${steps.length} step${steps.length === 1 ? "" : "s"}</div>
          <div class="pill ${good ? "is-good" : "is-critical"}">● ${state}${closing.isZero() ? "" : good ? " — is owed this" : " — owes this"}</div>
        </article>`;
    })
    .join("");

  const grid = `<section class="positions"${ccys.length === 1 ? ' style="grid-template-columns:1fr"' : ""}>${cards}</section>`;
  return grid + renderCombined(tab, fold, who, ccys);
}

/**
 * The honest version of the artifact's "both sides together" card. It only states a combined
 * figure when every currency involved has a real rate behind it; otherwise it names what is
 * missing rather than assuming one.
 */
function renderCombined(tab: Tab, fold: FoldResult, who: string, ccys: string[]): string {
  if (ccys.length < 2) return "";
  const unpriced = ccys.filter((c) => c !== tab.base_currency && effectiveRate(fold.rates, c) === undefined);
  if (unpriced.length > 0) {
    return `
      <div class="combined" style="border-left-color:var(--rule-strong)">
        <div class="combined-t">
          <strong>These sides can't be added up yet.</strong> There is no rate for
          ${unpriced.map((c) => `<code>${esc(c)}</code>`).join(", ")} on this tab, so
          ${esc(who)}'s ${esc(unpriced.join("/"))} position can't be expressed in ${esc(tab.base_currency)}.
          Log a real conversion, or declare a rate, and this becomes a single number.
        </div>
        <div class="combined-fig num" style="color:var(--ink-3)">—</div>
      </div>`;
  }
  const net = fold.balances.get(who) ?? new Decimal(0);
  const good = !net.isNegative();
  return `
    <div class="combined" style="border-left-color:var(--${good ? "good" : "critical"})">
      <div class="combined-t">
        <strong>Both sides together.</strong> Every currency here has a rate behind it, so
        ${esc(who)}'s whole position folds into one figure in ${esc(tab.base_currency)}.
      </div>
      <div class="combined-fig num" style="color:var(--${good ? "good" : "critical"}-ink)">${money(net, tab.base_currency, true)}</div>
    </div>`;
}

function renderEntries(tab: Tab): string {
  if (tab.events.length === 0) {
    return `<div class="empty"><div class="empty-fig num">0</div><div class="empty-t">No entries yet</div>
      <p class="empty-p">Nothing has been recorded on this tab.</p></div>`;
  }
  const rows = tab.events
    .map((ev, i) => {
      const idx = `<td class="idx">${i + 1}</td>`;
      const note = (n?: string) => (n ? `<small>${esc(n)}</small>` : "");
      const id = `<small class="eid">${esc(ev.id)}</small>`;

      if (ev.kind === "expense") {
        const chips = ev.shares
          .map(
            (s) =>
              `<span class="who">${esc(s.participant)} <span class="num">${
                s.pct !== undefined ? `${esc(s.pct)}%` : group(new Decimal(s.amount!))
              }</span></span>`
          )
          .join("");
        return `<tr>${idx}
          <td class="desc">${esc(ev.description)}${note(ev.note)}${id}</td>
          <td><span class="who is-payer">${esc(ev.paid_by)}</span></td>
          <td class="r amt">${group(new Decimal(ev.amount))}<span class="ccy">${esc(sym(ev.currency) || ev.currency)}</span></td>
          <td><div class="chips">${chips}</div></td></tr>`;
      }
      if (ev.kind === "settlement") {
        return `<tr>${idx}
          <td class="desc">Settlement — ${esc(ev.from)} paid ${esc(ev.to)}${note(ev.note)}${id}</td>
          <td><span class="who is-payer">${esc(ev.from)}</span></td>
          <td class="r amt">${group(new Decimal(ev.amount))}<span class="ccy">${esc(sym(ev.currency) || ev.currency)}</span></td>
          <td><div class="chips"><span class="who">${esc(ev.to)} <span class="num">received</span></span></div></td></tr>`;
      }
      if (ev.kind === "conversion") {
        return `<tr>${idx}
          <td class="desc">Conversion — ${esc(ev.from_currency)} to ${esc(ev.to_currency)}${note(ev.note)}${id}</td>
          <td><span class="tag">rate</span></td>
          <td class="r amt">${group(new Decimal(ev.from_amount))}<span class="ccy">${esc(sym(ev.from_currency) || ev.from_currency)}</span></td>
          <td><div class="chips"><span class="who">got <span class="num">${group(new Decimal(ev.to_amount))} ${esc(sym(ev.to_currency) || ev.to_currency)}</span></span></div></td></tr>`;
      }
      return `<tr>${idx}
        <td class="desc">${ev.foreign_per_base !== undefined ? "Declared rate" : "Cleared declared rate"} — ${esc(ev.currency)}${note(ev.note)}${id}</td>
        <td><span class="tag">rate</span></td>
        <td class="r amt">${ev.foreign_per_base !== undefined ? group(new Decimal(ev.foreign_per_base)) : "—"}<span class="ccy">${esc(ev.currency)}/${esc(tab.base_currency)}</span></td>
        <td><div class="chips"><span class="who">${ev.foreign_per_base !== undefined ? "overrides the average" : "back to the average"}</span></div></td></tr>`;
    })
    .join("");

  return `<div class="scroll"><table>
    <thead><tr><th style="width:26px"></th><th>Entry</th><th>Paid by</th><th class="r">Amount</th><th>Assigned to</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderWhoOwesWhat(tab: Tab, fold: FoldResult, who: string): string {
  const report = balancesReport(tab);
  if (report.balances.length === 0) {
    return `<div class="empty"><div class="empty-fig num">0</div><div class="empty-t">Nobody has a position yet</div>
      <p class="empty-p">No entries, so no one owes anyone anything.</p></div>`;
  }
  // Only currencies that genuinely can't be valued get their own column; the rest are folded
  // into the base figure already.
  const unpriced = [...new Set(report.balances.flatMap((b) => Object.keys(b.unvalued)))].sort();
  const sorted = [...report.balances].sort((a, b) =>
    new Decimal(b.net).abs().comparedTo(new Decimal(a.net).abs())
  );

  const rows = sorted
    .map((b) => {
      const net = new Decimal(b.net);
      const cls = net.isZero() ? "flat" : net.isPositive() ? "owed" : "owes";
      const cols = unpriced
        .map((c) => {
          const raw = b.unvalued[c];
          if (raw === undefined) return `<td class="r net flat">—</td>`;
          const d = new Decimal(raw);
          return `<td class="r net ${d.isZero() ? "flat" : d.isPositive() ? "owed" : "owes"}">${money(d, c, true)}</td>`;
        })
        .join("");
      const standing = net.isZero()
        ? "Settled in " + esc(tab.base_currency)
        : net.isPositive()
          ? "Is owed"
          : "Owes";
      return `<tr${b.participant === who ? ' class="is-focus"' : ""}>
        <td><strong>${esc(b.participant)}</strong>${b.participant === who ? ' <span class="tag pool">shown above</span>' : ""}</td>
        <td class="r net ${cls}">${money(net, tab.base_currency, true)}</td>
        ${cols}
        <td>${standing}</td>
        <td class="desc"><a class="lnk" href="?tab=${encodeURIComponent(tab.name)}&amp;who=${encodeURIComponent(b.participant)}">See how →</a></td>
      </tr>`;
    })
    .join("");

  return `<div class="scroll"><table>
    <thead><tr>
      <th>Person</th>
      <th class="r">${esc(tab.base_currency)}</th>
      ${unpriced.map((c) => `<th class="r">${esc(c)}</th>`).join("")}
      <th>Standing</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderSettlements(tab: Tab, fold: FoldResult): string {
  const settlements = tab.events.filter((e): e is Extract<TabEvent, { kind: "settlement" }> => e.kind === "settlement");
  if (settlements.length === 0) {
    return `<div class="empty">
      <div class="empty-fig num">0</div>
      <div class="empty-t">No money has actually moved yet</div>
      <p class="empty-p">Every figure above is an obligation, not a receipt — nothing has been settled between anyone on this tab.</p>
    </div>`;
  }
  const rows = settlements
    .map((ev) => {
      const locked = fold.settlementValues.get(ev.id);
      return `<tr>
        <td class="num">${esc(ev.date)}</td>
        <td><span class="who is-payer">${esc(ev.from)}</span></td>
        <td><span class="who">${esc(ev.to)}</span></td>
        <td class="r amt">${group(new Decimal(ev.amount))}<span class="ccy">${esc(sym(ev.currency) || ev.currency)}</span></td>
        <td class="r amt">${locked ? money(locked, tab.base_currency) : "—"}</td>
        <td class="desc">${ev.note ? esc(ev.note) : "<span style='color:var(--ink-3)'>—</span>"}</td>
      </tr>`;
    })
    .join("");
  return `<div class="scroll"><table>
    <thead><tr><th>Date</th><th>From</th><th>To</th><th class="r">Amount</th><th class="r">Locked value</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export function renderTabPage(tab: Tab, requested: string | undefined, generatedAt: string): string {
  const fold = foldTab(tab);
  const people = [...fold.balances.keys()];
  // Default to the largest position — the participant the tab is really about.
  const biggest = people
    .slice()
    .sort((a, b) => (fold.balances.get(b) ?? new Decimal(0)).abs().comparedTo((fold.balances.get(a) ?? new Decimal(0)).abs()))[0];
  const who = requested && people.includes(requested) ? requested : (biggest ?? "");
  const zeroSum = [...fold.balances.values()].reduce((a, b) => a.plus(b), new Decimal(0)).isZero();

  const selector = people
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map(
      (p) =>
        `<a class="chip ${p === who ? "is-on" : ""}" href="?tab=${encodeURIComponent(tab.name)}&amp;who=${encodeURIComponent(p)}">${esc(p)}</a>`
    )
    .join("");

  const body = `
  <header class="masthead">
    <div class="eyebrow">whoowes · live · base ${esc(tab.base_currency)}</div>
    <h1>${esc(tab.name)}</h1>
    <p class="dek">Folded from the event log on every request — there is no snapshot to go stale. Every figure below is derived; nothing is typed in.</p>
    <div class="asof">
      <span class="num">${tab.events.length}</span> ${tab.events.length === 1 ? "entry" : "entries"} ·
      <span class="num">${people.length}</span> ${people.length === 1 ? "participant" : "participants"} ·
      tab is <strong>${esc(tab.status)}</strong> · as of <span class="num">${esc(generatedAt)}</span>
    </div>
  </header>

  ${who ? `<section class="sec">
    <div class="sec-head"><h2>How ${esc(who)} stands</h2><div class="sec-note">Pick anyone · every step below is an entry</div></div>
    <div class="chips" style="margin-bottom:4px">${selector}</div>
    ${renderPositions(tab, fold, who)}
  </section>

  <section class="sec">
    <div class="sec-head">
      <h2>How each side got there</h2>
      <div class="sec-note">Every step is an entry below — nothing here is typed in by hand</div>
    </div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--in)"></span> Towards being owed</span>
      <span class="key"><span class="swatch" style="background:var(--out)"></span> Towards owing</span>
      <span class="key"><span class="swatch" style="background:var(--good)"></span> Closing, is owed</span>
      <span class="key"><span class="swatch" style="background:var(--critical)"></span> Closing, owes</span>
    </div>
    <div class="falls">${currenciesFor(tab, fold, who).map((c) => renderTrack(tab, fold, who, c)).join("")}</div>
  </section>` : ""}

  <section class="sec">
    <div class="sec-head"><h2>Entries</h2><div class="sec-note"><span class="num">${tab.events.length}</span> · balances refold on every read</div></div>
    ${renderEntries(tab)}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>Who owes what</h2><div class="sec-note">Net per person · a currency with no rate stays in its own column, unvalued</div></div>
    ${renderWhoOwesWhat(tab, fold, who)}
  </section>

  <section class="sec">
    <div class="sec-head"><h2>Settlements</h2><div class="sec-note">Money that has actually moved between people</div></div>
    ${renderSettlements(tab, fold)}
  </section>

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
        <td><strong><a class="lnk" href="?tab=${encodeURIComponent(t.name)}">${esc(t.name)}</a></strong></td>
        <td>${esc(t.status)}</td>
        <td>${esc(t.base_currency)}</td>
        <td class="r num">${t.events.length}</td>
      </tr>`
    )
    .join("");
  const body = `
  <header class="masthead">
    <div class="eyebrow">whoowes · live</div>
    <h1>Tabs</h1>
    <p class="dek">Pick a tab to see its entries, who is assigned to what, and what has actually been settled.</p>
    <div class="asof">as of <span class="num">${esc(generatedAt)}</span></div>
  </header>
  <section class="sec">
    ${
      ledger.tabs.length === 0
        ? `<div class="empty"><div class="empty-fig num">0</div><div class="empty-t">No tabs yet</div>
           <p class="empty-p">Create one with the <code>create_tab</code> tool.</p></div>`
        : `<div class="scroll"><table><thead><tr><th>Tab</th><th>Status</th><th>Base</th><th class="r">Entries</th></tr></thead><tbody>${rows}</tbody></table></div>`
    }
  </section>`;
  return page("whoowes — tabs", body);
}

export function renderError(message: string): string {
  return page(
    "whoowes",
    `<header class="masthead"><div class="eyebrow">whoowes</div><h1>Nothing to show</h1></header>
     <section class="sec"><div class="empty"><div class="empty-fig num">—</div>
     <div class="empty-t">${esc(message)}</div>
     <p class="empty-p"><a class="lnk" href="/view">Back to all tabs</a></p></div></section>`
  );
}

/** The artifact's design system, verbatim where it survived the port to server rendering. */
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
    --ink:#171B26; --ink-2:#4A5165; --ink-3:#767D93;
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
    --ink:#E9EBF1; --ink-2:#A7AEC1; --ink-3:#767D93;
    --in:#3987e5; --out:#d95926;
    --good-bg:#102A12; --critical-bg:#2E1414; --good-ink:#4FC24F; --critical-ink:#E97878;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3);
  }}
  :root[data-theme="dark"]{
    --surface:#101319; --card:#171B24; --card-sunk:#1E232E;
    --rule:#2B313F; --rule-strong:#414960;
    --ink:#E9EBF1; --ink-2:#A7AEC1; --ink-3:#767D93;
    --in:#3987e5; --out:#d95926;
    --good-bg:#102A12; --critical-bg:#2E1414; --good-ink:#4FC24F; --critical-ink:#E97878;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.3);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--surface);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1060px;margin:0 auto;padding:40px 24px 96px}
  @media (max-width:600px){.wrap{padding:28px 16px 64px}}
  .num{font-family:var(--data);font-variant-numeric:tabular-nums}
  a.lnk{color:var(--in);text-decoration:none}
  a.lnk:hover{text-decoration:underline}

  .masthead{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:8px}
  .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
  h1{font-family:var(--display);font-weight:400;font-size:clamp(30px,5vw,44px);margin:6px 0 4px;letter-spacing:-.01em;text-wrap:balance}
  .dek{color:var(--ink-2);max-width:62ch;margin:0}
  .asof{margin-top:12px;font-size:12.5px;color:var(--ink-3)}
  .asof .num{color:var(--ink-2)}
  h2{font-family:var(--display);font-weight:400;font-size:22px;margin:0;letter-spacing:-.01em}
  .sec{margin-top:44px}
  .sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--rule);padding-bottom:8px}
  .sec-note{font-size:13px;color:var(--ink-3)}

  .chip{display:inline-flex;align-items:center;font-size:12px;padding:3px 9px;border-radius:999px;
    background:var(--card-sunk);border:1px solid var(--rule);color:var(--ink-2);text-decoration:none}
  .chip:hover{border-color:var(--rule-strong)}
  .chip.is-on{background:var(--in);border-color:var(--in);color:#fff;font-weight:600}

  .positions{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px}
  @media (max-width:720px){.positions{grid-template-columns:1fr !important}}
  .pos{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:20px;box-shadow:var(--shadow);position:relative;overflow:hidden}
  .pos::before{content:"";position:absolute;inset:0 auto 0 0;width:3px}
  .pos.is-good::before{background:var(--good)}
  .pos.is-critical::before{background:var(--critical)}
  .pos-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
  .pos-fig{font-family:var(--display);font-size:clamp(30px,5.5vw,42px);font-variant-numeric:tabular-nums;letter-spacing:-.02em;margin:6px 0 2px;line-height:1.1}
  .pos.is-good .pos-fig{color:var(--good-ink)}
  .pos.is-critical .pos-fig{color:var(--critical-ink)}
  .pos-sub{font-size:13px;color:var(--ink-2)}
  .pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:999px;margin-top:10px}
  .pill.is-good{background:var(--good-bg);color:var(--good-ink)}
  .pill.is-critical{background:var(--critical-bg);color:var(--critical-ink)}

  .combined{margin-top:16px;background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--critical);
    border-radius:10px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;box-shadow:var(--shadow)}
  .combined-t{font-size:13.5px;color:var(--ink-2);max-width:66ch}
  .combined-fig{font-family:var(--display);font-size:30px;font-variant-numeric:tabular-nums;white-space:nowrap}

  .falls{display:grid;grid-template-columns:1fr 1fr;gap:28px}
  @media (max-width:860px){.falls{grid-template-columns:1fr}}
  .fall{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:18px 20px 14px;box-shadow:var(--shadow)}
  .fall-h{font-weight:700;font-size:13px;letter-spacing:.02em}
  .fall-sub{font-size:12px;color:var(--ink-3);margin-bottom:14px}
  .step{display:grid;grid-template-columns:1fr;gap:3px;margin-bottom:11px}
  .step-top{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;align-items:baseline}
  .step-name{color:var(--ink-2)}
  /* NB: modifiers are .up/.down, NOT .pos — .pos is the position card above and would drag
     its padding/border onto every bar it touched. */
  .step-val{font-family:var(--data);font-variant-numeric:tabular-nums;font-size:12px}
  .step-val.up{color:var(--in)}
  .step-val.down{color:var(--out)}
  .track{position:relative;height:13px;background:var(--card-sunk);border-radius:3px}
  .bar{position:absolute;top:0;bottom:0;border-radius:4px}
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
  .legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--ink-2);margin-bottom:18px}
  .key{display:inline-flex;align-items:center;gap:6px}
  .swatch{width:11px;height:11px;border-radius:3px}

  .scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:10px;background:var(--card);box-shadow:var(--shadow)}
  table{border-collapse:collapse;width:100%;font-size:13.5px;min-width:720px}
  thead th{text-align:left;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:700;
    padding:11px 14px;border-bottom:1px solid var(--rule-strong);white-space:nowrap;background:var(--card)}
  td{padding:11px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:var(--card-sunk)}
  tbody tr.is-focus td{background:var(--card-sunk)}
  td.r,th.r{text-align:right}
  .idx{color:var(--ink-3);font-family:var(--data);font-size:11.5px}
  .desc{color:var(--ink)}
  .desc small{display:block;color:var(--ink-3);font-size:11.5px;margin-top:2px}
  .desc small.eid{font-family:var(--data);font-size:10px;opacity:.55}
  .amt{font-family:var(--data);font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
  .ccy{color:var(--ink-3);font-size:11px;margin-left:2px;font-family:var(--body);font-weight:400}
  .who{display:inline-flex;align-items:center;gap:5px;font-size:12px;background:var(--card-sunk);border:1px solid var(--rule);
    padding:2px 7px;border-radius:5px;white-space:nowrap}
  .who .num{font-size:11px;color:var(--ink-2)}
  .who.is-payer{background:transparent;border-color:var(--in);color:var(--in);font-weight:600}
  .chips{display:flex;flex-wrap:wrap;gap:5px}
  .net{font-family:var(--data);font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
  .net.owes{color:var(--critical-ink)}
  .net.owed{color:var(--good-ink)}
  .net.flat{color:var(--ink-3)}
  .tag{font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--card-sunk);color:var(--ink-3)}
  .tag.pool{background:var(--in);color:#fff}

  .empty{background:var(--card);border:1px dashed var(--rule-strong);border-radius:10px;padding:32px 24px;text-align:center}
  .empty-fig{font-family:var(--display);font-size:34px;color:var(--ink-3)}
  .empty-t{font-weight:600;margin:4px 0 4px}
  .empty-p{font-size:13.5px;color:var(--ink-2);max-width:60ch;margin:0 auto}

  footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);font-size:12px;color:var(--ink-3);
    display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  code{font-family:var(--data);font-size:.9em;background:var(--card-sunk);padding:1px 5px;border-radius:4px;color:var(--ink-2)}
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}
