import { ICONS } from "./icons.js";
import { REMOTE_UI_ICONS } from "./remote-icons.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Asset URLs carry a content hash, so a browser never keeps running a cached runtime from an older release.
const REMOTE_UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "remote-ui");
function assetVersion(name) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(REMOTE_UI_DIR, name))).digest("hex").slice(0, 12); }
  catch { return String(Date.now()); }
}
const RUNTIME_JS = `/ui/remote-ui/remote-ui-web.js?v=${assetVersion("remote-ui-web.js")}`;
const RUNTIME_CSS = `/ui/remote-ui/remote-ui-web.css?v=${assetVersion("remote-ui-web.css")}`;

// -----------------------------------------------------------------------------
// Dashboard page
//
// Visual language follows the Advanced Automations editor (same author): dark surfaces, lime accent, a topbar with
// the integration mark, a sidebar list next to a workspace panel, a log panel underneath and native dialogs.
// Everything is inline so the page works on a Remote without internet access.
// -----------------------------------------------------------------------------

const BRAND_SVG = '<svg aria-hidden="true" viewBox="0 0 90 90" fill="none" stroke="#e9ff5b" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M21.86 72.58A36 36 0 0 1 21.86 17.42"/><path d="M12.45 17.09L21.86 17.42L20.55 26.75"/><path d="M68.14 17.42A36 36 0 0 1 68.14 72.58"/><path d="M77.55 72.91L68.14 72.58L69.45 63.25"/><rect x="35" y="19" width="20" height="52" rx="8"/><path d="M45 58h0" stroke-width="7"/></svg>';

function remoteIconCss() {
  return Object.entries(REMOTE_UI_ICONS).map(([name, { d }]) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="${d}"/></svg>`;
    return `.uc-remote-ui__icon[data-glyph="${name}"]{--glyph:url("data:image/svg+xml,${encodeURIComponent(svg)}")}`;
  }).join("\n");
}

function iconCss() {
  return Object.entries(ICONS).map(([name, path]) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="${path}"/></svg>`;
    return `.mi-${name}{--mi-url:url("data:image/svg+xml,${encodeURIComponent(svg)}")}`;
  }).join("\n");
}

const STYLES = String.raw`
:root{color-scheme:dark;--bg:#0b0d10;--panel:#121519;--panel-2:#181c21;--panel-3:#20252c;--field:#0e1115;--border:#2a3038;--border-strong:#3a424d;--text:#f3f5f7;--muted:#929ba7;--accent:#e9ff5b;--accent-text:#171a0c;--danger:#ff6b6b;--success:#6ee7a8;--warning:#ffc86b;--radius-sm:8px;--radius:12px;--radius-lg:16px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-7:32px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{min-width:320px}body{margin:0;min-width:320px;min-height:100vh;background:var(--bg);color:var(--text)}
button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}.hidden{display:none!important}
h1,h2,h3,p{margin:0}h1{font-size:clamp(25px,3vw,38px);font-weight:650;letter-spacing:-.03em}h2{font-size:19px;line-height:1.25}h3{font-size:16px;line-height:1.3}p{color:var(--muted);font-size:14px;line-height:1.55}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.mi{--mi-size:20px;display:inline-block;width:var(--mi-size);height:var(--mi-size);flex:none;background:currentColor;-webkit-mask:var(--mi-url) center/contain no-repeat;mask:var(--mi-url) center/contain no-repeat}
.shell{width:min(1480px,calc(100% - 32px));margin:0 auto;padding:28px 0 52px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:var(--space-6);margin-bottom:var(--space-6)}
.brand-lockup{display:flex;align-items:center;gap:var(--space-3);min-width:0}.brand-icon{width:46px;height:46px;flex:none}
.top-actions,.editor-actions,.dialog-actions,.empty-actions{display:flex;align-items:center;gap:var(--space-2)}
.top-actions{flex-wrap:wrap;justify-content:flex-end}
.panel{border:1px solid var(--border);background:var(--panel);border-radius:var(--radius)}
.layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:var(--space-4);min-height:620px}.layout.single{grid-template-columns:minmax(0,1fr)}
.sidebar{padding:var(--space-4)}
.sidebar-head,.editor-head,.logs-head,.dialog-head,.overview-section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-5)}
.sidebar-head{align-items:center;padding:var(--space-1) var(--space-1) var(--space-4);border-bottom:1px solid var(--border)}.sidebar-head p{margin-top:var(--space-1);font-size:12px}
.sidebar-head-actions{display:flex;align-items:center;gap:var(--space-1)}
.item-list{padding-top:var(--space-3);display:grid;gap:var(--space-2)}
.list-item{width:100%;border:1px solid transparent;color:var(--text);background:transparent;padding:var(--space-3);border-radius:9px;text-align:left;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px var(--space-2);align-items:center}
.list-item:hover{background:var(--panel-2)}.list-item.active{border-color:var(--border-strong);background:var(--panel-2)}
.list-item .item-top{display:flex;gap:var(--space-2);align-items:center;min-width:0;grid-column:1}
.list-item strong{min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list-item small{grid-column:1;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-item .chevron{grid-column:2;grid-row:1/span 2;color:var(--muted);transition:transform .16s ease,color .16s ease}
.list-item:hover .chevron,.list-item.active .chevron{color:var(--text);transform:translateX(2px)}
.list-divider{height:1px;background:var(--border);margin:var(--space-1) 0}
.list-empty{color:var(--muted);font-size:13px;text-align:center;padding:22px 8px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.dot.ok{background:var(--success)}.dot.warn{background:var(--warning)}.dot.bad{background:var(--danger)}
.workspace{padding:var(--space-6);min-width:0}
.empty-state{min-height:560px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:var(--space-3)}
.empty-state p{max-width:560px;margin-bottom:var(--space-2)}.empty-icon{width:76px;height:76px;margin-bottom:var(--space-1)}
.role-choices{display:grid;grid-template-columns:repeat(2,minmax(0,280px));gap:var(--space-3);margin-top:var(--space-3)}
.role-choice{display:grid;align-content:start;gap:var(--space-2);text-align:left;padding:var(--space-5);border:1px solid var(--border);border-radius:var(--radius);background:var(--panel-2);color:var(--text)}
.role-choice:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--panel-2))}
.role-choice strong{font-size:15px;display:flex;align-items:center;gap:var(--space-2)}.role-choice span{color:var(--muted);font-size:13px;line-height:1.5}
.overview-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-6);padding-bottom:var(--space-5);border-bottom:1px solid var(--border)}
.overview-head>div:first-child{display:grid;gap:var(--space-2);min-width:0}
.overview-title-row{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap}
.overview-status{display:inline-flex;align-items:center;min-height:24px;padding:3px 9px;border:1px solid color-mix(in srgb,var(--success) 55%,var(--border));border-radius:999px;color:var(--success);background:color-mix(in srgb,var(--success) 8%,transparent);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.overview-status.warn{color:var(--warning);border-color:color-mix(in srgb,var(--warning) 55%,var(--border));background:color-mix(in srgb,var(--warning) 8%,transparent)}
.overview-status.bad{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 55%,var(--border));background:color-mix(in srgb,var(--danger) 8%,transparent)}
.overview-status.off{color:var(--muted);border-color:var(--border);background:var(--panel-2)}
.editor-actions{flex-wrap:wrap;justify-content:flex-end}
.overview-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-3);margin:var(--space-5) 0}
.overview-metrics>div{display:grid;gap:var(--space-2);min-width:0;padding:var(--space-4);border:1px solid var(--border);border-radius:var(--radius);background:var(--panel-2)}
.overview-metrics span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.overview-metrics strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.overview-section{padding:var(--space-5);border:1px solid var(--border);border-radius:var(--radius);background:color-mix(in srgb,var(--panel-2) 48%,transparent)}
.overview-section+.overview-section{margin-top:var(--space-5)}
.overview-section-head{align-items:center;padding-bottom:var(--space-4);border-bottom:1px solid var(--border)}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-2) var(--space-5);margin:var(--space-4) 0 0;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.preview-peer+.preview-peer{margin-top:var(--space-4)}
.preview-peer>strong{display:block;font-size:13px;margin:var(--space-4) 0 var(--space-2)}
.preview-sections{display:grid;gap:var(--space-2)}
.preview-section{border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--panel-2)}
.preview-section summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:var(--space-2);padding:10px var(--space-3);font-size:13px;font-weight:600}
.preview-section summary::-webkit-details-marker{display:none}
.preview-section summary .grow{flex:1;text-transform:capitalize}
.count{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--panel-3);color:var(--muted)}
.count.c{color:var(--success)}.count.u{color:var(--accent)}.count.r{color:var(--danger)}
.preview-items{padding:0 var(--space-3) var(--space-3);display:grid;gap:var(--space-2);font-size:12px;color:var(--muted)}
.preview-items b{color:#cbd1d8;font-weight:600}
.timeline{display:grid;padding-top:var(--space-3)}
.timeline-item{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:var(--space-3);padding:var(--space-2) 0}
.timeline-item::before{content:"";position:absolute;left:13px;top:0;bottom:0;width:1px;background:var(--border-strong)}
.timeline-item:first-child::before{top:50%}.timeline-item:last-child::before{bottom:50%}
.timeline-marker{position:relative;z-index:1;width:11px;height:11px;margin:5px 0 0 8px;border:2px solid var(--panel);border-radius:50%;background:var(--accent);box-shadow:0 0 0 1px var(--border-strong)}
.timeline-item.done .timeline-marker{background:var(--success)}.timeline-item.error .timeline-marker{background:var(--danger)}
.timeline-item>div{font-size:13px;padding-top:1px}
.button,.icon-button{border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);background:var(--panel-2);padding:9px 13px;font-weight:600;font-size:13px;line-height:1.2}
.button:hover:not(:disabled),.icon-button:hover:not(:disabled){border-color:var(--border-strong);filter:brightness(1.08)}
.button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}.button.secondary{background:var(--panel-2)}.button.ghost{background:transparent}.button.danger{color:var(--danger)}.button.small{padding:6px 9px;font-size:12px}
.icon-button{width:36px;height:36px;padding:0;display:grid;place-items:center}
.button-with-icon{display:inline-flex;align-items:center;justify-content:center;gap:6px}.button-with-icon .mi{--mi-size:18px}.icon-button .mi{--mi-size:20px}
.status-badge{display:inline-flex;align-items:center;gap:var(--space-2);color:var(--muted);font-size:12px;white-space:nowrap}
.status-badge span{width:8px;height:8px;border-radius:50%;background:var(--warning)}.status-badge.connected span{background:var(--success)}.status-badge.error span{background:var(--danger)}
.notice{margin-bottom:var(--space-4);padding:var(--space-3) var(--space-4);border:1px solid var(--border);background:var(--panel);border-radius:9px;font-size:13px}
.notice.error{border-color:color-mix(in srgb,var(--danger) 55%,var(--border));color:#ffc1c1}.notice.success{border-color:color-mix(in srgb,var(--success) 55%,var(--border));color:#baf5d3}
.notice.warning{border-color:color-mix(in srgb,var(--warning) 55%,var(--border));color:#ffe2b0;display:flex;align-items:center;gap:var(--space-3)}
.notice.warning span.grow{flex:1}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-4)}
.field{display:grid;gap:7px;min-width:0;align-content:start}.field>span{color:#cbd1d8;font-size:12px;font-weight:600}.field small{color:var(--muted);font-size:11px;line-height:1.4}.field.wide,.switch-row.wide{grid-column:1/-1}
input,select,textarea{width:100%;min-width:0;color:var(--text);background:var(--field);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 11px;outline:none}
textarea{min-height:82px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}
.switch-row{display:flex;align-items:center;gap:var(--space-3);min-height:42px;color:#cbd1d8;font-size:13px;cursor:pointer;position:relative}
.switch-row input{position:absolute;opacity:0;width:1px;height:1px}
.switch{width:38px;height:22px;border-radius:999px;background:#373d45;position:relative;transition:.18s;flex:none}
.switch::after{content:"";width:16px;height:16px;background:white;border-radius:50%;position:absolute;left:3px;top:3px;transition:.18s}
.switch-row input:checked+.switch{background:var(--accent)}.switch-row input:checked+.switch::after{transform:translateX(16px);background:var(--accent-text)}
.switch-row input:focus-visible+.switch{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 40%,transparent)}
.switch-row small{display:block;color:var(--muted);font-size:11px}
.settings-group{display:grid;gap:var(--space-3);padding:var(--space-4);border:1px solid var(--border);border-radius:var(--radius);background:var(--field)}
.settings-group h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.sections-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--space-4)}
.danger-zone{border-color:color-mix(in srgb,var(--danger) 40%,var(--border))}
.logs-panel{margin-top:var(--space-4);padding:var(--space-4)}
.logs-head{align-items:center;padding-bottom:var(--space-3);border-bottom:1px solid var(--border)}
.log-actions{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;justify-content:flex-end}
.logs{display:grid;max-height:280px;overflow:auto}
.log-row{display:grid;grid-template-columns:165px 75px minmax(0,1fr);gap:var(--space-3);padding:9px var(--space-1);border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);font-size:12px}
.log-row time,.log-empty{color:var(--muted)}.log-row span:last-child{overflow-wrap:anywhere}
.log-level{text-transform:uppercase;font-size:10px;font-weight:700;color:var(--muted)}.log-level.error{color:var(--danger)}.log-level.warn{color:var(--warning)}.log-level.info{color:var(--success)}
.log-empty{padding:22px var(--space-1);text-align:center}
dialog{width:min(660px,calc(100% - 24px));max-height:calc(100vh - 32px);border:0;padding:0;background:transparent;color:var(--text)}
dialog.wide-dialog{width:min(860px,calc(100% - 24px))}dialog::backdrop{background:rgba(0,0,0,.68);backdrop-filter:blur(4px)}
.dialog-card{max-height:calc(100vh - 32px);overflow:auto;padding:var(--space-5);border:1px solid var(--border-strong);background:var(--panel);border-radius:13px;display:grid;gap:var(--space-4)}
.dialog-head p{margin-top:var(--space-1)}.dialog-actions .spacer{flex:1}
.inline-result{padding:10px 12px;border-radius:var(--radius-sm);background:var(--panel-2);color:var(--muted);font-size:12px}.inline-result.error{color:#ffc1c1}.inline-result.success{color:#baf5d3}
.tabs{display:inline-flex;gap:var(--space-1);padding:var(--space-1);border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--field);justify-self:start}
.tabs button{border:0;background:transparent;color:var(--muted);padding:7px 12px;border-radius:6px;font-weight:600;font-size:13px}.tabs button.active{background:var(--panel-3);color:var(--text)}
.discovered{display:grid;gap:var(--space-2)}
.discovered-row{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--panel-2)}
.discovered-row div{flex:1;min-width:0}.discovered-row strong{display:block;font-size:13px}.discovered-row small{color:var(--muted);font-size:12px}
.token-box{display:flex;align-items:center;gap:var(--space-2);padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--field)}
.token-box code{flex:1;overflow-wrap:anywhere}
.saving-overlay{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:rgba(8,10,13,.48);backdrop-filter:blur(5px)}
.saving-card{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-5);border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--panel);box-shadow:0 18px 60px rgba(0,0,0,.38)}
.loading-spinner{width:24px;height:24px;border:3px solid var(--border-strong);border-top-color:var(--accent);border-radius:50%;animation:spin .75s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.login{width:min(420px,100%);margin:10vh auto 0;padding:var(--space-6);display:grid;gap:var(--space-4)}
.login .brand-lockup h1{font-size:28px}
.preview-layout{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-6);align-items:start;margin-top:var(--space-4)}
.sim{--sim-zoom:.72;display:grid;gap:var(--space-3);justify-items:center;width:calc(480px * var(--sim-zoom))}
.sim-toolbar{display:flex;align-items:center;gap:var(--space-2);width:100%}
.sim-toolbar select{flex:1;min-width:0;padding:7px 9px;font-size:12px}
.sim-toolbar .grow{flex:1}
.sim-toolbar .page-label{color:var(--muted);font-size:12px;min-width:64px;text-align:center;white-space:nowrap}
.sim-toolbar .icon-button{width:32px;height:32px}
.sim-screen{position:relative;width:480px;height:850px;zoom:var(--sim-zoom);border-radius:28px;overflow:hidden;background:#000;border:1px solid var(--border-strong);box-shadow:0 0 0 6px #050607,0 18px 50px rgba(0,0,0,.45);outline:none;--uc-font-family-poppins:Poppins,Inter,ui-sans-serif,system-ui,sans-serif}
.sim-screen:focus-visible{box-shadow:0 0 0 6px #050607,0 0 0 8px color-mix(in srgb,var(--accent) 70%,transparent)}
.sim-error{position:absolute;inset:0;display:grid;place-content:center;gap:12px;padding:40px;text-align:center;color:#d0d0d0;font:18px/1.5 Inter,system-ui,sans-serif}
.sim-error strong{color:#fff;font-size:22px}
.sim-keys{display:flex;gap:var(--space-2);justify-content:center}
.sim-keys .button{padding:7px 12px;font-size:12px}
.uc-remote-ui .uc-remote-ui__icon{font-family:inherit!important}
.uc-remote-ui__icon[data-glyph]{color:inherit;background:currentColor;-webkit-mask:var(--glyph) center/contain no-repeat;mask:var(--glyph) center/contain no-repeat}
.sim-empty{display:grid;place-items:center;text-align:center;width:calc(480px * .72);max-width:100%;min-height:220px;padding:var(--space-5);border:1px dashed var(--border-strong);border-radius:var(--radius);color:var(--muted);font-size:13px}
@media (max-width:480px){.sim{--sim-zoom:.6}.sim-empty{width:100%}}
@media (max-width:1100px){.preview-layout{grid-template-columns:1fr;justify-items:center}.preview-layout>.preview-changes{width:100%}}
@media (max-width:1100px){.overview-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:920px){.layout{grid-template-columns:1fr}.overview-head{flex-direction:column;align-items:stretch}.editor-actions{justify-content:flex-start}.topbar{flex-direction:column;align-items:flex-start}.top-actions{justify-content:flex-start}.role-choices{grid-template-columns:1fr}}
@media (max-width:680px){.logs-head{flex-direction:column;align-items:flex-start}.shell{width:calc(100% - 32px);padding-top:20px}.overview-metrics,.form-grid,.sections-grid{grid-template-columns:1fr}.log-row{grid-template-columns:1fr;gap:3px}.workspace{padding:var(--space-4)}.kv{grid-template-columns:1fr;gap:2px}.kv dd{margin-bottom:var(--space-2)}.log-actions{justify-content:flex-start}}
`;

const BODY = String.raw`
<div class="shell">
  <section id="loginView" class="panel login hidden">
    <div class="brand-lockup"><span class="brand-icon">@@BRAND@@</span><h1>Remote Sync</h1></div>
    <p>Sign in with the Web Configurator PIN of <strong id="loginRemote">this remote</strong>.</p>
    <form id="loginForm" class="form-grid" style="grid-template-columns:1fr">
      <label class="field"><span>Web Configurator PIN</span><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
      <div id="loginError" class="inline-result error hidden"></div>
      <button class="button primary" type="submit">Sign in</button>
    </form>
  </section>

  <div id="appView" class="hidden">
    <header class="topbar">
      <div class="brand-lockup"><span class="brand-icon">@@BRAND@@</span><h1>Remote Sync</h1></div>
      <div class="top-actions">
        <span id="connectionBadge" class="status-badge"><span></span> Checking…</span>
        <button id="syncButton" class="button secondary button-with-icon hidden" type="button"><span class="mi mi-refresh" aria-hidden="true"></span><span>Synchronize</span></button>
        <button id="settingsButton" class="button secondary button-with-icon" type="button"><span class="mi mi-settings" aria-hidden="true"></span><span>Settings</span></button>
        <button id="logoutButton" class="icon-button" type="button" aria-label="Sign out" title="Sign out"><span class="mi mi-arrow_back" aria-hidden="true"></span></button>
      </div>
    </header>

    <div id="notice" class="notice hidden" role="status" aria-live="polite"></div>

    <main id="layout" class="layout">
      <aside id="sidebar" class="sidebar panel hidden">
        <div class="sidebar-head">
          <div><h2>Satellites</h2><p id="satelliteCount">0 paired</p></div>
          <div class="sidebar-head-actions">
            <button id="refreshSatellites" class="icon-button" type="button" aria-label="Refresh satellites" title="Refresh"><span class="mi mi-refresh" aria-hidden="true"></span></button>
            <button id="addSatelliteButton" class="icon-button" type="button" aria-label="Add satellite" title="Add satellite"><span class="mi mi-add" aria-hidden="true"></span></button>
          </div>
        </div>
        <div id="satelliteList" class="item-list"></div>
      </aside>
      <section id="workspace" class="workspace panel"></section>
    </main>

    <section class="panel logs-panel">
      <div class="logs-head">
        <div><h2>Log</h2></div>
        <div class="log-actions">
          <label class="switch-row"><input id="continuousLogs" type="checkbox" checked><span class="switch"></span><span>Continuous refresh</span></label>
          <button id="refreshLogs" class="button secondary button-with-icon" type="button"><span class="mi mi-refresh" aria-hidden="true"></span><span>Refresh</span></button>
          <button id="clearLogView" class="button ghost button-with-icon" type="button"><span class="mi mi-delete" aria-hidden="true"></span><span>Clear view</span></button>
        </div>
      </div>
      <div id="logs" class="logs"><div class="log-empty">No log entries yet.</div></div>
    </section>
  </div>
</div>

<dialog id="settingsDialog" class="wide-dialog">
  <form id="settingsForm" class="dialog-card" method="dialog">
    <div class="dialog-head">
      <div><h2>Settings</h2><p id="settingsSubtitle">Remote Sync configuration</p></div>
      <button class="icon-button" value="cancel" aria-label="Close"><span class="mi mi-close" aria-hidden="true"></span></button>
    </div>
    <div id="settingsBody" class="form-grid" style="grid-template-columns:1fr"></div>
    <div id="settingsResult" class="inline-result hidden"></div>
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button class="button ghost" value="cancel">Cancel</button>
      <button id="saveSettings" class="button primary button-with-icon" type="button"><span class="mi mi-check" aria-hidden="true"></span><span>Save settings</span></button>
    </div>
  </form>
</dialog>

<dialog id="addDialog" class="wide-dialog">
  <div class="dialog-card">
    <div class="dialog-head">
      <div><h2>Add a satellite</h2><p>Remote Sync is installed or updated, set up and paired automatically.</p></div>
      <button id="closeAdd" class="icon-button" type="button" aria-label="Close"><span class="mi mi-close" aria-hidden="true"></span></button>
    </div>
    <div class="tabs" role="tablist">
      <button id="tabPin" class="active" type="button">Address &amp; PIN</button>
      <button id="tabToken" type="button">Pairing token</button>
    </div>
    <div id="discovered" class="discovered"></div>
    <form id="pinForm" class="form-grid">
      <label class="field"><span>Satellite address</span><input name="address" type="text" placeholder="192.168.1.42" required></label>
      <label class="field"><span>Web Configurator PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>
      <label class="field"><span>Name</span><input name="name" type="text" placeholder="Optional — taken from the remote"></label>
      <label class="switch-row"><input name="install" type="checkbox" checked><span class="switch"></span><span>Install or update Remote Sync<small>Uses this Primary's version</small></span></label>
    </form>
    <form id="tokenForm" class="form-grid hidden">
      <label class="field"><span>Satellite agent address</span><input name="address" type="text" placeholder="192.168.1.42" required></label>
      <label class="field"><span>Agent port</span><input name="port" type="number" min="1" max="65535" placeholder="11081"></label>
      <label class="field"><span>Pairing token</span><input name="token" type="password" autocomplete="off" required></label>
      <label class="field"><span>Name</span><input name="name" type="text" placeholder="Optional"></label>
      <p class="field wide" style="font-size:12px">For Satellites on Remote Sync 0.8 or older, which show a pairing token instead of supporting PIN pairing.</p>
    </form>
    <div id="addProgress" class="timeline hidden"></div>
    <div id="addResult" class="inline-result hidden"></div>
    <div class="dialog-actions">
      <button id="discoverButton" class="button ghost button-with-icon" type="button"><span class="mi mi-search" aria-hidden="true"></span><span>Search network</span></button>
      <span class="spacer"></span>
      <button id="cancelAdd" class="button ghost" type="button">Cancel</button>
      <button id="submitAdd" class="button primary button-with-icon" type="button"><span class="mi mi-add" aria-hidden="true"></span><span>Add satellite</span></button>
    </div>
  </div>
</dialog>

<dialog id="messageDialog">
  <form method="dialog" class="dialog-card">
    <div class="dialog-head">
      <div><h2 id="messageTitle">Confirm</h2><p id="messageText"></p></div>
      <button class="icon-button" value="cancel" aria-label="Close"><span class="mi mi-close" aria-hidden="true"></span></button>
    </div>
    <div class="dialog-actions">
      <span class="spacer"></span>
      <button class="button ghost" value="cancel">Cancel</button>
      <button id="messageConfirm" class="button primary" value="confirm">OK</button>
    </div>
  </form>
</dialog>

<div id="savingOverlay" class="saving-overlay hidden" role="status" aria-live="polite" aria-busy="true">
  <div class="saving-card"><span class="loading-spinner"></span><strong id="savingText">Saving…</strong></div>
</div>
`;

const SCRIPT = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name) => '<span class="mi mi-' + name + '" aria-hidden="true"></span>';
  const SECTION_LABELS = { resources: "Resources (icons, images)", entities: "Entities", activities: "Activities", activity_groups: "Activity groups", macros: "Macros", remotes: "Remote entities", profiles: "Profiles and pages", docks: "Docks (tunnelled)" };
  const state = { session: null, status: null, satellites: [], preview: null, settings: null, logs: [], logSeq: 0, selected: "primary", busy: new Set(), addMode: "pin" };
  let noticeTimer = null;

  // ---------------------------------------------------------------- helpers
  async function call(path, { method = "GET", body } = {}) {
    const response = await fetch("/ui/api" + path, {
      method, credentials: "same-origin",
      headers: Object.assign({ "X-Remote-Sync-UI": "1" }, body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401 && path !== "/login") { showLogin(); throw new Error("Sign in required"); }
    if (!response.ok && !(data && data.success === false)) throw new Error((data && data.error) || ("HTTP " + response.status));
    return data;
  }
  function notice(message, kind = "success") {
    const el = $("notice"); el.className = "notice " + kind; el.textContent = message;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => el.classList.add("hidden"), 5000);
  }
  function overlay(text) { if (text) { $("savingText").textContent = text; $("savingOverlay").classList.remove("hidden"); } else $("savingOverlay").classList.add("hidden"); }
  function confirmDialog(title, text, label = "OK", danger = false) {
    return new Promise((resolve) => {
      $("messageTitle").textContent = title; $("messageText").textContent = text;
      const button = $("messageConfirm"); button.textContent = label; button.className = "button " + (danger ? "danger secondary" : "primary");
      const dialog = $("messageDialog");
      dialog.onclose = () => resolve(dialog.returnValue === "confirm");
      dialog.returnValue = ""; dialog.showModal();
    });
  }
  function when(value) {
    if (!value) return "Never";
    const date = new Date(value); if (isNaN(date)) return esc(value);
    const seconds = Math.round((Date.now() - date) / 1000);
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.round(seconds / 3600) + " h ago";
    return date.toLocaleString();
  }
  function tone(text) {
    const value = String(text || "").toLowerCase();
    if (/error|unreachable|degraded|invalid|fail|offline/.test(value)) return "bad";
    if (/building|applying|starting|pending|ready to pair|choose|updat|disabled/.test(value)) return "warn";
    return "ok";
  }
  function cmpVersion(a, b) {
    const pa = String(a || "").split(/[.+-]/).map((n) => parseInt(n, 10) || 0), pb = String(b || "").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
    return 0;
  }
  const role = () => (state.session && state.session.role) || "unassigned";
  const metric = (label, value) => "<div><span>" + label + "</span><strong>" + value + "</strong></div>";
  const button = (cls, iconName, label, attrs) => '<button class="button ' + cls + ' button-with-icon" type="button" ' + attrs + ">" + icon(iconName) + "<span>" + label + "</span></button>";

  // ---------------------------------------------------------------- login
  function showLogin() {
    $("appView").classList.add("hidden"); $("loginView").classList.remove("hidden"); $("pin").focus();
  }
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault(); $("loginError").classList.add("hidden");
    try { await call("/login", { method: "POST", body: { pin: $("pin").value } }); $("pin").value = ""; await start(); }
    catch (error) { $("loginError").textContent = error.message; $("loginError").classList.remove("hidden"); }
  });
  $("logoutButton").addEventListener("click", async () => { try { await call("/logout", { method: "POST" }); } catch {} showLogin(); });

  // ---------------------------------------------------------------- header
  function renderHeader() {
    const s = state.status; if (!s) return;
    const badge = $("connectionBadge");
    const r = role();
    const roleLabel = r === "primary" ? "Primary" : r === "satellite" ? "Satellite" : "Role not chosen";
    badge.className = "status-badge " + (tone(s.status.state) === "ok" ? "connected" : tone(s.status.state) === "bad" ? "error" : "");
    badge.innerHTML = "<span></span> " + esc(roleLabel + " · " + ((s.config && s.config.node_name) || "") + " · " + s.status.state);
    $("syncButton").classList.toggle("hidden", r !== "primary");
  }

  // ---------------------------------------------------------------- sidebar
  function renderSidebar() {
    const primary = role() === "primary";
    $("sidebar").classList.toggle("hidden", !primary);
    $("layout").classList.toggle("single", !primary);
    if (!primary) return;
    const s = state.status;
    const list = state.satellites.length ? state.satellites : (s.satellites || []);
    $("satelliteCount").textContent = list.length + " paired · " + list.filter((x) => x.online).length + " online";
    const item = (id, dot, title, sub) => '<button class="list-item' + (state.selected === id ? " active" : "") + '" type="button" data-select="' + esc(id) + '"><span class="item-top"><span class="dot ' + dot + '"></span><strong>' + esc(title) + "</strong></span><small>" + sub + '</small><span class="mi mi-arrow_forward chevron" aria-hidden="true"></span></button>';
    let html = item("primary", tone(s.status.state), (s.config && s.config.node_name) || "This remote", "Primary · " + esc(s.status.last_sync_result || "Never synchronized"));
    html += '<div class="list-divider"></div>';
    if (!list.length) html += '<div class="list-empty">No satellites yet.<br><br>' + button("primary small", "add", "Add satellite", 'data-open="add"') + "</div>";
    for (const sat of list) {
      const statusText = sat.updating ? "Updating" : sat.online ? (sat.enabled ? "Online" : "Disabled") : (sat.enabled ? "Offline" : "Disabled");
      html += item(sat.peer_id, sat.updating ? "warn" : !sat.enabled ? "" : sat.online ? "ok" : "bad", sat.name, esc(statusText) + (sat.version ? " · v" + esc(sat.version) : "") + " · " + when(sat.last_sync_at));
    }
    $("satelliteList").innerHTML = html;
  }

  // ---------------------------------------------------------------- workspace
  function wakeNotice() {
    if (!state.status || state.status.wake_on_wlan !== false) return "";
    return '<div class="notice warning"><span class="grow"><b>Wake on WLAN is off.</b> Remote Sync cannot reach this remote while it sleeps.</span>' + button("secondary small", "check", "Enable", 'data-act="wake"') + "</div>";
  }

  function roleChooser() {
    return '<div class="empty-state"><span class="empty-icon">' + BRAND + "</span><h2>Choose this remote's role</h2>" +
      "<p>Setup is complete. Decide whether this remote is the Primary that shares its configuration, or a Satellite that receives it. You can change this later in Settings.</p>" +
      '<div class="role-choices">' +
      '<button class="role-choice" type="button" data-role="primary"><strong>' + icon("devices") + "Primary</strong><span>Shares activities, profiles, pages and entities with Satellites. Add Satellites by IP address and PIN.</span></button>" +
      '<button class="role-choice" type="button" data-role="satellite"><strong>' + icon("download") + "Satellite</strong><span>Receives the Primary's configuration. Adding it on the Primary by IP address and PIN also sets this role automatically.</span></button>" +
      "</div></div>";
  }

  function previewBlock(peers, generated = false) {
    if (!peers || !peers.length) {
      return '<p style="margin-top:var(--space-4)">' + (generated
        ? "No satellites are paired yet, so there is nothing to compare. The remote screen shows the configuration satellites will receive."
        : "No preview yet. Run a preview to see what would change.") + "</p>";
    }
    return peers.map((peer) => {
      if (!peer.success) return '<div class="preview-peer"><strong>' + esc(peer.name) + '</strong><div class="inline-result error">' + esc(peer.error || "Preview failed") + "</div></div>";
      const sections = Object.entries(peer.sections || {}).map(([name, sec]) => {
        const items = sec.items || {};
        const list = (key, label) => items[key] && items[key].length ? "<div><b>" + label + ":</b> " + items[key].map(esc).join(", ") + "</div>" : "";
        const counts = sec.create_or_update !== undefined
          ? '<span class="count u">' + sec.create_or_update + " files</span>"
          : '<span class="count c">+' + (sec.create || 0) + '</span><span class="count u">~' + (sec.update || 0) + '</span><span class="count r">−' + (sec.remove || 0) + "</span>";
        const body = list("create", "New") + list("remove", "Removed") + list("update", "Updated");
        return '<details class="preview-section"><summary><span class="grow">' + esc(name.replaceAll("_", " ")) + "</span>" + counts + "</summary>" + (body ? '<div class="preview-items">' + body + "</div>" : "") + "</details>";
      }).join("");
      return '<div class="preview-peer"><strong>' + esc(peer.name) + " — " + esc(peer.summary || "") + '</strong><div class="preview-sections">' + sections + "</div></div>";
    }).join("");
  }

  function primaryOverview() {
    const s = state.status; const st = s.status; const sats = s.satellites || [];
    const online = sats.filter((x) => x.online).length;
    const p = state.preview;
    return wakeNotice() +
      '<div class="overview-head"><div><div class="overview-title-row"><h2>' + esc(s.config.node_name) + '</h2><span class="overview-status ' + tone(st.state) + '">' + esc(st.state) + "</span></div>" +
      "<p>Primary · Remote Sync " + esc(s.version) + (s.remote && s.remote.api ? " · Remote API " + esc(s.remote.api) : "") + "</p></div>" +
      '<div class="editor-actions">' + button("ghost", "visibility", "Preview", 'data-act="preview"') + button("secondary", "add", "Add satellite", 'data-open="add"') + button("primary", "refresh", "Synchronize now", 'data-act="sync"') + "</div></div>" +
      '<div class="overview-metrics">' + metric("Satellites online", online + " of " + sats.length) + metric("Last synchronization", when(st.last_sync_at)) +
      metric("Pending changes", st.pending_changes ? "Yes" : "No") + metric("Successful / failed", esc(st.successful_syncs) + " / " + esc(st.failed_syncs)) + "</div>" +
      '<section class="overview-section"><div class="overview-section-head"><h3>Synchronization</h3></div><dl class="kv">' +
      "<dt>Last result</dt><dd>" + esc(st.last_sync_result || "Never synchronized") + "</dd>" +
      "<dt>Sections</dt><dd>" + esc(((s.config.sync && s.config.sync.sections) || []).map((x) => SECTION_LABELS[x] || x).join(", ")) + "</dd>" +
      "<dt>Automatic</dt><dd>" + (s.config.sync && s.config.sync.auto_sync ? "On change and every " + Math.round(s.config.sync.interval_seconds / 60) + " min" : "Off") + "</dd>" +
      "<dt>Agent</dt><dd class=\"mono\">" + esc(s.agent_url || "") + "</dd>" +
      "<dt>Wake on WLAN</dt><dd>" + (s.wake_on_wlan === true ? "On" : s.wake_on_wlan === false ? "Off" : "Unknown") + "</dd></dl></section>" +
      '<section class="overview-section"><div class="overview-section-head"><h3>Preview</h3><span class="status-badge">' + (p ? "Generated " + when(p.generated_at) : "") + "</span></div>" +
      '<div class="preview-layout"><div id="simSlot"></div><div class="preview-changes">' + previewBlock(p && p.peers, Boolean(p)) + "</div></div></section>";
  }

  function satelliteDetail(sat) {
    const s = state.status;
    const statusText = sat.updating ? "Updating" : sat.online ? (sat.enabled ? "Online" : "Online, disabled") : (sat.enabled ? "Offline" : "Disabled");
    const outdated = sat.version && sat.version !== "legacy" && cmpVersion(sat.version, s.version) < 0;
    const id = esc(encodeURIComponent(sat.peer_id));
    const busy = state.busy.has(sat.peer_id) ? " disabled" : "";
    const act = (cls, iconName, label, action) => button(cls, iconName, label, 'data-sat="' + id + '" data-action="' + action + '"' + busy);
    const p = state.preview && state.preview.peers ? state.preview.peers.filter((x) => x.peer_id === sat.peer_id) : [];
    return '<div class="overview-head"><div><div class="overview-title-row"><h2>' + esc(sat.name) + '</h2><span class="overview-status ' + (statusText === "Online" ? "ok" : statusText === "Updating" ? "warn" : statusText.startsWith("Offline") ? "bad" : "off") + '">' + esc(statusText) + "</span>" +
      (outdated ? '<span class="overview-status warn">Update available</span>' : "") + "</div>" +
      "<p>Satellite · " + esc(sat.identifier || "") + (sat.managed ? " · managed by this Primary" : " · paired with a token") + "</p></div>" +
      '<div class="editor-actions">' + act("ghost danger", "delete", "Remove", "remove") + act("ghost", "close", "Unpair", "unpair") + act("ghost", "compare_arrows", "Rotate credentials", "rotate") +
      act("ghost", "search", "Rediscover", "rediscover") + act("ghost", sat.enabled ? "close" : "play_arrow", sat.enabled ? "Disable" : "Enable", sat.enabled ? "disable" : "enable") +
      (sat.managed ? act("secondary", "download", "Update", "update") : "") + act("secondary", "visibility", "Preview", "preview") + act("primary", "refresh", "Synchronize", "sync") + "</div></div>" +
      '<div class="overview-metrics">' + metric("Version", sat.version ? "v" + esc(sat.version) : "Unknown") + metric("Last synchronization", when(sat.last_sync_at)) +
      metric("Mirrored entities", esc(sat.mirrored_entities || 0)) + metric("Dock tunnels", esc(sat.dock_tunnels || 0)) + "</div>" +
      '<section class="overview-section"><div class="overview-section-head"><h3>Status</h3></div><dl class="kv">' +
      "<dt>Last result</dt><dd>" + esc(sat.last_sync_result || "—") + "</dd>" +
      "<dt>Agent</dt><dd class=\"mono\">" + esc(sat.url || "Discovering…") + "</dd>" +
      "<dt>Network</dt><dd class=\"mono\">" + esc((sat.mac || "MAC unknown") + " · " + ((sat.broadcasts || []).join(", ") || "broadcast unknown")) + "</dd>" +
      (sat.last_update_result ? "<dt>Update</dt><dd>" + esc(sat.last_update_result) + "</dd>" : "") +
      (sat.last_error ? '<dt>Last error</dt><dd style="color:var(--danger)">' + esc(sat.last_error) + "</dd>" : "") +
      (sat.next_retry_at ? "<dt>Next retry</dt><dd>" + esc(new Date(sat.next_retry_at).toLocaleTimeString()) + "</dd>" : "") + "</dl></section>" +
      '<section class="overview-section"><div class="overview-section-head"><h3>Preview</h3></div>' +
      '<div class="preview-layout"><div id="simSlot"></div><div class="preview-changes">' + previewBlock(p, Boolean(state.preview)) + "</div></div></section>";
  }

  function satelliteRoleView() {
    const s = state.status; const pairing = s.config.pairing || {};
    const paired = Boolean(pairing.paired_master_id);
    return wakeNotice() +
      '<div class="overview-head"><div><div class="overview-title-row"><h2>' + esc(s.config.node_name) + '</h2><span class="overview-status ' + (paired ? "ok" : "warn") + '">' + (paired ? "Paired" : "Ready to pair") + "</span></div>" +
      "<p>Satellite · Remote Sync " + esc(s.version) + " · " + esc(s.config.pairing_identifier || "") + "</p></div></div>" +
      '<div class="overview-metrics">' + metric("Primary", esc(pairing.paired_master_name || "Not paired")) + metric("Paired", when(pairing.paired_at)) +
      metric("Mirrored entities", esc(s.proxy_count || 0)) + metric("Last apply", when(s.status.last_sync_at)) + "</div>" +
      (paired
        ? '<section class="overview-section"><div class="overview-section-head"><h3>Synchronization</h3></div><dl class="kv"><dt>Last result</dt><dd>' + esc(s.status.last_sync_result || "—") + "</dd><dt>Agent</dt><dd class=\"mono\">" + esc(s.agent_url || "") + "</dd></dl></section>"
        : '<section class="overview-section"><div class="overview-section-head"><h3>Pair with the Primary</h3></div>' +
          '<p style="margin-top:var(--space-4)">On the Primary\'s dashboard choose <b>Add satellite</b> and enter this remote\'s IP address and Web Configurator PIN. Remote Sync on this remote is updated and paired automatically.</p>' +
          '<p style="margin:var(--space-4) 0 var(--space-2)">Pairing token for Primaries on Remote Sync 0.8 or older:</p>' +
          '<div class="token-box"><code id="pairingToken">Shown after sign-in only</code>' + button("ghost small", "content_copy", "Copy", 'data-act="copy-token"') + "</div></section>");
  }

  function renderWorkspace() {
    const r = role();
    let html;
    if (r === "unassigned") html = roleChooser();
    else if (r === "satellite") html = satelliteRoleView();
    else {
      const list = state.satellites.length ? state.satellites : (state.status.satellites || []);
      const sat = list.find((x) => x.peer_id === state.selected);
      if (!sat) state.selected = "primary";
      html = sat ? satelliteDetail(sat) : primaryOverview();
    }
    // Unchanged markup is not re-rendered, so the remote preview keeps its focus and scroll position between polls.
    if (html === state.workspaceHtml && $("workspace").firstChild) return;
    state.workspaceHtml = html;
    $("workspace").innerHTML = html;
    if (r === "satellite" && state.status.pairing_token) $("pairingToken") && ($("pairingToken").textContent = state.status.pairing_token);
    placeSimulator();
  }

  function renderLogs() {
    const box = $("logs");
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    const lines = state.logs.filter((line) => line.level !== "debug").slice(-300);
    box.innerHTML = lines.length ? lines.map((line) => '<div class="log-row"><time>' + esc(new Date(line.time).toLocaleString()) + '</time><span class="log-level ' + line.level + '">' + esc(line.level) + "</span><span>" + esc(line.namespace.replace("remote-sync:", "")) + " — " + esc(line.message) + "</span></div>").join("") : '<div class="log-empty">No log entries yet.</div>';
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function render() {
    if (!state.status) return;
    renderHeader(); renderSidebar(); renderWorkspace();
  }


  // ---------------------------------------------------------------- remote UI preview
  // Renders the Primary's latest snapshot with the Remote UI browser runtime. The model is read-only: commands are
  // never sent anywhere.
  const sim = { el: null, root: null, runtime: null, data: null, state: null, profileId: "", loadedAt: null };
  const simName = (value, fallback = "Unnamed") => {
    if (value && typeof value === "object" && !Array.isArray(value)) return String(value.en || value.en_US || value.de || Object.values(value)[0] || fallback);
    return String(value || fallback);
  };
  const simId = (value) => String(value?.entity_id || value?.id || value?.group_id || value?.profile_id || "");
  const simList = (value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.entities) ? value.entities : [];
  function simResource(kind, value) {
    const text = String(value || "");
    if (!text) return "";
    if (text.startsWith("custom:")) return "/ui/api/resource/" + encodeURIComponent(kind) + "/" + encodeURIComponent(text.slice(7));
    const api = text.match(/^\/api\/resources\/([^/]+)\/(.+)$/);
    if (api) return "/ui/api/resource/" + api[1] + "/" + api[2];
    if (/^https?:\/\//i.test(text) || text.startsWith("data:")) return text;
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(text)) return "/ui/api/resource/" + encodeURIComponent(kind) + "/" + encodeURIComponent(text);
    return "";
  }
  function simEntity(reference) {
    const id = String(reference?.entity_id || reference?.target_id || (reference?.type !== "group" ? reference?.id : "") || (typeof reference === "string" ? reference : ""));
    return id ? sim.state.entities.get(id) || null : null;
  }
  function simScreenItems(screen) {
    if (!screen) return [];
    const result = [];
    for (const reference of simList(screen.page?.items ?? screen.page?.elements)) {
      const groupId = String(reference?.group_id || (reference?.type === "group" ? reference?.target_id || reference?.id : "") || "");
      if (groupId) {
        const group = sim.state.groups.get(groupId) || { group_id: groupId, name: groupId, entities: [] };
        result.push({ kind: "group", id: groupId, data: { ...group, entity_type: "group" } });
        if (sim.state.expandedGroups.has(groupId)) {
          for (const member of simList(group.entities)) { const entity = simEntity(member); if (entity) result.push({ kind: "entity", id: simId(entity), data: entity, nested: true }); }
        }
        continue;
      }
      const entity = simEntity(reference);
      if (entity) result.push({ kind: entity.entity_type === "activity" ? "activity" : "entity", id: simId(entity), data: entity });
    }
    return result;
  }
  function simEntityScreens(entity) {
    if (!entity) return [];
    const id = simId(entity);
    const ui = entity.options?.user_interface || entity.user_interface || {};
    const pages = Array.isArray(ui.pages) ? ui.pages : [];
    if (pages.length) return pages.map((page, index) => ({ kind: "entity-page", owner: id, id: String(page.page_id || page.id || id + "-" + index), title: simName(page.name, simName(entity.name, id)), image: page.image || ui.image, page }));
    const included = simList(entity.options?.included_entities || entity.included_entities || entity.entities);
    return included.length ? [{ kind: "entity-page", owner: id, id: id + "-included", title: simName(entity.name, id), image: ui.image, page: { items: included } }] : [];
  }
  function simBuild(profileId) {
    const data = sim.data;
    const entities = new Map();
    for (const entity of [...data.entities, ...data.activities, ...data.macros, ...data.remotes]) {
      const id = simId(entity); if (!id) continue;
      const attributes = { ...(entity.attributes || {}) };
      if (entity.entity_type === "activity" && !attributes.state) attributes.state = "OFF";
      entities.set(id, { ...entity, entity_id: id, attributes });
    }
    // Activity and remote screens list their included entities; resolve the references to full entities so names,
    // icons and states show instead of identifiers.
    for (const entity of entities.values()) {
      const options = entity.options;
      if (!options || !Array.isArray(options.included_entities)) continue;
      entity.options = { ...options, included_entities: options.included_entities.map((reference) => entities.get(String(reference?.entity_id || reference?.id || reference)) || reference) };
    }
    const profile = data.profiles.find((item) => item.profile_id === profileId) || data.profiles[0] || null;
    const groups = new Map((profile?.groups || []).map((group) => [simId(group), { ...group, group_id: simId(group), entity_type: "group" }]));
    const pages = [...(profile?.pages || [])].sort((a, b) => Number(a.pos ?? a.sort_order ?? 0) - Number(b.pos ?? b.sort_order ?? 0));
    sim.profileId = profile?.profile_id || "";
    sim.state = {
      settings: { enable_activity_bar: true, battery_level: 100, charging: false },
      profile, profiles: data.profiles,
      screens: pages.map((page) => ({ kind: "profile-page", id: String(page.page_id || page.id), title: simName(page.name, "Page"), image: page.image, page })),
      screenIndex: 0, selectedIndex: 0, entities, groups, expandedGroups: new Set(), activities: data.activities, activeActivity: null,
      activityOverlayOpen: false, overlayEntity: null, activityOverlayIndex: 0, activityOverlayClosing: false,
      entityControlOpen: false, controlEntity: null, entityControlClosing: false
    };
  }
  const simModel = () => ({
    state: sim.state, sessionBase: "",
    screenItems: simScreenItems, entityScreens: simEntityScreens,
    groupMembers: (group) => simList(group?.entities).map(simEntity).filter(Boolean),
    nameOf: simName, idOf: simId, resourceUrl: simResource,
    backgroundUrl: (screen) => simResource("BackgroundImage", screen?.image) || "/ui/remote-ui/background.svg"
  });
  function ensureRuntime() {
    if (sim.runtime) return true;
    if (!window.RemoteUIWeb) return false;
    sim.runtime = window.RemoteUIWeb.create({ root: sim.root, actions: simActions });
    return true;
  }
  function simError(error) {
    console.error("Remote screen preview failed:", error);
    if (!sim.el) return;
    sim.el.querySelector(".page-label").textContent = "Preview error";
    sim.root.innerHTML = '<div class="sim-error"><strong>The remote screen could not be shown.</strong><span>' + esc(error && error.message || error) + "</span></div>";
  }
  function simRender() {
    if (!sim.state || !sim.el) return;
    try {
      if (!ensureRuntime()) {
        sim.el.querySelector(".page-label").textContent = "Loading…";
        clearTimeout(sim.retryTimer);
        sim.retryTimer = setTimeout(() => window.RemoteUIWeb ? simRender() : simError(new Error("The screen renderer did not load. Reload the page.")), 1500);
        return;
      }
      sim.runtime.update(simModel());
      const total = sim.state.screens.length;
      sim.el.querySelector(".page-label").textContent = total ? "Page " + (sim.state.screenIndex + 1) + " / " + total : "No pages";
    } catch (error) { simError(error); }
  }
  const simActions = {
    setScreen(index) { const s = sim.state; s.screenIndex = Math.max(0, Math.min(index, s.screens.length - 1)); s.selectedIndex = 0; simRender(); },
    navigateScreen(delta) { const s = sim.state; if (!s.screens.length) return; s.screenIndex = (s.screenIndex + delta + s.screens.length) % s.screens.length; s.selectedIndex = 0; simRender(); },
    moveSelection(delta) { const s = sim.state; const items = simScreenItems(s.screens[s.screenIndex]); if (!items.length) return; s.selectedIndex = (s.selectedIndex + delta + items.length) % items.length; simRender(); },
    activateItem(index) {
      const s = sim.state; const item = simScreenItems(s.screens[s.screenIndex])[index]; if (!item) return;
      s.selectedIndex = index;
      if (item.kind === "group") { s.expandedGroups.has(item.id) ? s.expandedGroups.delete(item.id) : s.expandedGroups.add(item.id); }
      else if (["activity", "remote"].includes(item.data.entity_type)) { s.activityOverlayOpen = true; s.overlayEntity = item.data; s.activityOverlayIndex = 0; }
      else { s.entityControlOpen = true; s.controlEntity = item.data; }
      simRender();
    },
    openEntityById(id) { const entity = sim.state.entities.get(String(id)); if (!entity) return; if (["activity", "remote"].includes(entity.entity_type)) { sim.state.activityOverlayOpen = true; sim.state.overlayEntity = entity; sim.state.activityOverlayIndex = 0; } else { sim.state.entityControlOpen = true; sim.state.controlEntity = entity; } simRender(); },
    closeDetail() { Object.assign(sim.state, { activityOverlayOpen: false, overlayEntity: null, entityControlOpen: false, controlEntity: null }); simRender(); },
    toggleGroup(id) { const set = sim.state.expandedGroups; set.has(id) ? set.delete(id) : set.add(id); simRender(); },
    setActivityPage(index) { sim.state.activityOverlayIndex = Math.max(0, index); simRender(); },
    navigateActivityPage(delta) { const pages = simEntityScreens(sim.state.overlayEntity); if (!pages.length) return; sim.state.activityOverlayIndex = (sim.state.activityOverlayIndex + delta + pages.length) % pages.length; simRender(); },
    goHome() { simActions.closeDetail(); simActions.setScreen(0); },
    switchProfile(id) { simBuild(String(id)); simRender(); },
    command() { return null; }, activityPower() { return null; }, toggleGroupPower() { return null; }, setGroupPower() { return null; },
    patchSettings() { return null; }, request() { return null; }, refresh() { return null; }
  };
  function ensureSimulator() {
    if (sim.el) return sim.el;
    const el = document.createElement("div");
    el.className = "sim";
    el.innerHTML = '<div class="sim-toolbar"><span class="grow"></span><button class="icon-button" type="button" data-sim="prev" aria-label="Previous page">' + icon("arrow_back") + '</button><span class="page-label">Loading…</span><button class="icon-button" type="button" data-sim="next" aria-label="Next page">' + icon("arrow_forward") + "</button></div>" +
      '<div class="sim-screen" tabindex="0" aria-label="Remote screen preview — arrow keys navigate, Enter opens, Escape goes back"><div class="uc-remote-ui"></div></div>' +
      '<div class="sim-keys"><button class="button secondary" type="button" data-sim="BACK">Back</button><button class="button secondary" type="button" data-sim="HOME">Home</button></div>';
    sim.el = el;
    sim.root = el.querySelector(".uc-remote-ui");
    // The runtime writes icon-font code points; draw them as outline icons instead.
    const glyphs = () => {
      for (const node of sim.root.querySelectorAll(".uc-remote-ui__icon:not([data-glyph])")) {
        const name = GLYPH_NAMES[node.textContent] || "circle";
        node.dataset.glyph = name; node.textContent = "";
      }
    };
    new MutationObserver(glyphs).observe(sim.root, { childList: true, subtree: true });
    el.addEventListener("click", (event) => {
      const button = event.target.closest("[data-sim]"); if (!button) return;
      const key = button.dataset.sim;
      if (key === "prev") simActions.navigateScreen(-1);
      else if (key === "next") simActions.navigateScreen(1);
      else sim.runtime?.handleHardware(key, "short");
    });
    el.querySelector(".sim-screen").addEventListener("keydown", (event) => {
      const map = { ArrowLeft: "DPAD_LEFT", ArrowRight: "DPAD_RIGHT", ArrowUp: "DPAD_UP", ArrowDown: "DPAD_DOWN", Enter: "DPAD_MIDDLE", Escape: "BACK", Home: "HOME" };
      if (!map[event.key] || !sim.runtime) return;
      event.preventDefault(); sim.runtime.handleHardware(map[event.key], "short");
    });
    return el;
  }
  function placeSimulator() {
    const slot = $("simSlot"); if (!slot) return;
    if (!sim.data || !sim.data.available) {
      slot.outerHTML = '<div class="sim-empty">' + (sim.data ? "Run a preview to see the remote screen as satellites will show it." : "Loading preview…") + "</div>";
      return;
    }
    if (!sim.data.profiles.length) {
      slot.outerHTML = '<div class="sim-empty">Enable “Profiles and pages” in Settings to preview the remote screen.</div>';
      return;
    }
    slot.replaceWith(ensureSimulator());
    if (!sim.runtime) simRender();
  }
  async function loadSimulator() {
    if (role() !== "primary") return;
    let data;
    try { data = await call("/simulator"); }
    catch (error) { console.error("Loading the preview data failed:", error); return; }
    if (data.available && sim.data && sim.data.generated_at === data.generated_at && sim.runtime) return;
    sim.data = data;
    if (data.available && data.profiles.length) {
      ensureSimulator();
      try {
        const keep = data.profiles.some((profile) => profile.profile_id === sim.profileId) ? sim.profileId : data.active_profile_id;
        simBuild(keep || data.profiles[0].profile_id);
        simRender();
      } catch (error) { simError(error); }
    }
    state.workspaceHtml = null;
    renderWorkspace();
  }

  // ---------------------------------------------------------------- actions
  async function run(label, fn, key) {
    if (key) { state.busy.add(key); render(); }
    try {
      const result = await fn();
      if (result && result.success === false) notice(label + " failed: " + (result.error || "unknown error"), "error");
      else if (result && result.warning) notice(label + " finished with a warning: " + result.warning, "warning");
      else if (result && result.purge && result.purge.success) notice(label + " finished — " + result.purge.removed + " synchronized object(s) deleted from the satellite");
      else notice(label + " finished");
      return result;
    } catch (error) { notice(label + " failed: " + error.message, "error"); }
    finally { if (key) state.busy.delete(key); await refresh(); }
  }

  async function waitForRestart(text) {
    overlay(text);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    for (let i = 0; i < 20; i++) {
      try { const session = await fetch("/ui/api/session", { credentials: "same-origin" }).then((r) => r.json()); state.session = session; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    overlay(null);
    await refresh(); await refreshDetails();
  }

  document.addEventListener("click", async (event) => {
    const select = event.target.closest("[data-select]");
    if (select) { state.selected = select.dataset.select; render(); return; }
    const open = event.target.closest("[data-open]");
    if (open && open.dataset.open === "add") { openAdd(); return; }
    const choice = event.target.closest("[data-role]");
    if (choice) {
      const target = choice.dataset.role;
      const ok = await confirmDialog(target === "primary" ? "Make this remote the Primary?" : "Make this remote a Satellite?",
        target === "primary" ? "This remote will share its configuration with the Satellites you add." : "This remote will receive the configuration of a Primary. Existing activities created by Remote Sync may be replaced during synchronization.",
        target === "primary" ? "Make Primary" : "Make Satellite");
      if (!ok) return;
      try { await call("/role", { method: "POST", body: { role: target } }); await waitForRestart("Applying role…"); notice(target === "primary" ? "This remote is now the Primary" : "This remote is now a Satellite"); }
      catch (error) { notice(error.message, "error"); }
      return;
    }
    const act = event.target.closest("[data-act]");
    if (act) {
      const name = act.dataset.act;
      if (name === "sync") await run("Synchronization", () => call("/sync", { method: "POST", body: {} }));
      if (name === "preview") { await run("Preview", () => call("/sync", { method: "POST", body: { dry_run: true } })); state.preview = await call("/preview").catch(() => state.preview); state.selected = "primary"; render(); await loadSimulator(); }
      if (name === "wake") await run("Enabling Wake on WLAN", () => call("/wake-on-wlan", { method: "POST" }));
      if (name === "copy-token") { try { await navigator.clipboard.writeText($("pairingToken").textContent); notice("Pairing token copied"); } catch { notice("Copy failed — select the token manually", "error"); } }
      if (name === "use-discovered") { $("pinForm").address.value = act.dataset.address; $("pinForm").pin.focus(); }
      return;
    }
    const sat = event.target.closest("[data-sat]");
    if (sat) {
      const action = sat.dataset.action; const peerId = decodeURIComponent(sat.dataset.sat);
      if (action === "remove" || action === "unpair") {
        const ok = await confirmDialog(action === "remove" ? "Remove this satellite?" : "Unpair this satellite?",
          action === "remove" ? "Everything this Primary synchronized to it — profiles and pages, activity groups, activities, macros, Docks, mirrored entities and resources — is deleted from the satellite, then it is unpaired and removed. Its own configuration stays." : "The satellite stops receiving synchronizations until it is paired again. Synchronized configuration stays on it.",
          action === "remove" ? "Remove" : "Unpair", true);
        if (!ok) return;
      }
      if (action === "remove") overlay("Deleting synchronized configuration from the satellite…");
      try { await run(action[0].toUpperCase() + action.slice(1), () => call("/satellites/" + encodeURIComponent(peerId) + "/actions/" + action, { method: "POST" }), peerId); }
      finally { overlay(null); }
      if (action === "preview") { state.preview = await call("/preview").catch(() => state.preview); await loadSimulator(); }
      if (action === "remove") state.selected = "primary";
      await refreshDetails();
    }
  });

  $("syncButton").addEventListener("click", () => run("Synchronization", () => call("/sync", { method: "POST", body: {} })));
  $("refreshSatellites").addEventListener("click", async () => { try { state.satellites = (await call("/satellites?refresh=true")).satellites; render(); notice("Satellite status refreshed"); } catch (error) { notice(error.message, "error"); } });
  $("addSatelliteButton").addEventListener("click", () => openAdd());

  // ---------------------------------------------------------------- add dialog
  function setAddMode(mode) {
    state.addMode = mode;
    $("tabPin").classList.toggle("active", mode === "pin"); $("tabToken").classList.toggle("active", mode === "token");
    $("pinForm").classList.toggle("hidden", mode !== "pin"); $("tokenForm").classList.toggle("hidden", mode !== "token");
    $("discovered").classList.toggle("hidden", mode !== "pin"); $("discoverButton").classList.toggle("hidden", mode !== "pin");
  }
  $("tabPin").addEventListener("click", () => setAddMode("pin"));
  $("tabToken").addEventListener("click", () => setAddMode("token"));
  function openAdd() {
    setAddMode("pin"); $("pinForm").reset(); $("tokenForm").reset();
    $("addResult").classList.add("hidden"); $("addProgress").classList.add("hidden"); $("submitAdd").disabled = false;
    $("addDialog").showModal(); discover();
  }
  const closeAdd = () => $("addDialog").close();
  $("closeAdd").addEventListener("click", closeAdd); $("cancelAdd").addEventListener("click", closeAdd);
  $("discoverButton").addEventListener("click", discover);
  async function discover() {
    $("discovered").innerHTML = '<div class="inline-result">Searching the network for satellites…</div>';
    try {
      const found = (await call("/discover")).satellites;
      $("discovered").innerHTML = found.length ? found.map((x) => '<div class="discovered-row">' + icon("devices") + "<div><strong>" + esc(x.name) + "</strong><small>" + esc((x.address || "") + (x.version ? " · v" + x.version : "")) + "</small></div>" +
        button("secondary small", "arrow_forward", "Use", 'data-act="use-discovered" data-address="' + esc(x.address || "") + '"') + "</div>").join("") : "";
    } catch { $("discovered").innerHTML = ""; }
  }
  function renderProgress(job) {
    const box = $("addProgress"); if (!job) return;
    box.classList.remove("hidden");
    box.innerHTML = (job.steps || []).map((step, index, all) => '<div class="timeline-item ' + (job.state === "error" && index === all.length - 1 ? "error" : index < all.length - 1 || job.state === "done" ? "done" : "") + '"><span class="timeline-marker"></span><div>' + esc(step.message) + "</div></div>").join("");
  }
  $("submitAdd").addEventListener("click", async () => {
    const form = state.addMode === "pin" ? $("pinForm") : $("tokenForm");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const result = $("addResult"); result.className = "inline-result"; result.textContent = state.addMode === "pin" ? "Adding — installing Remote Sync can take a minute…" : "Pairing…"; result.classList.remove("hidden");
    $("submitAdd").disabled = true;
    const address = String(data.get("address") || "").trim().toLowerCase();
    const poll = setInterval(async () => {
      try { const s = await call("/status"); state.status = s; renderProgress((s.provisioning || []).find((job) => job.address === address)); } catch {}
    }, 1000);
    try {
      const response = state.addMode === "pin"
        ? await call("/satellites", { method: "POST", body: { address: data.get("address"), pin: data.get("pin"), name: data.get("name") || null, install: data.get("install") === "on" } })
        : await call("/satellites/token", { method: "POST", body: { address: data.get("address"), port: Number(data.get("port")) || null, token: data.get("token"), name: data.get("name") || null } });
      if (response && response.success) {
        result.className = "inline-result success"; result.textContent = "Added " + response.name + ".";
        state.selected = response.peer_id;
        setTimeout(async () => { closeAdd(); await waitForRestart("Applying configuration…"); }, 900);
      } else { result.className = "inline-result error"; result.textContent = (response && response.error) || "Adding failed"; $("submitAdd").disabled = false; }
    } catch (error) { result.className = "inline-result error"; result.textContent = error.message; $("submitAdd").disabled = false; }
    finally { clearInterval(poll); try { const s = await call("/status"); renderProgress((s.provisioning || []).find((job) => job.address === address)); } catch {} }
  });

  // ---------------------------------------------------------------- settings dialog
  const sw = (name, label, checked, hint) => '<label class="switch-row"><input type="checkbox" name="' + name + '"' + (checked ? " checked" : "") + '><span class="switch"></span><span>' + label + (hint ? "<small>" + hint + "</small>" : "") + "</span></label>";
  const field = (name, label, value, attrs = "", hint = "") => '<label class="field"><span>' + label + '</span><input name="' + name + '" value="' + esc(value) + '" ' + attrs + ">" + (hint ? "<small>" + hint + "</small>" : "") + "</label>";
  async function openSettings() {
    $("settingsResult").classList.add("hidden");
    try { state.settings = await call("/settings"); } catch (error) { notice(error.message, "error"); return; }
    const s = state.settings; const r = s.role; const sync = s.sync || {};
    $("settingsSubtitle").textContent = (r === "primary" ? "Primary" : r === "satellite" ? "Satellite" : "Role not chosen") + " · " + s.remote.host;
    let html = '<div class="settings-group"><h3>General</h3><div class="form-grid">' + field("node_name", "Name", s.node_name, 'type="text" maxlength="64"') +
      field("agent_public_url", "Agent URL override", s.agent_public_url, 'type="text" placeholder="http://192.168.1.10:11081"', "Only for routed or multi-interface networks") + "</div></div>";
    if (r === "primary") {
      html += '<div class="settings-group"><h3>Synchronization</h3><div class="form-grid">' +
        sw("auto_sync", "Automatic synchronization", sync.auto_sync, "After configuration changes and periodically") +
        sw("auto_update_satellites", "Keep satellites up to date", sync.auto_update_satellites, "Satellites added by PIN get this version") +
        sw("prune", "Remove deleted objects on satellites", sync.prune) +
        sw("use_standby_inhibitor", "Keep satellites awake while applying", sync.use_standby_inhibitor) +
        sw("verify_existing_resource_hashes", "Verify existing resource hashes", sync.verify_existing_resource_hashes, "Slower; repairs damaged icons and images") +
        field("interval_seconds", "Periodic check interval (seconds)", sync.interval_seconds, 'type="number" min="300" max="86400" step="60"') + "</div>" +
        '<div class="sections-grid">' + (sync.available_sections || []).map((name) => '<label class="switch-row"><input type="checkbox" name="section" value="' + name + '"' + ((sync.sections || []).includes(name) ? " checked" : "") + '><span class="switch"></span><span>' + esc(SECTION_LABELS[name] || name) + "</span></label>").join("") + "</div></div>" +
        '<div class="settings-group"><h3>Docks</h3><label class="field"><span>Physical Dock API token(s)</span><textarea name="dock_tokens" placeholder="One token for all Docks, or one DOCK_ID=token per line"></textarea><small>' +
        (s.docks.default_token_set || s.docks.dock_ids.length ? "Stored: " + (s.docks.default_token_set ? "default token" : "") + (s.docks.dock_ids.length ? (s.docks.default_token_set ? ", " : "") + esc(s.docks.dock_ids.join(", ")) : "") + ". Leave empty to keep." : "Needed for Dock synchronization.") + "</small></label>" +
        (s.docks.default_token_set || s.docks.dock_ids.length ? sw("clear_dock_tokens", "Remove stored Dock tokens", false) : "") + "</div>";
    }
    html += '<div class="settings-group"><h3>Network</h3><p style="font-size:12px">Detected: ' + esc([s.network.interface, s.network.mac, (s.network.broadcasts || []).join(", "), s.network.source].filter(Boolean).join(" · ") || "unknown") + "</p>" +
      '<div class="form-grid">' + field("mac_override", "MAC override", s.network.mac_override, 'type="text" placeholder="Automatic"') + field("broadcast_overrides", "WoWLAN broadcast override(s)", s.network.broadcast_overrides, 'type="text" placeholder="Automatic"', "Comma-separated directed broadcast addresses") + "</div></div>";
    if (r !== "unassigned") {
      html += '<div class="settings-group danger-zone"><h3>Role</h3><p style="font-size:13px">This remote is the ' + (r === "primary" ? "Primary. Resetting removes all paired satellites from it." : "Satellite. Resetting unpairs it from its Primary.") + "</p>" +
        '<div>' + button("secondary danger small", "delete", "Reset role", 'data-reset-role="1"') + "</div></div>";
    }
    $("settingsBody").innerHTML = html;
    $("settingsDialog").showModal();
  }
  $("settingsButton").addEventListener("click", openSettings);
  $("settingsBody").addEventListener("click", async (event) => {
    if (!event.target.closest("[data-reset-role]")) return;
    $("settingsDialog").close();
    const ok = await confirmDialog("Reset this remote's role?", role() === "primary" ? "All satellites are removed from this Primary. You can choose the role again afterwards." : "This Satellite is unpaired. You can choose the role again afterwards.", "Reset role", true);
    if (!ok) return;
    try { await call("/role/reset", { method: "POST" }); state.selected = "primary"; await waitForRestart("Resetting role…"); notice("Role reset — choose a new role"); }
    catch (error) { notice(error.message, "error"); }
  });
  $("saveSettings").addEventListener("click", async () => {
    const form = $("settingsForm"); const data = new FormData(form); const s = state.settings;
    const body = { node_name: data.get("node_name"), agent_public_url: data.get("agent_public_url"), mac_override: data.get("mac_override"), broadcast_overrides: data.get("broadcast_overrides") };
    if (s.role === "primary") {
      Object.assign(body, { sections: data.getAll("section"), interval_seconds: Number(data.get("interval_seconds")) });
      for (const key of ["auto_sync", "auto_update_satellites", "prune", "use_standby_inhibitor", "verify_existing_resource_hashes"]) body[key] = data.get(key) === "on";
      if (String(data.get("dock_tokens") || "").trim()) body.dock_tokens = data.get("dock_tokens");
      if (data.get("clear_dock_tokens") === "on") body.clear_dock_tokens = true;
    }
    const result = $("settingsResult");
    try {
      await call("/settings", { method: "PUT", body });
      $("settingsDialog").close();
      await waitForRestart("Saving settings…");
      notice("Settings saved");
    } catch (error) { result.className = "inline-result error"; result.textContent = error.message; }
  });

  // ---------------------------------------------------------------- logs
  $("refreshLogs").addEventListener("click", () => pollLogs().then(renderLogs).catch(() => {}));
  $("clearLogView").addEventListener("click", () => { state.logs = []; renderLogs(); });
  async function pollLogs() {
    const data = await call("/logs?after=" + state.logSeq);
    if (data.lines.length) { state.logs.push(...data.lines); state.logs = state.logs.slice(-1000); state.logSeq = data.lines[data.lines.length - 1].seq; }
  }

  // ---------------------------------------------------------------- polling
  async function refresh() { try { state.status = await call("/status"); render(); } catch {} }
  async function refreshDetails() {
    try {
      if (role() === "primary") {
        const [sats, preview] = await Promise.all([call("/satellites"), call("/preview")]);
        state.satellites = sats.satellites; state.preview = preview;
      }
      render();
      await loadSimulator();
    } catch {}
  }
  async function start() {
    const session = await fetch("/ui/api/session", { credentials: "same-origin" }).then((r) => r.json());
    state.session = session;
    if (session.node_name) $("loginRemote").textContent = session.node_name;
    if (!session.authenticated) { showLogin(); return; }
    $("loginView").classList.add("hidden"); $("appView").classList.remove("hidden");
    await refresh(); await refreshDetails(); await pollLogs().catch(() => {}); renderLogs();
  }
  setInterval(async () => {
    if (!state.session || !state.session.authenticated || document.hidden || document.querySelector("dialog[open]")) return;
    await refresh();
    if ($("continuousLogs").checked) { await pollLogs().catch(() => {}); renderLogs(); }
  }, 5000);
  setInterval(() => { if (state.session && state.session.authenticated && !document.hidden && !document.querySelector("dialog[open]")) refreshDetails(); }, 30000);
  start().catch((error) => notice(error.message, "error"));
})();
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Remote Sync</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(BRAND_SVG.replace('aria-hidden="true"', 'xmlns="http://www.w3.org/2000/svg"'))}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500&family=Space+Mono&display=swap">
<link rel="stylesheet" href="${RUNTIME_CSS}">
<script src="${RUNTIME_JS}"></script>
<style>${STYLES}
${iconCss()}
${remoteIconCss()}</style>
</head>
<body>
${BODY.replaceAll("@@BRAND@@", BRAND_SVG)}
<script>const BRAND = ${JSON.stringify(BRAND_SVG)};
const GLYPH_NAMES = ${JSON.stringify(Object.fromEntries(Object.entries(REMOTE_UI_ICONS).map(([name, { char }]) => [JSON.parse(`"${char}"`), name])))};
${SCRIPT}</script>
</body>
</html>`;

export function dashboardPage() {
  return PAGE;
}
