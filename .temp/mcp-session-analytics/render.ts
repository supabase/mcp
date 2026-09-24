import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEvidence } from './run.ts';

const directory = import.meta.dirname;
const fontPath = resolve(directory, 'Geist-Variable.woff2');

const escapeHtml = (value: string | number) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const number = (value: number) => new Intl.NumberFormat('en-US').format(value);
const compact = (value: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' }).format(value);
const percentage = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
const width = (value: number, maximum: number) => `${Math.max(2, (value / maximum) * 100).toFixed(2)}%`;
const source = (kind: 'production' | 'synthetic' | 'validated') => {
  const labels = {
    production: 'Production aggregate',
    synthetic: 'Synthetic model',
    validated: 'Validated handles',
  };
  return `<span class="source source-${kind}"><span></span>${labels[kind]}</span>`;
};

export async function renderReport(evidence = buildEvidence()) {
  const font = (await readFile(fontPath)).toString('base64');
  const production = evidence.executive.production;
  const synthetic = evidence.executive.synthetic;
  const maxIntent = Math.max(...evidence.intentClusters.map((row) => row.sessions));
  const maxCapability = Math.max(...evidence.missingCapabilities.map((row) => row.demandSessions));
  const maxOutput = Math.max(...evidence.reliability.outputHotspots.map((row) => row.p95Chars));
  const maxToolCalls = Math.max(...evidence.reliability.tools.map((row) => row.calls));
  const embeddedData = JSON.stringify(evidence).replaceAll('</script>', '<\\/script>');

  const intentRows = evidence.intentClusters
    .map(
      (row, index) => `<div class="chart-row">
        <div class="rank">${index + 1}</div>
        <div class="chart-copy"><strong>${escapeHtml(row.goal)}</strong><span>${number(row.sessions)} sessions · ${percentage(row.sharePct)} of model</span></div>
        <div class="bar"><i style="width:${width(row.sessions, maxIntent)}"></i></div>
        <div class="chart-value"><strong>${percentage(row.completionPct)}</strong><span>complete</span></div>
      </div>`,
    )
    .join('');

  const cohortRows = evidence.cohorts
    .map(
      (row) => `<tr>
        <td><strong>${escapeHtml(row.cohort)}</strong></td>
        <td class="numeric">${number(row.sessions)}</td>
        <td><div class="metric-bar"><i style="width:${row.sharePct}%"></i><span>${percentage(row.sharePct)}</span></div></td>
        <td class="numeric good">${percentage(row.completionPct)}</td>
        <td class="numeric ${row.repeatToolPct >= 35 ? 'warn' : ''}">${percentage(row.repeatToolPct)}</td>
      </tr>`,
    )
    .join('');

  const funnelSteps = evidence.workflows.funnel
    .map(
      (row, index) => `<div class="funnel-step" style="--funnel-width:${row.conversionPct}%">
        <div class="funnel-top"><span>0${index + 1}</span><strong>${escapeHtml(row.stage)}</strong></div>
        <div class="funnel-fill"><i></i></div>
        <div class="funnel-stats"><strong>${number(row.sessions)}</strong><span>${percentage(row.conversionPct)}</span></div>
      </div>`,
    )
    .join('<div class="funnel-arrow">→</div>');

  const loopRows = evidence.workflows.loops
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.path)}</code></td>
        <td><span class="signal ${row.signal.includes('Healthy') ? 'signal-good' : 'signal-warn'}">${escapeHtml(row.signal)}</span></td>
        <td class="numeric">${number(row.sessions)}</td>
      </tr>`,
    )
    .join('');

  const capabilityRows = evidence.missingCapabilities
    .map(
      (row, index) => `<div class="demand-row ${index === 0 ? 'demand-top' : ''}">
        <div class="rank">${index + 1}</div>
        <div class="demand-name"><strong>${escapeHtml(row.capability)}</strong><span>${number(row.blockedSessions)} blocked · ${percentage(row.recoveryPct)} recovered</span></div>
        <div class="bar"><i style="width:${width(row.demandSessions, maxCapability)}"></i></div>
        <strong class="demand-total">${number(row.demandSessions)}</strong>
      </div>`,
    )
    .join('');

  const toolRows = evidence.reliability.tools
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.tool)}</code></td>
        <td><div class="metric-bar"><i style="width:${width(row.calls, maxToolCalls)}"></i><span>${compact(row.calls)}</span></div></td>
        <td class="numeric ${row.errorRatePct > production.errorRatePct ? 'bad' : 'good'}">${percentage(row.errorRatePct)}</td>
      </tr>`,
    )
    .join('');

  const outputRows = evidence.reliability.outputHotspots
    .map(
      (row) => `<div class="output-row">
        <code>${escapeHtml(row.tool)}</code>
        <div class="output-bar"><i style="width:${width(row.p95Chars, maxOutput)}"></i></div>
        <div class="output-values"><strong>${compact(row.p95Chars)}</strong><span>p95 · ${compact(row.p50Chars)} p50</span></div>
      </div>`,
    )
    .join('');

  const continuityRows = evidence.continuity.agentContinuity
    .map(
      (row) => `<div class="continuity-row">
        <div><strong>${escapeHtml(row.mode)}</strong><span>${number(row.sessions)} sessions</span></div>
        <div class="bar"><i style="width:${row.completionPct}%"></i></div>
        <strong>${percentage(row.completionPct)}</strong>
      </div>`,
    )
    .join('');

  const telemetryRows = evidence.telemetry.productionCoverage
    .map(
      (row) => `<div class="coverage-row">
        <div><strong>${escapeHtml(row.field)}</strong><span>${percentage(row.coveragePct)}</span></div>
        <div class="coverage-track"><i style="width:${row.coveragePct}%"></i></div>
      </div>`,
    )
    .join('');

  const evalRows = evidence.evalBacklog
    .map(
      (row) => `<tr>
        <td><span class="priority priority-${row.priority.toLowerCase()}">${row.priority}</span></td>
        <td><strong>${escapeHtml(row.scenario)}</strong></td>
        <td>${escapeHtml(row.evidence)}</td>
        <td>${escapeHtml(row.contract)}</td>
      </tr>`,
    )
    .join('');

  const recommendationRows = evidence.recommendations
    .map(
      (row) => `<article class="recommendation">
        <div class="rec-head"><span class="priority priority-${row.priority.toLowerCase()}">${row.priority}</span><span class="rec-id">${row.id}</span></div>
        <h3>${escapeHtml(row.action)}</h3>
        <p>${escapeHtml(row.evidence)}</p>
        <dl><div><dt>Owner</dt><dd>${escapeHtml(row.owner)}</dd></div><div><dt>Success check</dt><dd>${escapeHtml(row.success)}</dd></div></dl>
      </article>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>MCP product analytics</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23171717'/%3E%3Cpath d='M9 22V10h3l4 6 4-6h3v12h-3v-7l-4 5-4-5v7z' fill='%23fff'/%3E%3C/svg%3E">
  <style>
    @font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900;font-style:normal;font-display:swap}
    :root{--background:#f7f7f5;--foreground:#181817;--card:#fff;--muted:#f1f1ee;--muted-foreground:#6d6d67;--border:#e4e4df;--primary:#171717;--green:#1f8f5f;--green-soft:#eaf6f0;--blue:#3971e7;--blue-soft:#edf3ff;--amber:#a66b08;--amber-soft:#fff6df;--red:#c43838;--red-soft:#fff0f0;--violet:#7157d9;--violet-soft:#f2efff;--radius:10px;--shadow:0 1px 2px rgb(0 0 0 / .04)}
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;background:var(--background);color:var(--foreground);font-family:Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;letter-spacing:.01em}
    a{color:inherit}
    code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:12px}
    .rail{position:fixed;inset:0 auto 0 0;width:58px;background:#171717;color:#fff;display:flex;flex-direction:column;align-items:center;z-index:20}
    .logo{width:34px;height:34px;margin:14px 0 24px;border:1px solid #3c3c3c;border-radius:9px;display:grid;place-items:center;font-weight:750}
    .rail nav{display:flex;flex-direction:column;gap:8px}
    .rail a{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;color:#9b9b96;text-decoration:none;font-size:11px;font-weight:700}
    .rail a:hover,.rail a:focus-visible{background:#2a2a29;color:#fff;outline:none}
    .rail .active{background:#fff;color:#171717}
    .rail-bottom{margin-top:auto;margin-bottom:15px;color:#858580;font-size:10px;writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:.08em;text-transform:uppercase}
    .topbar{position:sticky;top:0;z-index:15;margin-left:58px;height:52px;background:rgb(255 255 255 / .88);backdrop-filter:blur(14px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 28px}
    .crumb{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted-foreground)}
    .crumb strong{color:var(--foreground)}
    .run-status{display:flex;align-items:center;gap:8px;color:var(--muted-foreground);font-size:12px}
    .run-status i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px var(--green-soft)}
    main{margin-left:58px;max-width:1500px;padding:34px 36px 72px}
    .hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}
    .eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.09em;font-weight:700;color:var(--muted-foreground);margin-bottom:8px}
    h1{font-size:30px;line-height:1.08;letter-spacing:-.025em;margin:0 0 8px;font-weight:720}
    .hero p{margin:0;color:var(--muted-foreground);max-width:740px;line-height:1.55}
    .hero-meta{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .date-chip{background:var(--card);border:1px solid var(--border);padding:7px 10px;border-radius:8px;white-space:nowrap;font-size:12px;color:var(--muted-foreground)}
    .source{display:inline-flex;align-items:center;gap:6px;width:max-content;padding:4px 7px;border:1px solid var(--border);border-radius:999px;background:var(--card);font-size:10px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--muted-foreground)}
    .source span{width:6px;height:6px;border-radius:50%}
    .source-production span{background:var(--green)}.source-synthetic span{background:var(--violet)}.source-validated span{background:var(--blue)}
    .source-strip{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}
    section{scroll-margin-top:72px;margin-top:28px}
    .section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:12px}
    .section-head h2{font-size:17px;letter-spacing:-.01em;margin:0 0 4px}
    .section-head p{margin:0;color:var(--muted-foreground);font-size:12px}
    .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
    .kpi-grid{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:10px}
    .kpi{padding:15px;min-height:112px;display:flex;flex-direction:column}
    .kpi-label{font-size:11px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.06em;font-weight:650}
    .kpi strong{font-size:26px;letter-spacing:-.035em;margin-top:12px;font-weight:680}
    .kpi small{margin-top:auto;color:var(--muted-foreground);font-size:11px;line-height:1.3}
    .kpi .bad{color:var(--red)}
    .insight{display:grid;grid-template-columns:24px 1fr;gap:10px;margin-top:10px;padding:12px 14px;border:1px solid #dce9e2;background:#f6fbf8;border-radius:var(--radius);font-size:12px;line-height:1.5}
    .insight b{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--green-soft);color:var(--green);font-size:11px}
    .grid-2{display:grid;grid-template-columns:1.2fr .8fr;gap:12px}.grid-even{grid-template-columns:1fr 1fr}.grid-2>*{min-width:0}
    .panel{min-width:0;padding:18px}
    .panel-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
    .panel-title h3{font-size:13px;margin:0}.panel-title span{font-size:11px;color:var(--muted-foreground)}
    .chart-row,.demand-row{display:grid;grid-template-columns:24px minmax(180px,1.1fr) minmax(120px,1fr) 72px;align-items:center;gap:12px;min-height:52px;border-top:1px solid var(--border)}
    .chart-row:first-child,.demand-row:first-child{border-top:0}
    .rank{width:22px;height:22px;border-radius:6px;background:var(--muted);display:grid;place-items:center;color:var(--muted-foreground);font-size:10px;font-weight:700}
    .chart-copy,.demand-name{display:flex;flex-direction:column;gap:3px}.chart-copy strong,.demand-name strong{font-size:12px}.chart-copy span,.demand-name span{font-size:10px;color:var(--muted-foreground)}
    .bar,.output-bar{height:7px;border-radius:999px;background:var(--muted);overflow:hidden}.bar i,.output-bar i{height:100%;display:block;border-radius:inherit;background:var(--violet)}
    .chart-value{text-align:right;display:flex;flex-direction:column}.chart-value strong{font-size:12px}.chart-value span{font-size:9px;text-transform:uppercase;color:var(--muted-foreground)}
    .table-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;min-width:620px}
    th{padding:9px 10px;text-align:left;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);font-weight:650}
    td{padding:11px 10px;border-bottom:1px solid var(--border);font-size:12px;vertical-align:middle}tbody tr:last-child td{border-bottom:0}
    .numeric{text-align:right;font-variant-numeric:tabular-nums}.good{color:var(--green)}.warn{color:var(--amber)}.bad{color:var(--red)}
    .metric-bar{display:grid;grid-template-columns:minmax(70px,1fr) 52px;gap:8px;align-items:center}.metric-bar:before{content:"";grid-area:1/1;display:block;height:6px;border-radius:99px;background:var(--muted)}.metric-bar i{grid-area:1/1;height:6px;border-radius:99px;background:var(--blue);z-index:1}.metric-bar span{grid-area:1/2;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted-foreground);font-size:11px}
    .funnel{display:flex;align-items:center;padding:20px}.funnel-step{flex:1;min-width:0}.funnel-top{display:flex;gap:8px;align-items:center;margin-bottom:12px}.funnel-top span{font-size:9px;color:var(--muted-foreground)}.funnel-top strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.funnel-fill{height:44px;background:var(--muted);border-radius:7px;display:flex;align-items:stretch}.funnel-fill i{width:var(--funnel-width);border-radius:7px;background:linear-gradient(90deg,#8069dc,var(--violet))}.funnel-stats{display:flex;justify-content:space-between;margin-top:8px}.funnel-stats strong{font-size:12px}.funnel-stats span{font-size:10px;color:var(--muted-foreground)}.funnel-arrow{color:#aaa;font-size:16px;margin:0 9px}
    .recovery{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.mini-stat{padding:14px;background:var(--muted);border-radius:8px}.mini-stat span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)}.mini-stat strong{display:block;margin-top:8px;font-size:21px}
    .signal{font-size:10px;border-radius:999px;padding:4px 7px;white-space:nowrap}.signal-good{color:var(--green);background:var(--green-soft)}.signal-warn{color:var(--amber);background:var(--amber-soft)}
    .demand-top{margin:0 -8px;padding:0 8px;border:1px solid #dfd8ff!important;background:var(--violet-soft);border-radius:8px}.demand-row .bar i{background:var(--blue)}.demand-total{text-align:right;font-size:12px}
    .output-row{display:grid;grid-template-columns:minmax(160px,1.1fr) minmax(100px,1fr) 100px;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--border)}.output-row:first-child{border-top:0}.output-row .output-bar i{background:var(--amber)}.output-values{display:flex;flex-direction:column;text-align:right}.output-values strong{font-size:12px}.output-values span{font-size:9px;color:var(--muted-foreground)}
    .session-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.session-callout{padding:17px;border:1px solid #cfe4d8;background:#f5fbf8;border-radius:var(--radius)}.session-callout h3{margin:0 0 8px;font-size:13px}.session-callout p{font-size:12px;line-height:1.55;margin:0;color:#3f5148}.session-callout a{color:var(--green);font-weight:650;text-underline-offset:3px}.session-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}.session-metric{padding:13px;background:var(--card);border:1px solid var(--border);border-radius:8px}.session-metric strong{font-size:18px;display:block}.session-metric span{font-size:9px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.05em}.continuity-row{display:grid;grid-template-columns:minmax(150px,1.2fr) 1fr 48px;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border)}.continuity-row:first-child{border-top:0}.continuity-row>div:first-child{display:flex;flex-direction:column;gap:2px}.continuity-row span{font-size:10px;color:var(--muted-foreground)}.continuity-row>strong{text-align:right;font-size:11px}
    .version-card{padding:20px}.version-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.version-head h3{margin:0 0 4px;font-size:15px}.version-head p{margin:0;color:var(--muted-foreground);font-size:11px}.delta{font-size:20px;font-weight:700;color:var(--red);text-align:right}.delta span{display:block;font-size:9px;color:var(--muted-foreground);font-weight:500;text-transform:uppercase}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.period{padding:14px;background:var(--muted);border-radius:8px}.period-top{display:flex;justify-content:space-between;align-items:center}.period-top span{font-size:10px;text-transform:uppercase;color:var(--muted-foreground)}.period-top strong{font-size:15px}.period .bar{margin:12px 0 7px}.period .bar i{background:var(--red)}.period small{color:var(--muted-foreground)}
    .coverage-row{padding:10px 0;border-top:1px solid var(--border)}.coverage-row:first-child{border-top:0}.coverage-row>div:first-child{display:flex;justify-content:space-between;font-size:11px}.coverage-row>div span{color:var(--muted-foreground)}.coverage-track{height:7px;background:var(--muted);border-radius:99px;margin-top:8px;overflow:hidden}.coverage-track i{height:100%;display:block;background:var(--green);border-radius:inherit}
    .check-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.check-list li{display:grid;grid-template-columns:18px 1fr;gap:8px;font-size:11px;line-height:1.4}.check-list li:before{content:"✓";width:17px;height:17px;display:grid;place-items:center;border-radius:50%;background:var(--green-soft);color:var(--green);font-weight:700;font-size:10px}
    .limit-list{margin:14px 0 0;padding:14px 0 0 18px;border-top:1px solid var(--border);color:var(--muted-foreground);font-size:11px;line-height:1.6}
    .priority{display:inline-grid;place-items:center;min-width:30px;height:21px;padding:0 7px;border-radius:999px;font-size:9px;font-weight:750;letter-spacing:.04em}.priority-p0{background:var(--red-soft);color:var(--red)}.priority-p1{background:var(--amber-soft);color:var(--amber)}.priority-p2{background:var(--blue-soft);color:var(--blue)}
    .recommendations{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.recommendation{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;min-height:255px}.rec-head{display:flex;justify-content:space-between;align-items:center}.rec-id{font-size:10px;color:var(--muted-foreground)}.recommendation h3{font-size:14px;line-height:1.25;margin:18px 0 8px}.recommendation p{font-size:11px;color:var(--muted-foreground);line-height:1.45;margin:0 0 18px}.recommendation dl{margin:auto 0 0}.recommendation dl div{padding-top:10px;border-top:1px solid var(--border);margin-top:10px}.recommendation dt{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)}.recommendation dd{margin:4px 0 0;font-size:10px;line-height:1.4}
    footer{margin-top:38px;padding-top:18px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:20px;color:var(--muted-foreground);font-size:10px;line-height:1.5}
    @media(max-width:1180px){.kpi-grid{grid-template-columns:repeat(3,1fr)}.recommendations{grid-template-columns:repeat(3,1fr)}.session-metrics{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:820px){.rail{display:none}.topbar{margin-left:0;padding:0 16px}.run-status span{display:none}main{margin-left:0;padding:24px 16px 54px}.hero{align-items:flex-start;flex-direction:column}.hero-meta{justify-content:flex-start}.kpi-grid{grid-template-columns:repeat(2,1fr)}.grid-2,.session-grid{grid-template-columns:1fr}.funnel{align-items:stretch;flex-direction:column}.funnel-arrow{transform:rotate(90deg);align-self:center;margin:5px}.recommendations{grid-template-columns:1fr 1fr}.chart-row,.demand-row{grid-template-columns:24px 1fr 54px}.chart-row .bar,.demand-row .bar{grid-column:2/4}.output-row{grid-template-columns:1fr 86px}.output-row .output-bar{grid-row:2;grid-column:1/3}.session-callout{order:-1}}
    @media(max-width:520px){h1{font-size:25px}.kpi-grid{grid-template-columns:1fr 1fr}.kpi{min-height:104px}.kpi strong{font-size:22px}.recommendations{grid-template-columns:1fr}.comparison{grid-template-columns:1fr}.session-metrics{grid-template-columns:1fr 1fr}.source-strip{gap:5px}footer{flex-direction:column}.chart-row,.demand-row{gap:8px}.chart-copy,.demand-name{min-width:0}.chart-copy strong,.demand-name strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
    @media print{.rail,.topbar{display:none}main{margin:0;padding:20px}section{break-inside:avoid}.card,.recommendation{box-shadow:none}}
  </style>
</head>
<body>
  <aside class="rail" aria-label="Report navigation">
    <div class="logo" aria-label="MCP analytics">M</div>
    <nav>
      <a class="active" href="#overview" aria-label="Overview">01</a>
      <a href="#workflows" aria-label="Workflows">02</a>
      <a href="#reliability" aria-label="Reliability">03</a>
      <a href="#sessions" aria-label="Sessions">04</a>
      <a href="#actions" aria-label="Actions">05</a>
    </nav>
    <div class="rail-bottom">Product analytics</div>
  </aside>
  <header class="topbar">
    <div class="crumb"><span>MCP</span><span>/</span><strong>Product analytics</strong></div>
    <div class="run-status"><i></i><span>Deterministic report · aggregate-safe</span></div>
  </header>
  <main>
    <div class="hero">
      <div>
        <div class="eyebrow">Supabase MCP · 28-day review</div>
        <h1>MCP product analytics</h1>
        <p>Production scale and reliability metrics sit beside a synthetic workflow model. Source labels mark every view so product hypotheses do not read as measured intent.</p>
      </div>
      <div class="hero-meta">
        <span class="date-chip">Aug 27 → Sep 24, 2026</span>
        <span class="date-chip">Generated Sep 24, 2026</span>
      </div>
    </div>
    <div class="source-strip" aria-label="Data sources">
      ${source('production')}${source('synthetic')}${source('validated')}
    </div>

    <section id="overview">
      <div class="section-head"><div><h2>Executive KPIs</h2><p>Scale, reliability, output, and modeled goal completion.</p></div>${source('production')}</div>
      <div class="kpi-grid">
        <article class="kpi card"><span class="kpi-label">Tool calls</span><strong>${compact(production.calls)}</strong><small>${number(production.calls)} aggregate events</small></article>
        <article class="kpi card"><span class="kpi-label">Identified users</span><strong>${compact(production.identifiedUsers)}</strong><small>${percentage(production.identifiedUserCoveragePct)} field coverage</small></article>
        <article class="kpi card"><span class="kpi-label">Error rate</span><strong class="bad">${percentage(production.errorRatePct)}</strong><small>${compact(production.errorCount)} error outcomes</small></article>
        <article class="kpi card"><span class="kpi-label">p95 latency</span><strong>${number(production.latencyMs.p95)} ms</strong><small>${number(production.latencyMs.p50)} ms at p50</small></article>
        <article class="kpi card"><span class="kpi-label">p95 output</span><strong>${compact(production.outputChars.p95)}</strong><small>${number(production.outputChars.p50)} characters at p50</small></article>
        <article class="kpi card"><span class="kpi-label">Goal completion</span><strong>${percentage(synthetic.completionPct)}</strong><small>${number(synthetic.completedSessions)} of ${number(synthetic.sessions)} modeled sessions · ${source('synthetic')}</small></article>
      </div>
      <div class="insight"><b>↗</b><div><strong>Largest product risk:</strong> <code>execute_sql</code> carries 81.7% of production calls and runs above the overall error baseline. Output size is the second clear cost center.</div></div>
    </section>

    <section id="intents">
      <div class="section-head"><div><h2>Intent and goal clusters</h2><p>Modeled jobs to be done, ranked by session share.</p></div>${source('synthetic')}</div>
      <div class="grid-2">
        <div class="panel card"><div class="panel-title"><h3>Goal mix</h3><span>${number(synthetic.sessions)} sessions</span></div>${intentRows}</div>
        <div class="panel card"><div class="panel-title"><h3>User cohorts</h3><span>Completion and repeat-tool behavior</span></div><div class="table-wrap"><table><thead><tr><th>Cohort</th><th class="numeric">Sessions</th><th>Share</th><th class="numeric">Complete</th><th class="numeric">Repeat</th></tr></thead><tbody>${cohortRows}</tbody></table></div></div>
      </div>
      <div class="insight"><b>i</b><div><strong>Finding:</strong> Debuggers and explorers repeat tools most often and complete fewer goals. Prioritize recovery guidance and tool discovery for these cohorts.</div></div>
    </section>

    <section id="workflows">
      <div class="section-head"><div><h2>Workflow funnels and recovery</h2><p>Modeled progression, recovery, and repeated paths.</p></div>${source('synthetic')}</div>
      <div class="card funnel">${funnelSteps}</div>
      <div class="grid-2 grid-even" style="margin-top:12px">
        <div class="panel card"><div class="panel-title"><h3>Recovery after first failure</h3><span>${percentage(evidence.workflows.recovery.recoveryPct)} recovered</span></div><div class="recovery"><div class="mini-stat"><span>Initial failures</span><strong>${number(evidence.workflows.recovery.initialFailureSessions)}</strong></div><div class="mini-stat"><span>Recovered</span><strong class="good">${number(evidence.workflows.recovery.recoveredSessions)}</strong></div><div class="mini-stat"><span>Abandoned</span><strong class="bad">${number(evidence.workflows.recovery.abandonedSessions)}</strong></div></div></div>
        <div class="panel card"><div class="panel-title"><h3>Common transitions and loops</h3><span>Sessions with path</span></div><div class="table-wrap"><table><thead><tr><th>Path</th><th>Signal</th><th class="numeric">Sessions</th></tr></thead><tbody>${loopRows}</tbody></table></div></div>
      </div>
    </section>

    <section id="capabilities">
      <div class="section-head"><div><h2>Missing-capability demand</h2><p>Modeled demand ranked by affected sessions.</p></div>${source('synthetic')}</div>
      <div class="panel card"><div class="panel-title"><h3>Demand rank</h3><span>Demand sessions</span></div>${capabilityRows}</div>
      <div class="insight"><b>1</b><div><strong>Recommendation:</strong> Backups and Point-in-Time Recovery lead modeled demand and blocked outcomes. Validate the workflow with a focused eval before changing the public tool surface.</div></div>
    </section>

    <section id="reliability">
      <div class="section-head"><div><h2>Reliability and output efficiency</h2><p>Production call volume, error rate, latency, and response size.</p></div>${source('production')}</div>
      <div class="grid-2 grid-even">
        <div class="panel card"><div class="panel-title"><h3>Highest-volume tools</h3><span>28-day aggregate</span></div><div class="table-wrap"><table><thead><tr><th>Tool</th><th>Calls</th><th class="numeric">Error rate</th></tr></thead><tbody>${toolRows}</tbody></table></div></div>
        <div class="panel card"><div class="panel-title"><h3>Output hotspots</h3><span>Characters per result</span></div>${outputRows}</div>
      </div>
      <div class="insight"><b>!</b><div><strong>Finding:</strong> <code>generate_typescript_types</code> reaches ${number(evidence.reliability.outputHotspots[0].p95Chars)} characters at p95. Page, compress, or return a retrievable artifact before adding new output-heavy tools.</div></div>
    </section>

    <section id="sessions">
      <div class="section-head"><div><h2>Session and agent continuity</h2><p>Explicit handles carry more confidence than inferred groups.</p></div>${source('validated')}</div>
      <div class="session-metrics">
        <div class="session-metric"><strong>${percentage(evidence.continuity.productionExplicitSessionCoveragePct)}</strong><span>Production explicit coverage</span></div>
        <div class="session-metric"><strong>${evidence.continuity.validatedExplicitSessions}</strong><span>Validated explicit sessions</span></div>
        <div class="session-metric"><strong>${evidence.continuity.validatedCalls}</strong><span>Validated calls</span></div>
        <div class="session-metric"><strong>0 / 0</strong><span>Validated merges / splits</span></div>
      </div>
      <div class="session-grid">
        <div class="panel card"><div class="panel-title"><h3>Modeled continuity</h3><span>${source('synthetic')}</span></div>${continuityRows}</div>
        <aside class="session-callout" aria-label="Session estimate disclaimer">
          <h3>Inferred sessions are estimates</h3>
          <p><a href="https://docs.agentcat.com/sdk/stateless-servers">AgentCat's stateless-server fallback</a> groups events without a session ID by identified user, AI client, and a 30-minute inactivity window. This is an approximation, not ground truth. The same user can run two distinct sessions in the same client within 30 minutes, so the heuristic can merge them. Treat inferred session counts and funnels as estimates. Explicit validated session handles remain the higher-confidence signal.</p>
          <p style="margin-top:10px"><strong>Controlled fixture:</strong> the fallback produced ${evidence.continuity.fallbackFixture.estimatedMerges} estimated merges and ${evidence.continuity.fallbackFixture.estimatedSplits} split, while explicit handles preserved all eight sessions.</p>
        </aside>
      </div>
    </section>

    <section id="versions">
      <div class="section-head"><div><h2>Client and version regressions</h2><p>Matched two-week production windows. Association does not prove cause.</p></div>${source('production')}</div>
      <article class="version-card card">
        <div class="version-head"><div><h3>Cursor 1.0.0</h3><p>${escapeHtml(evidence.clientVersions[0].interpretation)}</p></div><div class="delta">+${evidence.clientVersions[0].deltaPercentagePoints.toFixed(2)} pp<span>Error-rate change</span></div></div>
        <div class="comparison"><div class="period"><div class="period-top"><span>Prior window</span><strong>${percentage(evidence.clientVersions[0].priorErrorRatePct)}</strong></div><div class="bar"><i style="width:${evidence.clientVersions[0].priorErrorRatePct * 6}%"></i></div><small>${number(evidence.clientVersions[0].priorCalls)} calls</small></div><div class="period"><div class="period-top"><span>Current window</span><strong>${percentage(evidence.clientVersions[0].currentErrorRatePct)}</strong></div><div class="bar"><i style="width:${evidence.clientVersions[0].currentErrorRatePct * 6}%"></i></div><small>${number(evidence.clientVersions[0].currentCalls)} calls</small></div></div>
      </article>
    </section>

    <section id="telemetry">
      <div class="section-head"><div><h2>Telemetry quality and privacy</h2><p>Coverage gaps and the boundary applied to this report.</p></div>${source('production')}</div>
      <div class="grid-2 grid-even">
        <div class="panel card"><div class="panel-title"><h3>Production field coverage</h3><span>Aggregate availability</span></div>${telemetryRows}</div>
        <div class="panel card"><div class="panel-title"><h3>Report privacy boundary</h3><span>Checked locally</span></div><ul class="check-list">${evidence.telemetry.privacyControls.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><ul class="limit-list">${evidence.telemetry.knownLimits.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
      </div>
    </section>

    <section id="evals">
      <div class="section-head"><div><h2>Eval backlog</h2><p>Scored checks tied to the largest product risks.</p></div><span class="date-chip">6 scenarios</span></div>
      <div class="panel card"><div class="table-wrap"><table><thead><tr><th>Priority</th><th>Scenario</th><th>Evidence</th><th>Observable contract</th></tr></thead><tbody>${evalRows}</tbody></table></div></div>
    </section>

    <section id="actions">
      <div class="section-head"><div><h2>Recommendation queue</h2><p>Ranked actions with owner and success check.</p></div><span class="date-chip">3 P0 · 2 P1</span></div>
      <div class="recommendations">${recommendationRows}</div>
    </section>

    <footer><span>Production source: <code>mcp.logs.prod</code>, aggregate query window ending Sep 24, 2026.</span><span>Synthetic source: fixed 2,400-session workflow model. Report artifact contains no raw telemetry.</span></footer>
  </main>
  <script type="application/json" id="report-evidence">${embeddedData}</script>
</body>
</html>`;

  return html;
}

async function main() {
  const html = await renderReport();
  await writeFile(resolve(directory, 'report.html'), html);
  console.log(JSON.stringify({ bytes: Buffer.byteLength(html), output: 'report.html', sections: 11 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
