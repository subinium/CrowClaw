/**
 * CrowClaw Web Dashboard
 *
 * Premium single-page agent management UI.
 * Served as a single HTML file with embedded CSS and JS — no build step required.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CrowClaw</title>
<link rel="icon" type="image/png" href="/docs/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+KR:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;border-radius:0!important}
:root{--b0:#06080d;--b1:#0a0d14;--b2:#10141c;--b3:#161b26;--bd:#1e2738;--t0:#f0f2f5;--t1:#c8cdd6;--t2:#7e8694;--t3:#4a5060;--ac:#c0392b;--ah:#e74c3c;--as:rgba(192,57,43,.07);--ok:#27ae60;--wn:#f39c12;--er:#e74c3c;--m:'JetBrains Mono',monospace;--s:'Inter','Noto Sans KR',-apple-system,sans-serif}
html,body{height:100%;overflow:hidden}
body{font-family:var(--s);background:var(--b0);color:var(--t0);line-height:1.5;-webkit-font-smoothing:antialiased;background-image:radial-gradient(ellipse at 20% 0%,rgba(192,57,43,.04) 0%,transparent 50%),radial-gradient(ellipse at 80% 100%,rgba(16,20,28,.8) 0%,transparent 50%)}
a{color:var(--ac);text-decoration:none}a:hover{color:var(--ah)}
::selection{background:var(--ac);color:#fff}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--b3)}::-webkit-scrollbar-thumb:hover{background:var(--t3)}

.app{display:grid;grid-template-columns:232px 1fr;height:100vh}
.sb{background:linear-gradient(180deg,var(--b1) 0%,#070a10 100%);border-right:1px solid var(--bd);display:flex;flex-direction:column}
.sb-logo{padding:18px 18px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--bd);background:linear-gradient(135deg,rgba(192,57,43,.06) 0%,transparent 60%)}
.sb-logo img{width:28px;height:28px;flex-shrink:0}
.sb-logo span{font-size:15px;font-weight:700;letter-spacing:-.4px}
.sb-nav{flex:1;overflow-y:auto;padding:10px 8px}
.sb-s{margin-bottom:14px}
.sb-l{padding:0 12px;margin-bottom:5px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:var(--t3)}
.ni{display:flex;align-items:center;gap:9px;padding:7px 12px;font-size:13px;color:var(--t2);cursor:pointer;transition:all .12s;border-left:2px solid transparent;margin-bottom:1px}
.ni:hover{color:var(--t1);background:rgba(255,255,255,.02)}
.ni.a{color:var(--ac);background:linear-gradient(90deg,rgba(192,57,43,.1) 0%,rgba(192,57,43,.02) 100%);border-left-color:var(--ac);font-weight:500}
.ni svg{width:15px;height:15px;flex-shrink:0;opacity:.45}.ni.a svg{opacity:1}
.ni .ct{margin-left:auto;padding:1px 5px;background:var(--b3);font-family:var(--m);font-size:10px;color:var(--t3)}
.ni.a .ct{color:var(--ac);background:rgba(192,57,43,.12)}
.sb-ft{padding:10px 14px;border-top:1px solid var(--bd);display:flex;flex-direction:column;gap:4px;background:linear-gradient(180deg,transparent 0%,rgba(6,8,13,.5) 100%)}
.sb-ft-r{display:flex;align-items:center;gap:7px}
.led{width:6px;height:6px;background:var(--t3);flex-shrink:0}
.led.ok{background:var(--ok);box-shadow:0 0 6px rgba(39,174,96,.4)}
.led.er{background:var(--er);box-shadow:0 0 6px rgba(231,76,60,.4)}
.sb-ft span{font-size:10px;color:var(--t3);font-weight:500}
.sb-ft .ft-stat{font-size:10px;color:var(--t3);font-family:var(--m)}

.mn{display:flex;flex-direction:column;overflow:hidden}
.mh{padding:18px 28px 0;flex-shrink:0;background:linear-gradient(180deg,rgba(192,57,43,.03) 0%,transparent 100%)}
.mh h2{font-size:17px;font-weight:700;letter-spacing:-.4px;background:linear-gradient(90deg,var(--t0) 0%,var(--t2) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.mh p{font-size:11px;color:var(--t3);font-weight:500;margin-top:1px}
.mb{flex:1;overflow-y:auto;padding:16px 28px 28px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 12px;border:1px solid var(--bd);background:var(--b3);color:var(--t1);font-size:11px;font-weight:500;font-family:var(--s);cursor:pointer;transition:all .12s;outline:none}
.btn:hover{background:rgba(255,255,255,.04);border-color:var(--t3)}
.btn:active{opacity:.85}
.btn-p{background:linear-gradient(135deg,var(--ac) 0%,#a0301f 100%);border-color:transparent;color:#fff}
.btn-p:hover{background:linear-gradient(135deg,var(--ah) 0%,var(--ac) 100%)}
.em{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 0;gap:6px;opacity:.5}
.em-t{font-size:14px;font-weight:600;color:var(--t1)}
.em-s{font-size:11px;color:var(--t3)}
.card{background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.6) 100%);border:1px solid var(--bd);padding:14px 18px;transition:all .15s}
.card:hover{border-color:var(--t3);background:linear-gradient(145deg,rgba(22,27,38,.9) 0%,var(--b2) 100%)}
.tag{display:inline-block;padding:2px 5px;background:var(--b3);font-size:9px;font-weight:500;font-family:var(--m);color:var(--t2);letter-spacing:.2px}
.tag.ok{color:var(--ok);background:rgba(39,174,96,.1)}
.tag.er{color:var(--er);background:rgba(231,76,60,.1)}
.tag.wn{color:var(--wn);background:rgba(243,156,18,.1)}
.tag.ac{color:var(--ac);background:rgba(192,57,43,.1)}
.srch{width:100%;padding:7px 12px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:12px;font-family:var(--s);outline:none;margin-bottom:14px}
.srch:focus{border-color:var(--ac)}.srch::placeholder{color:var(--t3)}
.sec-h{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:var(--t3);margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px}
.kv{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;font-size:12px;border-bottom:1px solid var(--bd)}
.kv:last-child{border-bottom:none}
.kv-k{color:var(--t2);font-weight:500}.kv-v{color:var(--t0);font-family:var(--m);font-size:11px}

.tabs{display:flex;gap:0;border-bottom:1px solid var(--bd);margin-bottom:14px}
.tab{padding:7px 14px;font-size:11px;font-weight:500;color:var(--t3);cursor:pointer;border-bottom:2px solid transparent;transition:all .12s}
.tab:hover{color:var(--t1)}.tab.a{color:var(--ac);border-bottom-color:var(--ac);background:linear-gradient(180deg,transparent 0%,rgba(192,57,43,.04) 100%)}

.vw{display:none}.vw.on{display:flex;flex-direction:column;flex:1;overflow:hidden}

/* Chat */
.chat-bar{display:flex;align-items:center;gap:10px;padding:12px 28px 0;flex-shrink:0}
.chat-sel{padding:5px 8px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:11px;font-family:var(--m);outline:none;min-width:180px;cursor:pointer;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg width='10' height='6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0l5 6 5-6' fill='none' stroke='%234a5060' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:24px}
.chat-sel option{background:var(--b2);color:var(--t0)}
.cw{display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0 28px}
.cm{flex:1;overflow-y:auto;padding:20px 0;display:flex;flex-direction:column;gap:6px}
.mg{max-width:72%;min-width:60px;padding:10px 14px;font-size:13.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;animation:mi .2s ease both}
@keyframes mi{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
.mg.u{align-self:flex-end;background:linear-gradient(135deg,var(--ac) 0%,#8c2a1e 100%);color:#fff;box-shadow:0 1px 6px rgba(192,57,43,.2)}
.mg.as{align-self:flex-start;background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.5) 100%);border:1px solid var(--bd);box-shadow:0 1px 4px rgba(0,0,0,.15)}
.mg.sy{align-self:center;background:transparent;color:var(--t3);font-size:10px;font-weight:500;padding:2px 0}
.mg.tl{align-self:flex-start;border-left:2px solid var(--wn);background:linear-gradient(145deg,var(--b1) 0%,var(--b2) 100%);font-family:var(--m);font-size:10px;max-width:82%;line-height:1.7;box-shadow:0 1px 4px rgba(0,0,0,.15)}
.rt{display:none}
.mg.tl .rt{display:block;margin-bottom:3px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--wn)}
.ci{padding:10px 0 14px;flex-shrink:0}
.ci-f{display:flex;align-items:center;gap:6px;padding:3px 3px 3px 14px;border:1px solid var(--bd);background:var(--b2);transition:border-color .12s}
.ci-f:focus-within{border-color:var(--ac)}
.ci-f input{flex:1;padding:7px 0;border:none;background:transparent;color:var(--t0);font-size:12px;font-family:var(--s);outline:none}
.ci-f input::placeholder{color:var(--t3)}
.snd{width:30px;height:30px;border:none;background:linear-gradient(135deg,var(--ac) 0%,#a0301f 100%);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .12s;flex-shrink:0}
.snd:hover{background:linear-gradient(135deg,var(--ah) 0%,var(--ac) 100%)}.snd:active{opacity:.85}
.snd svg{width:13px;height:13px}
.tc{background:var(--b1);border:1px solid var(--bd);margin:3px 0;overflow:hidden}
.tc:hover{border-color:var(--t3)}
.tc-h{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none}
.tc-ic{width:16px;height:16px;background:var(--wn);display:flex;align-items:center;justify-content:center;font-size:8px;color:var(--b0);font-weight:700;flex-shrink:0}
.tc-n{font-size:11px;font-family:var(--m);color:var(--t1)}
.tc-s{margin-left:auto;font-size:9px;font-weight:600}.tc-s.ok{color:var(--ok)}.tc-s.er{color:var(--er)}
.tc-c{color:var(--t3);transition:transform .12s;font-size:9px}.tc.op .tc-c{transform:rotate(90deg)}
.tc-b{display:none;padding:0 10px 8px;font-family:var(--m);font-size:9px;color:var(--t2);line-height:1.7;border-top:1px solid var(--bd);white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto}
.tc.op .tc-b{display:block;padding-top:6px}
.typ{display:flex;align-items:center;gap:3px;padding:10px 14px;align-self:flex-start}
.td{width:4px;height:4px;background:var(--t3);animation:bn 1.4s infinite both}
.td:nth-child(2){animation-delay:.16s}.td:nth-child(3){animation-delay:.32s}
@keyframes bn{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}

.md h1,.md h2,.md h3{font-weight:600;margin:8px 0 4px;color:var(--t0)}
.md h1{font-size:16px}.md h2{font-size:14px}.md h3{font-size:12px}
.md p{margin:2px 0}.md ul,.md ol{padding-left:16px;margin:2px 0}.md li{margin:1px 0}
.md strong{font-weight:600;color:var(--t0)}.md em{font-style:italic;color:var(--t1)}
.md code{font-family:var(--m);font-size:10px;background:var(--b0);padding:1px 4px;border:1px solid var(--bd);color:var(--ah)}
.md pre{background:var(--b0);border:1px solid var(--bd);padding:10px 12px;margin:4px 0;overflow-x:auto}
.md pre code{background:none;border:none;padding:0;color:var(--t1);font-size:10px;line-height:1.7}
.md blockquote{border-left:2px solid var(--ac);padding-left:8px;margin:3px 0;color:var(--t2);font-style:italic}
.md a{color:var(--ac)}.md hr{border:none;border-top:1px solid var(--bd);margin:8px 0}

.sk-card{background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.6) 100%);border:1px solid var(--bd);padding:14px 18px;transition:all .15s}
.sk-card:hover{border-color:var(--t3);background:linear-gradient(145deg,rgba(22,27,38,.9) 0%,var(--b2) 100%)}
.sk-card h4{font-size:13px;font-weight:600;margin-bottom:3px}
.sk-card .sk-sum{font-size:11px;color:var(--t2);line-height:1.5;margin-bottom:6px}
.sk-card .sk-tags{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px}
.sk-steps{list-style:none;padding:0;counter-reset:sk}
.sk-steps.hide{display:none}
.sk-steps li{font-size:10px;color:var(--t2);padding:1px 0;counter-increment:sk;font-family:var(--m)}
.sk-steps li::before{content:counter(sk) ". ";color:var(--t3);font-weight:600}
.sk-tog{font-size:10px;color:var(--ac);cursor:pointer;font-weight:500;display:inline-block}
.sk-tog:hover{color:var(--ah)}
.sk-act{display:flex;align-items:center;gap:6px;margin-top:6px}

.cp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:none;align-items:flex-start;justify-content:center;padding-top:15vh;backdrop-filter:blur(4px)}
.cp-overlay.on{display:flex}
.cp-box{width:460px;background:var(--b1);border:1px solid var(--bd);box-shadow:0 16px 48px rgba(0,0,0,.5);overflow:hidden}
.cp-input{width:100%;padding:12px 16px;border:none;border-bottom:1px solid var(--bd);background:transparent;color:var(--t0);font-size:14px;font-family:var(--s);outline:none}
.cp-input::placeholder{color:var(--t3)}
.cp-list{max-height:320px;overflow-y:auto;padding:4px 0}
.cp-item{display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;transition:background .1s;font-size:13px;color:var(--t1)}
.cp-item:hover,.cp-item.a{background:rgba(192,57,43,.08);color:var(--t0)}
.cp-item .cp-k{margin-left:auto;font-size:9px;font-family:var(--m);color:var(--t3);padding:2px 5px;background:var(--b3)}
.cp-cat{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--t3);padding:10px 16px 4px}
.cp-footer{padding:6px 16px;border-top:1px solid var(--bd);font-size:9px;color:var(--t3);display:flex;gap:12px}
.sw{position:relative;display:inline-block;width:28px;height:14px;cursor:pointer}
.sw input{opacity:0;width:0;height:0}
.sw-sl{position:absolute;inset:0;background:var(--b3);transition:all .15s}
.sw-sl::before{content:'';position:absolute;height:10px;width:10px;left:2px;bottom:2px;background:var(--t3);transition:all .15s}
.sw input:checked+.sw-sl{background:rgba(39,174,96,.2)}
.sw input:checked+.sw-sl::before{transform:translateX(14px);background:var(--ok)}

.gw-card{background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.6) 100%);border:1px solid var(--bd);padding:14px 18px;transition:all .15s}
.gw-card:hover{border-color:var(--t3);background:linear-gradient(145deg,rgba(22,27,38,.9) 0%,var(--b2) 100%)}
.gw-hd{display:flex;align-items:center;gap:7px;margin-bottom:6px}
.gw-nm{font-size:12px;font-weight:600}
.gw-url{font-size:9px;font-family:var(--m);color:var(--t3);word-break:break-all;cursor:pointer;padding:5px 7px;background:var(--b0);border:1px solid var(--bd);margin:5px 0}
.gw-url:hover{border-color:var(--t3);color:var(--t2)}
.gw-fld{display:flex;flex-direction:column;gap:3px;margin-top:6px}
.gw-fld label{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--t3)}
.gw-fld input{padding:5px 8px;border:1px solid var(--bd);background:var(--b0);color:var(--t0);font-size:11px;font-family:var(--m);outline:none}
.gw-fld input:focus{border-color:var(--ac)}
.gw-acts{display:flex;align-items:center;gap:6px;margin-top:6px}
.cfg-badge{font-size:9px;font-weight:600;color:var(--ok);text-transform:uppercase;letter-spacing:.4px}
.gw-probe{min-height:14px;padding:2px 0}
.gw-pol{margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);display:flex;gap:10px;flex-wrap:wrap}
.gw-pol-r{display:flex;flex-direction:column;gap:2px;flex:1;min-width:120px}
.gw-pol-r label{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--t3)}
.gw-pol-r select{padding:4px 6px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:11px;font-family:var(--m);outline:none;-webkit-appearance:none;appearance:none}
.gw-pol-r select:focus{border-color:var(--ac)}

.mcp-blk{background:var(--b2);border:1px solid var(--bd);padding:14px 18px;margin-bottom:14px}
.mcp-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:11px;border-bottom:1px solid var(--bd)}
.mcp-row:last-child{border-bottom:none}
.mcp-row .lbl{color:var(--t2)}.mcp-row .val{font-family:var(--m);font-size:10px}

.cfg-blk{background:var(--b2);border:1px solid var(--bd);overflow:hidden}

.pre-card{background:var(--b2);border:1px solid var(--bd);padding:14px 18px;transition:border-color .12s}
.pre-card:hover{border-color:var(--t3)}
.pre-card h4{font-size:13px;font-weight:600;margin-bottom:2px}
.pre-card .role{font-size:10px;color:var(--ac);font-weight:500;margin-bottom:4px}
.pre-card .goal{font-size:11px;color:var(--t2);line-height:1.5;margin-bottom:8px}
.pre-card .tr{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px}

.tl-card{background:var(--b2);border:1px solid var(--bd);padding:12px 16px;transition:border-color .12s}
.tl-card:hover{border-color:var(--t3)}
.tl-card .tl-nm{font-family:var(--m);font-size:11px;font-weight:500;color:var(--t0);margin-bottom:2px}
.tl-card .tl-ds{font-size:10px;color:var(--t3);line-height:1.5;margin-bottom:6px}
.tl-card .tl-mt{display:flex;align-items:center;gap:5px}

.ob-overlay{position:fixed;inset:0;background:rgba(6,8,13,.92);z-index:200;display:none;align-items:center;justify-content:center;backdrop-filter:blur(8px)}
.ob-overlay.on{display:flex}
.ob-box{width:420px;background:var(--b1);border:1px solid var(--bd);box-shadow:0 24px 64px rgba(0,0,0,.6);padding:32px}
.ob-box h2{font-size:18px;font-weight:700;margin-bottom:4px;background:linear-gradient(90deg,var(--t0) 0%,var(--ac) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.ob-box p{font-size:12px;color:var(--t2);margin-bottom:20px;line-height:1.6}
.ob-step{display:none}.ob-step.on{display:block}
.ob-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:6px}
.ob-input{width:100%;padding:10px 14px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:13px;font-family:var(--m);outline:none;margin-bottom:16px}
.ob-input:focus{border-color:var(--ac)}
.ob-select{width:100%;padding:10px 14px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:13px;font-family:var(--m);outline:none;margin-bottom:16px;-webkit-appearance:none;appearance:none}
.ob-select:focus{border-color:var(--ac)}
.ob-dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px}
.ob-dot{width:8px;height:8px;background:var(--b3);transition:all .2s}.ob-dot.on{background:var(--ac)}
.ob-nav{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.ob-skip{font-size:11px;color:var(--t3);cursor:pointer;background:none;border:none;font-family:var(--s)}.ob-skip:hover{color:var(--t2)}
</style>
</head>
<body>
<div class="app">
  <aside class="sb">
    <div class="sb-logo">
      <img src="/docs/logo.png" alt="CrowClaw">
      <span>CrowClaw</span>
    </div>
    <nav class="sb-nav">
      <div class="sb-s"><div class="sb-l">General</div>
        <div class="ni a" data-v="chat" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>Chat<span class="ct" id="nSs">0</span></div>
      </div>
      <div class="sb-s"><div class="sb-l">Agent</div>
        <div class="ni" data-v="presets" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>Presets</div>
        <div class="ni" data-v="skills" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Skills<span class="ct" id="nSk">0</span></div>
      </div>
      <div class="sb-s"><div class="sb-l">System</div>
        <div class="ni" data-v="tools" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z"/></svg>Tools<span class="ct" id="nTl">0</span></div>
        <div class="ni" data-v="gateway" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>Gateway</div>
        <div class="ni" data-v="mcp" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8"/><rect x="2" y="14" width="20" height="8"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>MCP</div>
        <div class="ni" data-v="jobs" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Jobs<span class="ct" id="nJb">0</span></div>
        <div class="ni" data-v="logs" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Logs</div>
        <div class="ni" data-v="settings" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>Settings</div>
      </div>
    </nav>
    <div class="sb-ft">
      <div class="sb-ft-r"><div class="led" id="sLed"></div><span id="sLbl">Connecting</span></div>
      <div class="sb-ft-r"><span class="ft-stat" id="ftMod"></span></div>
      <div class="sb-ft-r"><span class="ft-stat" id="ftTl"></span></div>
    </div>
  </aside>

  <main class="mn">
    <div class="vw on" id="v-chat">
      <div class="chat-bar">
        <select class="chat-sel" id="sSel" onchange="onSC()"><option value="">Select session...</option></select>
        <button class="btn btn-p" onclick="mkS()"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New Session</button>
      </div>
      <div class="cw">
        <div class="cm" id="cMs"><div class="em"><div class="em-t">No Session</div><div class="em-s">Create a session to start</div></div></div>
        <div class="ci"><div class="ci-f"><input id="mIn" placeholder="Send a message..." onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();snd()}">
          <button class="snd" onclick="snd()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div></div>
      </div>
    </div>

    <div class="vw" id="v-presets">
      <div class="mh"><h2>Presets</h2><p>Agent personas, toolsets, and MCP configurations</p></div>
      <div class="mb">
        <div class="tabs" id="pTabs">
          <div class="tab a" data-pt="agent" onclick="pTab(this)">Agent</div>
          <div class="tab" data-pt="toolset" onclick="pTab(this)">Toolset</div>
          <div class="tab" data-pt="mcp-p" onclick="pTab(this)">MCP</div>
        </div>
        <div id="pAgent" class="grid"></div>
        <div id="pToolset" class="grid" style="display:none"></div>
        <div id="pMcpP" class="grid" style="display:none"></div>
      </div>
    </div>

    <div class="vw" id="v-skills">
      <div class="mh"><h2>Skills</h2><p>Built-in agent capabilities</p></div>
      <div class="mb">
        <input class="srch" id="skSr" placeholder="Filter skills..." oninput="fSk()">
        <div id="skLs"></div>
      </div>
    </div>

    <div class="vw" id="v-tools">
      <div class="mh"><h2>Tools</h2><p>Registered tool capabilities</p></div>
      <div class="mb">
        <input class="srch" id="tlSr" placeholder="Filter tools..." oninput="fTl()">
        <div id="tGrd"></div>
      </div>
    </div>

    <div class="vw" id="v-gateway">
      <div class="mh"><h2>Gateway</h2><p>Platform integrations and webhook endpoints</p></div>
      <div class="mb"><div class="grid" id="gGrd"></div></div>
    </div>

    <div class="vw" id="v-mcp">
      <div class="mh"><h2>MCP</h2><p>Model Context Protocol servers and presets</p></div>
      <div class="mb">
        <div class="sec-h">Server Status</div>
        <div id="mcpSt"><div class="em"><div class="em-s">Loading MCP status...</div></div></div>
        <div class="sec-h" style="margin-top:20px">Preset Library</div>
        <div class="grid" id="mcpPr"></div>
      </div>
    </div>

    <div class="vw" id="v-jobs">
      <div class="mh"><h2>Scheduled Jobs</h2><p>Cron-style agent execution</p></div>
      <div class="mb">
        <div style="display:flex;gap:8px;margin-bottom:14px">
          <button class="btn btn-p" onclick="jbCreate()">+ New Job</button>
          <button class="btn" onclick="jbTick()">Tick Now</button>
        </div>
        <div id="jbLs"><div class="em"><div class="em-s">Loading jobs...</div></div></div>
      </div>
    </div>

    <div class="vw" id="v-logs">
      <div class="mh"><h2>Activity Log</h2><p>Recent system events</p></div>
      <div class="mb">
        <div id="logOut" style="font-family:var(--m);font-size:10px;color:var(--t2);line-height:1.8;max-height:calc(100vh - 160px);overflow-y:auto"></div>
      </div>
    </div>

    <div class="vw" id="v-settings">
      <div class="mh"><h2>Settings</h2><p>Current system configuration</p></div>
      <div class="mb"><div id="cfB"><div class="em"><div class="em-s">Loading configuration...</div></div></div></div>
    </div>

    <div class="cp-overlay" id="cpOv" onclick="if(event.target===this)cpClose()">
      <div class="cp-box">
        <input class="cp-input" id="cpIn" placeholder="Type a command..." oninput="cpFilter()" onkeydown="cpKey(event)">
        <div class="cp-list" id="cpList"></div>
        <div class="cp-footer"><span>&#8593;&#8595; navigate</span><span>&#8629; select</span><span>esc close</span></div>
      </div>
    </div>

    <div class="ob-overlay" id="obOv">
      <div class="ob-box">
        <h2>Welcome to CrowClaw</h2>
        <p>Let's set up your agent in 3 quick steps.</p>
        <div class="ob-dots"><div class="ob-dot on" id="obd0"></div><div class="ob-dot" id="obd1"></div><div class="ob-dot" id="obd2"></div></div>

        <div class="ob-step on" id="obs0">
          <div class="ob-label">Step 1 — API Key</div>
          <input class="ob-input" id="obKey" type="password" placeholder="sk-or-... (OpenRouter or OpenAI key)">
          <div class="ob-label">Provider Base URL</div>
          <input class="ob-input" id="obUrl" value="https://openrouter.ai/api/v1" placeholder="https://openrouter.ai/api/v1">
        </div>

        <div class="ob-step" id="obs1">
          <div class="ob-label">Step 2 — Model</div>
          <select class="ob-select" id="obMod">
            <option value="anthropic/claude-sonnet-4">Claude Sonnet 4</option>
            <option value="anthropic/claude-haiku-4-5">Claude Haiku 4.5</option>
            <option value="openai/gpt-4o">GPT-4o</option>
            <option value="openai/gpt-4o-mini">GPT-4o Mini</option>
            <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
            <option value="meta-llama/llama-4-maverick">Llama 4 Maverick</option>
          </select>
        </div>

        <div class="ob-step" id="obs2">
          <div class="ob-label">Step 3 — Agent Preset</div>
          <select class="ob-select" id="obPre">
            <option value="">Default (general assistant)</option>
          </select>
          <p style="font-size:10px;color:var(--t3);margin-top:-10px">You can change this anytime in the Presets tab.</p>
        </div>

        <div class="ob-nav">
          <button class="ob-skip" onclick="obSkip()">Skip setup</button>
          <div>
            <button class="btn" id="obBack" style="display:none" onclick="obNav(-1)">Back</button>
            <button class="btn btn-p" id="obNext" onclick="obNav(1)">Next</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
var B=location.origin,sid=localStorage.getItem('cc_sid')||null,ss=[],aT=[],aPre=null,aSk=null;

function ap(p,o){return fetch(B+p,Object.assign({headers:{'content-type':'application/json'}},o||{})).then(function(r){return r.json()})}
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML}
function $(i){return document.getElementById(i)}
function ago(d){if(!d)return'--';var s=Math.floor((Date.now()-new Date(d).getTime())/1000);return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':Math.floor(s/86400)+'d ago'}

function md(r){
  if(!r)return'';var t=esc(r);
  t=t.replace(/\\\`\\\`\\\`(\\w*)?\\n([\\s\\S]*?)\\\`\\\`\\\`/g,function(_,l,c){return'<pre><code>'+c.trim()+'</code></pre>'});
  t=t.replace(/\\\`([^\\\`]+)\\\`/g,'<code>$1</code>');
  t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  t=t.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
  t=t.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  t=t.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  t=t.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  t=t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  t=t.replace(/^- (.+)$/gm,'<li>$1</li>');
  t=t.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
  t=t.replace(/^---$/gm,'<hr>');
  t=t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  t=t.replace(/\\n\\n/g,'</p><p>');t=t.replace(/\\n/g,'<br>');
  return'<p>'+t+'</p>';
}

function tcc(n,ok,out){
  var id='tc'+Math.random().toString(36).slice(2,7);
  return'<div class="tc" id="'+id+'"><div class="tc-h" onclick="document.getElementById(\\''+id+'\\').classList.toggle(\\'op\\')"><div class="tc-ic">T</div><span class="tc-n">'+esc(n)+'</span><span class="tc-s '+(ok?'ok':'er')+'">'+(ok?'done':'error')+'</span><span class="tc-c">&#9654;</span></div><div class="tc-b">'+esc(out)+'</div></div>';
}

function go(el){
  var ns=document.querySelectorAll('.ni');for(var i=0;i<ns.length;i++)ns[i].classList.remove('a');
  el.classList.add('a');var v=el.getAttribute('data-v');
  var vs=document.querySelectorAll('.vw');for(var i=0;i<vs.length;i++)vs[i].classList.remove('on');
  $('v-'+v).classList.add('on');
  if(v==='chat'&&sid)lH();
  if(v==='tools')lT();
  if(v==='gateway')rGw();
  if(v==='skills')rSk();
  if(v==='settings')lCfg();
  if(v==='mcp')lMcp();
  if(v==='presets')lPre();
  if(v==='jobs')lJobs();
  if(v==='logs')rLogs();
}
function goTo(v){var ns=document.querySelectorAll('.ni');for(var i=0;i<ns.length;i++){if(ns[i].getAttribute('data-v')===v){go(ns[i]);return}}}

function chk(){
  ap('/health').then(function(h){
    $('sLed').className='led '+(h.ok?'ok':'er');$('sLbl').textContent=h.ok?'Connected':'Error';
  }).catch(function(){$('sLed').className='led er';$('sLbl').textContent='Offline'});
}

// SSE real-time connection
var evtSrc=null;
function connectSSE(){
  if(evtSrc)evtSrc.close();
  try{
    evtSrc=new EventSource(B+'/api/events');
    evtSrc.onopen=function(){$('sLed').className='led ok';$('sLbl').textContent='Live'};
    evtSrc.addEventListener('heartbeat',function(e){
      try{var d=JSON.parse(e.data);if(d.sessions!==undefined){$('nSs').textContent=d.sessions;addLog('heartbeat: '+d.sessions+' sessions')}}catch(ex){}
    });
    evtSrc.addEventListener('status',function(e){
      try{var d=JSON.parse(e.data);if(d.type==='connected'){$('sLed').className='led ok';$('sLbl').textContent='Live'}}catch(ex){}
    });
    evtSrc.onerror=function(){$('sLed').className='led';$('sLbl').textContent='Reconnecting...'};
  }catch(ex){/* SSE not supported or server doesn\\'t support it */}
}

// Server-side session list
function lSessions(){
  ap('/api/sessions').then(function(d){
    var serverSessions=d.sessions||[];
    // Merge with local sessions
    serverSessions.forEach(function(s){
      if(!ss.find(function(x){return x.id===s.sessionId})){
        ss.push({id:s.sessionId,n:s.messageCount||0,t:s.updatedAt||new Date().toISOString()});
      }
    });
    rSel();
  }).catch(function(){});
}

// Command palette
var cpItems=[
  {cat:'Navigate',label:'Chat',action:function(){goTo('chat')},key:''},
  {cat:'Navigate',label:'Presets',action:function(){goTo('presets')},key:''},
  {cat:'Navigate',label:'Skills',action:function(){goTo('skills')},key:''},
  {cat:'Navigate',label:'Tools',action:function(){goTo('tools')},key:''},
  {cat:'Navigate',label:'Gateway',action:function(){goTo('gateway')},key:''},
  {cat:'Navigate',label:'MCP',action:function(){goTo('mcp')},key:''},
  {cat:'Navigate',label:'Settings',action:function(){goTo('settings')},key:''},
  {cat:'Actions',label:'New Session',action:function(){mkS()},key:'N'},
  {cat:'Actions',label:'Refresh Tools',action:function(){lT()},key:'R'},
  {cat:'Actions',label:'Refresh Skills',action:function(){aSk=null;rSk()},key:''},
  {cat:'Actions',label:'Load Presets',action:function(){aPre=null;lPre()},key:''},
];
var cpIdx=0;
function cpOpen(){$('cpOv').classList.add('on');$('cpIn').value='';cpFilter();$('cpIn').focus()}
function cpClose(){$('cpOv').classList.remove('on')}
function cpFilter(){
  var q=$('cpIn').value.toLowerCase();
  var f=q?cpItems.filter(function(i){return i.label.toLowerCase().indexOf(q)!==-1||i.cat.toLowerCase().indexOf(q)!==-1}):cpItems;
  cpIdx=0;
  var cats={};f.forEach(function(i){if(!cats[i.cat])cats[i.cat]=[];cats[i.cat].push(i)});
  var h='';
  Object.keys(cats).forEach(function(c){
    h+='<div class="cp-cat">'+esc(c)+'</div>';
    cats[c].forEach(function(it,idx){
      var gIdx=f.indexOf(it);
      h+='<div class="cp-item'+(gIdx===0?' a':'')+'" data-ci="'+gIdx+'" onclick="cpExec('+gIdx+')" onmouseenter="cpHover('+gIdx+')">'+esc(it.label);
      if(it.key)h+='<span class="cp-k">'+esc(it.key)+'</span>';
      h+='</div>';
    });
  });
  $('cpList').innerHTML=h||'<div style="padding:16px;color:var(--t3);font-size:12px">No matches</div>';
}
function cpHover(i){cpIdx=i;var items=$('cpList').querySelectorAll('.cp-item');for(var j=0;j<items.length;j++)items[j].classList.toggle('a',parseInt(items[j].getAttribute('data-ci'))===i)}
function cpKey(e){
  var items=$('cpList').querySelectorAll('.cp-item');
  if(e.key==='Escape'){cpClose();e.preventDefault();return}
  if(e.key==='Enter'){cpExec(cpIdx);cpClose();e.preventDefault();return}
  if(e.key==='ArrowDown'){cpIdx=Math.min(cpIdx+1,items.length-1);cpHover(cpIdx);e.preventDefault()}
  if(e.key==='ArrowUp'){cpIdx=Math.max(cpIdx-1,0);cpHover(cpIdx);e.preventDefault()}
}
function cpExec(i){
  var q=$('cpIn').value.toLowerCase();
  var f=q?cpItems.filter(function(it){return it.label.toLowerCase().indexOf(q)!==-1||it.cat.toLowerCase().indexOf(q)!==-1}):cpItems;
  if(f[i])f[i].action();
  cpClose();
}
document.addEventListener('keydown',function(e){
  if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();cpOpen()}
});

function mkS(){
  var id='s-'+Date.now().toString(36);
  ss.push({id:id,n:0,t:new Date().toISOString()});
  rSel();pk(id);
}
function rSel(){
  var sel=$('sSel');var cur=sel.value;
  $('nSs').textContent=ss.length;
  var h='<option value="">Select session...</option>';
  ss.forEach(function(s){h+='<option value="'+esc(s.id)+'">'+esc(s.id.slice(0,20))+' ('+(s.n||0)+' msgs)</option>'});
  sel.innerHTML=h;sel.value=cur||sid||'';
}
function onSC(){var v=$('sSel').value;if(v)pk(v)}
function pk(id){sid=id;localStorage.setItem('cc_sid',id);$('sSel').value=id;lH()}

function lH(){
  if(!sid)return;
  ap('/api/sessions/'+sid+'/history').then(function(d){rMs(d.messages||[])}).catch(function(){rMs([])});
}
function rMs(ms){
  var c=$('cMs');
  if(!ms||!ms.length){c.innerHTML='<div class="em"><div class="em-t">New Session</div><div class="em-s">Type a message to begin.</div></div>';return}
  c.innerHTML=ms.map(function(m){
    var r=m.role||'user';
    if(r==='tool'){var ok=!m.content||!m.content.match(/error|fail/i);return tcc(m.name||'tool',ok,m.content||'')}
    var b=r==='user'?esc(m.content||''):'<div class="md">'+md(m.content||'')+'</div>';
    return'<div class="mg '+(r==='user'?'u':r==='assistant'?'as':r==='system'?'sy':'tl')+'"><span class="rt">'+r+(m.name?' / '+esc(m.name):'')+'</span>'+b+'</div>';
  }).join('');c.scrollTop=c.scrollHeight;
}
function snd(){
  var el=$('mIn'),t=el.value.trim();if(!t||!sid)return;el.value='';
  addLog('chat: sent message to '+sid);
  var c=$('cMs');if(c.querySelector('.em'))c.innerHTML='';
  c.innerHTML+='<div class="mg u"><span class="rt">you</span>'+esc(t)+'</div>';
  c.innerHTML+='<div class="typ"><div class="td"></div><div class="td"></div><div class="td"></div></div>';
  c.scrollTop=c.scrollHeight;
  var s=ss.find(function(x){return x.id===sid});if(s){s.n=(s.n||0)+1;s.t=new Date().toISOString();rSel()}
  ap('/api/sessions/'+sid,{method:'POST',body:JSON.stringify({userMessage:t})}).then(function(d){
    var ind=c.querySelector('.typ');if(ind)ind.remove();
    if(d.toolResults&&d.toolResults.length){
      d.toolResults.forEach(function(tr){
        c.innerHTML+=tcc(tr.toolName,tr.ok,tr.output||'');
      });
    }
    lH();
  }).catch(function(e){
    var ind=c.querySelector('.typ');if(ind)ind.remove();
    c.innerHTML+='<div class="mg sy">Error: '+(e.message||'Unknown')+'</div>';
  });
}

function lT(){
  ap('/api/system/status').then(function(d){
    var t=d.tools||[];aT=t.map(function(x){return typeof x==='string'?{name:x,description:'',runtime:'worker',dangerLevel:''}:x});
    $('nTl').textContent=aT.length;
    if(d.model)$('ftMod').textContent=d.model;
    if(aT.length)$('ftTl').textContent=aT.length+' tools';
    fTl();
  }).catch(function(){});
}
function fTl(){
  var q=($('tlSr')?$('tlSr').value:'').toLowerCase();
  var f=aT;
  if(q){f=aT.filter(function(x){return(x.name||'').toLowerCase().indexOf(q)!==-1||(x.description||'').toLowerCase().indexOf(q)!==-1})}
  var groups={};
  f.forEach(function(x){var p=(x.name||'').split('.');var g=p.length>1?p[0]:'core';if(!groups[g])groups[g]=[];groups[g].push(x)});
  var el=$('tGrd');
  if(!f.length){el.innerHTML='<div class="em"><div class="em-s">No tools found</div></div>';return}
  var h='';
  Object.keys(groups).sort().forEach(function(g){
    h+='<div style="grid-column:1/-1"><div class="sec-h" style="margin-top:10px">'+esc(g.toUpperCase())+'</div></div>';
    groups[g].forEach(function(x){
      h+='<div class="tl-card"><div class="tl-nm">'+esc(x.name||'')+'</div>';
      if(x.description)h+='<div class="tl-ds">'+esc((x.description||'').slice(0,100))+'</div>';
      h+='<div class="tl-mt"><span class="tag">'+esc(x.runtime||'worker')+'</span>';
      if(x.dangerLevel==='high'||x.dangerLevel==='critical')h+='<span class="tag er">danger</span>';
      h+='</div></div>';
    });
  });
  el.innerHTML=h;
}

var actPre=localStorage.getItem('cc_preset')||null;
var actTs=localStorage.getItem('cc_toolset')||null;

function lPre(){
  if(aPre){rPre();return}
  ap('/api/presets').then(function(d){aPre=d;rPre()}).catch(function(){
    $('pAgent').innerHTML='<div class="em"><div class="em-s">Could not load presets</div></div>';
  });
}
function rPre(){
  if(!aPre)return;
  var agents=aPre.agents||[];
  $('pAgent').innerHTML=agents.map(function(a){
    var isA=actPre===a.name;
    var tools=(a.tools||[]).map(function(t){return'<span class="tag">'+esc(t)+'</span>'}).join('');
    return'<div class="pre-card'+(isA?' style="border-color:var(--ac)"':'')+'"><h4>'+esc(a.name)+'</h4><div class="role">'+esc(a.role||'')+'</div><div class="goal">'+esc(a.goal||'')+'</div>'+(tools?'<div class="tr">'+tools+'</div>':'')+'<button class="btn'+(isA?' btn-p':'')+'" onclick="aPr(\\''+esc(a.name)+'\\')">'+( isA?'Active':'Apply')+'</button></div>';
  }).join('')||'<div class="em"><div class="em-s">No agent presets</div></div>';

  var tss=aPre.toolsets||[];
  $('pToolset').innerHTML=tss.map(function(ts){
    var isA=actTs===ts.name;
    var names=(ts.toolNames||[]).join(', ');
    return'<div class="pre-card'+(isA?' style="border-color:var(--ac)"':'')+'"><h4>'+esc(ts.name)+'</h4><div class="goal">'+esc(ts.description||'')+'</div><div style="font-size:10px;color:var(--t3);font-family:var(--m);line-height:1.5;margin-bottom:8px">'+esc(names.slice(0,140))+(names.length>140?'...':'')+'</div>'+(isA?'<span class="tag ac">Active</span>':'<button class="btn" onclick="aTs(\\''+esc(ts.name)+'\\')">Select</button>')+'</div>';
  }).join('')||'<div class="em"><div class="em-s">No toolset presets</div></div>';

  var mcps=aPre.mcp||[];
  $('pMcpP').innerHTML=mcps.map(function(m){
    var isOn=localStorage.getItem('cc_mcp_'+m.name)==='on';
    return'<div class="pre-card'+(isOn?' style="border-color:var(--ok)"':'')+'"><h4>'+esc(m.name)+'</h4><div class="goal">'+esc(m.description||'')+'</div><button class="btn'+(isOn?' btn-p':'')+'" onclick="tgMcp(\\''+esc(m.name)+'\\',this);rPre()" style="margin-top:6px">'+(isOn?'Connected':'Connect')+'</button></div>';
  }).join('')||'<div class="em"><div class="em-s">No MCP presets</div></div>';
}
function pTab(el){
  var tabs=document.querySelectorAll('#pTabs .tab');
  for(var i=0;i<tabs.length;i++)tabs[i].classList.remove('a');
  el.classList.add('a');
  var t=el.getAttribute('data-pt');
  $('pAgent').style.display=t==='agent'?'grid':'none';
  $('pToolset').style.display=t==='toolset'?'grid':'none';
  $('pMcpP').style.display=t==='mcp-p'?'grid':'none';
}
function aPr(n){
  actPre=n;localStorage.setItem('cc_preset',n);
  var preset=(aPre&&aPre.agents||[]).find(function(a){return a.name===n});
  if(preset){
    ap('/api/agent/preset',{method:'POST',body:JSON.stringify({name:n,role:preset.role,goal:preset.goal,backstory:preset.backstory})}).catch(function(){});
  }
  rPre();
}
function aTs(n){
  actTs=n;localStorage.setItem('cc_toolset',n);
  ap('/api/toolset/select',{method:'POST',body:JSON.stringify({name:n})}).catch(function(){});
  rPre();
}

function rSk(){
  if(aSk){fSk();return}
  ap('/api/skills').then(function(d){
    aSk=d.skills||[];$('nSk').textContent=aSk.length;fSk();
  }).catch(function(){$('skLs').innerHTML='<div class="em"><div class="em-s">Could not load skills</div></div>'});
}
function fSk(){
  if(!aSk)return;
  var q=$('skSr').value.toLowerCase();
  var f=q?aSk.filter(function(s){
    return s.title.toLowerCase().indexOf(q)!==-1||s.summary.toLowerCase().indexOf(q)!==-1||(s.slug||'').toLowerCase().indexOf(q)!==-1||
    (s.triggerPhrases||[]).some(function(tp){return tp.toLowerCase().indexOf(q)!==-1});
  }):aSk;
  var catMap={'git':'Git','code':'Code Review','debug':'Debugging','project':'DevOps','api':'API','database':'DevOps','deploy':'DevOps','write':'Testing','refactor':'Code Review','docker':'DevOps','security':'Security','performance':'Performance','web':'Web','github':'Git','env':'DevOps'};
  var groups={};
  f.forEach(function(s){
    var prefix=(s.slug||'').split('-')[0];
    var cat=catMap[prefix]||'General';
    if(!groups[cat])groups[cat]=[];
    groups[cat].push(s);
  });
  var cats=Object.keys(groups).sort();
  var h='';
  cats.forEach(function(c){
    h+='<div class="sec-h" style="margin-top:14px;margin-bottom:10px">'+esc(c)+' <span style="color:var(--t3);font-weight:400">('+groups[c].length+')</span></div>';
    h+='<div class="grid" style="margin-bottom:6px">';
    groups[c].forEach(function(s){
      var triggers=(s.triggerPhrases||[]).map(function(tp){return'<span class="tag">'+esc(tp)+'</span>'}).join('');
      var steps=s.steps||[];
      var uid='sk'+Math.random().toString(36).slice(2,7);
      h+='<div class="sk-card"><h4>'+esc(s.title)+'</h4>';
      h+='<div class="sk-sum">'+esc(s.summary||'')+'</div>';
      if(triggers)h+='<div class="sk-tags">'+triggers+'</div>';
      if(steps.length){
        h+='<span class="sk-tog" onclick="var u=document.getElementById(\\''+uid+'\\');u.classList.toggle(\\'hide\\');this.textContent=u.classList.contains(\\'hide\\')?(\\''+steps.length+' steps \\u25B6\\'):(\\''+steps.length+' steps \\u25BC\\')">'+steps.length+' steps &#9654;</span>';
        h+='<ol class="sk-steps hide" id="'+uid+'">';
        steps.forEach(function(st){h+='<li>'+esc(st)+'</li>'});
        h+='</ol>';
      }
      var enKey='cc_sk_'+s.slug;var isEn=localStorage.getItem(enKey)!=='off';
      h+='<div class="sk-act"><label class="sw"><input type="checkbox" '+(isEn?'checked':'')+' onchange="tgSk(\\''+esc(s.slug)+'\\',this.checked)"><span class="sw-sl"></span></label><span style="font-size:9px;color:'+(isEn?'var(--ok)':'var(--t3)')+'">'+( isEn?'Enabled':'Disabled')+'</span></div>';
      h+='</div>';
    });
    h+='</div>';
  });
  if(!h)h='<div class="em"><div class="em-s">No skills found</div></div>';
  $('skLs').innerHTML=h;
}

var gwPlats=[
  {n:'Telegram',id:'telegram',r:'/webhooks/telegram',f:'Bot Token',k:'cc_gw_telegram',probe:true},
  {n:'Discord',id:'discord',r:'/webhooks/discord',f:'Webhook URL',k:'cc_gw_discord',probe:true},
  {n:'Slack',id:'slack',r:'/webhooks/slack',f:'Bot Token',k:'cc_gw_slack',probe:true},
  {n:'WhatsApp',id:'whatsapp',r:'/webhooks/whatsapp',f:'Access Token',k:'cc_gw_whatsapp',probe:true},
  {n:'Signal',id:'signal',r:'/webhooks/signal',f:'Phone Number',k:'cc_gw_signal',probe:false},
  {n:'Email',id:'email',r:'/webhooks/email',f:'API Key',k:'cc_gw_email',probe:false},
  {n:'Matrix',id:'matrix',r:'/webhooks/matrix',f:'Access Token',k:'cc_gw_matrix',probe:true},
  {n:'SMS',id:'sms',r:'/webhooks/sms',f:'Twilio SID',k:'cc_gw_sms',probe:false},
  {n:'Webhook',id:'webhook',r:'/webhooks/generic',f:'Secret',k:'cc_gw_webhook',probe:false}
];
function rGw(){
  $('gGrd').innerHTML=gwPlats.map(function(g,i){
    var u=location.origin+g.r;
    var saved=localStorage.getItem(g.k)||'';
    var cfg=!!saved;
    var dmPol=localStorage.getItem('cc_gw_dm_'+g.id)||'pairing';
    var grpPol=localStorage.getItem('cc_gw_grp_'+g.id)||'open';
    var h='<div class="gw-card">';
    h+='<div class="gw-hd"><div class="led '+(cfg?'ok':'')+'"></div><span class="gw-nm">'+esc(g.n)+'</span>';
    if(cfg)h+='<span class="cfg-badge" style="margin-left:auto">Configured</span>';
    h+='</div>';
    h+='<div class="gw-url" onclick="navigator.clipboard.writeText(\\''+esc(u)+'\\');this.textContent=\\'Copied!\\';var s=this;setTimeout(function(){s.textContent=\\''+esc(u)+'\\'},1500)" title="Click to copy">'+esc(u)+'</div>';
    h+='<div class="gw-fld"><label>'+esc(g.f)+'</label><input id="gwi'+i+'" type="password" value="'+esc(saved)+'" placeholder="Enter '+esc(g.f.toLowerCase())+'..."></div>';
    h+='<div class="gw-acts"><button class="btn" onclick="svGw('+i+')">Save</button>';
    if(g.probe)h+='<button class="btn" onclick="prGw(\\''+g.id+'\\','+i+')">Probe</button>';
    h+='</div>';
    h+='<div id="gwp'+i+'" class="gw-probe"></div>';
    // Policy section
    h+='<div class="gw-pol">';
    h+='<div class="gw-pol-r"><label>DM Policy</label><select id="gwdm'+i+'" onchange="svPol(\\''+g.id+'\\','+i+')">';
    ['pairing','allowlist','open','disabled'].forEach(function(p){h+='<option value="'+p+'"'+(dmPol===p?' selected':'')+'>'+p+'</option>'});
    h+='</select></div>';
    h+='<div class="gw-pol-r"><label>Group Policy</label><select id="gwgp'+i+'" onchange="svPol(\\''+g.id+'\\','+i+')">';
    ['open','disabled','allowlist'].forEach(function(p){h+='<option value="'+p+'"'+(grpPol===p?' selected':'')+'>'+p+'</option>'});
    h+='</select></div>';
    h+='</div>';
    h+='</div>';
    return h;
  }).join('');
}
function svGw(i){
  var g=gwPlats[i];var val=$('gwi'+i).value;
  localStorage.setItem(g.k,val);
  ap('/api/gateway/'+g.id+'/config',{method:'POST',body:JSON.stringify({token:val,enabled:!!val})}).catch(function(){});
  rGw();
}
function prGw(platform,i){
  var el=$('gwp'+i);el.innerHTML='<span style="color:var(--t3);font-size:10px">Probing...</span>';
  var token=$('gwi'+i).value;
  if(!token){el.innerHTML='<span style="color:var(--er);font-size:10px">Enter token first</span>';return}
  ap('/api/gateway/'+platform+'/probe',{method:'POST',body:JSON.stringify({token:token,webhookUrl:token})}).then(function(d){
    if(d.ok){
      el.innerHTML='<span style="color:var(--ok);font-size:10px">&#10003; '+esc(d.identity||'Valid')+'</span>';
    }else{
      el.innerHTML='<span style="color:var(--er);font-size:10px">&#10007; '+esc(d.error||'Failed')+'</span>';
    }
  }).catch(function(e){
    el.innerHTML='<span style="color:var(--er);font-size:10px">Error: '+esc(e.message||'')+'</span>';
  });
}
function svPol(platform,i){
  var dm=$('gwdm'+i).value;var gp=$('gwgp'+i).value;
  localStorage.setItem('cc_gw_dm_'+platform,dm);
  localStorage.setItem('cc_gw_grp_'+platform,gp);
  ap('/api/gateway/'+platform+'/policy',{method:'POST',body:JSON.stringify({dmPolicy:dm,groupPolicy:gp})}).catch(function(){});
}
function tgSk(slug,on){
  localStorage.setItem('cc_sk_'+slug,on?'on':'off');
  ap('/api/skills/'+slug+'/toggle',{method:'POST',body:JSON.stringify({enabled:on})}).catch(function(){});
  fSk();
}
function tgMcp(name,el){
  var k='cc_mcp_'+name;var cur=localStorage.getItem(k)==='on';
  var newState=!cur;
  localStorage.setItem(k,newState?'on':'off');
  el.textContent=newState?'Connecting...':'Disconnecting...';
  el.disabled=true;
  // Call backend (will be available when MCP manager is implemented)
  ap('/api/mcp/'+(newState?'connect':'disconnect'),{method:'POST',body:JSON.stringify({preset:name})}).then(function(){
    el.textContent=newState?'Connected':'Connect';
    el.className=newState?'btn btn-p':'btn';
    el.disabled=false;
  }).catch(function(){
    el.textContent=newState?'Connected':'Connect';
    el.className=newState?'btn btn-p':'btn';
    el.disabled=false;
  });
  lMcp();
}

function lMcp(){
  ap('/api/system/status').then(function(d){
    var mc=d.mcp;
    if(!mc){$('mcpSt').innerHTML='<div class="mcp-blk"><div class="mcp-row"><span class="lbl">Status</span><span class="val" style="color:var(--t3)">No MCP client configured</span></div></div>';return}
    var ok=!mc.degraded;
    var h='<div class="mcp-blk">';
    h+='<div class="mcp-row"><span class="lbl">Status</span><span class="val" style="color:var('+(ok?'--ok':'--er')+');">'+(ok?'Healthy':'Degraded')+'</span></div>';
    h+='<div class="mcp-row"><span class="lbl">Cached Tools</span><span class="val">'+esc(''+(mc.cachedTools||0))+'</span></div>';
    h+='<div class="mcp-row"><span class="lbl">Revision</span><span class="val">'+esc(''+(mc.toolsRevision||0))+'</span></div>';
    h+='<div class="mcp-row"><span class="lbl">Resources</span><span class="val">'+(mc.supportsResources?'<span style="color:var(--ok)">Supported</span>':'<span style="color:var(--t3)">Unsupported</span>')+'</span></div>';
    h+='<div class="mcp-row"><span class="lbl">Prompts</span><span class="val">'+(mc.supportsPrompts?'<span style="color:var(--ok)">Supported</span>':'<span style="color:var(--t3)">Unsupported</span>')+'</span></div>';
    if(mc.lastError)h+='<div class="mcp-row"><span class="lbl">Last Error</span><span class="val" style="color:var(--er)">'+esc(mc.lastError)+'</span></div>';
    if(mc.lastRefreshAt)h+='<div class="mcp-row"><span class="lbl">Last Refresh</span><span class="val">'+esc(mc.lastRefreshAt)+'</span></div>';
    h+='</div>';
    $('mcpSt').innerHTML=h;
  }).catch(function(){$('mcpSt').innerHTML='<div class="em"><div class="em-s">Could not load MCP status</div></div>'});

  if(aPre){rMcpPr();return}
  ap('/api/presets').then(function(d){aPre=d;rMcpPr()}).catch(function(){});
}
function rMcpPr(){
  var mcps=(aPre&&aPre.mcp)||[];
  $('mcpPr').innerHTML=mcps.map(function(m){
    var isOn=localStorage.getItem('cc_mcp_'+m.name)==='on';
    return'<div class="card'+(isOn?' style="border-color:var(--ok)"':'')+'"><div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><div class="led '+(isOn?'ok':'')+'"></div><h4 style="font-size:12px;font-weight:600">'+esc(m.name)+'</h4></div><div style="font-size:10px;color:var(--t2);line-height:1.5;margin-bottom:6px">'+esc(m.description||'')+'</div><button class="btn'+(isOn?' btn-p':'')+'" onclick="tgMcp(\\''+esc(m.name)+'\\',this)">'+(isOn?'Connected':'Connect')+'</button></div>';
  }).join('')||'<div class="em"><div class="em-s">No MCP presets available</div></div>';
}

function lCfg(){
  ap('/api/system/status').then(function(d){
    var mc=d.mcp;var mcL=mc?(mc.degraded?'degraded':'healthy ('+mc.cachedTools+' cached tools)'):'not configured';
    var ps=[
      ['Service',d.service||'--'],
      ['Version',d.version||'--'],
      ['Deployment',d.deployment||'--'],
      ['Model',d.model||'--'],
      ['Provider',d.provider||'--'],
      ['Tools',''+(d.tools||[]).length],
      ['MCP Status',mcL],
      ['Plugins',(d.plugins||[]).join(', ')||'none']
    ];
    $('cfB').innerHTML='<div class="cfg-blk">'+ps.map(function(p){return'<div class="kv"><span class="kv-k">'+esc(p[0])+'</span><span class="kv-v">'+esc(p[1])+'</span></div>'}).join('')+'</div>';
  }).catch(function(){$('cfB').innerHTML='<div class="em"><div class="em-s">Could not load configuration</div></div>'});
}

function lCfgState(){
  ap('/api/config/snapshot').then(function(d){
    if(d.activePreset)actPre=d.activePreset;
    if(d.activeToolset)actTs=d.activeToolset;
    if(d.disabledSkills){d.disabledSkills.forEach(function(s){localStorage.setItem('cc_sk_'+s,'off')})}
  }).catch(function(){});
}

chk();lT();rSel();lCfgState();connectSSE();lSessions();
if(sid)$('sSel').value=sid;
setInterval(chk,10000);

// Onboarding
var obStep=0;
function obShow(){
  var sel=$('obPre');
  (aPre&&aPre.agents||[]).forEach(function(a){
    var o=document.createElement('option');o.value=a.name;o.textContent=a.name+' \\u2014 '+a.role;sel.appendChild(o);
  });
  $('obOv').classList.add('on');
}
function obSkip(){$('obOv').classList.remove('on');localStorage.setItem('cc_onboarded','1')}
function obNav(dir){
  obStep+=dir;
  if(obStep>2){
    var key=$('obKey').value.trim();
    var url=$('obUrl').value.trim();
    var mod=$('obMod').value;
    var pre=$('obPre').value;
    if(key)localStorage.setItem('cc_api_key',key);
    if(url)localStorage.setItem('cc_api_url',url);
    if(mod)localStorage.setItem('cc_model',mod);
    ap('/api/config/provider',{method:'POST',body:JSON.stringify({apiKey:key,baseUrl:url,model:mod})}).catch(function(){});
    if(pre){
      var preset=(aPre&&aPre.agents||[]).find(function(a){return a.name===pre});
      if(preset)ap('/api/agent/preset',{method:'POST',body:JSON.stringify({name:pre,role:preset.role,goal:preset.goal,backstory:preset.backstory})}).catch(function(){});
    }
    localStorage.setItem('cc_onboarded','1');
    $('obOv').classList.remove('on');
    chk();lT();
    return;
  }
  if(obStep<0)obStep=0;
  for(var i=0;i<3;i++){
    $('obs'+i).classList.toggle('on',i===obStep);
    $('obd'+i).classList.toggle('on',i===obStep);
  }
  $('obBack').style.display=obStep>0?'inline-flex':'none';
  $('obNext').textContent=obStep===2?'Finish':'Next';
}

// Jobs
function lJobs(){
  ap('/api/scheduler/jobs').then(function(d){
    var jobs=Array.isArray(d)?d:d.jobs||[];
    $('nJb').textContent=jobs.length;
    if(!jobs.length){$('jbLs').innerHTML='<div class="em"><div class="em-s">No scheduled jobs</div></div>';return}
    $('jbLs').innerHTML=jobs.map(function(j){
      var st=j.lastRunStatus||'pending';
      var stCls=st==='success'?'ok':st==='error'?'er':'';
      return '<div class="card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-family:var(--m);font-size:12px;font-weight:600">'+esc(j.id)+'</span><span class="tag '+(j.enabled?'ok':'er')+'">'+(j.enabled?'active':'paused')+'</span></div>'
        +'<div style="font-size:11px;color:var(--t2);margin-bottom:6px">'+esc(j.task)+'</div>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap;font-size:10px;font-family:var(--m);color:var(--t3)">'
        +'<span>'+esc(j.schedule)+'</span>'
        +'<span>runs: '+(j.runCount||0)+'</span>'
        +(j.lastRunAt?'<span>last: '+ago(j.lastRunAt)+'</span>':'')
        +(st!=='pending'?'<span class="tag '+stCls+'">'+st+'</span>':'')
        +'</div></div>';
    }).join('');
  }).catch(function(){$('jbLs').innerHTML='<div class="em"><div class="em-s">Could not load jobs</div></div>'});
}
function jbTick(){
  ap('/api/scheduler/tick',{method:'POST'}).then(function(d){
    addLog('scheduler: tick executed');
    lJobs();
  }).catch(function(){});
}
function jbCreate(){
  var id=prompt('Job ID:');if(!id)return;
  var task=prompt('Task (prompt):');if(!task)return;
  var mins=prompt('Interval (minutes):','60');
  ap('/api/scheduler/jobs',{method:'POST',body:JSON.stringify({id:id,task:task,everyMinutes:parseInt(mins)||60})}).then(function(){addLog('scheduler: created job '+id);lJobs()}).catch(function(){});
}

// Logs
var logEntries=[];
function addLog(msg){
  logEntries.push({t:new Date().toISOString(),m:msg});
  if(logEntries.length>200)logEntries.shift();
  rLogs();
}
function rLogs(){
  var el=$('logOut');if(!el)return;
  el.innerHTML=logEntries.slice().reverse().map(function(e){
    return '<div style="padding:2px 0;border-bottom:1px solid var(--bd)"><span style="color:var(--t3)">'+e.t.slice(11,19)+'</span> '+esc(e.m)+'</div>';
  }).join('');
}

ap('/api/system/status').then(function(d){
  if(d.provider==='none'&&!localStorage.getItem('cc_onboarded')){
    ap('/api/presets').then(function(p){aPre=p;obShow()}).catch(function(){obShow()});
  }
}).catch(function(){});
</script>
</body>
</html>`;

/**
 * Creates a fetch handler that serves the dashboard and proxies API calls.
 */
export function createDashboardHandler(
  runtimeFetch: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/dashboard') {
      return new Response(DASHBOARD_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    return runtimeFetch(req);
  };
}

export const webPackage = {
  name: '@crowclaw/web',
  purpose:
    'CrowClaw web dashboard — a single-page application for managing agent sessions, tools, and memory.',
};
