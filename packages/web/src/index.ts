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
:root{--bg-primary:#0d1117;--bg-secondary:#161b22;--bg-tertiary:#1c2128;--bg-card:#21262d;--text-primary:#e6edf3;--text-secondary:#8b949e;--text-muted:#484f58;--accent:#c0392b;--accent-hover:#e74c3c;--success:#27ae60;--warning:#f39c12;--error:#e74c3c;--border:#30363d;--font-mono:'SF Mono','Fira Code','JetBrains Mono',monospace;--font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--radius:6px;--transition:150ms ease;--b0:var(--bg-primary);--b1:var(--bg-secondary);--b2:var(--bg-tertiary);--b3:var(--bg-card);--bd:var(--border);--t0:var(--text-primary);--t1:#c8cdd6;--t2:var(--text-secondary);--t3:var(--text-muted);--ac:var(--accent);--ah:var(--accent-hover);--as:rgba(192,57,43,.07);--ok:var(--success);--wn:var(--warning);--er:var(--error);--m:var(--font-mono);--s:'Inter','Noto Sans KR',var(--font-sans)}
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
.ni{display:flex;align-items:center;gap:9px;padding:7px 12px;font-size:13px;color:var(--t2);cursor:pointer;transition:all var(--transition);border-left:2px solid transparent;margin-bottom:1px}
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
.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 12px;border:1px solid var(--bd);background:var(--b3);color:var(--t1);font-size:11px;font-weight:500;font-family:var(--s);cursor:pointer;transition:all var(--transition);outline:none}
.btn:hover{background:rgba(255,255,255,.04);border-color:var(--t3)}
.btn:active{opacity:.85}
.btn-p{background:linear-gradient(135deg,var(--ac) 0%,#a0301f 100%);border-color:transparent;color:#fff}
.btn-p:hover{background:linear-gradient(135deg,var(--ah) 0%,var(--ac) 100%)}
.btn-danger{background:rgba(231,76,60,.1);border-color:var(--er);color:var(--er)}
.btn-danger:hover{background:rgba(231,76,60,.2)}
.em{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 0;gap:6px;opacity:.5}
.em-t{font-size:14px;font-weight:600;color:var(--t1)}
.em-s{font-size:11px;color:var(--t3)}
.card{background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.6) 100%);border:1px solid var(--bd);padding:14px 18px;transition:all var(--transition)}
.card:hover{border-color:var(--t3);background:linear-gradient(145deg,rgba(22,27,38,.9) 0%,var(--b2) 100%)}
.tag{display:inline-block;padding:2px 5px;background:var(--b3);font-size:9px;font-weight:500;font-family:var(--m);color:var(--t2);letter-spacing:.2px}
.tag.ok{color:var(--ok);background:rgba(39,174,96,.1)}.tag.er{color:var(--er);background:rgba(231,76,60,.1)}.tag.wn{color:var(--wn);background:rgba(243,156,18,.1)}.tag.ac{color:var(--ac);background:rgba(192,57,43,.1)}
.srch{width:100%;padding:7px 12px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:12px;font-family:var(--s);outline:none;margin-bottom:14px}
.srch:focus{border-color:var(--ac)}.srch::placeholder{color:var(--t3)}
.sec-h{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:var(--t3);margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px}
.kv{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;font-size:12px;border-bottom:1px solid var(--bd)}
.kv:last-child{border-bottom:none}
.kv-k{color:var(--t2);font-weight:500}.kv-v{color:var(--t0);font-family:var(--m);font-size:11px}
.tabs{display:flex;gap:0;border-bottom:1px solid var(--bd);margin-bottom:14px}
.tab{padding:7px 14px;font-size:11px;font-weight:500;color:var(--t3);cursor:pointer;border-bottom:2px solid transparent;transition:all var(--transition)}
.tab:hover{color:var(--t1)}.tab.a{color:var(--ac);border-bottom-color:var(--ac);background:linear-gradient(180deg,transparent 0%,rgba(192,57,43,.04) 100%)}
.vw{display:none}.vw.on{display:flex;flex-direction:column;flex:1;overflow:hidden;animation:fadePanel var(--transition) ease}
@keyframes fadePanel{from{opacity:0}to{opacity:1}}
.skeleton{background:linear-gradient(90deg,var(--b2) 25%,var(--b3) 50%,var(--b2) 75%);background-size:200% 100%;animation:skPulse 1.5s ease infinite;height:14px;margin-bottom:8px}
@keyframes skPulse{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skeleton-block{height:60px}
.err-state{background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.3);padding:16px;display:flex;flex-direction:column;align-items:center;gap:8px}
.err-state .err-msg{font-size:12px;color:var(--er);font-weight:500}
.err-state .btn{margin-top:4px}
.chat-area{display:flex;flex:1;overflow:hidden}
.sess-sidebar{width:200px;border-right:1px solid var(--bd);display:flex;flex-direction:column;background:var(--b1);flex-shrink:0;overflow:hidden}
.sess-sidebar .sess-hdr{display:flex;align-items:center;gap:6px;padding:10px 10px 8px;border-bottom:1px solid var(--bd)}
.sess-sidebar .sess-hdr input{flex:1;padding:5px 8px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:10px;font-family:var(--s);outline:none}
.sess-sidebar .sess-hdr input:focus{border-color:var(--ac)}
.sess-sidebar .sess-hdr input::placeholder{color:var(--t3)}
.sess-sidebar .sess-hdr button{width:24px;height:24px;border:1px solid var(--bd);background:var(--ac);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;transition:background var(--transition)}
.sess-sidebar .sess-hdr button:hover{background:var(--ah)}
.sess-list{flex:1;overflow-y:auto;padding:4px 0}
.sess-item{padding:8px 10px;cursor:pointer;border-left:2px solid transparent;transition:all var(--transition);position:relative}
.sess-item:hover{background:rgba(255,255,255,.02)}
.sess-item.active{background:linear-gradient(90deg,rgba(192,57,43,.1) 0%,rgba(192,57,43,.02) 100%);border-left-color:var(--ac)}
.sess-item .sess-title{font-size:11px;font-weight:500;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px}
.sess-item .sess-meta{display:flex;gap:6px;font-size:9px;color:var(--t3);font-family:var(--m);margin-top:2px}
.sess-item .sess-ctx{height:3px;background:var(--b3);margin-top:3px;overflow:hidden}
.sess-item .sess-ctx-bar{height:100%;background:var(--ac);transition:width var(--transition)}
.sess-item .sess-actions{position:absolute;right:6px;top:6px;display:none;gap:3px}
.sess-item:hover .sess-actions{display:flex}
.sess-actions button{width:18px;height:18px;border:none;background:var(--b3);color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;transition:all var(--transition)}
.sess-actions button:hover{color:var(--t0);background:var(--b2)}
.sess-rename-input{width:100%;padding:3px 6px;border:1px solid var(--ac);background:var(--b2);color:var(--t0);font-size:11px;font-family:var(--s);outline:none}
.sess-toggle{display:none;position:absolute;top:10px;left:10px;width:28px;height:28px;border:1px solid var(--bd);background:var(--b2);color:var(--t1);cursor:pointer;z-index:50;font-size:14px;align-items:center;justify-content:center}
.chat-bar{display:flex;align-items:center;gap:10px;padding:12px 28px 0;flex-shrink:0}
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
.ci-f{display:flex;align-items:center;gap:6px;padding:3px 3px 3px 14px;border:1px solid var(--bd);background:var(--b2);transition:border-color var(--transition)}
.ci-f:focus-within{border-color:var(--ac)}
.ci-f input{flex:1;padding:7px 0;border:none;background:transparent;color:var(--t0);font-size:12px;font-family:var(--s);outline:none}
.ci-f input::placeholder{color:var(--t3)}
.snd{width:30px;height:30px;border:none;background:linear-gradient(135deg,var(--ac) 0%,#a0301f 100%);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all var(--transition);flex-shrink:0}
.snd:hover{background:linear-gradient(135deg,var(--ah) 0%,var(--ac) 100%)}.snd:active{opacity:.85}
.snd svg{width:13px;height:13px}
.tc{background:var(--b1);border:1px solid var(--bd);margin:3px 0;overflow:hidden}.tc:hover{border-color:var(--t3)}
.tc-h{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none}
.tc-ic{width:16px;height:16px;background:var(--wn);display:flex;align-items:center;justify-content:center;font-size:8px;color:var(--b0);font-weight:700;flex-shrink:0}
.tc-n{font-size:11px;font-family:var(--m);color:var(--t1)}
.tc-s{margin-left:auto;font-size:9px;font-weight:600}.tc-s.ok{color:var(--ok)}.tc-s.er{color:var(--er)}
.tc-c{color:var(--t3);transition:transform var(--transition);font-size:9px}.tc.op .tc-c{transform:rotate(90deg)}
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
.sk-card{background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.6) 100%);border:1px solid var(--bd);padding:14px 18px;transition:all var(--transition)}
.sk-card:hover{border-color:var(--t3);background:linear-gradient(145deg,rgba(22,27,38,.9) 0%,var(--b2) 100%)}
.sk-card h4{font-size:13px;font-weight:600;margin-bottom:3px}
.sk-card .sk-sum{font-size:11px;color:var(--t2);line-height:1.5;margin-bottom:6px}
.sk-card .sk-tags{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px}
.sk-steps{list-style:none;padding:0;counter-reset:sk}.sk-steps.hide{display:none}
.sk-steps li{font-size:10px;color:var(--t2);padding:1px 0;counter-increment:sk;font-family:var(--m)}
.sk-steps li::before{content:counter(sk) ". ";color:var(--t3);font-weight:600}
.sk-tog{font-size:10px;color:var(--ac);cursor:pointer;font-weight:500;display:inline-block}.sk-tog:hover{color:var(--ah)}
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
.sw-sl{position:absolute;inset:0;background:var(--b3);transition:all var(--transition)}
.sw-sl::before{content:'';position:absolute;height:10px;width:10px;left:2px;bottom:2px;background:var(--t3);transition:all var(--transition)}
.sw input:checked+.sw-sl{background:rgba(39,174,96,.2)}
.sw input:checked+.sw-sl::before{transform:translateX(14px);background:var(--ok)}
.gw-card{background:linear-gradient(145deg,var(--b2) 0%,rgba(22,27,38,.6) 100%);border:1px solid var(--bd);padding:14px 18px;transition:all var(--transition)}
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
.pre-card{background:var(--b2);border:1px solid var(--bd);padding:14px 18px;transition:border-color var(--transition)}
.pre-card:hover{border-color:var(--t3)}
.pre-card h4{font-size:13px;font-weight:600;margin-bottom:2px}
.pre-card .role{font-size:10px;color:var(--ac);font-weight:500;margin-bottom:4px}
.pre-card .goal{font-size:11px;color:var(--t2);line-height:1.5;margin-bottom:8px}
.pre-card .tr{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px}
.tl-card{background:var(--b2);border:1px solid var(--bd);padding:12px 16px;transition:border-color var(--transition)}
.tl-card:hover{border-color:var(--t3)}
.tl-card .tl-nm{font-family:var(--m);font-size:11px;font-weight:500;color:var(--t0);margin-bottom:2px}
.tl-card .tl-ds{font-size:10px;color:var(--t3);line-height:1.5;margin-bottom:6px}
.tl-card .tl-mt{display:flex;align-items:center;gap:5px}
.ob-overlay{position:fixed;inset:0;background:rgba(6,8,13,.92);z-index:200;display:none;align-items:center;justify-content:center;backdrop-filter:blur(8px)}
.ob-overlay.on{display:flex}
.ob-box{width:520px;max-width:calc(100vw - 32px);background:var(--b1);border:1px solid var(--bd);box-shadow:0 24px 64px rgba(0,0,0,.6);padding:32px}
.ob-box h2{font-size:18px;font-weight:700;margin-bottom:4px;background:linear-gradient(90deg,var(--t0) 0%,var(--ac) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.ob-box p{font-size:12px;color:var(--t2);margin-bottom:20px;line-height:1.6}
.ob-step{display:none;transition:opacity .25s ease,transform .25s ease}.ob-step.on{display:block}
.ob-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:6px}
.ob-input{width:100%;padding:10px 14px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:13px;font-family:var(--m);outline:none;margin-bottom:16px}
.ob-input:focus{border-color:var(--ac)}
.ob-select{width:100%;padding:10px 14px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:13px;font-family:var(--m);outline:none;margin-bottom:16px;-webkit-appearance:none;appearance:none}
.ob-select:focus{border-color:var(--ac)}
.ob-dots{display:flex;gap:6px;justify-content:center;margin-bottom:20px}
.ob-dot{width:8px;height:8px;background:var(--b3);transition:all .2s}.ob-dot.on{background:var(--ac)}
.ob-nav{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.ob-skip{font-size:11px;color:var(--t3);cursor:pointer;background:none;border:none;font-family:var(--s)}.ob-skip:hover{color:var(--t2)}
.ob-provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.ob-pcard{background:var(--b2);border:1px solid var(--bd);padding:14px;cursor:pointer;transition:all var(--transition)}
.ob-pcard:hover{border-color:var(--t3)}
.ob-pcard.sel{border-color:var(--ac);background:rgba(192,57,43,.08)}
.ob-pcard h4{font-size:13px;font-weight:600;margin-bottom:2px}
.ob-pcard .ob-pcard-desc{font-size:10px;color:var(--t3);line-height:1.4}
.ob-key-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--t3);cursor:pointer;font-size:11px;font-family:var(--s)}
.ob-key-toggle:hover{color:var(--t1)}
.ob-test-result{font-size:11px;margin-bottom:12px;padding:6px 10px;display:none}
.ob-test-result.ok{display:block;color:var(--ok);background:rgba(39,174,96,.08);border:1px solid rgba(39,174,96,.2)}
.ob-test-result.er{display:block;color:var(--er);background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.2)}
.ob-spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--t3);border-top-color:transparent;animation:spin .8s linear infinite;vertical-align:middle;margin-right:4px}
.ob-model-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.ob-mcard{background:var(--b2);border:1px solid var(--bd);padding:10px 14px;cursor:pointer;transition:all var(--transition);font-size:12px}
.ob-mcard:hover{border-color:var(--t3)}
.ob-mcard.sel{border-color:var(--ac);background:rgba(192,57,43,.08)}
.ob-mcard .ob-mcard-name{font-weight:600;font-size:11px;font-family:var(--m)}
.ob-preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.ob-prcard{background:var(--b2);border:1px solid var(--bd);padding:10px 14px;cursor:pointer;transition:all var(--transition)}
.ob-prcard:hover{border-color:var(--t3)}
.ob-prcard.sel{border-color:var(--ac);background:rgba(192,57,43,.08)}
.ob-prcard h4{font-size:12px;font-weight:600;margin-bottom:2px}
.ob-prcard .ob-prcard-desc{font-size:10px;color:var(--t3)}
.auth-overlay{position:fixed;inset:0;background:rgba(6,8,13,.96);z-index:300;display:none;align-items:center;justify-content:center;backdrop-filter:blur(12px)}
.auth-overlay.on{display:flex}
.auth-box{width:360px;background:var(--b1);border:1px solid var(--bd);box-shadow:0 24px 64px rgba(0,0,0,.7);padding:32px;text-align:center}
.auth-box h2{font-size:18px;font-weight:700;margin-bottom:4px;background:linear-gradient(90deg,var(--t0) 0%,var(--ac) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.auth-box p{font-size:12px;color:var(--t2);margin-bottom:20px}
.auth-box input{width:100%;padding:10px 14px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:13px;font-family:var(--m);outline:none;margin-bottom:12px;text-align:center}
.auth-box input:focus{border-color:var(--ac)}
.auth-box .auth-err{font-size:11px;color:var(--er);margin-bottom:8px;min-height:16px}
@keyframes authShake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
.auth-box.shake{animation:authShake .4s ease}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:150;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);animation:modalIn var(--transition) ease}
.modal-overlay.on{display:flex}
@keyframes modalIn{from{opacity:0}to{opacity:1}}
.modal-box{width:520px;max-height:80vh;background:var(--b1);border:1px solid var(--bd);box-shadow:0 16px 48px rgba(0,0,0,.5);overflow-y:auto;animation:modalScale var(--transition) ease}
@keyframes modalScale{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.modal-hdr{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--bd)}
.modal-hdr h3{font-size:14px;font-weight:600}
.modal-close{width:24px;height:24px;border:none;background:transparent;color:var(--t3);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center}
.modal-close:hover{color:var(--t0)}
.modal-body{padding:16px 20px}
.modal-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--bd)}
.form-group{margin-bottom:12px}
.form-label{display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--t3);margin-bottom:4px}
.form-input{width:100%;padding:7px 10px;border:1px solid var(--bd);background:var(--b2);color:var(--t0);font-size:12px;font-family:var(--s);outline:none}
.form-input:focus{border-color:var(--ac)}.form-input::placeholder{color:var(--t3)}
textarea.form-input{min-height:60px;resize:vertical;font-family:var(--m);font-size:11px;line-height:1.6}
select.form-input{-webkit-appearance:none;appearance:none;cursor:pointer}
.form-radio-group{display:flex;gap:12px;margin-top:4px}
.form-radio{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--t1);cursor:pointer}
.form-radio input[type=radio]{accent-color:var(--ac)}
.form-hint{font-size:10px;color:var(--t3);margin-top:3px;font-style:italic}
.form-checkbox-group{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.form-checkbox{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--t1);cursor:pointer;padding:3px 6px;background:var(--b2);border:1px solid var(--bd)}
.form-checkbox:hover{border-color:var(--t3)}
.form-checkbox input[type=checkbox]{accent-color:var(--ac)}
.mem-table{width:100%;border-collapse:collapse;font-size:11px}
.mem-table th{text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--t3);padding:6px 10px;border-bottom:1px solid var(--bd)}
.mem-table td{padding:8px 10px;border-bottom:1px solid var(--bd);color:var(--t1);cursor:pointer;transition:background var(--transition)}
.mem-table tr:hover td{background:rgba(255,255,255,.02)}
.mem-table .mem-content{max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mem-table .mem-del{width:24px;height:24px;border:none;background:transparent;color:var(--t3);cursor:pointer;font-size:12px;transition:color var(--transition)}
.mem-table .mem-del:hover{color:var(--er)}
.hamburger{display:none;position:fixed;top:12px;left:12px;width:36px;height:36px;border:1px solid var(--bd);background:var(--b1);color:var(--t1);cursor:pointer;z-index:60;font-size:18px;align-items:center;justify-content:center}
@media (max-width:768px){
.app{grid-template-columns:1fr}
.sb{position:fixed;left:-232px;top:0;bottom:0;z-index:55;transition:left .25s ease;width:232px}
.sb.mobile-open{left:0}
.mobile-backdrop.on{display:block}
.hamburger{display:flex}
.sess-sidebar{display:none}
.sess-toggle{display:flex}
.chat-area{flex-direction:column}
.cp-box{width:calc(100vw - 32px)}
.modal-box{width:calc(100vw - 32px)}
.auth-box{width:calc(100vw - 32px)}
.grid{grid-template-columns:1fr}
.ci{position:sticky;bottom:0;background:var(--b0);padding:6px 0 10px}
.mem-table{display:block;overflow-x:auto}
}
.msg-streaming{position:relative}
.cursor-blink{display:inline-block;width:2px;height:1em;background:var(--ac);margin-left:2px;animation:blink 1s step-end infinite;vertical-align:text-bottom}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.tool-block{border:1px solid var(--bd);margin:4px 0;overflow:hidden;align-self:flex-start;max-width:82%}
.tool-block.tool-running{border-color:var(--wn);background:rgba(243,156,18,.05)}
.tool-block.tool-success{border-color:var(--ok);background:rgba(39,174,96,.05)}
.tool-block.tool-error{border-color:var(--er);background:rgba(231,76,60,.05)}
.tb-h{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:11px}
.tb-nm{font-family:var(--m);font-weight:500;color:var(--t1)}
.tb-body{padding:0 10px 6px;font-family:var(--m);font-size:9px;color:var(--t2);line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;border-top:1px solid var(--bd)}
.tb-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--wn);border-top-color:transparent;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.trace-panel{position:fixed;right:0;top:0;bottom:0;width:280px;background:var(--b1);border-left:1px solid var(--bd);z-index:80;display:none;flex-direction:column;overflow:hidden}
.trace-panel.on{display:flex}
.trace-toggle{position:fixed;right:12px;bottom:12px;width:32px;height:32px;border:1px solid var(--bd);background:var(--b2);color:var(--t1);cursor:pointer;z-index:81;font-size:14px;display:flex;align-items:center;justify-content:center}
.trace-toggle:hover{border-color:var(--ac);color:var(--ac)}
.tp-hdr{padding:10px 12px;border-bottom:1px solid var(--bd);font-size:11px;font-weight:600;color:var(--t1)}
.tp-body{flex:1;overflow-y:auto;padding:8px 12px;font-size:10px;font-family:var(--m);color:var(--t2);line-height:1.7}
.tp-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--bd)}
.tp-row:last-child{border-bottom:none}
.tp-step{padding:6px 0;border-bottom:1px solid var(--bd);font-size:10px;color:var(--t2)}
.iter-sep{text-align:center;padding:4px 0;font-size:9px;color:var(--t3);font-weight:600;letter-spacing:1px;text-transform:uppercase}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:8px 16px;background:var(--b3);border:1px solid var(--bd);color:var(--t1);font-size:11px;font-weight:500;z-index:500;animation:toastIn .3s ease;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.toast.error{border-color:var(--er);color:var(--er)}
@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
</style>
</head>
<body>
<div class="mobile-backdrop" id="mobBack" onclick="closeMobileSb()"></div>
<button class="hamburger" id="hamBtn" onclick="toggleMobileSb()">&#9776;</button>
<div class="auth-overlay" id="authOv"><div class="auth-box" id="authBox"><h2>CrowClaw</h2><p>Enter your dashboard token to continue.</p><input id="authIn" type="password" placeholder="Dashboard token..." onkeydown="if(event.key==='Enter')authSubmit()"><div class="auth-err" id="authErr"></div><button class="btn btn-p" style="width:100%" onclick="authSubmit()">Sign In</button></div></div>
<div class="app">
  <aside class="sb" id="sbEl">
    <div class="sb-logo"><img src="/docs/logo.png" alt="CrowClaw"><span>CrowClaw</span></div>
    <nav class="sb-nav">
      <div class="sb-s"><div class="sb-l">General</div>
        <div class="ni a" data-v="chat" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>Chat<span class="ct" id="nSs">0</span></div>
        <div class="ni" data-v="memory" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>Memory</div>
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
        <div class="ni" data-v="usage" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>Usage</div>
        <div class="ni" data-v="logs" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Logs</div>
        <div class="ni" data-v="settings" onclick="go(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>Settings</div>
      </div>
    </nav>
    <div class="sb-ft"><div class="sb-ft-r"><div class="led" id="sLed"></div><span id="sLbl">Connecting</span></div><div class="sb-ft-r"><span class="ft-stat" id="ftMod"></span></div><div class="sb-ft-r"><span class="ft-stat" id="ftTl"></span></div></div>
  </aside>
  <main class="mn">
    <div class="vw on" id="v-chat"><div class="chat-area"><div class="sess-sidebar" id="sessSb"><div class="sess-hdr"><input id="sessSearch" placeholder="Search sessions..." oninput="filterSessions()"><button onclick="mkS()" title="New Session">+</button></div><div class="sess-list" id="sessList"></div></div><div style="display:flex;flex-direction:column;flex:1;overflow:hidden"><button class="sess-toggle" id="sessToggle" onclick="toggleSessSidebar()">&#9776;</button><div class="cw"><div class="cm" id="cMs"><div class="em"><div class="em-t">No Session</div><div class="em-s">Create a session to start</div></div></div><div class="ci"><div class="ci-f"><input id="mIn" placeholder="Send a message..." onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sndStream()}"><button class="snd" onclick="sndStream()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div></div></div></div></div><button class="trace-toggle" id="trBtn" onclick="toggleTrace()">T</button><div class="trace-panel" id="trPanel"><div class="tp-hdr">Trace</div><div class="tp-body"><div class="tp-row"><span>Iteration</span><span id="trIter">0</span></div><div class="tp-row"><span>Tool</span><span id="trTool">--</span></div><div class="tp-row"><span>Tokens</span><span id="trTokens">0</span></div><div class="tp-row"><span>Elapsed</span><span id="trElapsed">0ms</span></div><div id="trSteps"></div></div></div></div>
    <div class="vw" id="v-memory"><div class="mh"><h2>Memory Browser</h2><p>Search, view, and manage agent memories</p></div><div class="mb"><div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"><input class="srch" id="memSrch" style="flex:1;margin-bottom:0;min-width:200px" placeholder="Search memories..." oninput="filterMemories()"><select class="form-input" id="memScope" style="width:auto;min-width:120px" onchange="loadMemories()"><option value="">All scopes</option><option value="session">Session</option><option value="user">User</option><option value="workspace">Workspace</option></select></div><div id="memList"><div class="em"><div class="em-t">No memories yet</div><div class="em-s">Memories will appear here as the agent captures them</div></div></div></div></div>
    <div class="vw" id="v-presets"><div class="mh"><h2>Presets</h2><p>Agent personas, toolsets, and MCP configurations</p></div><div class="mb"><div class="tabs" id="pTabs"><div class="tab a" data-pt="agent" onclick="pTab(this)">Agent</div><div class="tab" data-pt="toolset" onclick="pTab(this)">Toolset</div><div class="tab" data-pt="mcp-p" onclick="pTab(this)">MCP</div></div><div id="pAgent" class="grid"></div><div id="pToolset" class="grid" style="display:none"></div><div id="pMcpP" class="grid" style="display:none"></div></div></div>
    <div class="vw" id="v-skills"><div class="mh"><h2>Skills</h2><p>Built-in agent capabilities</p></div><div class="mb"><input class="srch" id="skSr" placeholder="Filter skills..." oninput="fSk()"><div id="skLs"></div></div></div>
    <div class="vw" id="v-tools"><div class="mh"><h2>Tools</h2><p>Registered tool capabilities</p></div><div class="mb"><input class="srch" id="tlSr" placeholder="Filter tools..." oninput="fTl()"><div id="tGrd"></div></div></div>
    <div class="vw" id="v-gateway"><div class="mh"><h2>Gateway</h2><p>Platform integrations and webhook endpoints</p></div><div class="mb"><div class="grid" id="gGrd"></div></div></div>
    <div class="vw" id="v-mcp"><div class="mh"><h2>MCP</h2><p>Model Context Protocol servers and presets</p></div><div class="mb"><div class="sec-h">Server Status</div><div id="mcpSt"><div class="em"><div class="em-s">Loading MCP status...</div></div></div><div class="sec-h" style="margin-top:20px">Preset Library</div><div class="grid" id="mcpPr"></div></div></div>
    <div class="vw" id="v-jobs"><div class="mh"><h2>Scheduled Jobs</h2><p>Cron-style agent execution</p></div><div class="mb"><div style="display:flex;gap:8px;margin-bottom:14px"><button class="btn btn-p" onclick="jbModalOpen()">+ New Job</button><button class="btn" onclick="jbTick()">Tick Now</button></div><div id="jbLs"><div class="em"><div class="em-s">Loading jobs...</div></div></div></div></div>
    <div class="vw" id="v-usage"><div class="mh"><h2>Usage</h2><p>Token usage, cost tracking, and API call metrics</p></div><div class="mb"><div class="grid" id="uCards" style="margin-bottom:18px"></div><div class="sec-h">Per-Model Breakdown</div><div id="uModel" style="margin-bottom:18px"></div><div class="sec-h">Recent Entries <span style="font-weight:400;text-transform:none;letter-spacing:0">(last 20)</span></div><div id="uEntries"></div><div style="margin-top:14px"><button class="btn" onclick="uReset()">Reset Usage</button></div></div></div>
    <div class="vw" id="v-logs"><div class="mh"><h2>Activity Log</h2><p>Recent system events</p></div><div class="mb"><div id="logOut" style="font-family:var(--m);font-size:10px;color:var(--t2);line-height:1.8;max-height:calc(100vh - 160px);overflow-y:auto"></div></div></div>
    <div class="vw" id="v-settings"><div class="mh"><h2>Settings</h2><p>Current system configuration</p></div><div class="mb"><div id="cfB"><div class="em"><div class="em-s">Loading configuration...</div></div></div></div></div>
    <div class="cp-overlay" id="cpOv" onclick="if(event.target===this)cpClose()"><div class="cp-box"><input class="cp-input" id="cpIn" placeholder="Type a command..." oninput="cpFilter()" onkeydown="cpKey(event)"><div class="cp-list" id="cpList"></div><div class="cp-footer"><span>&#8593;&#8595; navigate</span><span>&#8629; select</span><span>esc close</span></div></div></div>
    <div class="modal-overlay" id="jbModal" onclick="if(event.target===this)jbModalClose()"><div class="modal-box" role="dialog" aria-label="Create Job"><div class="modal-hdr"><h3>Create Scheduled Job</h3><button class="modal-close" onclick="jbModalClose()">&times;</button></div><div class="modal-body"><div class="form-group"><label class="form-label">Job Name *</label><input class="form-input" id="jbName" placeholder="my-daily-report"></div><div class="form-group"><label class="form-label">Task / Prompt *</label><textarea class="form-input" id="jbTask" placeholder="Summarize today's metrics..."></textarea></div><div class="form-group"><label class="form-label">Schedule Type</label><div class="form-radio-group"><label class="form-radio"><input type="radio" name="jbSchedType" value="interval" checked onchange="jbSchedChange()">Every N minutes</label><label class="form-radio"><input type="radio" name="jbSchedType" value="cron" onchange="jbSchedChange()">Cron expression</label></div></div><div class="form-group"><label class="form-label">Schedule Value</label><input class="form-input" id="jbSchedVal" placeholder="60"><div class="form-hint" id="jbSchedHint">Runs every 60 minutes</div></div><div class="form-group"><label class="form-label">Model Override (optional)</label><select class="form-input" id="jbModel"><option value="">Default</option><option value="anthropic/claude-sonnet-4">Claude Sonnet 4</option><option value="openai/gpt-4o">GPT-4o</option></select></div><div class="form-group"><label class="form-label">Skills (optional)</label><div id="jbSkills" class="form-checkbox-group"></div></div><div class="form-group"><label class="form-label">Delivery Target (optional)</label><div style="display:flex;gap:6px"><select class="form-input" id="jbDelPlatform" style="width:auto;min-width:100px"><option value="">None</option><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="slack">Slack</option><option value="email">Email</option></select><input class="form-input" id="jbDelChannel" placeholder="Channel / recipient" style="flex:1"></div></div></div><div class="modal-footer"><button class="btn" onclick="jbModalClose()">Cancel</button><button class="btn btn-p" onclick="jbSubmit()">Create Job</button></div></div></div>
    <div class="modal-overlay" id="memModal" onclick="if(event.target===this)memModalClose()"><div class="modal-box" role="dialog" aria-label="Memory Detail"><div class="modal-hdr"><h3>Memory Detail</h3><button class="modal-close" onclick="memModalClose()">&times;</button></div><div class="modal-body" id="memModalBody"></div><div class="modal-footer"><button class="btn" onclick="memModalClose()">Close</button></div></div></div>
    <div class="ob-overlay" id="obOv"><div class="ob-box"><div id="obDots" class="ob-dots"></div><div class="ob-step on" id="obs0"><h2>CrowClaw</h2><p>Self-improving AI agent framework</p><p style="font-size:11px;color:var(--t3)">Set up your agent in under 60 seconds</p><div style="margin-top:20px;display:flex;gap:8px"><button class="btn btn-p" onclick="obNav(1)">Get Started</button><button class="ob-skip" onclick="obSkip()">Skip setup</button></div></div><div class="ob-step" id="obs1"><div class="ob-label">Choose Provider</div><div class="ob-provider-grid"><div class="ob-pcard" data-prov="openai" data-url="https://api.openai.com/v1" onclick="obSelProv(this)"><h4>OpenAI</h4><div class="ob-pcard-desc">GPT-4o, GPT-4.1, o-series</div></div><div class="ob-pcard" data-prov="anthropic" data-url="https://api.anthropic.com" onclick="obSelProv(this)"><h4>Anthropic</h4><div class="ob-pcard-desc">Claude 4, Claude Sonnet, Haiku</div></div><div class="ob-pcard" data-prov="openrouter" data-url="https://openrouter.ai/api/v1" onclick="obSelProv(this)"><h4>OpenRouter</h4><div class="ob-pcard-desc">200+ models, single API key</div></div><div class="ob-pcard" data-prov="custom" data-url="" onclick="obSelProv(this)"><h4>Custom</h4><div class="ob-pcard-desc">Any OpenAI-compatible endpoint</div></div></div></div><div class="ob-step" id="obs2"><div class="ob-label">API Key</div><div style="position:relative"><input class="ob-input" id="obKey" type="password" placeholder="sk-..."><button class="ob-key-toggle" onclick="obToggleKey()">show</button></div><div class="ob-label">Base URL</div><input class="ob-input" id="obUrl" value="" placeholder="https://api.openai.com/v1"><button class="btn" id="obTestBtn" onclick="obTestConn()" style="margin-bottom:8px">Test Connection</button><div class="ob-test-result" id="obTestRes"></div></div><div class="ob-step" id="obs3"><div class="ob-label">Select Model</div><div class="ob-model-grid" id="obModGrid"></div></div><div class="ob-step" id="obs4"><div class="ob-label">Agent Preset</div><div class="ob-preset-grid" id="obPreGrid"></div></div><div class="ob-step" id="obs5"><h2>CrowClaw is ready!</h2><p>Start chatting below</p><ul style="font-size:11px;color:var(--t2);list-style:none;padding:0;margin:12px 0"><li style="margin-bottom:4px">Press Cmd+K for quick commands</li><li>Explore Skills and Tools in the sidebar</li></ul><button class="btn btn-p" onclick="obFinish()">Start Chatting</button></div><div class="ob-nav" id="obNavBar"><button class="ob-skip" onclick="obSkip()">Skip setup</button><div><button class="btn" id="obBack" style="display:none" onclick="obNav(-1)">Back</button><button class="btn btn-p" id="obNext" style="display:none" onclick="obNav(1)">Next</button></div></div></div></div>
  </main>
</div>
<script>
var B=location.origin,sid=localStorage.getItem('cc_sid')||null,ss=[],aT=[],aPre=null,aSk=null,allMem=[];
var authToken=sessionStorage.getItem('cc_auth_token')||null;
function ap(p,o){var opts=Object.assign({headers:{'content-type':'application/json'}},o||{});if(authToken)opts.headers['Authorization']='Bearer '+authToken;return fetch(B+p,opts).then(function(r){if(r.status===401){showAuth();throw new Error('Unauthorized')}return r.json()})}
function esc(t){var d=document.createElement('div');d.textContent=t;return d.innerHTML}
function $(i){return document.getElementById(i)}
function ago(d){if(!d)return'--';var s=Math.floor((Date.now()-new Date(d).getTime())/1000);return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':Math.floor(s/86400)+'d ago'}
function showAuth(){$('authOv').classList.add('on')}
function hideAuth(){$('authOv').classList.remove('on')}
function authSubmit(){var tok=$('authIn').value.trim();if(!tok){$('authErr').textContent='Please enter a token';return}$('authErr').textContent='';fetch(B+'/api/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:tok})}).then(function(r){return r.json()}).then(function(d){if(d.ok){authToken=tok;sessionStorage.setItem('cc_auth_token',tok);hideAuth();initApp()}else{$('authErr').textContent='Invalid token';$('authBox').classList.add('shake');setTimeout(function(){$('authBox').classList.remove('shake')},500)}}).catch(function(){$('authErr').textContent='Connection error'})}
function checkAuth(){fetch(B+'/api/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:authToken||''})}).then(function(r){return r.json()}).then(function(d){if(d.ok||d.bypass){hideAuth();initApp()}else{showAuth()}}).catch(function(){initApp()})}
function toggleMobileSb(){var sb=$('sbEl');sb.classList.toggle('mobile-open');$('mobBack').classList.toggle('on',sb.classList.contains('mobile-open'))}
function closeMobileSb(){$('sbEl').classList.remove('mobile-open');$('mobBack').classList.remove('on')}
function toggleSessSidebar(){var sb=$('sessSb');sb.style.display=sb.style.display==='none'?'flex':'none'}
function md(r){if(!r)return'';var t=esc(r);t=t.replace(/\\\`\\\`\\\`(\\w*)?\\n([\\s\\S]*?)\\\`\\\`\\\`/g,function(_,l,c){return'<pre><code>'+c.trim()+'</code></pre>'});t=t.replace(/\\\`([^\\\`]+)\\\`/g,'<code>$1</code>');t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');t=t.replace(/\\*(.+?)\\*/g,'<em>$1</em>');t=t.replace(/^### (.+)$/gm,'<h3>$1</h3>');t=t.replace(/^## (.+)$/gm,'<h2>$1</h2>');t=t.replace(/^# (.+)$/gm,'<h1>$1</h1>');t=t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');t=t.replace(/^- (.+)$/gm,'<li>$1</li>');t=t.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');t=t.replace(/^---$/gm,'<hr>');t=t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');t=t.replace(/\\n\\n/g,'</p><p>');t=t.replace(/\\n/g,'<br>');return'<p>'+t+'</p>'}
function tcc(n,ok,out){var id='tc'+Math.random().toString(36).slice(2,7);return'<div class="tc" id="'+id+'"><div class="tc-h" onclick="document.getElementById(\\''+id+'\\').classList.toggle(\\'op\\')"><div class="tc-ic">T</div><span class="tc-n">'+esc(n)+'</span><span class="tc-s '+(ok?'ok':'er')+'">'+(ok?'done':'error')+'</span><span class="tc-c">&#9654;</span></div><div class="tc-b">'+esc(out)+'</div></div>'}
function go(el){var ns=document.querySelectorAll('.ni');for(var i=0;i<ns.length;i++)ns[i].classList.remove('a');el.classList.add('a');var v=el.getAttribute('data-v');var vs=document.querySelectorAll('.vw');for(var i=0;i<vs.length;i++)vs[i].classList.remove('on');$('v-'+v).classList.add('on');closeMobileSb();if(v==='chat'&&sid)lH();if(v==='memory')loadMemories();if(v==='tools')lT();if(v==='gateway')rGw();if(v==='skills')rSk();if(v==='settings')lCfg();if(v==='mcp')lMcp();if(v==='presets')lPre();if(v==='jobs')lJobs();if(v==='usage')lUsage();if(v==='logs')rLogs()}
function goTo(v){var ns=document.querySelectorAll('.ni');for(var i=0;i<ns.length;i++){if(ns[i].getAttribute('data-v')===v){go(ns[i]);return}}}
function chk(){ap('/health').then(function(h){$('sLed').className='led '+(h.ok?'ok':'er');$('sLbl').textContent=h.ok?'Connected':'Error'}).catch(function(){$('sLed').className='led er';$('sLbl').textContent='Offline'})}
var evtSrc=null;function connectSSE(){if(evtSrc)evtSrc.close();try{evtSrc=new EventSource(B+'/api/events');evtSrc.onopen=function(){$('sLed').className='led ok';$('sLbl').textContent='Live'};evtSrc.addEventListener('heartbeat',function(e){try{var d=JSON.parse(e.data);if(d.sessions!==undefined){$('nSs').textContent=d.sessions}}catch(ex){}});evtSrc.addEventListener('status',function(e){try{var d=JSON.parse(e.data);if(d.type==='connected'){$('sLed').className='led ok';$('sLbl').textContent='Live'}}catch(ex){}});evtSrc.onerror=function(){$('sLed').className='led';$('sLbl').textContent='Reconnecting...'}}catch(ex){}}
function lSessions(){ap('/api/sessions').then(function(d){var sv=d.sessions||[];sv.forEach(function(s){if(!ss.find(function(x){return x.id===s.sessionId})){ss.push({id:s.sessionId,n:s.messageCount||0,t:s.updatedAt||new Date().toISOString(),preview:s.preview||''})}});rSessList()}).catch(function(){})}
function rSessList(){$('nSs').textContent=ss.length;var q=($('sessSearch')?$('sessSearch').value:'').toLowerCase();var filtered=ss;if(q){filtered=ss.filter(function(s){return(s.id||'').toLowerCase().indexOf(q)!==-1||(s.title||'').toLowerCase().indexOf(q)!==-1||(s.preview||'').toLowerCase().indexOf(q)!==-1})}filtered.sort(function(a,b){return new Date(b.t||0).getTime()-new Date(a.t||0).getTime()});var h='';if(!filtered.length){h='<div class="em" style="padding:20px 0"><div class="em-s">'+(ss.length?'No matching sessions':'No sessions yet')+'</div></div>'}filtered.forEach(function(s){var isActive=s.id===sid;var title=s.title||(s.preview?s.preview.slice(0,30):s.id.slice(0,20));h+='<div class="sess-item'+(isActive?' active':'')+'" data-sid="'+esc(s.id)+'" onclick="pk(\\''+esc(s.id)+'\\')">';h+='<div class="sess-actions"><button onclick="event.stopPropagation();sessRename(\\''+esc(s.id)+'\\')" title="Rename">&#9998;</button><button onclick="event.stopPropagation();sessDelete(\\''+esc(s.id)+'\\')" title="Delete">&#128465;</button></div>';h+='<div class="sess-title" id="stitle-'+esc(s.id)+'">'+esc(title)+'</div>';h+='<div class="sess-meta"><span>'+ago(s.t)+'</span><span>'+(s.n||0)+' msgs</span></div>';if(s.contextPct!==undefined){h+='<div class="sess-ctx"><div class="sess-ctx-bar" style="width:'+Math.min(100,s.contextPct||0)+'%"></div></div>'}h+='</div>'});$('sessList').innerHTML=h}
function filterSessions(){rSessList()}
function sessRename(id){var el=document.querySelector('[data-sid="'+id+'"] .sess-title');if(!el)return;var cur=el.textContent;el.innerHTML='<input class="sess-rename-input" value="'+esc(cur)+'" onkeydown="if(event.key===\\'Enter\\'){sessDoRename(\\''+esc(id)+'\\',this.value);event.stopPropagation()}else if(event.key===\\'Escape\\'){rSessList();event.stopPropagation()}" onclick="event.stopPropagation()" autofocus>';el.querySelector('input').focus();el.querySelector('input').select()}
function sessDoRename(id,name){ap('/api/sessions/'+id+'/rename',{method:'POST',body:JSON.stringify({name:name})}).then(function(){var s=ss.find(function(x){return x.id===id});if(s)s.title=name;rSessList()}).catch(function(){rSessList()})}
function sessDelete(id){if(!confirm('Delete this session?'))return;ap('/api/sessions/'+id,{method:'DELETE'}).then(function(){ss=ss.filter(function(x){return x.id!==id});if(sid===id){sid=null;localStorage.removeItem('cc_sid');$('cMs').innerHTML='<div class="em"><div class="em-t">No Session</div><div class="em-s">Create a session to start</div></div>'}rSessList()}).catch(function(){})}
var cpItems=[{cat:'Navigate',label:'Chat',action:function(){goTo('chat')},key:''},{cat:'Navigate',label:'Memory',action:function(){goTo('memory')},key:''},{cat:'Navigate',label:'Presets',action:function(){goTo('presets')},key:''},{cat:'Navigate',label:'Skills',action:function(){goTo('skills')},key:''},{cat:'Navigate',label:'Tools',action:function(){goTo('tools')},key:''},{cat:'Navigate',label:'Gateway',action:function(){goTo('gateway')},key:''},{cat:'Navigate',label:'MCP',action:function(){goTo('mcp')},key:''},{cat:'Navigate',label:'Settings',action:function(){goTo('settings')},key:''},{cat:'Actions',label:'New Session',action:function(){mkS()},key:'N'},{cat:'Actions',label:'New Job',action:function(){jbModalOpen()},key:'J'},{cat:'Actions',label:'Refresh Tools',action:function(){lT()},key:'R'}];
var cpIdx=0;function cpOpen(){$('cpOv').classList.add('on');$('cpIn').value='';cpFilter();$('cpIn').focus()}function cpClose(){$('cpOv').classList.remove('on')}
function cpFilter(){var q=$('cpIn').value.toLowerCase();var f=q?cpItems.filter(function(i){return i.label.toLowerCase().indexOf(q)!==-1||i.cat.toLowerCase().indexOf(q)!==-1}):cpItems;cpIdx=0;var cats={};f.forEach(function(i){if(!cats[i.cat])cats[i.cat]=[];cats[i.cat].push(i)});var h='';Object.keys(cats).forEach(function(c){h+='<div class="cp-cat">'+esc(c)+'</div>';cats[c].forEach(function(it){var gIdx=f.indexOf(it);h+='<div class="cp-item'+(gIdx===0?' a':'')+'" data-ci="'+gIdx+'" onclick="cpExec('+gIdx+')" onmouseenter="cpHover('+gIdx+')">'+esc(it.label);if(it.key)h+='<span class="cp-k">'+esc(it.key)+'</span>';h+='</div>'})});$('cpList').innerHTML=h||'<div style="padding:16px;color:var(--t3);font-size:12px">No matches</div>'}
function cpHover(i){cpIdx=i;var items=$('cpList').querySelectorAll('.cp-item');for(var j=0;j<items.length;j++)items[j].classList.toggle('a',parseInt(items[j].getAttribute('data-ci'))===i)}
function cpKey(e){if(e.key==='Escape'){cpClose();e.preventDefault();return}if(e.key==='Enter'){cpExec(cpIdx);cpClose();e.preventDefault();return}if(e.key==='ArrowDown'){cpIdx=Math.min(cpIdx+1,$('cpList').querySelectorAll('.cp-item').length-1);cpHover(cpIdx);e.preventDefault()}if(e.key==='ArrowUp'){cpIdx=Math.max(cpIdx-1,0);cpHover(cpIdx);e.preventDefault()}}
function cpExec(i){var q=$('cpIn').value.toLowerCase();var f=q?cpItems.filter(function(it){return it.label.toLowerCase().indexOf(q)!==-1||it.cat.toLowerCase().indexOf(q)!==-1}):cpItems;if(f[i])f[i].action();cpClose()}
function mkS(){var id='s-'+Date.now().toString(36);ss.push({id:id,n:0,t:new Date().toISOString(),title:'',preview:''});rSessList();pk(id)}
function pk(id){sid=id;localStorage.setItem('cc_sid',id);rSessList();lH()}
function lH(){if(!sid)return;ap('/api/sessions/'+sid+'/history').then(function(d){rMs(d.messages||[])}).catch(function(){rMs([])})}
function rMs(ms){var c=$('cMs');if(!ms||!ms.length){c.innerHTML='<div class="em"><div class="em-t">New Session</div><div class="em-s">Type a message to begin.</div></div>';return}c.innerHTML=ms.map(function(m){var r=m.role||'user';if(r==='tool'){var ok=!m.content||!m.content.match(/error|fail/i);return tcc(m.name||'tool',ok,m.content||'')}var b=r==='user'?esc(m.content||''):'<div class="md">'+md(m.content||'')+'</div>';return'<div class="mg '+(r==='user'?'u':r==='assistant'?'as':r==='system'?'sy':'tl')+'"><span class="rt">'+r+(m.name?' / '+esc(m.name):'')+'</span>'+b+'</div>'}).join('');c.scrollTop=c.scrollHeight}
function snd(){var el=$('mIn'),t=el.value.trim();if(!t||!sid)return;el.value='';var c=$('cMs');if(c.querySelector('.em'))c.innerHTML='';c.innerHTML+='<div class="mg u"><span class="rt">you</span>'+esc(t)+'</div>';c.innerHTML+='<div class="typ"><div class="td"></div><div class="td"></div><div class="td"></div></div>';c.scrollTop=c.scrollHeight;var s=ss.find(function(x){return x.id===sid});if(s){s.n=(s.n||0)+1;s.t=new Date().toISOString();if(!s.title)s.title=t.slice(0,30);s.preview=t.slice(0,60);rSessList()}ap('/api/sessions/'+sid,{method:'POST',body:JSON.stringify({userMessage:t})}).then(function(d){var ind=c.querySelector('.typ');if(ind)ind.remove();if(d.toolResults&&d.toolResults.length){d.toolResults.forEach(function(tr){c.innerHTML+=tcc(tr.toolName,tr.ok,tr.output||'')})}lH()}).catch(function(e){var ind=c.querySelector('.typ');if(ind)ind.remove();c.innerHTML+='<div class="err-state"><div class="err-msg">Error: '+(e.message||'Unknown')+'</div><button class="btn" onclick="lH()">Retry</button></div>'})}
function lT(){ap('/api/system/status').then(function(d){var t=d.tools||[];aT=t.map(function(x){return typeof x==='string'?{name:x,description:'',runtime:'worker',dangerLevel:''}:x});$('nTl').textContent=aT.length;if(d.model)$('ftMod').textContent=d.model;if(aT.length)$('ftTl').textContent=aT.length+' tools';fTl()}).catch(function(){$('tGrd').innerHTML='<div class="err-state"><div class="err-msg">Could not load tools</div><button class="btn" onclick="lT()">Retry</button></div>'})}
function fTl(){var q=($('tlSr')?$('tlSr').value:'').toLowerCase();var f=aT;if(q){f=aT.filter(function(x){return(x.name||'').toLowerCase().indexOf(q)!==-1||(x.description||'').toLowerCase().indexOf(q)!==-1})}var groups={};f.forEach(function(x){var p=(x.name||'').split('.');var g=p.length>1?p[0]:'core';if(!groups[g])groups[g]=[];groups[g].push(x)});var el=$('tGrd');if(!f.length){el.innerHTML='<div class="em"><div class="em-s">No tools found</div></div>';return}var h='';Object.keys(groups).sort().forEach(function(g){h+='<div style="grid-column:1/-1"><div class="sec-h" style="margin-top:10px">'+esc(g.toUpperCase())+'</div></div>';groups[g].forEach(function(x){h+='<div class="tl-card"><div class="tl-nm">'+esc(x.name||'')+'</div>';if(x.description)h+='<div class="tl-ds">'+esc((x.description||'').slice(0,100))+'</div>';h+='<div class="tl-mt"><span class="tag">'+esc(x.runtime||'worker')+'</span>';if(x.dangerLevel==='high'||x.dangerLevel==='critical')h+='<span class="tag er">danger</span>';h+='</div></div>'})});el.innerHTML=h}
var actPre=localStorage.getItem('cc_preset')||null,actTs=localStorage.getItem('cc_toolset')||null;
function lPre(){if(aPre){rPre();return}ap('/api/presets').then(function(d){aPre=d;rPre()}).catch(function(){$('pAgent').innerHTML='<div class="err-state"><div class="err-msg">Could not load presets</div><button class="btn" onclick="aPre=null;lPre()">Retry</button></div>'})}
function rPre(){if(!aPre)return;var agents=aPre.agents||[];$('pAgent').innerHTML=agents.map(function(a){var isA=actPre===a.name;var tools=(a.tools||[]).map(function(t){return'<span class="tag">'+esc(t)+'</span>'}).join('');return'<div class="pre-card'+(isA?' style="border-color:var(--ac)"':'')+'"><h4>'+esc(a.name)+'</h4><div class="role">'+esc(a.role||'')+'</div><div class="goal">'+esc(a.goal||'')+'</div>'+(tools?'<div class="tr">'+tools+'</div>':'')+'<button class="btn'+(isA?' btn-p':'')+'" onclick="aPr(\\''+esc(a.name)+'\\')">'+( isA?'Active':'Apply')+'</button></div>'}).join('')||'<div class="em"><div class="em-s">No agent presets</div></div>';var tss=aPre.toolsets||[];$('pToolset').innerHTML=tss.map(function(ts){var isA=actTs===ts.name;var names=(ts.toolNames||[]).join(', ');return'<div class="pre-card'+(isA?' style="border-color:var(--ac)"':'')+'"><h4>'+esc(ts.name)+'</h4><div class="goal">'+esc(ts.description||'')+'</div><div style="font-size:10px;color:var(--t3);font-family:var(--m);line-height:1.5;margin-bottom:8px">'+esc(names.slice(0,140))+'</div>'+(isA?'<span class="tag ac">Active</span>':'<button class="btn" onclick="aTs(\\''+esc(ts.name)+'\\')">Select</button>')+'</div>'}).join('')||'<div class="em"><div class="em-s">No toolset presets</div></div>';var mcps=aPre.mcp||[];var avail=window._mcpPresetStatus||{};$('pMcpP').innerHTML=mcps.map(function(m){var isOn=localStorage.getItem('cc_mcp_'+m.name)==='on';var ps=avail[m.name];var unavail=ps&&ps.available===false;var errHtml=unavail?'<div style="font-size:9px;color:var(--er);margin-top:4px">'+esc(ps.error||'Unavailable')+'</div>':'';var btnDisabled=unavail&&!isOn?' disabled style="opacity:0.5"':'';return'<div class="pre-card'+(isOn?' style="border-color:var(--ok)"':'')+'"><h4>'+esc(m.name)+'</h4><div class="goal">'+esc(m.description||'')+'</div>'+errHtml+'<div style="display:flex;gap:4px;margin-top:6px"><button class="btn'+(isOn?' btn-p':'')+'"'+btnDisabled+' onclick="tgMcp(\\''+esc(m.name)+'\\',this);rPre()">'+(isOn?'Connected':'Connect')+'</button>'+(isOn?'<button class="btn" onclick="testMcp(\\''+esc(m.name)+'\\',this)">Test</button>':'')+'</div></div>'}).join('')||'<div class="em"><div class="em-s">No MCP presets</div></div>'}
function pTab(el){var tabs=document.querySelectorAll('#pTabs .tab');for(var i=0;i<tabs.length;i++)tabs[i].classList.remove('a');el.classList.add('a');var t=el.getAttribute('data-pt');$('pAgent').style.display=t==='agent'?'grid':'none';$('pToolset').style.display=t==='toolset'?'grid':'none';$('pMcpP').style.display=t==='mcp-p'?'grid':'none'}
function aPr(n){actPre=n;localStorage.setItem('cc_preset',n);var preset=(aPre&&aPre.agents||[]).find(function(a){return a.name===n});if(preset){ap('/api/agent/preset',{method:'POST',body:JSON.stringify({name:n,role:preset.role,goal:preset.goal,backstory:preset.backstory})}).catch(function(){})}rPre()}
function aTs(n){actTs=n;localStorage.setItem('cc_toolset',n);ap('/api/toolset/select',{method:'POST',body:JSON.stringify({name:n})}).catch(function(){});rPre()}
function rSk(){if(aSk){fSk();return}ap('/api/skills').then(function(d){aSk=d.skills||[];$('nSk').textContent=aSk.length;fSk()}).catch(function(){$('skLs').innerHTML='<div class="err-state"><div class="err-msg">Could not load skills</div><button class="btn" onclick="aSk=null;rSk()">Retry</button></div>'})}
function fSk(){if(!aSk)return;var q=$('skSr').value.toLowerCase();var f=q?aSk.filter(function(s){return s.title.toLowerCase().indexOf(q)!==-1||s.summary.toLowerCase().indexOf(q)!==-1||(s.slug||'').toLowerCase().indexOf(q)!==-1||(s.triggerPhrases||[]).some(function(tp){return tp.toLowerCase().indexOf(q)!==-1})}):aSk;var catMap={'git':'Git','code':'Code Review','debug':'Debugging','project':'DevOps','api':'API','database':'DevOps','deploy':'DevOps','write':'Testing','refactor':'Code Review','docker':'DevOps','security':'Security','performance':'Performance','web':'Web','github':'Git','env':'DevOps'};var groups={};f.forEach(function(s){var prefix=(s.slug||'').split('-')[0];var cat=catMap[prefix]||'General';if(!groups[cat])groups[cat]=[];groups[cat].push(s)});var cats=Object.keys(groups).sort();var h='';cats.forEach(function(c){h+='<div class="sec-h" style="margin-top:14px;margin-bottom:10px">'+esc(c)+' <span style="color:var(--t3);font-weight:400">('+groups[c].length+')</span></div>';h+='<div class="grid" style="margin-bottom:6px">';groups[c].forEach(function(s){var triggers=(s.triggerPhrases||[]).map(function(tp){return'<span class="tag">'+esc(tp)+'</span>'}).join('');var steps=s.steps||[];var uid='sk'+Math.random().toString(36).slice(2,7);h+='<div class="sk-card"><h4>'+esc(s.title)+'</h4>';h+='<div class="sk-sum">'+esc(s.summary||'')+'</div>';if(triggers)h+='<div class="sk-tags">'+triggers+'</div>';if(steps.length){h+='<span class="sk-tog" onclick="var u=document.getElementById(\\''+uid+'\\');u.classList.toggle(\\'hide\\');this.textContent=u.classList.contains(\\'hide\\')?(\\''+steps.length+' steps \\u25B6\\'):(\\''+steps.length+' steps \\u25BC\\')">'+steps.length+' steps &#9654;</span>';h+='<ol class="sk-steps hide" id="'+uid+'">';steps.forEach(function(st){h+='<li>'+esc(st)+'</li>'});h+='</ol>'}var enKey='cc_sk_'+s.slug;var isEn=localStorage.getItem(enKey)!=='off';h+='<div class="sk-act"><label class="sw"><input type="checkbox" '+(isEn?'checked':'')+' onchange="tgSk(\\''+esc(s.slug)+'\\',this.checked)"><span class="sw-sl"></span></label><span style="font-size:9px;color:'+(isEn?'var(--ok)':'var(--t3)')+'">'+( isEn?'Enabled':'Disabled')+'</span></div>';h+='</div>'});h+='</div>'});if(!h)h='<div class="em"><div class="em-s">No skills found</div></div>';$('skLs').innerHTML=h}
var gwPlats=[{n:'Telegram',id:'telegram',r:'/webhooks/telegram',f:'Bot Token',k:'cc_gw_telegram',probe:true},{n:'Discord',id:'discord',r:'/webhooks/discord',f:'Webhook URL',k:'cc_gw_discord',probe:true},{n:'Slack',id:'slack',r:'/webhooks/slack',f:'Bot Token',k:'cc_gw_slack',probe:true},{n:'WhatsApp',id:'whatsapp',r:'/webhooks/whatsapp',f:'Access Token',k:'cc_gw_whatsapp',probe:true},{n:'Signal',id:'signal',r:'/webhooks/signal',f:'Phone Number',k:'cc_gw_signal',probe:false},{n:'Email',id:'email',r:'/webhooks/email',f:'API Key',k:'cc_gw_email',probe:false},{n:'Matrix',id:'matrix',r:'/webhooks/matrix',f:'Access Token',k:'cc_gw_matrix',probe:true},{n:'SMS',id:'sms',r:'/webhooks/sms',f:'Twilio SID',k:'cc_gw_sms',probe:false},{n:'Webhook',id:'webhook',r:'/webhooks/generic',f:'Secret',k:'cc_gw_webhook',probe:false}];
function rGw(){$('gGrd').innerHTML=gwPlats.map(function(g,i){var u=location.origin+g.r;var saved=localStorage.getItem(g.k)||'';var cfg=!!saved;var dmPol=localStorage.getItem('cc_gw_dm_'+g.id)||'pairing';var grpPol=localStorage.getItem('cc_gw_grp_'+g.id)||'open';var h='<div class="gw-card">';h+='<div class="gw-hd"><div class="led '+(cfg?'ok':'')+'"></div><span class="gw-nm">'+esc(g.n)+'</span>';if(cfg)h+='<span class="cfg-badge" style="margin-left:auto">Configured</span>';h+='</div>';h+='<div class="gw-url" onclick="navigator.clipboard.writeText(\\''+esc(u)+'\\');this.textContent=\\'Copied!\\';var s=this;setTimeout(function(){s.textContent=\\''+esc(u)+'\\'},1500)" title="Click to copy">'+esc(u)+'</div>';h+='<div class="gw-fld"><label>'+esc(g.f)+'</label><input id="gwi'+i+'" type="password" value="'+esc(saved)+'" placeholder="Enter '+esc(g.f.toLowerCase())+'..."></div>';h+='<div class="gw-acts"><button class="btn" onclick="svGw('+i+')">Save</button>';if(g.probe)h+='<button class="btn" onclick="prGw(\\''+g.id+'\\','+i+')">Probe</button>';h+='</div>';h+='<div id="gwp'+i+'" class="gw-probe"></div>';h+='<div class="gw-pol"><div class="gw-pol-r"><label>DM Policy</label><select id="gwdm'+i+'" onchange="svPol(\\''+g.id+'\\','+i+')">';['pairing','allowlist','open','disabled'].forEach(function(p){h+='<option value="'+p+'"'+(dmPol===p?' selected':'')+'>'+p+'</option>'});h+='</select></div><div class="gw-pol-r"><label>Group Policy</label><select id="gwgp'+i+'" onchange="svPol(\\''+g.id+'\\','+i+')">';['open','disabled','allowlist'].forEach(function(p){h+='<option value="'+p+'"'+(grpPol===p?' selected':'')+'>'+p+'</option>'});h+='</select></div></div></div>';return h}).join('')}
function svGw(i){var g=gwPlats[i];var val=$('gwi'+i).value;localStorage.setItem(g.k,val);ap('/api/gateway/'+g.id+'/config',{method:'POST',body:JSON.stringify({token:val,enabled:!!val})}).catch(function(){});rGw()}
function prGw(platform,i){var el=$('gwp'+i);el.innerHTML='<span style="color:var(--t3);font-size:10px">Probing...</span>';var token=$('gwi'+i).value;if(!token){el.innerHTML='<span style="color:var(--er);font-size:10px">Enter token first</span>';return}ap('/api/gateway/'+platform+'/probe',{method:'POST',body:JSON.stringify({token:token,webhookUrl:token})}).then(function(d){if(d.ok){el.innerHTML='<span style="color:var(--ok);font-size:10px">&#10003; '+esc(d.identity||'Valid')+'</span>'}else{el.innerHTML='<span style="color:var(--er);font-size:10px">&#10007; '+esc(d.error||'Failed')+'</span>'}}).catch(function(e){el.innerHTML='<span style="color:var(--er);font-size:10px">Error: '+esc(e.message||'')+'</span>'})}
function svPol(platform,i){var dm=$('gwdm'+i).value;var gp=$('gwgp'+i).value;localStorage.setItem('cc_gw_dm_'+platform,dm);localStorage.setItem('cc_gw_grp_'+platform,gp);ap('/api/gateway/'+platform+'/policy',{method:'POST',body:JSON.stringify({dmPolicy:dm,groupPolicy:gp})}).catch(function(){})}
function tgSk(slug,on){localStorage.setItem('cc_sk_'+slug,on?'on':'off');ap('/api/skills/'+slug+'/toggle',{method:'POST',body:JSON.stringify({enabled:on})}).catch(function(){});fSk()}
function tgMcp(name,el){var k='cc_mcp_'+name;var cur=localStorage.getItem(k)==='on';var newState=!cur;localStorage.setItem(k,newState?'on':'off');el.textContent=newState?'Connecting...':'Disconnecting...';el.disabled=true;ap('/api/mcp/'+(newState?'connect':'disconnect'),{method:'POST',body:JSON.stringify({preset:name})}).then(function(d){el.textContent=newState?'Connected':'Connect';el.className=newState?'btn btn-p':'btn';el.disabled=false;var vEl=document.getElementById('mcpV_'+name);if(vEl&&d&&d.verify){var v=d.verify;if(v.ok){vEl.innerHTML='<span style="color:var(--ok);font-size:10px">Connected -- '+(v.toolCount||0)+' tools'+(typeof v.resourceCount==='number'?', '+v.resourceCount+' resources':'')+ ' ('+v.latencyMs+'ms)</span>'}else{vEl.innerHTML='<span style="color:var(--warn,#f59e0b);font-size:10px">Connected but verification failed: '+(v.error||'unknown')+'</span>'}}}).catch(function(){el.textContent=newState?'Connected':'Connect';el.className=newState?'btn btn-p':'btn';el.disabled=false});lMcp()}
function testMcp(name,btn){btn.textContent='Testing...';btn.disabled=true;ap('/api/mcp/verify',{method:'POST',body:JSON.stringify({preset:name})}).then(function(v){var vEl=document.getElementById('mcpV_'+name);if(vEl){if(v.ok){vEl.innerHTML='<span style="color:var(--ok);font-size:10px">Connected -- '+(v.toolCount||0)+' tools'+(typeof v.resourceCount==='number'?', '+v.resourceCount+' resources':'')+ ' ('+v.latencyMs+'ms)</span>'}else{vEl.innerHTML='<span style="color:var(--warn,#f59e0b);font-size:10px">Verification failed: '+(v.error||'unknown')+'</span>'}}btn.textContent='Test';btn.disabled=false}).catch(function(){btn.textContent='Test';btn.disabled=false})}
function lMcp(){ap('/api/system/status').then(function(d){var mc=d.mcp;if(!mc){$('mcpSt').innerHTML='<div class="mcp-blk"><div class="mcp-row"><span class="lbl">Status</span><span class="val" style="color:var(--t3)">No MCP client configured</span></div></div>';return}var ok=!mc.degraded;var h='<div class="mcp-blk">';h+='<div class="mcp-row"><span class="lbl">Status</span><span class="val" style="color:var('+(ok?'--ok':'--er')+');">'+(ok?'Healthy':'Degraded')+'</span></div>';h+='<div class="mcp-row"><span class="lbl">Cached Tools</span><span class="val">'+(mc.cachedTools||0)+'</span></div>';h+='<div class="mcp-row"><span class="lbl">Revision</span><span class="val">'+(mc.toolsRevision||0)+'</span></div>';h+='</div>';$('mcpSt').innerHTML=h}).catch(function(){$('mcpSt').innerHTML='<div class="err-state"><div class="err-msg">Could not load MCP status</div><button class="btn" onclick="lMcp()">Retry</button></div>'});lMcpPresetStatus();if(aPre){rMcpPr();return}ap('/api/presets').then(function(d){aPre=d;rMcpPr()}).catch(function(){})}
function rMcpPr(){var mcps=(aPre&&aPre.mcp)||[];var avail=window._mcpPresetStatus||{};$('mcpPr').innerHTML=mcps.map(function(m){var isOn=localStorage.getItem('cc_mcp_'+m.name)==='on';var ps=avail[m.name];var unavail=ps&&ps.available===false;var errHtml=unavail?'<div style="font-size:9px;color:var(--er);margin-bottom:4px">'+esc(ps.error||'Unavailable')+'</div>':'';var btnDisabled=unavail&&!isOn?' disabled style="opacity:0.5"':'';return'<div class="card'+(isOn?' style="border-color:var(--ok)"':'')+'"><div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><div class="led '+(isOn?'ok':'')+'"></div><h4 style="font-size:12px;font-weight:600">'+esc(m.name)+'</h4></div><div style="font-size:10px;color:var(--t2);line-height:1.5;margin-bottom:6px">'+esc(m.description||'')+'</div>'+errHtml+'<div id="mcpV_'+esc(m.name)+'" style="min-height:14px;margin-bottom:4px"></div><div style="display:flex;gap:4px"><button class="btn'+(isOn?' btn-p':'')+'"'+btnDisabled+' onclick="tgMcp(\\''+esc(m.name)+'\\',this)">'+(isOn?'Connected':'Connect')+'</button>'+(isOn?'<button class="btn" onclick="testMcp(\\''+esc(m.name)+'\\',this)">Test</button>':'')+'</div></div>'}).join('')||'<div class="em"><div class="em-s">No MCP presets available</div></div>'}
function lMcpPresetStatus(){ap('/api/mcp/presets/status').then(function(arr){var map={};(arr||[]).forEach(function(p){map[p.name]=p});window._mcpPresetStatus=map;rMcpPr()}).catch(function(){})}
function lCfg(){ap('/api/system/status').then(function(d){var mc=d.mcp;var mcL=mc?(mc.degraded?'degraded':'healthy'):'not configured';var ps=[['Service',d.service||'--'],['Version',d.version||'--'],['Deployment',d.deployment||'--'],['Model',d.model||'--'],['Provider',d.provider||'--'],['Tools',''+(d.tools||[]).length],['MCP Status',mcL],['Plugins',(d.plugins||[]).join(', ')||'none']];$('cfB').innerHTML='<div class="cfg-blk">'+ps.map(function(p){return'<div class="kv"><span class="kv-k">'+esc(p[0])+'</span><span class="kv-v">'+esc(p[1])+'</span></div>'}).join('')+'</div>'}).catch(function(){$('cfB').innerHTML='<div class="err-state"><div class="err-msg">Could not load configuration</div><button class="btn" onclick="lCfg()">Retry</button></div>'})}
function lCfgState(){ap('/api/config/snapshot').then(function(d){if(d.activePreset)actPre=d.activePreset;if(d.activeToolset)actTs=d.activeToolset;if(d.disabledSkills){d.disabledSkills.forEach(function(s){localStorage.setItem('cc_sk_'+s,'off')})}}).catch(function(){})}
function loadMemories(){var scope=$('memScope')?$('memScope').value:'';var url=sid?'/api/sessions/'+sid+'/memories':'';if(!url){$('memList').innerHTML='<div class="em"><div class="em-t">No memories yet</div><div class="em-s">Memories will appear here as the agent captures them</div></div>';return}if(scope)url+='?scope='+scope;$('memList').innerHTML='<div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:70%"></div>';ap(url).then(function(d){allMem=d.records||[];filterMemories()}).catch(function(){$('memList').innerHTML='<div class="err-state"><div class="err-msg">Could not load memories</div><button class="btn" onclick="loadMemories()">Retry</button></div>'})}
function filterMemories(){var q=($('memSrch')?$('memSrch').value:'').toLowerCase();var f=allMem;if(q){f=allMem.filter(function(m){return(m.content||m.summary||'').toLowerCase().indexOf(q)!==-1||(m.tags||[]).join(' ').toLowerCase().indexOf(q)!==-1})}if(!f.length){$('memList').innerHTML='<div class="em"><div class="em-t">'+(allMem.length?'No matching memories':'No memories found')+'</div><div class="em-s">'+(allMem.length?'Try a different search term':'Memories will appear as the agent captures them')+'</div></div>';return}var h='<table class="mem-table"><thead><tr><th>Content</th><th>Tags</th><th>Scope</th><th>Created</th><th></th></tr></thead><tbody>';f.forEach(function(m,i){var content=m.content||m.summary||'';h+='<tr onclick="memDetail('+i+')">';h+='<td class="mem-content">'+esc(content.slice(0,80))+(content.length>80?'...':'')+'</td>';h+='<td>'+(m.tags||[]).map(function(t){return'<span class="tag">'+esc(t)+'</span>'}).join(' ')+'</td>';h+='<td><span class="tag">'+esc(m.scope||'session')+'</span></td>';h+='<td style="font-family:var(--m);font-size:10px;color:var(--t3)">'+ago(m.createdAt)+'</td>';h+='<td><button class="mem-del" onclick="event.stopPropagation();memDel(\\''+esc(m.id||'')+'\\')">&#10005;</button></td>';h+='</tr>'});h+='</tbody></table>';$('memList').innerHTML=h}
function memDetail(idx){var q=($('memSrch')?$('memSrch').value:'').toLowerCase();var filtered=allMem;if(q){filtered=allMem.filter(function(m){return(m.content||m.summary||'').toLowerCase().indexOf(q)!==-1||(m.tags||[]).join(' ').toLowerCase().indexOf(q)!==-1})}var m=filtered[idx];if(!m)return;var h='<div style="margin-bottom:12px"><div class="form-label">Content</div><div style="font-size:12px;color:var(--t1);line-height:1.6;white-space:pre-wrap;background:var(--b2);border:1px solid var(--bd);padding:10px">'+esc(m.content||m.summary||'')+'</div></div>';h+='<div style="margin-bottom:12px"><div class="form-label">Tags</div><div style="display:flex;flex-wrap:wrap;gap:4px">'+(m.tags||[]).map(function(t){return'<span class="tag">'+esc(t)+'</span>'}).join('')+'</div></div>';h+='<div style="margin-bottom:12px"><div class="form-label">Scope</div><span class="tag">'+esc(m.scope||'session')+'</span></div>';if(m.createdAt)h+='<div><div class="form-label">Created</div><span style="font-size:11px;color:var(--t2);font-family:var(--m)">'+esc(m.createdAt)+'</span></div>';$('memModalBody').innerHTML=h;$('memModal').classList.add('on');trapFocus($('memModal').querySelector('.modal-box'))}
function memModalClose(){$('memModal').classList.remove('on')}
function memDel(id){if(!confirm('Delete this memory?'))return;ap('/api/memories/'+id,{method:'DELETE'}).then(function(){loadMemories()}).catch(function(){})}
function jbModalOpen(){$('jbModal').classList.add('on');$('jbName').value='';$('jbTask').value='';$('jbSchedVal').value='60';$('jbModel').value='';$('jbDelPlatform').value='';$('jbDelChannel').value='';jbSchedChange();var skH='';(aSk||[]).forEach(function(s){skH+='<label class="form-checkbox"><input type="checkbox" value="'+esc(s.slug)+'">'+esc(s.title)+'</label>'});$('jbSkills').innerHTML=skH||'<span style="font-size:10px;color:var(--t3)">No skills available</span>';trapFocus($('jbModal').querySelector('.modal-box'))}
function jbModalClose(){$('jbModal').classList.remove('on')}
function jbSchedChange(){var type=document.querySelector('input[name=jbSchedType]:checked');var val=$('jbSchedVal');var hint=$('jbSchedHint');if(type&&type.value==='cron'){val.placeholder='*/30 * * * *';hint.textContent='Enter a standard cron expression'}else{val.placeholder='60';hint.textContent='Runs every '+(parseInt(val.value)||60)+' minutes'}}
function jbSubmit(){var name=$('jbName').value.trim();var task=$('jbTask').value.trim();if(!name||!task){alert('Job name and task are required');return}var type=document.querySelector('input[name=jbSchedType]:checked');var schedVal=$('jbSchedVal').value.trim()||'60';var schedule=type&&type.value==='cron'?schedVal:'every:'+schedVal+'m';var model=$('jbModel').value||undefined;var skills=[];document.querySelectorAll('#jbSkills input:checked').forEach(function(cb){skills.push(cb.value)});var delPlat=$('jbDelPlatform').value;var delChan=$('jbDelChannel').value.trim();var body={id:name,task:task,schedule:schedule};if(model)body.model=model;if(skills.length)body.skillSlugs=skills;if(delPlat&&delChan)body.deliverTo={platform:delPlat,config:{channel:delChan}};ap('/api/scheduler/jobs',{method:'POST',body:JSON.stringify(body)}).then(function(){jbModalClose();lJobs()}).catch(function(e){alert('Failed: '+(e.message||'Unknown'))})}
function lJobs(){ap('/api/scheduler/jobs').then(function(d){var jobs=Array.isArray(d)?d:d.jobs||[];$('nJb').textContent=jobs.length;if(!jobs.length){$('jbLs').innerHTML='<div class="em"><div class="em-s">No scheduled jobs</div></div>';return}$('jbLs').innerHTML=jobs.map(function(j){var st=j.lastRunStatus||'pending';var stCls=st==='success'?'ok':st==='error'?'er':'';return'<div class="card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-family:var(--m);font-size:12px;font-weight:600">'+esc(j.id)+'</span><span class="tag '+(j.enabled?'ok':'er')+'">'+(j.enabled?'active':'paused')+'</span></div><div style="font-size:11px;color:var(--t2);margin-bottom:6px">'+esc(j.task)+'</div><div style="display:flex;gap:8px;flex-wrap:wrap;font-size:10px;font-family:var(--m);color:var(--t3)"><span>'+esc(j.schedule)+'</span><span>runs: '+(j.runCount||0)+'</span>'+(j.lastRunAt?'<span>last: '+ago(j.lastRunAt)+'</span>':'')+(st!=='pending'?'<span class="tag '+stCls+'">'+st+'</span>':'')+'</div></div>'}).join('')}).catch(function(){$('jbLs').innerHTML='<div class="err-state"><div class="err-msg">Could not load jobs</div><button class="btn" onclick="lJobs()">Retry</button></div>'})}
function jbTick(){ap('/api/scheduler/tick',{method:'POST'}).then(function(){lJobs()}).catch(function(){})}
function lUsage(){ap('/api/usage').then(function(d){var tt=d.totalTokens||0;var ti=d.totalInputTokens||0;var to=d.totalOutputTokens||0;var cost=d.totalCostUsd||0;var lat=d.avgLatencyMs||0;var entries=d.entries||[];var bm=d.byModel||{};$('uCards').innerHTML='<div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">TOTAL TOKENS</div><div style="font-size:22px;font-weight:700;font-family:var(--m)">'+tt.toLocaleString()+'</div></div><div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">TOTAL COST</div><div style="font-size:22px;font-weight:700;font-family:var(--m);color:var(--ok)">$'+cost.toFixed(4)+'</div></div><div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">AVG LATENCY</div><div style="font-size:22px;font-weight:700;font-family:var(--m)">'+Math.round(lat)+'<span style="font-size:12px;color:var(--t3)">ms</span></div></div><div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">API CALLS</div><div style="font-size:22px;font-weight:700;font-family:var(--m)">'+entries.length+'</div></div>';var models=Object.keys(bm).sort(function(a,b){return(bm[b].cost||0)-(bm[a].cost||0)});if(!models.length){$('uModel').innerHTML='<div class="em"><div class="em-s">No model data yet</div></div>'}else{var th='<div style="font-family:var(--m);font-size:11px">';models.forEach(function(m){var v=bm[m];th+='<div class="kv"><span style="flex:2;color:var(--t1)">'+esc(m)+'</span><span style="flex:1;text-align:right">'+v.calls+'</span><span style="flex:1;text-align:right">'+v.tokens.toLocaleString()+'</span><span style="flex:1;text-align:right;color:var(--ok)">$'+(v.cost||0).toFixed(4)+'</span></div>'});th+='</div>';$('uModel').innerHTML=th}var recent=entries.slice(-20).reverse();if(!recent.length){$('uEntries').innerHTML='<div class="em"><div class="em-s">No entries yet</div></div>'}else{var eh='<div style="font-family:var(--m);font-size:10px">';recent.forEach(function(e){eh+='<div class="kv"><span style="flex:2;color:var(--t2)">'+ago(e.timestamp)+'</span><span style="flex:2;color:var(--t1)">'+esc(e.model)+'</span><span style="flex:1;text-align:right">'+(e.inputTokens||0).toLocaleString()+'</span><span style="flex:1;text-align:right">'+(e.outputTokens||0).toLocaleString()+'</span><span style="flex:1;text-align:right;color:var(--ok)">$'+(e.costUsd||0).toFixed(4)+'</span></div>'});eh+='</div>';$('uEntries').innerHTML=eh}}).catch(function(){$('uCards').innerHTML='<div class="err-state"><div class="err-msg">Could not load usage data</div><button class="btn" onclick="lUsage()">Retry</button></div>'})}
function uReset(){if(!confirm('Reset all usage data?'))return;ap('/api/usage/reset',{method:'POST'}).then(function(){lUsage()}).catch(function(){})}
var logEntries=[];function addLog(msg){logEntries.push({t:new Date().toISOString(),m:msg});if(logEntries.length>200)logEntries.shift();rLogs()}
function rLogs(){var el=$('logOut');if(!el)return;el.innerHTML=logEntries.slice().reverse().map(function(e){return'<div style="padding:2px 0;border-bottom:1px solid var(--bd)"><span style="color:var(--t3)">'+e.t.slice(11,19)+'</span> '+esc(e.m)+'</div>'}).join('')}
function trapFocus(el){if(!el)return;var focusable=el.querySelectorAll('input,button,select,textarea,[tabindex]:not([tabindex="-1"])');if(!focusable.length)return;var first=focusable[0];var last=focusable[focusable.length-1];el.addEventListener('keydown',function(e){if(e.key==='Tab'){if(e.shiftKey){if(document.activeElement===first){e.preventDefault();last.focus()}}else{if(document.activeElement===last){e.preventDefault();first.focus()}}}})}
document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();cpOpen();return}if(e.key==='Escape'){if($('cpOv').classList.contains('on')){cpClose();return}if($('jbModal').classList.contains('on')){jbModalClose();return}if($('memModal').classList.contains('on')){memModalClose();return}}});
var obStep=0,obProv='',obSelMod='',obSelPre='general';
var obModels={openai:["gpt-4o","gpt-4.1","gpt-4o-mini","o3-mini"],anthropic:["claude-sonnet-4","claude-4","claude-haiku-4"],openrouter:["anthropic/claude-sonnet-4","openai/gpt-4o","google/gemini-2.5-flash","meta-llama/llama-3-70b"],custom:["custom-model"]};
var obPresets=[{id:'general',name:'General Assistant',desc:'Balanced all-purpose agent'},{id:'coder',name:'Coding Assistant',desc:'Optimized for development tasks'},{id:'researcher',name:'Researcher',desc:'Deep research and analysis'},{id:'creative',name:'Creative Writer',desc:'Writing and content creation'}];
function obRenderDots(){var d=$('obDots');d.innerHTML='';for(var i=0;i<6;i++){d.innerHTML+='<div class="ob-dot'+(i===obStep?' on':'')+'" id="obd'+i+'"></div>'}}
function obShow(){$('obOv').classList.add('on');obRenderDots();obUpdateNav()}
function obSkip(){$('obOv').classList.remove('on');localStorage.setItem('cc_onboarded','1')}
function obUpdateNav(){$('obBack').style.display=obStep>0&&obStep<5?'inline-flex':'none';$('obNext').style.display=obStep>0&&obStep<5?'inline-flex':'none';$('obNext').textContent=obStep===4?'Finish':'Next'}
function obSelProv(el){document.querySelectorAll('.ob-pcard').forEach(function(c){c.classList.remove('sel')});el.classList.add('sel');obProv=el.getAttribute('data-prov')||'';$('obUrl').value=el.getAttribute('data-url')||'';obRenderModels()}
function obToggleKey(){var inp=$('obKey');if(inp.type==='password'){inp.type='text';document.querySelector('.ob-key-toggle').textContent='hide'}else{inp.type='password';document.querySelector('.ob-key-toggle').textContent='show'}}
function obTestConn(){var key=$('obKey').value.trim();var url=$('obUrl').value.trim();var res=$('obTestRes');if(!key){res.className='ob-test-result er';res.textContent='Please enter an API key';return}res.className='ob-test-result';res.style.display='block';res.innerHTML='<span class="ob-spinner"></span> Testing...';fetch(B+'/api/config/provider/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({apiKey:key,baseUrl:url,provider:obProv})}).then(function(r){return r.json()}).then(function(d){if(d.ok){res.className='ob-test-result ok';res.textContent='Connection successful!'}else{res.className='ob-test-result er';res.textContent=d.error||'Connection failed'}}).catch(function(e){res.className='ob-test-result er';res.textContent='Error: '+(e.message||'Network error')})}
function obRenderModels(){var grid=$('obModGrid');var models=obModels[obProv]||[];grid.innerHTML='';models.forEach(function(m){var d=document.createElement('div');d.className='ob-mcard'+(m===obSelMod?' sel':'');d.innerHTML='<div class="ob-mcard-name">'+esc(m)+'</div>';d.onclick=function(){obSelMod=m;grid.querySelectorAll('.ob-mcard').forEach(function(c){c.classList.remove('sel')});d.classList.add('sel')};grid.appendChild(d)})}
function obRenderPresets(){var grid=$('obPreGrid');grid.innerHTML='';obPresets.forEach(function(p){var d=document.createElement('div');d.className='ob-prcard'+(p.id===obSelPre?' sel':'');d.innerHTML='<h4>'+esc(p.name)+'</h4><div class="ob-prcard-desc">'+esc(p.desc)+'</div>';d.onclick=function(){obSelPre=p.id;grid.querySelectorAll('.ob-prcard').forEach(function(c){c.classList.remove('sel')});d.classList.add('sel')};grid.appendChild(d)})}
function obFinish(){var key=$('obKey').value.trim();var url=$('obUrl').value.trim();ap('/api/config/provider',{method:'POST',body:JSON.stringify({apiKey:key,baseUrl:url,model:obSelMod,provider:obProv,preset:obSelPre})}).catch(function(){});localStorage.setItem('cc_onboarded','1');$('obOv').classList.remove('on');chk();lT()}
function obNav(dir){obStep+=dir;if(obStep<0)obStep=0;if(obStep>5)obStep=5;if(obStep===3)obRenderModels();if(obStep===4)obRenderPresets();if(obStep===5){obFinish();return}for(var i=0;i<6;i++){$('obs'+i).classList.toggle('on',i===obStep)}obRenderDots();obUpdateNav()}
function initApp(){chk();lT();rSessList();lCfgState();connectSSE();lSessions();if(sid)rSessList();setInterval(chk,10000);ap('/api/system/status').then(function(d){if(d.provider==='none'&&!localStorage.getItem('cc_onboarded')){ap('/api/presets').then(function(p){aPre=p;obShow()}).catch(function(){obShow()})}}).catch(function(){})}
var streamIter=0,streamStart=0,streamTokens=0;
function sndStream(){var el=$('mIn'),t=el.value.trim();if(!t||!sid)return;el.value='';var c=$('cMs');if(c.querySelector('.em'))c.innerHTML='';c.innerHTML+='<div class="mg u"><span class="rt">you</span>'+esc(t)+'</div>';var s=ss.find(function(x){return x.id===sid});if(s){s.n=(s.n||0)+1;s.t=new Date().toISOString();if(!s.title)s.title=t.slice(0,30);s.preview=t.slice(0,60);rSessList()}streamIter=0;streamStart=Date.now();streamTokens=0;$('trIter').textContent='0';$('trTool').textContent='--';$('trTokens').textContent='0';$('trElapsed').textContent='0ms';$('trSteps').innerHTML='';var bubble=document.createElement('div');bubble.className='mg as msg-streaming md';bubble.innerHTML='<span class="cursor-blink"></span>';c.appendChild(bubble);c.scrollTop=c.scrollHeight;fetch(B+'/api/sessions/'+sid+'/stream',{method:'POST',headers:{'content-type':'application/json',Authorization:authToken?'Bearer '+authToken:''},body:JSON.stringify({message:t})}).then(function(r){if(!r.ok||!r.body){bubble.remove();sndFallback(t);return}var reader=r.body.getReader();var dec=new TextDecoder();var buf='';function pump(){reader.read().then(function(res){if(res.done){var cur=bubble.querySelector('.cursor-blink');if(cur)cur.remove();bubble.classList.remove('msg-streaming');$('trElapsed').textContent=(Date.now()-streamStart)+'ms';return}buf+=dec.decode(res.value,{stream:true});var lines=buf.split('\\n');buf=lines.pop()||'';lines.forEach(function(ln){if(!ln.startsWith('data: '))return;var payload=ln.slice(6).trim();if(payload==='[DONE]')return;try{var ev=JSON.parse(payload);handleStreamEvent(ev,bubble,c)}catch(e){}});pump()}).catch(function(){var cur=bubble.querySelector('.cursor-blink');if(cur)cur.remove();bubble.classList.remove('msg-streaming')})}pump()}).catch(function(){bubble.remove();sndFallback(t)})}
function handleStreamEvent(ev,bubble,c){if(ev.type==='text-delta'){streamTokens++;$('trTokens').textContent=String(streamTokens);var cur=bubble.querySelector('.cursor-blink');var span=document.createElement('span');span.textContent=ev.content||'';if(cur)bubble.insertBefore(span,cur);else bubble.appendChild(span);c.scrollTop=c.scrollHeight}else if(ev.type==='tool-start'){$('trTool').textContent=ev.toolName||'--';var tb=document.createElement('div');tb.className='tool-block tool-running';tb.id='tb-'+(ev.toolCallId||'');tb.innerHTML='<div class="tb-h"><span class="tb-spin"></span><span class="tb-nm">'+esc(ev.toolName||'tool')+'</span></div>';c.appendChild(tb);c.scrollTop=c.scrollHeight;$('trSteps').innerHTML+='<div class="tp-step">tool: '+esc(ev.toolName||'')+'</div>'}else if(ev.type==='tool-end'){var tbEl=$('tb-'+(ev.toolCallId||''));if(tbEl){tbEl.classList.remove('tool-running');tbEl.classList.add(ev.ok?'tool-success':'tool-error');tbEl.innerHTML='<div class="tb-h"><span class="tb-nm">'+esc(ev.toolName||'tool')+'</span><span class="tc-s '+(ev.ok?'ok':'er')+'">'+(ev.ok?'done':'error')+'</span></div>'+(ev.result?'<div class="tb-body">'+esc(ev.result)+'</div>':'')}}else if(ev.type==='iteration-start'){streamIter=ev.iteration||0;$('trIter').textContent=String(streamIter);if(streamIter>0){var sep=document.createElement('div');sep.className='iter-sep';sep.textContent='iteration '+streamIter;c.appendChild(sep)}}else if(ev.type==='iteration-end'){$('trElapsed').textContent=(Date.now()-streamStart)+'ms'}else if(ev.type==='done'){var cur=bubble.querySelector('.cursor-blink');if(cur)cur.remove();bubble.classList.remove('msg-streaming');$('trElapsed').textContent=(Date.now()-streamStart)+'ms'}else if(ev.type==='error'){showToast(ev.error||'Stream error','error');var cur2=bubble.querySelector('.cursor-blink');if(cur2)cur2.remove();bubble.classList.remove('msg-streaming')}}
function sndFallback(t){var c=$('cMs');c.innerHTML+='<div class="typ"><div class="td"></div><div class="td"></div><div class="td"></div></div>';c.scrollTop=c.scrollHeight;ap('/api/sessions/'+sid,{method:'POST',body:JSON.stringify({userMessage:t})}).then(function(d){var ind=c.querySelector('.typ');if(ind)ind.remove();if(d.toolResults&&d.toolResults.length){d.toolResults.forEach(function(tr){c.innerHTML+=tcc(tr.toolName,tr.ok,tr.output||'')})}lH()}).catch(function(e){var ind=c.querySelector('.typ');if(ind)ind.remove();c.innerHTML+='<div class="err-state"><div class="err-msg">Error: '+(e.message||'Unknown')+'</div><button class="btn" onclick="lH()">Retry</button></div>'})}
function toggleTrace(){var p=$('trPanel');p.classList.toggle('on')}
function showToast(msg,type){var t=document.createElement('div');t.className='toast'+(type?' '+type:'');t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove()},3500)}
checkAuth();
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
