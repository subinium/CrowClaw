var B = location.origin,
  sid = localStorage.getItem('cc_sid') || null,
  ss = [],
  aT = [],
  aPre = null,
  aSk = null,
  allMem = [];
var authToken = null;

function ap(p, o) {
  var opts = Object.assign(
    { headers: { 'content-type': 'application/json' }, credentials: 'same-origin' },
    o || {}
  );
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  return fetch(B + p, opts).then(function (r) {
    if (r.status === 401) {
      showAuth();
      throw new Error('Unauthorized');
    }
    return r.json();
  });
}

function esc(t) {
  var d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function $(i) {
  return document.getElementById(i);
}

function ago(d) {
  if (!d) return '--';
  var s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  return s < 60
    ? s + 's ago'
    : s < 3600
      ? Math.floor(s / 60) + 'm ago'
      : s < 86400
        ? Math.floor(s / 3600) + 'h ago'
        : Math.floor(s / 86400) + 'd ago';
}

function showAuth() {
  $('authOv').classList.add('on');
}

function hideAuth() {
  $('authOv').classList.remove('on');
}

function authSubmit() {
  var tok = $('authIn').value.trim();
  if (!tok) {
    $('authErr').textContent = 'Please enter a token';
    return;
  }
  $('authErr').textContent = '';
  fetch(B + '/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token: tok }),
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      if (d.ok) {
        authToken = tok;
        hideAuth();
        initApp();
      } else {
        $('authErr').textContent = 'Invalid token';
        $('authBox').classList.add('shake');
        setTimeout(function () {
          $('authBox').classList.remove('shake');
        }, 500);
      }
    })
    .catch(function () {
      $('authErr').textContent = 'Connection error';
    });
}

function checkAuth() {
  chk();
  connectSSE();
  fetch(B + '/api/auth/check', { method: 'GET', credentials: 'same-origin' })
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      if (d.authenticated) {
        hideAuth();
        initApp();
      } else {
        showAuth();
      }
    })
    .catch(function () {
      initApp();
    });
}

function toggleMobileSb() {
  var sb = $('sbEl');
  sb.classList.toggle('mobile-open');
  $('mobBack').classList.toggle('on', sb.classList.contains('mobile-open'));
}

function closeMobileSb() {
  $('sbEl').classList.remove('mobile-open');
  $('mobBack').classList.remove('on');
}

function toggleSessSidebar() {
  var sb = $('sessSb');
  sb.style.display = sb.style.display === 'none' ? 'flex' : 'none';
}

function md(r) {
  if (!r) return '';
  var t = r;
  var codeBlocks = [];
  var cbRe = new RegExp('```(\\w*)\n([\\s\\S]*?)```', 'g');
  t = t.replace(cbRe, function (_, lang, code) {
    var idx = codeBlocks.length;
    codeBlocks.push(
      '<div style="position:relative"><pre class="md-pre"><code' +
        (lang ? ' class="lang-' + esc(lang) + '"' : '') +
        '>' +
        esc(code.trim()) +
        '</code></pre><button class="btn" onclick="navigator.clipboard.writeText(this.parentElement.querySelector(&apos;code&apos;).textContent);showToast(&apos;Copied&apos;,&apos;success&apos;)" style="position:absolute;top:6px;right:6px;font-size:10px;padding:2px 8px;opacity:0.3">Copy</button></div>'
    );
    return '%%CODEBLOCK' + idx + '%%';
  });
  var inlineCode = [];
  var icRe = new RegExp('`([^`]+)`', 'g');
  t = t.replace(icRe, function (_, code) {
    var idx = inlineCode.length;
    inlineCode.push('<code class="md-inline">' + esc(code) + '</code>');
    return '%%INLINE' + idx + '%%';
  });
  t = esc(t);
  t = t.replace(new RegExp('\\*\\*(.+?)\\*\\*', 'g'), '<strong>$1</strong>');
  t = t.replace(new RegExp('\\*(.+?)\\*', 'g'), '<em>$1</em>');
  t = t.replace(new RegExp('^### (.+)$', 'gm'), '<h3 class="md-h">$1</h3>');
  t = t.replace(new RegExp('^## (.+)$', 'gm'), '<h2 class="md-h">$1</h2>');
  t = t.replace(new RegExp('^# (.+)$', 'gm'), '<h1 class="md-h">$1</h1>');
  t = t.replace(
    new RegExp('^&gt; (.+)$', 'gm'),
    '<blockquote class="md-bq">$1</blockquote>'
  );
  t = t.replace(new RegExp('^---$', 'gm'), '<hr class="md-hr">');
  t = t.replace(
    new RegExp('\\[([^\\]]+)\\]\\(([^)]+)\\)', 'g'),
    function(_, label, url) {
      var trimmed = url.trim().toLowerCase();
      if (/^(javascript|vbscript|data):/i.test(trimmed)) {
        return '<span title="Blocked: unsafe URL scheme">' + label + '</span>';
      }
      return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
    }
  );
  var lines = t.split('\n');
  var out = [];
  var inUl = false;
  var inOl = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (new RegExp('^- (.+)$').test(line)) {
      if (!inUl) {
        if (inOl) {
          out.push('</ol>');
          inOl = false;
        }
        out.push('<ul class="md-ul">');
        inUl = true;
      }
      out.push('<li>' + line.replace(new RegExp('^- '), '') + '</li>');
    } else if (new RegExp('^\\d+\\. (.+)$').test(line)) {
      if (!inOl) {
        if (inUl) {
          out.push('</ul>');
          inUl = false;
        }
        out.push('<ol class="md-ol">');
        inOl = true;
      }
      out.push('<li>' + line.replace(new RegExp('^\\d+\\. '), '') + '</li>');
    } else {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      out.push(line);
    }
  }
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');
  t = out.join('\n');
  t = t.replace(new RegExp('\n\n+', 'g'), '</p><p>');
  t = t.replace(new RegExp('\n', 'g'), '<br>');
  t = '<p>' + t + '</p>';
  t = t.replace(new RegExp('<p>\\s*</p>', 'g'), '');
  t = t.replace(
    new RegExp('<p>\\s*(<h[123]|<pre|<ul|<ol|<blockquote|<hr)', 'g'),
    '$1'
  );
  t = t.replace(
    new RegExp(
      '(</h[123]>|</pre>|</ul>|</ol>|</blockquote>|<hr[^>]*>)\\s*</p>',
      'g'
    ),
    '$1'
  );
  for (var j = 0; j < codeBlocks.length; j++) {
    t = t.replace('%%CODEBLOCK' + j + '%%', codeBlocks[j]);
  }
  for (var k = 0; k < inlineCode.length; k++) {
    t = t.replace('%%INLINE' + k + '%%', inlineCode[k]);
  }
  return t;
}

function tcc(n, ok, out) {
  var id = 'tc' + Math.random().toString(36).slice(2, 7);
  return (
    '<div id="' +
    id +
    '" style="align-self:flex-start;max-width:90%;margin:2px 0"><div class="sf-row" onclick="var d=document.getElementById(&apos;' +
    id +
    '&apos;).querySelector(&apos;.sf-detail&apos;);if(d)d.style.display=d.style.display===&apos;none&apos;?&apos;block&apos;:&apos;none&apos;" style="border:1px solid ' +
    (ok ? 'rgba(48,209,88,.2)' : 'rgba(255,69,58,.3)') +
    ';background:' +
    (ok ? 'rgba(48,209,88,.03)' : 'rgba(255,69,58,.04)') +
    ';border-radius:6px;padding:6px 12px"><span class="sf-dot ' +
    (ok ? 'ok' : 'er') +
    '"></span><span class="sf-name">' +
    esc(n) +
    '</span><span class="sf-status" style="color:' +
    (ok ? 'var(--ok)' : 'var(--er)') +
    '">' +
    (ok ? 'done' : 'error') +
    '</span></div><div class="sf-detail" style="display:none;border:1px solid rgba(255,255,255,.06);border-top:none;border-radius:0 0 6px 6px;padding:8px 12px">' +
    esc(out.slice(0, 500)) +
    '</div></div>'
  );
}

function go(el) {
  var ns = document.querySelectorAll('.ni');
  for (var i = 0; i < ns.length; i++) ns[i].classList.remove('a');
  el.classList.add('a');
  var v = el.getAttribute('data-v');
  var vs = document.querySelectorAll('.mn>.vw');
  for (var i = 0; i < vs.length; i++) vs[i].classList.remove('on');
  $('v-' + v).classList.add('on');
  closeMobileSb();
  if (v === 'chat' && sid) lH();
  if (v === 'agent') {
    rSk();
    lPre();
  }
  if (v === 'connect') {
    lProv();
    lMcp();
    rGw();
    lT();
    lConnectStatus();
  }
  if (v === 'automate') {
    lJobs();
    jbStartAutoRefresh();
  } else {
    jbStopAutoRefresh();
  }
  if (v === 'settings') {
    lAgentCfg();
    lSec();
    lUsage();
    lCfg();
    loadMemories();
    rLogs();
  }
}

function goTo(v) {
  var viewMap = {
    memory: 'settings',
    presets: 'agent',
    skills: 'agent',
    tools: 'connect',
    gateway: 'connect',
    mcp: 'connect',
    providers: 'connect',
    jobs: 'automate',
    usage: 'settings',
    security: 'settings',
    logs: 'settings',
  };
  var mapped = viewMap[v] || v;
  var ns = document.querySelectorAll('.ni');
  for (var i = 0; i < ns.length; i++) {
    if (ns[i].getAttribute('data-v') === mapped) {
      go(ns[i]);
      return;
    }
  }
}

function chk() {
  ap('/health')
    .then(function (h) {
      $('sLed').className = 'led ' + (h.ok ? 'ok' : 'er');
      $('sLbl').textContent = h.ok ? 'Connected' : 'Error';
    })
    .catch(function () {
      $('sLed').className = 'led er';
      $('sLbl').textContent = 'Offline';
    });
}

var evtSrc = null;

function connectSSE() {
  if (evtSrc) evtSrc.close();
  try {
    evtSrc = new EventSource(B + '/api/events');
    evtSrc.onopen = function () {
      $('sLed').className = 'led ok';
      $('sLbl').textContent = 'Live';
    };
    evtSrc.addEventListener('heartbeat', function (e) {
      try {
        var d = JSON.parse(e.data);
        if (d.sessions !== undefined) {
          $('nSs').textContent = d.sessions;
        }
      } catch (ex) {}
    });
    evtSrc.addEventListener('status', function (e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'connected') {
          $('sLed').className = 'led ok';
          $('sLbl').textContent = 'Live';
        }
      } catch (ex) {}
    });
    evtSrc.onerror = function () {
      $('sLed').className = 'led';
      $('sLbl').textContent = 'Reconnecting...';
    };
  } catch (ex) {}
}

function lSessions() {
  ap('/api/sessions')
    .then(function (d) {
      var sv = d.sessions || [];
      sv.forEach(function (s) {
        if (
          !ss.find(function (x) {
            return x.id === s.sessionId;
          })
        ) {
          ss.push({
            id: s.sessionId,
            n: s.messageCount || 0,
            t: s.updatedAt || new Date().toISOString(),
            preview: s.preview || '',
          });
        }
      });
      rSessList();
    })
    .catch(function () {});
}

function rSessList() {
  $('nSs').textContent = ss.length;
  var q = ($('sessSearch') ? $('sessSearch').value : '').toLowerCase();
  var filtered = ss;
  if (q) {
    filtered = ss.filter(function (s) {
      return (
        (s.id || '').toLowerCase().indexOf(q) !== -1 ||
        (s.title || '').toLowerCase().indexOf(q) !== -1 ||
        (s.preview || '').toLowerCase().indexOf(q) !== -1
      );
    });
  }
  filtered.sort(function (a, b) {
    return new Date(b.t || 0).getTime() - new Date(a.t || 0).getTime();
  });
  var h = '';
  if (!filtered.length) {
    h +=
      '<div class="em" style="padding:20px 0"><div class="em-s">' +
      (ss.length ? 'No matching sessions' : 'No sessions yet') +
      '</div></div>';
  }
  filtered.forEach(function (s) {
    var isActive = s.id === sid;
    var title = s.title || (s.preview ? s.preview.slice(0, 30) : s.id.slice(0, 20));
    h +=
      '<div class="sess-item' +
      (isActive ? ' active' : '') +
      '" data-sid="' +
      esc(s.id) +
      '" onclick="pk(&apos;' +
      esc(s.id) +
      '&apos;)">';
    h +=
      '<div class="sess-actions"><button onclick="event.stopPropagation();sessRename(&apos;' +
      esc(s.id) +
      '&apos;)" title="Rename">&#9998;</button><button onclick="event.stopPropagation();sessDelete(&apos;' +
      esc(s.id) +
      '&apos;)" title="Delete">&#128465;</button></div>';
    h +=
      '<div class="sess-title" id="stitle-' + esc(s.id) + '">' + esc(title) + '</div>';
    h +=
      '<div class="sess-meta"><span>' +
      ago(s.t) +
      '</span><span>' +
      (s.n || 0) +
      ' msgs</span></div>';
    if (s.contextPct !== undefined) {
      h +=
        '<div class="sess-ctx"><div class="sess-ctx-bar" style="width:' +
        Math.min(100, s.contextPct || 0) +
        '%"></div></div>';
    }
    h += '</div>';
  });
  $('sessList').innerHTML = h;
}

function filterSessions() {
  rSessList();
}

function sessRename(id) {
  var el = document.querySelector('[data-sid="' + id + '"] .sess-title');
  if (!el) return;
  var cur = el.textContent;
  el.innerHTML =
    '<input class="sess-rename-input" value="' +
    esc(cur) +
    '" onkeydown="if(event.key===&apos;Enter&apos;){sessDoRename(&apos;' +
    esc(id) +
    '&apos;,this.value);event.stopPropagation()}else if(event.key===&apos;Escape&apos;){rSessList();event.stopPropagation()}" onclick="event.stopPropagation()" autofocus>';
  el.querySelector('input').focus();
  el.querySelector('input').select();
}

function sessDoRename(id, name) {
  ap('/api/sessions/' + id + '/rename', {
    method: 'POST',
    body: JSON.stringify({ name: name }),
  })
    .then(function () {
      var s = ss.find(function (x) {
        return x.id === id;
      });
      if (s) s.title = name;
      rSessList();
    })
    .catch(function () {
      rSessList();
    });
}

function sessDelete(id) {
  showConfirmModal('Delete this session?', function () {
    ap('/api/sessions/' + id, { method: 'DELETE' })
      .then(function () {
        ss = ss.filter(function (x) {
          return x.id !== id;
        });
        if (sid === id) {
          sid = null;
          localStorage.removeItem('cc_sid');
          $('cMs').innerHTML =
            '<div class="em"><div class="em-t">No Session</div><div class="em-s">Create a session to start</div></div>';
        }
        rSessList();
      })
      .catch(function () {});
  });
}

var cpItems = [
  { cat: 'Navigate', label: 'Chat', action: function () { goTo('chat'); }, key: '' },
  { cat: 'Navigate', label: 'Agent', action: function () { goTo('agent'); }, key: '' },
  { cat: 'Navigate', label: 'Connect', action: function () { goTo('connect'); }, key: '' },
  { cat: 'Navigate', label: 'Automate', action: function () { goTo('automate'); }, key: '' },
  { cat: 'Navigate', label: 'Settings', action: function () { goTo('settings'); }, key: '' },
  { cat: 'Navigate', label: 'Skills', action: function () { goTo('skills'); }, key: '' },
  { cat: 'Navigate', label: 'Providers', action: function () { goTo('providers'); }, key: '' },
  { cat: 'Navigate', label: 'Memory', action: function () { goTo('memory'); }, key: '' },
  { cat: 'Navigate', label: 'Security', action: function () { goTo('security'); }, key: '' },
  { cat: 'Navigate', label: 'Usage', action: function () { goTo('usage'); }, key: '' },
  { cat: 'Actions', label: 'New Session', action: function () { mkS(); }, key: 'N' },
  { cat: 'Actions', label: 'New Job', action: function () { jbModalOpen(); }, key: 'J' },
  { cat: 'Actions', label: 'Refresh Tools', action: function () { lT(); }, key: 'R' },
];

var cpIdx = 0;

function cpOpen() {
  $('cpOv').classList.add('on');
  $('cpIn').value = '';
  cpFilter();
  $('cpIn').focus();
}

function cpClose() {
  $('cpOv').classList.remove('on');
}

function cpFilter() {
  var q = $('cpIn').value.toLowerCase();
  var f = q
    ? cpItems.filter(function (i) {
        return (
          i.label.toLowerCase().indexOf(q) !== -1 ||
          i.cat.toLowerCase().indexOf(q) !== -1
        );
      })
    : cpItems;
  cpIdx = 0;
  var cats = {};
  f.forEach(function (i) {
    if (!cats[i.cat]) cats[i.cat] = [];
    cats[i.cat].push(i);
  });
  var h = '';
  Object.keys(cats).forEach(function (c) {
    h += '<div class="cp-cat">' + esc(c) + '</div>';
    cats[c].forEach(function (it) {
      var gIdx = f.indexOf(it);
      h +=
        '<div class="cp-item' +
        (gIdx === 0 ? ' a' : '') +
        '" data-ci="' +
        gIdx +
        '" onclick="cpExec(' +
        gIdx +
        ')" onmouseenter="cpHover(' +
        gIdx +
        ')">' +
        esc(it.label);
      if (it.key) h += '<span class="cp-k">' + esc(it.key) + '</span>';
      h += '</div>';
    });
  });
  $('cpList').innerHTML =
    h || '<div style="padding:16px;color:var(--t3);font-size:12px">No matches</div>';
}

function cpHover(i) {
  cpIdx = i;
  var items = $('cpList').querySelectorAll('.cp-item');
  for (var j = 0; j < items.length; j++)
    items[j].classList.toggle('a', parseInt(items[j].getAttribute('data-ci')) === i);
}

function cpKey(e) {
  if (e.key === 'Escape') {
    cpClose();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter') {
    cpExec(cpIdx);
    cpClose();
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    cpIdx = Math.min(cpIdx + 1, $('cpList').querySelectorAll('.cp-item').length - 1);
    cpHover(cpIdx);
    e.preventDefault();
  }
  if (e.key === 'ArrowUp') {
    cpIdx = Math.max(cpIdx - 1, 0);
    cpHover(cpIdx);
    e.preventDefault();
  }
}

function cpExec(i) {
  var q = $('cpIn').value.toLowerCase();
  var f = q
    ? cpItems.filter(function (it) {
        return (
          it.label.toLowerCase().indexOf(q) !== -1 ||
          it.cat.toLowerCase().indexOf(q) !== -1
        );
      })
    : cpItems;
  if (f[i]) f[i].action();
  cpClose();
}

function mkS() {
  var id = 's-' + Date.now().toString(36);
  ss.push({ id: id, n: 0, t: new Date().toISOString(), title: '', preview: '' });
  rSessList();
  pk(id);
}

function pk(id) {
  sid = id;
  localStorage.setItem('cc_sid', id);
  rSessList();
  lH();
}

function lH() {
  if (!sid) return;
  ap('/api/sessions/' + sid + '/history')
    .then(function (d) {
      rMs(d.messages || []);
    })
    .catch(function () {
      rMs([]);
    });
}

function rMs(ms) {
  var c = $('cMs');
  if (!ms || !ms.length) {
    c.innerHTML =
      '<div class="em"><div class="em-t">New Session</div><div class="em-s">Type a message to begin.</div></div>';
    return;
  }
  c.innerHTML = ms
    .map(function (m, i) {
      var r = m.role || 'user';
      if (r === 'tool') {
        var ok = !m.content || !m.content.match(/error|fail/i);
        return tcc(m.name || 'tool', ok, m.content || '');
      }
      var b =
        r === 'user'
          ? esc(m.content || '')
          : '<div class="md">' + md(m.content || '') + '</div>';
      return (
        '<div class="mg ' +
        (r === 'user' ? 'u' : r === 'assistant' ? 'as' : r === 'system' ? 'sy' : 'tl') +
        '"><span class="rt">' +
        r +
        (m.name ? ' / ' + esc(m.name) : '') +
        '</span>' +
        b +
        (r === 'assistant' && i > 0
          ? '<button class="btn" onclick="msgRetry(' +
            i +
            ')" style="margin-top:6px;font-size:10px;padding:2px 8px;opacity:0.5">Retry</button>'
          : '') +
        '</div>'
      );
    })
    .join('');
  c.scrollTop = c.scrollHeight;
  applyHljs();
}

function snd() {
  var el = $('mIn'),
    t = el.value.trim();
  if (!t || !sid) return;
  el.value = '';
  var c = $('cMs');
  if (c.querySelector('.em')) c.innerHTML = '';
  c.innerHTML += '<div class="mg u"><span class="rt">you</span>' + esc(t) + '</div>';
  c.innerHTML +=
    '<div class="typ"><div class="td"></div><div class="td"></div><div class="td"></div></div>';
  c.scrollTop = c.scrollHeight;
  var s = ss.find(function (x) {
    return x.id === sid;
  });
  if (s) {
    s.n = (s.n || 0) + 1;
    s.t = new Date().toISOString();
    if (!s.title) s.title = t.slice(0, 30);
    s.preview = t.slice(0, 60);
    rSessList();
  }
  ap('/api/sessions/' + sid, {
    method: 'POST',
    body: JSON.stringify({ userMessage: t }),
  })
    .then(function (d) {
      var ind = c.querySelector('.typ');
      if (ind) ind.remove();
      if (d.toolResults && d.toolResults.length) {
        d.toolResults.forEach(function (tr) {
          c.innerHTML += tcc(tr.toolName, tr.ok, tr.output || '');
        });
      }
      lH();
    })
    .catch(function (e) {
      var ind = c.querySelector('.typ');
      if (ind) ind.remove();
      c.innerHTML +=
        '<div class="err-state"><div class="err-msg">Error: ' +
        (e.message || 'Unknown') +
        '</div><button class="btn" onclick="lH()">Retry</button></div>';
    });
}

function lT() {
  ap('/api/system/status')
    .then(function (d) {
      var t = d.tools || [];
      aT = t.map(function (x) {
        return typeof x === 'string'
          ? { name: x, description: '', runtime: 'worker', dangerLevel: '' }
          : x;
      });
      $('nTl').textContent = aT.length;
      if (d.model) $('ftMod').textContent = d.model;
      if (aT.length) $('ftTl').textContent = aT.length + ' tools';
      fTl();
    })
    .catch(function () {
      $('tGrd').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load tools</div><button class="btn" onclick="lT()">Retry</button></div>';
    });
}

function fTl() {
  var q = ($('tlSr') ? $('tlSr').value : '').toLowerCase();
  var f = aT;
  if (q) {
    f = aT.filter(function (x) {
      return (
        (x.name || '').toLowerCase().indexOf(q) !== -1 ||
        (x.description || '').toLowerCase().indexOf(q) !== -1
      );
    });
  }
  var groups = {};
  f.forEach(function (x) {
    var p = (x.name || '').split('.');
    var g = p.length > 1 ? p[0] : 'core';
    if (!groups[g]) groups[g] = [];
    groups[g].push(x);
  });
  var el = $('tGrd');
  if (!f.length) {
    el.innerHTML = '<div class="em"><div class="em-s">No tools found</div></div>';
    return;
  }
  var h = '';
  Object.keys(groups)
    .sort()
    .forEach(function (g) {
      h +=
        '<div style="grid-column:1/-1"><div class="sec-h" style="margin-top:10px">' +
        esc(g.toUpperCase()) +
        '</div></div>';
      groups[g].forEach(function (x) {
        h +=
          '<div class="tl-card"><div class="tl-nm">' + esc(x.name || '') + '</div>';
        if (x.description)
          h +=
            '<div class="tl-ds">' +
            esc((x.description || '').slice(0, 100)) +
            '</div>';
        h +=
          '<div class="tl-mt"><span class="tag">' +
          esc(x.runtime || 'worker') +
          '</span>';
        if (x.dangerLevel === 'high' || x.dangerLevel === 'critical')
          h += '<span class="tag er">danger</span>';
        h += '</div></div>';
      });
    });
  el.innerHTML = h;
}

var actPre = localStorage.getItem('cc_preset') || null,
  actTs = localStorage.getItem('cc_toolset') || null;

function lPre() {
  lCfgPre();
  if (aPre) {
    rPre();
    return;
  }
  ap('/api/presets')
    .then(function (d) {
      aPre = d;
      rPre();
    })
    .catch(function () {
      $('pAgent').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load presets</div><button class="btn" onclick="aPre=null;lPre()">Retry</button></div>';
    });
}

function rPre() {
  if (!aPre) return;
  var agents = aPre.agents || [];
  $('pAgent').innerHTML =
    agents
      .map(function (a) {
        var isA = actPre === a.name;
        var tools = (a.tools || [])
          .map(function (t) {
            return '<span class="tag">' + esc(t) + '</span>';
          })
          .join('');
        return (
          '<div class="pre-card' +
          (isA ? ' style="border-color:var(--ac)"' : '') +
          '"><h4>' +
          esc(a.name) +
          '</h4><div class="role">' +
          esc(a.role || '') +
          '</div><div class="goal">' +
          esc(a.goal || '') +
          '</div>' +
          (tools ? '<div class="tr">' + tools + '</div>' : '') +
          '<button class="btn' +
          (isA ? ' btn-p' : '') +
          '" onclick="aPr(&apos;' +
          esc(a.name) +
          '&apos;)">' +
          (isA ? 'Active' : 'Apply') +
          '</button></div>'
        );
      })
      .join('') ||
    '<div class="em"><div class="em-s">No agent presets</div></div>';
  var tss = aPre.toolsets || [];
  $('pToolset').innerHTML =
    tss
      .map(function (ts) {
        var isA = actTs === ts.name;
        var names = (ts.toolNames || []).join(', ');
        return (
          '<div class="pre-card' +
          (isA ? ' style="border-color:var(--ac)"' : '') +
          '"><h4>' +
          esc(ts.name) +
          '</h4><div class="goal">' +
          esc(ts.description || '') +
          '</div><div style="font-size:10px;color:var(--t3);font-family:var(--m);line-height:1.5;margin-bottom:8px">' +
          esc(names.slice(0, 140)) +
          '</div>' +
          (isA
            ? '<span class="tag ac">Active</span>'
            : '<button class="btn" onclick="aTs(&apos;' +
              esc(ts.name) +
              '&apos;)">Select</button>') +
          '</div>'
        );
      })
      .join('') ||
    '<div class="em"><div class="em-s">No toolset presets</div></div>';
  var mcps = aPre.mcp || [];
  var avail = window._mcpPresetStatus || {};
  $('pMcpP').innerHTML =
    mcps
      .map(function (m) {
        var isOn = localStorage.getItem('cc_mcp_' + m.name) === 'on';
        var ps = avail[m.name];
        var unavail = ps && ps.available === false;
        var errHtml = unavail
          ? '<div style="font-size:9px;color:var(--er);margin-top:4px">' +
            esc(ps.error || 'Unavailable') +
            '</div>'
          : '';
        var btnDisabled =
          unavail && !isOn ? ' disabled style="opacity:0.5"' : '';
        return (
          '<div class="pre-card' +
          (isOn ? ' style="border-color:var(--ok)"' : '') +
          '"><h4>' +
          esc(m.name) +
          '</h4><div class="goal">' +
          esc(m.description || '') +
          '</div>' +
          errHtml +
          '<div style="display:flex;gap:4px;margin-top:6px"><button class="btn' +
          (isOn ? ' btn-p' : '') +
          '"' +
          btnDisabled +
          ' onclick="tgMcp(&apos;' +
          esc(m.name) +
          '&apos;,this);rPre()">' +
          (isOn ? 'Connected' : 'Connect') +
          '</button>' +
          (isOn
            ? '<button class="btn" onclick="testMcp(&apos;' +
              esc(m.name) +
              '&apos;,this)">Test</button>'
            : '') +
          '</div></div>'
        );
      })
      .join('') ||
    '<div class="em"><div class="em-s">No MCP presets</div></div>';
}

function pTab(el) {
  var tabs = document.querySelectorAll('#pTabs .tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('a');
  el.classList.add('a');
  var t = el.getAttribute('data-pt');
  $('pConfig').style.display = t === 'config' ? 'grid' : 'none';
  $('pAgent').style.display = t === 'agent' ? 'grid' : 'none';
  $('pToolset').style.display = t === 'toolset' ? 'grid' : 'none';
  $('pMcpP').style.display = t === 'mcp-p' ? 'grid' : 'none';
  if (t === 'config') rCfgPre();
}

function aPr(n) {
  actPre = n;
  localStorage.setItem('cc_preset', n);
  var preset = (aPre && aPre.agents || []).find(function (a) {
    return a.name === n;
  });
  if (preset) {
    ap('/api/agent/preset', {
      method: 'POST',
      body: JSON.stringify({
        name: n,
        role: preset.role,
        goal: preset.goal,
        backstory: preset.backstory,
      }),
    }).catch(function () {});
  }
  rPre();
}

function aTs(n) {
  actTs = n;
  localStorage.setItem('cc_toolset', n);
  ap('/api/toolset/select', {
    method: 'POST',
    body: JSON.stringify({ name: n }),
  }).catch(function () {});
  rPre();
}

var cfgPreData = null,
  actCfgPre = null;

function lCfgPre() {
  ap('/api/config-presets')
    .then(function (d) {
      cfgPreData = d.presets || [];
      actCfgPre = d.active || null;
      rCfgPre();
    })
    .catch(function () {
      $('pConfig').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load config presets</div><button class="btn" onclick="cfgPreData=null;lCfgPre()">Retry</button></div>';
    });
}

function rCfgPre() {
  if (!cfgPreData) {
    lCfgPre();
    return;
  }
  var h =
    '<div style="grid-column:1/-1;margin-bottom:4px"><button class="btn btn-p" onclick="cfgPreModal()">+ Create New</button></div>';
  cfgPreData.forEach(function (p) {
    var isA = actCfgPre === p.name;
    var mcpC = (p.mcpServers || []).length;
    var skC = (p.skills || []).length;
    var tlC = (p.tools || []).length;
    var meta = [];
    if (mcpC) meta.push(mcpC + ' MCP');
    if (skC) meta.push(skC + ' skills');
    if (tlC) meta.push(tlC + ' tools');
    if (p.toolset) meta.push('toolset: ' + p.toolset);
    h +=
      '<div class="card' +
      (isA ? ' style="border-color:var(--ac)"' : '') +
      '"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><h4 style="font-size:13px;font-weight:600">' +
      esc(p.name) +
      '</h4>' +
      (isA ? '<span class="tag ac">Active</span>' : '') +
      '</div>';
    h +=
      '<div style="font-size:11px;color:var(--t2);margin-bottom:6px">' +
      esc(p.description || '') +
      '</div>';
    if (meta.length)
      h +=
        '<div style="font-size:10px;color:var(--t3);font-family:var(--m);margin-bottom:8px">' +
        esc(meta.join(' | ')) +
        '</div>';
    if (p.model)
      h +=
        '<div style="font-size:10px;color:var(--t3);margin-bottom:6px">Model: ' +
        esc(p.model) +
        '</div>';
    h +=
      '<div style="display:flex;gap:4px"><button class="btn' +
      (isA ? ' btn-p' : '') +
      '" onclick="cfgPreSwitch(&apos;' +
      esc(p.name) +
      '&apos;)">' +
      (isA ? 'Active' : 'Activate') +
      '</button><button class="btn" onclick="cfgPreEdit(&apos;' +
      esc(p.name) +
      '&apos;)">Edit</button><button class="btn btn-danger" onclick="cfgPreDel(&apos;' +
      esc(p.name) +
      '&apos;)">Delete</button></div></div>';
  });
  if (cfgPreData.length === 0)
    h +=
      '<div class="em" style="grid-column:1/-1"><div class="em-s">No config presets</div></div>';
  $('pConfig').innerHTML = h;
}

function cfgPreSwitch(n) {
  ap('/api/config-presets/switch', {
    method: 'POST',
    body: JSON.stringify({ name: n }),
  })
    .then(function (d) {
      if (d.ok) {
        actCfgPre = n;
        if (d.preset && d.preset.toolset) {
          actTs = d.preset.toolset;
          localStorage.setItem('cc_toolset', actTs);
        }
        rCfgPre();
      }
    })
    .catch(function () {});
}

function cfgPreDel(n) {
  showConfirmModal('Delete config preset "' + n + '"?', function () {
    ap('/api/config-presets/' + encodeURIComponent(n), { method: 'DELETE' })
      .then(function (d) {
        if (d.ok) {
          cfgPreData = (cfgPreData || []).filter(function (p) {
            return p.name !== n;
          });
          if (actCfgPre === n) actCfgPre = null;
          rCfgPre();
        }
      })
      .catch(function () {});
  });
}

function cfgPreModal(edit) {
  var existing = edit
    ? (cfgPreData || []).find(function (p) {
        return p.name === edit;
      })
    : null;
  var title = existing ? 'Edit Config Preset' : 'Create Config Preset';
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'cfgPreOv';
  overlay.onclick = function (e) {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML =
    '<div class="modal-box" role="dialog"><div class="modal-hdr"><h3>' +
    title +
    '</h3><button class="modal-close" onclick="document.getElementById(&apos;cfgPreOv&apos;).remove()">&times;</button></div><div class="modal-body"><div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="cfgPreName" value="' +
    esc(existing ? existing.name : '') +
    '"' +
    (existing ? ' readonly' : '') +
    '></div><div class="form-group"><label class="form-label">Description</label><input class="form-input" id="cfgPreDesc" value="' +
    esc(existing ? existing.description || '' : '') +
    '"></div><div class="form-group"><label class="form-label">MCP Servers (comma-separated)</label><input class="form-input" id="cfgPreMcp" value="' +
    esc(existing ? (existing.mcpServers || []).join(', ') : '') +
    '"></div><div class="form-group"><label class="form-label">Skills (comma-separated slugs)</label><input class="form-input" id="cfgPreSkills" value="' +
    esc(existing ? (existing.skills || []).join(', ') : '') +
    '"></div><div class="form-group"><label class="form-label">Toolset</label><input class="form-input" id="cfgPreToolset" value="' +
    esc(existing ? existing.toolset || '' : '') +
    '"></div><div class="form-group"><label class="form-label">Model (optional)</label><input class="form-input" id="cfgPreModel" value="' +
    esc(existing ? existing.model || '' : '') +
    '"></div></div><div class="modal-footer"><button class="btn" onclick="document.getElementById(&apos;cfgPreOv&apos;).remove()">Cancel</button><button class="btn btn-p" onclick="cfgPreSave()">Save</button></div></div>';
  document.body.appendChild(overlay);
}

function cfgPreEdit(n) {
  cfgPreModal(n);
}

function cfgPreSave() {
  var name = $('cfgPreName').value.trim();
  if (!name) {
    showToast('Name is required', 'error');
    return;
  }
  var mcp = $('cfgPreMcp').value.trim();
  var skills = $('cfgPreSkills').value.trim();
  var body = {
    name: name,
    description: $('cfgPreDesc').value.trim() || undefined,
    mcpServers: mcp
      ? mcp
          .split(',')
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
      : [],
    skills: skills
      ? skills
          .split(',')
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
      : [],
    toolset: $('cfgPreToolset').value.trim() || undefined,
    model: $('cfgPreModel').value.trim() || undefined,
  };
  ap('/api/config-presets', {
    method: 'POST',
    body: JSON.stringify(body),
  })
    .then(function (d) {
      if (d.ok) {
        var ov = document.getElementById('cfgPreOv');
        if (ov) ov.remove();
        cfgPreData = null;
        lCfgPre();
      }
    })
    .catch(function () {});
}

function rSk() {
  if (aSk) {
    fSk();
    return;
  }
  ap('/api/skills')
    .then(function (d) {
      aSk = d.skills || [];
      $('nSk').textContent = aSk.length;
      fSk();
    })
    .catch(function () {
      $('skLs').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load skills</div><button class="btn" onclick="aSk=null;rSk()">Retry</button></div>';
    });
}

function fSk() {
  if (!aSk) return;
  var q = $('skSr').value.toLowerCase();
  var f = q
    ? aSk.filter(function (s) {
        return (
          s.title.toLowerCase().indexOf(q) !== -1 ||
          s.summary.toLowerCase().indexOf(q) !== -1 ||
          (s.slug || '').toLowerCase().indexOf(q) !== -1 ||
          (s.triggerPhrases || []).some(function (tp) {
            return tp.toLowerCase().indexOf(q) !== -1;
          })
        );
      })
    : aSk;
  var catMap = {
    git: 'Git',
    code: 'Code Review',
    debug: 'Debugging',
    project: 'DevOps',
    api: 'API',
    database: 'DevOps',
    deploy: 'DevOps',
    write: 'Testing',
    refactor: 'Code Review',
    docker: 'DevOps',
    security: 'Security',
    performance: 'Performance',
    web: 'Web',
    github: 'Git',
    env: 'DevOps',
  };
  var groups = {};
  f.forEach(function (s) {
    var prefix = (s.slug || '').split('-')[0];
    var cat = catMap[prefix] || 'General';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  });
  var cats = Object.keys(groups).sort();
  var h = '';
  cats.forEach(function (c) {
    h +=
      '<div class="sec-h" style="margin-top:14px;margin-bottom:10px">' +
      esc(c) +
      ' <span style="color:var(--t3);font-weight:400">(' +
      groups[c].length +
      ')</span></div>';
    h += '<div class="grid" style="margin-bottom:6px">';
    groups[c].forEach(function (s) {
      var triggers = (s.triggerPhrases || [])
        .map(function (tp) {
          return '<span class="tag">' + esc(tp) + '</span>';
        })
        .join('');
      var steps = s.steps || [];
      var uid = 'sk' + Math.random().toString(36).slice(2, 7);
      var src = s.source || 'builtin';
      var srcColors = {
        builtin: 'var(--t3)',
        learned: 'var(--ok)',
        custom: 'var(--ac)',
        local: '#3498db',
      };
      var srcColor = srcColors[src] || 'var(--t3)';
      h +=
        '<div class="sk-card"><div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><h4 style="flex:1">' +
        esc(s.title) +
        '</h4><span class="tag" data-source="' +
        esc(src) +
        '" style="color:' +
        srcColor +
        '">' +
        esc(src.charAt(0).toUpperCase() + src.slice(1)) +
        '</span></div>';
      h += '<div class="sk-sum">' + esc(s.summary || '') + '</div>';
      if (triggers) h += '<div class="sk-tags">' + triggers + '</div>';
      if (steps.length) {
        h +=
          '<span class="sk-tog" onclick="var u=document.getElementById(&apos;' +
          uid +
          '&apos;);u.classList.toggle(&apos;hide&apos;);this.textContent=u.classList.contains(&apos;hide&apos;)?(&apos;' +
          steps.length +
          ' steps \u25B6&apos;):(&apos;' +
          steps.length +
          ' steps \u25BC&apos;)">' +
          steps.length +
          ' steps &#9654;</span>';
        h += '<ol class="sk-steps hide" id="' + uid + '">';
        steps.forEach(function (st) {
          h += '<li>' + esc(st) + '</li>';
        });
        h += '</ol>';
      }
      var enKey = 'cc_sk_' + s.slug;
      var isEn = localStorage.getItem(enKey) !== 'off';
      h +=
        '<div class="sk-act" style="flex-wrap:wrap"><label class="sw"><input type="checkbox" ' +
        (isEn ? 'checked' : '') +
        ' onchange="tgSk(&apos;' +
        esc(s.slug) +
        '&apos;,this.checked)"><span class="sw-sl"></span></label><span style="font-size:9px;color:' +
        (isEn ? 'var(--ok)' : 'var(--t3)') +
        '">' +
        (isEn ? 'Enabled' : 'Disabled') +
        '</span><span style="margin-left:auto;display:flex;gap:4px"><button class="btn" style="padding:2px 6px;font-size:9px" onclick="event.stopPropagation();skRate(&apos;' +
        esc(s.slug) +
        '&apos;,&apos;helpful&apos;)" title="Helpful">&#9650;</button><button class="btn" style="padding:2px 6px;font-size:9px" onclick="event.stopPropagation();skRate(&apos;' +
        esc(s.slug) +
        '&apos;,&apos;unhelpful&apos;)" title="Unhelpful">&#9660;</button><button class="btn" style="padding:2px 6px;font-size:9px" data-edit-btn onclick="event.stopPropagation();skModalOpen(&apos;' +
        esc(s.slug) +
        '&apos;)">Edit</button>' +
        (src !== 'builtin'
          ? '<button class="btn btn-danger" style="padding:2px 6px;font-size:9px" data-delete-btn onclick="event.stopPropagation();skDel(&apos;' +
            esc(s.slug) +
            '&apos;)">Delete</button>'
          : '') +
        '</span></div>';
      h += '</div>';
    });
    h += '</div>';
  });
  if (!h)
    h = '<div class="em"><div class="em-s">No skills found</div></div>';
  $('skLs').innerHTML = h;
}

var gwPlats = [
  { n: 'Telegram', id: 'telegram', r: '/webhooks/telegram', f: 'Bot Token', k: 'cc_gw_telegram', probe: true },
  { n: 'Discord', id: 'discord', r: '/webhooks/discord', f: 'Webhook URL', k: 'cc_gw_discord', probe: true },
  { n: 'Slack', id: 'slack', r: '/webhooks/slack', f: 'Bot Token', k: 'cc_gw_slack', probe: true },
  { n: 'WhatsApp', id: 'whatsapp', r: '/webhooks/whatsapp', f: 'Access Token', k: 'cc_gw_whatsapp', probe: true },
  { n: 'Signal', id: 'signal', r: '/webhooks/signal', f: 'Phone Number', k: 'cc_gw_signal', probe: false },
  { n: 'Email', id: 'email', r: '/webhooks/email', f: 'API Key', k: 'cc_gw_email', probe: false },
  { n: 'Matrix', id: 'matrix', r: '/webhooks/matrix', f: 'Access Token', k: 'cc_gw_matrix', probe: true },
  { n: 'SMS', id: 'sms', r: '/webhooks/sms', f: 'Twilio SID', k: 'cc_gw_sms', probe: false },
  { n: 'Webhook', id: 'webhook', r: '/webhooks/generic', f: 'Secret', k: 'cc_gw_webhook', probe: false },
];
var gwConfigured = {};

function rGw() {
  $('gGrd').innerHTML = gwPlats
    .map(function (g, i) {
      var u = location.origin + g.r;
      var cfg = !!gwConfigured[g.id];
      var dmPol = localStorage.getItem('cc_gw_dm_' + g.id) || 'pairing';
      var grpPol = localStorage.getItem('cc_gw_grp_' + g.id) || 'open';
      var h = '<div class="gw-card">';
      h +=
        '<div class="gw-hd"><div class="led ' +
        (cfg ? 'ok' : '') +
        '"></div><span class="gw-nm">' +
        esc(g.n) +
        '</span>';
      if (cfg)
        h += '<span class="cfg-badge" style="margin-left:auto">Configured</span>';
      h += '</div>';
      h +=
        '<div class="gw-url" onclick="navigator.clipboard.writeText(&apos;' +
        esc(u) +
        '&apos;);this.textContent=&apos;Copied!&apos;;var s=this;setTimeout(function(){s.textContent=&apos;' +
        esc(u) +
        '&apos;},1500)" title="Click to copy">' +
        esc(u) +
        '</div>';
      h +=
        '<div class="gw-fld"><label>' +
        esc(g.f) +
        '</label><input id="gwi' +
        i +
        '" type="password" value="" placeholder="Enter ' +
        esc(g.f.toLowerCase()) +
        '..."></div>';
      h +=
        '<div class="gw-acts"><button class="btn" onclick="svGw(' +
        i +
        ')">Save</button>';
      if (g.probe)
        h +=
          '<button class="btn" onclick="prGw(&apos;' +
          g.id +
          '&apos;,' +
          i +
          ')">Probe</button>';
      h += '</div>';
      h += '<div id="gwp' + i + '" class="gw-probe"></div>';
      h +=
        '<div class="gw-pol"><div class="gw-pol-r"><label>DM Policy</label><select id="gwdm' +
        i +
        '" onchange="svPol(&apos;' +
        g.id +
        '&apos;,' +
        i +
        ')">';
      ['pairing', 'allowlist', 'open', 'disabled'].forEach(function (p) {
        h +=
          '<option value="' +
          p +
          '"' +
          (dmPol === p ? ' selected' : '') +
          '>' +
          p +
          '</option>';
      });
      h +=
        '</select></div><div class="gw-pol-r"><label>Group Policy</label><select id="gwgp' +
        i +
        '" onchange="svPol(&apos;' +
        g.id +
        '&apos;,' +
        i +
        ')">';
      ['open', 'disabled', 'allowlist'].forEach(function (p) {
        h +=
          '<option value="' +
          p +
          '"' +
          (grpPol === p ? ' selected' : '') +
          '>' +
          p +
          '</option>';
      });
      h += '</select></div></div></div>';
      return h;
    })
    .join('');
}

function svGw(i) {
  var g = gwPlats[i];
  var val = $('gwi' + i).value;
  gwConfigured[g.id] = !!val;
  ap('/api/gateway/' + g.id + '/config', {
    method: 'POST',
    body: JSON.stringify({ token: val, enabled: !!val }),
  }).catch(function () {});
  rGw();
}

function prGw(platform, i) {
  var el = $('gwp' + i);
  el.innerHTML =
    '<span style="color:var(--t3);font-size:10px">Probing...</span>';
  var token = $('gwi' + i).value;
  if (!token) {
    el.innerHTML =
      '<span style="color:var(--er);font-size:10px">Enter token first</span>';
    return;
  }
  ap('/api/gateway/' + platform + '/probe', {
    method: 'POST',
    body: JSON.stringify({ token: token, webhookUrl: token }),
  })
    .then(function (d) {
      if (d.ok) {
        el.innerHTML =
          '<span style="color:var(--ok);font-size:10px">&#10003; ' +
          esc(d.identity || 'Valid') +
          '</span>';
      } else {
        el.innerHTML =
          '<span style="color:var(--er);font-size:10px">&#10007; ' +
          esc(d.error || 'Failed') +
          '</span>';
      }
    })
    .catch(function (e) {
      el.innerHTML =
        '<span style="color:var(--er);font-size:10px">Error: ' +
        esc(e.message || '') +
        '</span>';
    });
}

function svPol(platform, i) {
  var dm = $('gwdm' + i).value;
  var gp = $('gwgp' + i).value;
  localStorage.setItem('cc_gw_dm_' + platform, dm);
  localStorage.setItem('cc_gw_grp_' + platform, gp);
  ap('/api/gateway/' + platform + '/policy', {
    method: 'POST',
    body: JSON.stringify({ dmPolicy: dm, groupPolicy: gp }),
  }).catch(function () {});
}

function tgSk(slug, on) {
  localStorage.setItem('cc_sk_' + slug, on ? 'on' : 'off');
  ap('/api/skills/' + slug + '/toggle', {
    method: 'POST',
    body: JSON.stringify({ enabled: on }),
  }).catch(function () {});
  fSk();
}

function tgMcp(name, el) {
  var k = 'cc_mcp_' + name;
  var cur = localStorage.getItem(k) === 'on';
  var newState = !cur;
  localStorage.setItem(k, newState ? 'on' : 'off');
  el.textContent = newState ? 'Connecting...' : 'Disconnecting...';
  el.disabled = true;
  ap('/api/mcp/' + (newState ? 'connect' : 'disconnect'), {
    method: 'POST',
    body: JSON.stringify({ preset: name }),
  })
    .then(function (d) {
      el.textContent = newState ? 'Connected' : 'Connect';
      el.className = newState ? 'btn btn-p' : 'btn';
      el.disabled = false;
      var vEl = document.getElementById('mcpV_' + name);
      if (vEl && d && d.verify) {
        var v = d.verify;
        if (v.ok) {
          vEl.innerHTML =
            '<span style="color:var(--ok);font-size:10px">Connected -- ' +
            (v.toolCount || 0) +
            ' tools' +
            (typeof v.resourceCount === 'number'
              ? ', ' + v.resourceCount + ' resources'
              : '') +
            ' (' +
            v.latencyMs +
            'ms)</span>';
        } else {
          vEl.innerHTML =
            '<span style="color:var(--warn,#f59e0b);font-size:10px">Connected but verification failed: ' +
            (v.error || 'unknown') +
            '</span>';
        }
      }
    })
    .catch(function () {
      el.textContent = newState ? 'Connected' : 'Connect';
      el.className = newState ? 'btn btn-p' : 'btn';
      el.disabled = false;
    });
  lMcp();
}

function testMcp(name, btn) {
  btn.textContent = 'Testing...';
  btn.disabled = true;
  ap('/api/mcp/verify', {
    method: 'POST',
    body: JSON.stringify({ preset: name }),
  })
    .then(function (v) {
      var vEl = document.getElementById('mcpV_' + name);
      if (vEl) {
        if (v.ok) {
          vEl.innerHTML =
            '<span style="color:var(--ok);font-size:10px">Connected -- ' +
            (v.toolCount || 0) +
            ' tools' +
            (typeof v.resourceCount === 'number'
              ? ', ' + v.resourceCount + ' resources'
              : '') +
            ' (' +
            v.latencyMs +
            'ms)</span>';
        } else {
          vEl.innerHTML =
            '<span style="color:var(--warn,#f59e0b);font-size:10px">Verification failed: ' +
            (v.error || 'unknown') +
            '</span>';
        }
      }
      btn.textContent = 'Test';
      btn.disabled = false;
    })
    .catch(function () {
      btn.textContent = 'Test';
      btn.disabled = false;
    });
}

function lMcp() {
  ap('/api/system/status')
    .then(function (d) {
      var mc = d.mcp;
      if (!mc) {
        $('mcpSt').innerHTML =
          '<div class="mcp-blk"><div class="mcp-row"><span class="lbl">Status</span><span class="val" style="color:var(--t3)">No MCP client configured</span></div></div>';
        return;
      }
      var ok = !mc.degraded;
      var h = '<div class="mcp-blk">';
      h +=
        '<div class="mcp-row"><span class="lbl">Status</span><span class="val" style="color:var(' +
        (ok ? '--ok' : '--er') +
        ');">' +
        (ok ? 'Healthy' : 'Degraded') +
        '</span></div>';
      h +=
        '<div class="mcp-row"><span class="lbl">Cached Tools</span><span class="val">' +
        (mc.cachedTools || 0) +
        '</span></div>';
      h +=
        '<div class="mcp-row"><span class="lbl">Revision</span><span class="val">' +
        (mc.toolsRevision || 0) +
        '</span></div>';
      h += '</div>';
      $('mcpSt').innerHTML = h;
    })
    .catch(function () {
      $('mcpSt').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load MCP status</div><button class="btn" onclick="lMcp()">Retry</button></div>';
    });
  lMcpCustom();
  lMcpPresetStatus();
  if (aPre) {
    rMcpPr();
    return;
  }
  ap('/api/presets')
    .then(function (d) {
      aPre = d;
      rMcpPr();
    })
    .catch(function () {});
}

function rMcpPr() {
  var mcps = (aPre && aPre.mcp) || [];
  var avail = window._mcpPresetStatus || {};
  $('mcpPr').innerHTML =
    mcps
      .map(function (m) {
        var isOn = localStorage.getItem('cc_mcp_' + m.name) === 'on';
        var ps = avail[m.name];
        var unavail = ps && ps.available === false;
        var errHtml = unavail
          ? '<div style="font-size:9px;color:var(--er);margin-bottom:4px">' +
            esc(ps.error || 'Unavailable') +
            '</div>'
          : '';
        var btnDisabled =
          unavail && !isOn ? ' disabled style="opacity:0.5"' : '';
        return (
          '<div class="card' +
          (isOn ? ' style="border-color:var(--ok)"' : '') +
          '"><div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><div class="led ' +
          (isOn ? 'ok' : '') +
          '"></div><h4 style="font-size:12px;font-weight:600">' +
          esc(m.name) +
          '</h4></div><div style="font-size:10px;color:var(--t2);line-height:1.5;margin-bottom:6px">' +
          esc(m.description || '') +
          '</div>' +
          errHtml +
          '<div id="mcpV_' +
          esc(m.name) +
          '" style="min-height:14px;margin-bottom:4px"></div><div style="display:flex;gap:4px"><button class="btn' +
          (isOn ? ' btn-p' : '') +
          '"' +
          btnDisabled +
          ' onclick="tgMcp(&apos;' +
          esc(m.name) +
          '&apos;,this)">' +
          (isOn ? 'Connected' : 'Connect') +
          '</button>' +
          (isOn
            ? '<button class="btn" onclick="testMcp(&apos;' +
              esc(m.name) +
              '&apos;,this)">Test</button><button class="btn" onclick="mcpCustomReconnect(&apos;' +
              esc(m.name) +
              '&apos;,this)">Reconnect</button>'
            : '') +
          '</div></div>'
        );
      })
      .join('') ||
    '<div class="em"><div class="em-s">No MCP presets available</div></div>';
}

function lMcpPresetStatus() {
  ap('/api/mcp/presets/status')
    .then(function (arr) {
      var map = {};
      (arr || []).forEach(function (p) {
        map[p.name] = p;
      });
      window._mcpPresetStatus = map;
      rMcpPr();
    })
    .catch(function () {});
}

function mcpAddOpen() {
  $('mcpName').value = '';
  $('mcpCmd').value = '';
  $('mcpArgs').value = '';
  $('mcpDesc').value = '';
  $('mcpEnvRows').innerHTML =
    '<div style="display:flex;gap:4px;margin-bottom:4px"><input class="form-input" style="flex:1" placeholder="KEY" data-envk><input class="form-input" style="flex:1" placeholder="VALUE" data-envv></div>';
  $('mcpAddModal').classList.add('on');
}

function mcpAddClose() {
  $('mcpAddModal').classList.remove('on');
}

function mcpAddEnvRow() {
  var d = document.createElement('div');
  d.style.cssText = 'display:flex;gap:4px;margin-bottom:4px';
  d.innerHTML =
    '<input class="form-input" style="flex:1" placeholder="KEY" data-envk><input class="form-input" style="flex:1" placeholder="VALUE" data-envv>';
  $('mcpEnvRows').appendChild(d);
}

function mcpAddSubmit() {
  var name = $('mcpName').value.trim();
  var cmd = $('mcpCmd').value.trim();
  if (!name || !cmd) {
    showToast('Name and Command are required', 'error');
    return;
  }
  var args = $('mcpArgs').value.trim();
  var desc = $('mcpDesc').value.trim();
  var env = {};
  var rows = $('mcpEnvRows').querySelectorAll('div');
  rows.forEach(function (r) {
    var k = r.querySelector('[data-envk]');
    var v = r.querySelector('[data-envv]');
    if (k && v && k.value.trim()) env[k.value.trim()] = v.value;
  });
  var hasEnv = Object.keys(env).length > 0;
  ap('/api/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({
      name: name,
      command: cmd,
      args: args,
      description: desc || undefined,
      env: hasEnv ? env : undefined,
    }),
  })
    .then(function (d) {
      if (d.ok) {
        mcpAddClose();
        lMcpCustom();
      } else {
        showToast(d.error || 'Failed to add server', 'error');
      }
    })
    .catch(function (e) {
      showToast('Error: ' + e.message, 'error');
    });
}

function lMcpCustom() {
  ap('/api/mcp/servers')
    .then(function (d) {
      var servers = d.servers || [];
      if (!servers.length) {
        $('mcpCustom').innerHTML =
          '<div class="em"><div class="em-s">No custom servers</div></div>';
        return;
      }
      $('mcpCustom').innerHTML =
        '<div class="grid">' +
        servers
          .map(function (s) {
            var connState = localStorage.getItem('cc_mcp_custom_' + s.name);
            var isOn = connState === 'on';
            return (
              '<div class="card' +
              (isOn ? ' style="border-color:var(--ok)"' : '') +
              '"><div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><div class="led ' +
              (isOn ? 'ok' : '') +
              '"></div><h4 style="font-size:12px;font-weight:600">' +
              esc(s.name) +
              '</h4><span class="tag" style="margin-left:auto">Custom</span></div><div style="font-size:10px;color:var(--t2);line-height:1.5;margin-bottom:4px">' +
              esc(s.description || s.command + ' ' + s.args.join(' ')) +
              '</div><div id="mcpCV_' +
              esc(s.name) +
              '" style="min-height:14px;margin-bottom:4px"></div><div style="display:flex;gap:4px;flex-wrap:wrap"><button class="btn" onclick="mcpCustomTools(&apos;' +
              esc(s.name) +
              '&apos;,this)">Tools</button><button class="btn" onclick="mcpCustomReconnect(&apos;' +
              esc(s.name) +
              '&apos;,this)">Reconnect</button><button class="btn btn-danger" onclick="mcpCustomDel(&apos;' +
              esc(s.name) +
              '&apos;)">Delete</button></div></div>'
            );
          })
          .join('') +
        '</div>';
    })
    .catch(function () {
      $('mcpCustom').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load custom servers</div><button class="btn" onclick="lMcpCustom()">Retry</button></div>';
    });
}

function mcpCustomDel(name) {
  showConfirmModal('Delete server ' + name + '?', function () {
    ap('/api/mcp/servers/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function () {
        localStorage.removeItem('cc_mcp_custom_' + name);
        lMcpCustom();
      })
      .catch(function () {});
  });
}

function mcpCustomTools(name, btn) {
  btn.textContent = 'Loading...';
  btn.disabled = true;
  ap('/api/mcp/servers/' + encodeURIComponent(name) + '/tools')
    .then(function (d) {
      var tools = d.tools || [];
      var vEl = document.getElementById('mcpCV_' + name);
      if (vEl) {
        if (tools.length) {
          var h =
            '<div style="margin-top:6px;border-top:1px solid var(--bd);padding-top:6px">';
          tools.forEach(function (t) {
            h +=
              '<div style="font-size:10px;margin-bottom:4px"><span style="color:var(--t0);font-weight:500">' +
              esc(t.name || t.registeredName || '') +
              '</span>';
            if (t.description)
              h +=
                ' <span style="color:var(--t3)">' +
                esc(t.description.slice(0, 80)) +
                '</span>';
            h += '</div>';
          });
          h += '</div>';
          vEl.innerHTML = h;
        } else {
          vEl.innerHTML =
            '<span style="color:var(--t3);font-size:10px">No tools' +
            (d.error ? ' (' + esc(d.error) + ')' : '') +
            '</span>';
        }
      }
      btn.textContent = 'Tools';
      btn.disabled = false;
    })
    .catch(function () {
      btn.textContent = 'Tools';
      btn.disabled = false;
    });
}

function mcpCustomReconnect(name, btn) {
  btn.textContent = 'Reconnecting...';
  btn.disabled = true;
  ap('/api/mcp/servers/' + encodeURIComponent(name) + '/reconnect', {
    method: 'POST',
  })
    .then(function (d) {
      var vEl = document.getElementById('mcpCV_' + name);
      if (vEl) {
        if (d.ok) {
          vEl.innerHTML =
            '<span style="color:var(--ok);font-size:10px">Reconnected</span>';
          localStorage.setItem('cc_mcp_custom_' + name, 'on');
        } else {
          vEl.innerHTML =
            '<span style="color:var(--er);font-size:10px">' +
            esc(d.error || 'Failed') +
            '</span>';
        }
      }
      btn.textContent = 'Reconnect';
      btn.disabled = false;
      lMcpCustom();
    })
    .catch(function () {
      btn.textContent = 'Reconnect';
      btn.disabled = false;
    });
}

function skModalOpen(editSlug) {
  $('skEditSlug').value = editSlug || '';
  $('skModalTitle').textContent = editSlug ? 'Edit Skill' : 'Create Skill';
  $('skModalSave').textContent = editSlug ? 'Save Changes' : 'Create Skill';
  if (editSlug && aSk) {
    var s = aSk.find(function (sk) {
      return sk.slug === editSlug;
    });
    if (s) {
      $('skTitle').value = s.title || '';
      $('skSummary').value = s.summary || '';
      $('skTriggers').value = (s.triggerPhrases || []).join('\n');
      $('skSteps').value = (s.steps || []).join('\n');
      $('skTools').value = (s.requiredTools || []).join(', ');
    }
  } else {
    $('skTitle').value = '';
    $('skSummary').value = '';
    $('skTriggers').value = '';
    $('skSteps').value = '';
    $('skTools').value = '';
  }
  $('skModal').classList.add('on');
}

function skModalClose() {
  $('skModal').classList.remove('on');
}

function skModalSubmit() {
  var title = $('skTitle').value.trim();
  if (!title) {
    showToast('Title is required', 'error');
    return;
  }
  var editSlug = $('skEditSlug').value;
  var payload = {
    title: title,
    summary: $('skSummary').value.trim(),
    triggerPhrases: $('skTriggers')
      .value.split('\n')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean),
    steps: $('skSteps')
      .value.split('\n')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean),
    requiredTools: $('skTools').value
      ? $('skTools')
          .value.split(',')
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
      : undefined,
  };
  var method = editSlug ? 'PUT' : 'POST';
  var url = editSlug
    ? '/api/skills/' + encodeURIComponent(editSlug)
    : '/api/skills';
  ap(url, { method: method, body: JSON.stringify(payload) })
    .then(function (d) {
      if (d.ok) {
        skModalClose();
        aSk = null;
        rSk();
      } else {
        showToast(d.error || 'Failed', 'error');
      }
    })
    .catch(function (e) {
      showToast('Error: ' + e.message, 'error');
    });
}

function skImportOpen() {
  $('skImportText').value = '';
  $('skImportModal').classList.add('on');
}

function skImportClose() {
  $('skImportModal').classList.remove('on');
}

function skImportSubmit() {
  var md = $('skImportText').value.trim();
  if (!md) {
    showToast('Paste SKILL.md content', 'error');
    return;
  }
  ap('/api/skills/import', {
    method: 'POST',
    body: JSON.stringify({ markdown: md }),
  })
    .then(function (d) {
      if (d.ok) {
        skImportClose();
        aSk = null;
        rSk();
      } else {
        showToast(d.error || 'Failed', 'error');
      }
    })
    .catch(function (e) {
      showToast('Error: ' + e.message, 'error');
    });
}

function skDel(slug) {
  showConfirmModal('Delete skill ' + slug + '?', function () {
    ap('/api/skills/' + encodeURIComponent(slug), { method: 'DELETE' })
      .then(function (d) {
        if (d.ok) {
          aSk = null;
          rSk();
        } else {
          showToast(d.error || 'Cannot delete', 'error');
        }
      })
      .catch(function () {});
  });
}

function skRate(slug, rating) {
  ap('/api/skills/' + encodeURIComponent(slug) + '/rate', {
    method: 'POST',
    body: JSON.stringify({ rating: rating }),
  })
    .then(function () {
      aSk = null;
      rSk();
    })
    .catch(function () {});
}

var provCfgCache = null;
var provSlotNames = ['primary', 'fallback', 'vision', 'compression', 'embedding'];
var provSlotLabels = {
  primary: 'Primary',
  fallback: 'Fallback',
  vision: 'Vision',
  compression: 'Compression',
  embedding: 'Embedding',
};

function lProv() {
  ap('/api/providers/config')
    .then(function (d) {
      provCfgCache = d.config;
      rProv();
    })
    .catch(function () {
      $('provSlots').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load provider config</div><button class="btn" onclick="lProv()">Retry</button></div>';
    });
}

function rProv() {
  var h = '';
  provSlotNames.forEach(function (sn) {
    var slot = provCfgCache && provCfgCache[sn] ? provCfgCache[sn] : null;
    var isOptional = sn !== 'primary';
    var ledColor = slot ? 'var(--ok,#22c55e)' : 'var(--t3,#666)';
    h +=
      '<div class="card" style="margin-bottom:12px" data-provider-slot="' +
      sn +
      '">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
    h +=
      '<span style="width:8px;height:8px;border-radius:50%;background:' +
      ledColor +
      ';display:inline-block"></span>';
    h +=
      '<h4 style="font-size:13px;font-weight:600">' +
      esc(provSlotLabels[sn]) +
      '</h4>';
    if (slot)
      h +=
        '<span class="tag" style="font-size:10px">' +
        esc(slot.provider + '/' + slot.model) +
        '</span>';
    h += '</div>';
    if (slot) {
      h +=
        '<div style="font-size:11px;color:var(--t2);margin-bottom:8px">' +
        esc(slot.name || sn) +
        '</div>';
      h +=
        '<div style="display:flex;gap:4px"><button class="btn" onclick="var b=this;btnLoading(b);provTest(&quot;' +
        sn +
        '&quot;).finally(function(){btnDone(b)})">Test</button><button class="btn btn-danger" onclick="provRemoveSlot(&quot;' +
        sn +
        '&quot;)">Remove</button></div>';
    } else {
      h += '<div style="display:flex;gap:4px">';
      if (isOptional)
        h +=
          '<button class="btn btn-p" onclick="provAddSlot(&quot;' +
          sn +
          '&quot;)">+ Add ' +
          esc(provSlotLabels[sn]) +
          ' Model</button>';
      else
        h +=
          '<button class="btn btn-p" onclick="provAddSlot(&quot;' +
          sn +
          '&quot;)">Configure Primary</button>';
      h += '</div>';
    }
    h += '</div>';
  });
  $('provSlots').innerHTML = h;
}

function provAddSlot(sn) {
  showFormModal(
    'Add ' + provSlotLabels[sn] + ' Provider',
    [
      {
        label: 'Provider',
        name: 'provider',
        placeholder: 'openai, anthropic, openrouter, custom',
        value: 'openai',
      },
      {
        label: 'Model',
        name: 'model',
        placeholder: 'gpt-4o, claude-sonnet-4',
        value: 'gpt-4o',
      },
      {
        label: 'API Key',
        name: 'apiKey',
        type: 'password',
        placeholder: 'Leave empty to use primary key',
      },
    ],
    function (data) {
      if (!data.provider || !data.model) {
        showToast('Provider and model are required', 'error');
        return;
      }
      var cfg = provCfgCache || {};
      if (!cfg.primary && sn !== 'primary') {
        showToast('Configure primary slot first', 'error');
        return;
      }
      cfg[sn] = {
        name: provSlotLabels[sn],
        provider: data.provider,
        model: data.model,
        apiKey: data.apiKey || undefined,
      };
      ap('/api/providers/config', {
        method: 'POST',
        body: JSON.stringify(cfg),
      })
        .then(function (d) {
          if (d.ok) {
            provCfgCache = d.config;
            rProv();
            showToast('Provider configured', 'success');
          } else {
            showToast(d.error || 'Failed', 'error');
          }
        })
        .catch(function (e) {
          showToast('Error: ' + e.message, 'error');
        });
    }
  );
}

function provRemoveSlot(sn) {
  if (sn === 'primary') {
    showConfirmModal(
      'Remove primary provider config? This will clear all slots.',
      function () {
        ap('/api/providers/config', {
          method: 'POST',
          body: JSON.stringify({
            primary: { name: 'Primary', provider: 'none', model: 'none' },
          }),
        })
          .then(function () {
            provCfgCache = null;
            rProv();
          })
          .catch(function () {});
      }
    );
  } else {
    var cfg = provCfgCache || {};
    delete cfg[sn];
    ap('/api/providers/config', {
      method: 'POST',
      body: JSON.stringify(cfg),
    })
      .then(function (d) {
        if (d.ok) {
          provCfgCache = d.config;
          rProv();
        }
      })
      .catch(function () {});
  }
}

function provTest(sn) {
  var slot = provCfgCache && provCfgCache[sn];
  if (!slot) {
    showToast('No config for slot ' + sn, 'error');
    return;
  }
  return ap('/api/providers/test', {
    method: 'POST',
    body: JSON.stringify({
      slot: sn,
      provider: slot.provider,
      model: slot.model,
      apiKey: slot.apiKey || '',
      baseUrl: slot.baseUrl || '',
    }),
  })
    .then(function (d) {
      if (d.ok) showToast('Test passed: ' + d.response, 'success');
      else showToast('Test failed: ' + d.error, 'error');
    })
    .catch(function (e) {
      showToast('Error: ' + e.message, 'error');
    });
}

function lAgentCfg() {
  ap('/api/config/agent')
    .then(function (d) {
      var cfg = d.config || {};
      var h = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
      h += '<div class="card"><div style="font-size:11px;color:var(--t2);margin-bottom:6px">Max Tool Iterations</div>';
      h += '<input class="form-input" type="number" id="acMaxIter" value="' + (cfg.maxToolIterations || 12) + '" min="1" max="20" style="width:80px" onchange="saveAgentCfg()"></div>';
      h += '<div class="card"><div style="font-size:11px;color:var(--t2);margin-bottom:6px">Max Result Length</div>';
      h += '<input class="form-input" type="number" id="acMaxResult" value="' + (cfg.maxToolResultLength || 2000) + '" min="500" max="10000" step="500" style="width:100px" onchange="saveAgentCfg()"></div>';
      h += '<div class="card"><div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t2)">Concurrent Tools</span>';
      h += '<label class="toggle-switch"><input type="checkbox" id="acConcurrent"' + (cfg.concurrentToolCalls ? ' checked' : '') + ' onchange="saveAgentCfg()"><span class="toggle-slider"></span></label></div></div>';
      h += '<div class="card"><div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t2)">Synthesize on Exhaustion</span>';
      h += '<label class="toggle-switch"><input type="checkbox" id="acSynthesize"' + (cfg.synthesizeOnExhaustion !== false ? ' checked' : '') + ' onchange="saveAgentCfg()"><span class="toggle-slider"></span></label></div></div>';
      h += '<div class="card" style="grid-column:span 2"><div style="display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;color:var(--t2)">Require Approval for Dangerous Tools</span>';
      h += '<label class="toggle-switch"><input type="checkbox" id="acApproval"' + (cfg.requireApprovalForDangerousTools !== false ? ' checked' : '') + ' onchange="saveAgentCfg()"><span class="toggle-slider"></span></label></div></div>';
      h += '</div>';
      $('agentCfgBody').innerHTML = h;
    })
    .catch(function () {
      $('agentCfgBody').innerHTML = '<div class="err-state"><div class="err-msg">Could not load agent config</div><button class="btn" onclick="lAgentCfg()">Retry</button></div>';
    });
}

function saveAgentCfg() {
  var cfg = {
    maxToolIterations: parseInt($('acMaxIter').value) || 12,
    maxToolResultLength: parseInt($('acMaxResult').value) || 2000,
    concurrentToolCalls: $('acConcurrent').checked,
    synthesizeOnExhaustion: $('acSynthesize').checked,
    requireApprovalForDangerousTools: $('acApproval').checked,
  };
  ap('/api/config/agent', {
    method: 'POST',
    body: JSON.stringify(cfg),
  })
    .then(function () {
      showToast('Agent config saved', 'success');
    })
    .catch(function (e) {
      showToast('Failed: ' + e.message, 'error');
    });
}

function lCfg() {
  ap('/api/system/status')
    .then(function (d) {
      var mc = d.mcp;
      var mcL = mc ? (mc.degraded ? 'degraded' : 'healthy') : 'not configured';
      var ps = [
        ['Service', d.service || '--'],
        ['Version', d.version || '--'],
        ['Deployment', d.deployment || '--'],
        ['Model', d.model || '--'],
        ['Provider', d.provider || '--'],
        ['Tools', '' + (d.tools || []).length],
        ['MCP Status', mcL],
        ['Plugins', (d.plugins || []).join(', ') || 'none'],
      ];
      $('cfB').innerHTML =
        '<div class="cfg-blk">' +
        ps
          .map(function (p) {
            return (
              '<div class="kv"><span class="kv-k">' +
              esc(p[0]) +
              '</span><span class="kv-v">' +
              esc(p[1]) +
              '</span></div>'
            );
          })
          .join('') +
        '</div>';
    })
    .catch(function () {
      $('cfB').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load configuration</div><button class="btn" onclick="lCfg()">Retry</button></div>';
    });
}

function lCfgState() {
  ap('/api/config/snapshot')
    .then(function (d) {
      if (d.activePreset) actPre = d.activePreset;
      if (d.activeToolset) actTs = d.activeToolset;
      if (d.disabledSkills) {
        d.disabledSkills.forEach(function (s) {
          localStorage.setItem('cc_sk_' + s, 'off');
        });
      }
      if (d.gateways) {
        Object.keys(d.gateways).forEach(function (gid) {
          gwConfigured[gid] = !!d.gateways[gid];
        });
      }
    })
    .catch(function () {});
}

function loadMemories() {
  var scope = $('memScope') ? $('memScope').value : '';
  var url = sid ? '/api/sessions/' + sid + '/memories' : '';
  if (!url) {
    $('memList').innerHTML =
      '<div class="em"><div class="em-t">No memories yet</div><div class="em-s">Memories will appear here as the agent captures them</div></div>';
    return;
  }
  if (scope) url += '?scope=' + scope;
  $('memList').innerHTML =
    '<div class="skeleton" style="width:80%"></div><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:70%"></div>';
  ap(url)
    .then(function (d) {
      allMem = d.records || [];
      filterMemories();
    })
    .catch(function () {
      $('memList').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load memories</div><button class="btn" onclick="loadMemories()">Retry</button></div>';
    });
}

function filterMemories() {
  var q = ($('memSrch') ? $('memSrch').value : '').toLowerCase();
  var f = allMem;
  if (q) {
    f = allMem.filter(function (m) {
      return (
        (m.content || m.summary || '').toLowerCase().indexOf(q) !== -1 ||
        (m.tags || []).join(' ').toLowerCase().indexOf(q) !== -1
      );
    });
  }
  if (!f.length) {
    $('memList').innerHTML =
      '<div class="em"><div class="em-t">' +
      (allMem.length ? 'No matching memories' : 'No memories found') +
      '</div><div class="em-s">' +
      (allMem.length
        ? 'Try a different search term'
        : 'Memories will appear as the agent captures them') +
      '</div></div>';
    return;
  }
  var h =
    '<table class="mem-table"><thead><tr><th>Content</th><th>Tags</th><th>Scope</th><th>Created</th><th></th></tr></thead><tbody>';
  f.forEach(function (m, i) {
    var content = m.content || m.summary || '';
    h += '<tr onclick="memDetail(' + i + ')">';
    h +=
      '<td class="mem-content">' +
      esc(content.slice(0, 80)) +
      (content.length > 80 ? '...' : '') +
      '</td>';
    h +=
      '<td>' +
      (m.tags || [])
        .map(function (t) {
          return '<span class="tag">' + esc(t) + '</span>';
        })
        .join(' ') +
      '</td>';
    h +=
      '<td><span class="tag">' + esc(m.scope || 'session') + '</span></td>';
    h +=
      '<td style="font-family:var(--m);font-size:10px;color:var(--t3)">' +
      ago(m.createdAt) +
      '</td>';
    h +=
      '<td><button class="mem-del" onclick="event.stopPropagation();memDel(&apos;' +
      esc(m.id || '') +
      '&apos;)">&#10005;</button></td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  $('memList').innerHTML = h;
}

function memDetail(idx) {
  var q = ($('memSrch') ? $('memSrch').value : '').toLowerCase();
  var filtered = allMem;
  if (q) {
    filtered = allMem.filter(function (m) {
      return (
        (m.content || m.summary || '').toLowerCase().indexOf(q) !== -1 ||
        (m.tags || []).join(' ').toLowerCase().indexOf(q) !== -1
      );
    });
  }
  var m = filtered[idx];
  if (!m) return;
  var h =
    '<div style="margin-bottom:12px"><div class="form-label">Content</div><div style="font-size:12px;color:var(--t1);line-height:1.6;white-space:pre-wrap;background:var(--b2);border:1px solid var(--bd);padding:10px">' +
    esc(m.content || m.summary || '') +
    '</div></div>';
  h +=
    '<div style="margin-bottom:12px"><div class="form-label">Tags</div><div style="display:flex;flex-wrap:wrap;gap:4px">' +
    (m.tags || [])
      .map(function (t) {
        return '<span class="tag">' + esc(t) + '</span>';
      })
      .join('') +
    '</div></div>';
  h +=
    '<div style="margin-bottom:12px"><div class="form-label">Scope</div><span class="tag">' +
    esc(m.scope || 'session') +
    '</span></div>';
  if (m.createdAt)
    h +=
      '<div><div class="form-label">Created</div><span style="font-size:11px;color:var(--t2);font-family:var(--m)">' +
      esc(m.createdAt) +
      '</span></div>';
  $('memModalBody').innerHTML = h;
  $('memModal').classList.add('on');
  trapFocus($('memModal').querySelector('.modal-box'));
}

function memModalClose() {
  $('memModal').classList.remove('on');
}

function memDel(id) {
  showConfirmModal('Delete this memory?', function () {
    ap('/api/memories/' + id, { method: 'DELETE' })
      .then(function () {
        loadMemories();
      })
      .catch(function () {});
  });
}

function jbModalOpen() {
  $('jbModal').classList.add('on');
  $('jbName').value = '';
  $('jbTask').value = '';
  $('jbSchedVal').value = '60';
  $('jbModel').value = '';
  $('jbDelPlatform').value = '';
  $('jbDelChannel').value = '';
  jbSchedChange();
  var skH = '';
  (aSk || []).forEach(function (s) {
    skH +=
      '<label class="form-checkbox"><input type="checkbox" value="' +
      esc(s.slug) +
      '">' +
      esc(s.title) +
      '</label>';
  });
  $('jbSkills').innerHTML =
    skH ||
    '<span style="font-size:10px;color:var(--t3)">No skills available</span>';
  trapFocus($('jbModal').querySelector('.modal-box'));
}

function jbModalClose() {
  $('jbModal').classList.remove('on');
}

function jbSchedChange() {
  var type = document.querySelector('input[name=jbSchedType]:checked');
  var val = $('jbSchedVal');
  var hint = $('jbSchedHint');
  if (type && type.value === 'cron') {
    val.placeholder = '*/30 * * * *';
    hint.textContent = 'Enter a standard cron expression';
  } else {
    val.placeholder = '60';
    hint.textContent =
      'Runs every ' + (parseInt(val.value) || 60) + ' minutes';
  }
}

function jbSubmit() {
  var name = $('jbName').value.trim();
  var task = $('jbTask').value.trim();
  if (!name || !task) {
    showToast('Job name and task are required', 'error');
    return;
  }
  var type = document.querySelector('input[name=jbSchedType]:checked');
  var schedVal = $('jbSchedVal').value.trim() || '60';
  var schedule =
    type && type.value === 'cron' ? schedVal : 'every:' + schedVal + 'm';
  var model = $('jbModel').value || undefined;
  var skills = [];
  document
    .querySelectorAll('#jbSkills input:checked')
    .forEach(function (cb) {
      skills.push(cb.value);
    });
  var delPlat = $('jbDelPlatform').value;
  var delChan = $('jbDelChannel').value.trim();
  var body = { id: name, task: task, schedule: schedule };
  if (model) body.model = model;
  if (skills.length) body.skillSlugs = skills;
  if (delPlat && delChan)
    body.deliverTo = { platform: delPlat, config: { channel: delChan } };
  ap('/api/scheduler/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
    .then(function () {
      jbModalClose();
      lJobs();
    })
    .catch(function (e) {
      showToast('Failed: ' + (e.message || 'Unknown'), 'error');
    });
}

function lJobs() {
  ap('/api/scheduler/jobs')
    .then(function (d) {
      var jobs = Array.isArray(d) ? d : d.jobs || [];
      $('nJb').textContent = jobs.length;
      lSchedStatus();
      if (!jobs.length) {
        $('jbLs').innerHTML =
          '<div class="em"><div class="em-s">No scheduled jobs</div></div>';
        return;
      }
      $('jbLs').innerHTML = jobs
        .map(function (j) {
          var st = j.lastRunStatus || 'pending';
          var stCls =
            st === 'success' ? 'ok' : st === 'error' ? 'er' : '';
          var eid = esc(j.id);
          return (
            '<div class="card" style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-family:var(--m);font-size:12px;font-weight:600">' +
            eid +
            '</span><span class="tag ' +
            (j.enabled ? 'ok' : 'er') +
            '">' +
            (j.enabled ? 'active' : 'paused') +
            '</span></div><div style="font-size:11px;color:var(--t2);margin-bottom:6px">' +
            esc(j.task) +
            '</div><div style="display:flex;gap:8px;flex-wrap:wrap;font-size:10px;font-family:var(--m);color:var(--t3)"><span>' +
            esc(j.schedule) +
            '</span><span>runs: ' +
            (j.runCount || 0) +
            '</span>' +
            (j.lastRunAt ? '<span>last: ' + ago(j.lastRunAt) + '</span>' : '') +
            (st !== 'pending'
              ? '<span class="tag ' + stCls + '">' + st + '</span>'
              : '') +
            '</div><div style="display:flex;gap:6px;margin-top:8px" class="jb-actions"><button class="btn" onclick="jbToggle(&apos;' +
            eid +
            '&apos;,' +
            (j.enabled ? 'true' : 'false') +
            ')">' +
            (j.enabled ? 'Pause' : 'Resume') +
            '</button><button class="btn" onclick="jbDryRun(&apos;' +
            eid +
            '&apos;)">Dry Run</button><button class="btn" style="color:var(--er)" onclick="jbDel(&apos;' +
            eid +
            '&apos;)">Delete</button><button class="btn" onclick="jbHistToggle(&apos;' +
            eid +
            '&apos;)">History</button></div><div id="jbHist-' +
            eid +
            '" style="display:none;margin-top:8px;font-size:10px;font-family:var(--m);color:var(--t3)"></div></div>'
          );
        })
        .join('');
    })
    .catch(function () {
      $('jbLs').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load jobs</div><button class="btn" onclick="lJobs()">Retry</button></div>';
    });
}

function jbTick() {
  ap('/api/scheduler/tick', { method: 'POST' })
    .then(function () {
      lJobs();
    })
    .catch(function () {});
}

function jbToggle(id, enabled) {
  var action = enabled ? 'pause' : 'resume';
  ap('/api/scheduler/jobs/' + encodeURIComponent(id) + '/' + action, {
    method: 'POST',
  })
    .then(function () {
      lJobs();
    })
    .catch(function () {});
}

function jbDel(id) {
  showConfirmModal('Delete job ' + id + '?', function () {
    ap('/api/scheduler/jobs/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        lJobs();
      })
      .catch(function () {});
  });
}

function jbDryRun(id) {
  ap('/api/scheduler/jobs/' + encodeURIComponent(id) + '/dry-run', {
    method: 'POST',
  })
    .then(function (r) {
      showToast(
        'Dry run ' +
          (r.ok ? 'OK' : 'FAILED') +
          (r.response ? ': ' + r.response.slice(0, 200) : ''),
        r.ok ? 'success' : 'error'
      );
    })
    .catch(function (e) {
      showToast('Dry run failed: ' + (e.message || 'Unknown'), 'error');
    });
}

function jbHistToggle(id) {
  var el = $('jbHist-' + id);
  if (!el) return;
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    return;
  }
  el.innerHTML = 'Loading...';
  el.style.display = 'block';
  ap(
    '/api/scheduler/jobs/' +
      encodeURIComponent(id) +
      '/history?limit=10'
  )
    .then(function (records) {
      if (!records.length) {
        el.innerHTML =
          '<div style="color:var(--t3)">No run history</div>';
        return;
      }
      el.innerHTML = records
        .map(function (r) {
          return (
            '<div style="padding:3px 0;border-bottom:1px solid var(--bd);display:flex;gap:8px;align-items:center"><span class="tag ' +
            (r.ok ? 'ok' : 'er') +
            '">' +
            (r.ok ? 'ok' : 'err') +
            '</span><span>' +
            r.durationMs +
            'ms</span><span>' +
            ago(r.startedAt) +
            '</span>' +
            (r.error
              ? '<span style="color:var(--er)">' +
                esc(r.error) +
                '</span>'
              : '') +
            '</div>'
          );
        })
        .join('');
    })
    .catch(function () {
      el.innerHTML =
        '<div style="color:var(--er)">Failed to load history</div>';
    });
}

function schedToggle() {
  ap('/api/scheduler/status')
    .then(function (s) {
      var action = s.running ? 'stop' : 'start';
      return ap('/api/scheduler/' + action, { method: 'POST' });
    })
    .then(function () {
      lSchedStatus();
    })
    .catch(function () {});
}

function lSchedStatus() {
  ap('/api/scheduler/status')
    .then(function (s) {
      var sl = $('schedLed');
      var sb = $('schedLbl');
      var st = $('schedToggle');
      if (sl) sl.className = 'led ' + (s.running ? 'ok' : '');
      if (sb) sb.textContent = s.running ? 'Running' : 'Stopped';
      if (st) st.textContent = s.running ? 'Stop' : 'Start';
    })
    .catch(function () {});
}

var jbAutoRefresh = null;

function jbStartAutoRefresh() {
  if (jbAutoRefresh) return;
  jbAutoRefresh = setInterval(function () {
    lJobs();
    lSchedStatus();
  }, 30000);
}

function jbStopAutoRefresh() {
  if (jbAutoRefresh) {
    clearInterval(jbAutoRefresh);
    jbAutoRefresh = null;
  }
}

function lUsage() {
  ap('/api/usage')
    .then(function (d) {
      var tt = d.totalTokens || 0;
      var ti = d.totalInputTokens || 0;
      var to = d.totalOutputTokens || 0;
      var cost = d.totalCostUsd || 0;
      var lat = d.avgLatencyMs || 0;
      var entries = d.entries || [];
      var bm = d.byModel || {};
      $('uCards').innerHTML =
        '<div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">TOTAL TOKENS</div><div style="font-size:22px;font-weight:700;font-family:var(--m)">' +
        tt.toLocaleString() +
        '</div></div><div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">TOTAL COST</div><div style="font-size:22px;font-weight:700;font-family:var(--m);color:var(--ok)">$' +
        cost.toFixed(4) +
        '</div></div><div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">AVG LATENCY</div><div style="font-size:22px;font-weight:700;font-family:var(--m)">' +
        Math.round(lat) +
        '<span style="font-size:12px;color:var(--t3)">ms</span></div></div><div class="card"><div style="font-size:10px;color:var(--t3);font-weight:500;margin-bottom:4px">API CALLS</div><div style="font-size:22px;font-weight:700;font-family:var(--m)">' +
        entries.length +
        '</div></div>';
      var models = Object.keys(bm).sort(function (a, b) {
        return (bm[b].cost || 0) - (bm[a].cost || 0);
      });
      if (!models.length) {
        $('uModel').innerHTML =
          '<div class="em"><div class="em-s">No model data yet</div></div>';
      } else {
        var th = '<div style="font-family:var(--m);font-size:11px">';
        models.forEach(function (m) {
          var v = bm[m];
          th +=
            '<div class="kv"><span style="flex:2;color:var(--t1)">' +
            esc(m) +
            '</span><span style="flex:1;text-align:right">' +
            v.calls +
            '</span><span style="flex:1;text-align:right">' +
            v.tokens.toLocaleString() +
            '</span><span style="flex:1;text-align:right;color:var(--ok)">$' +
            (v.cost || 0).toFixed(4) +
            '</span></div>';
        });
        th += '</div>';
        $('uModel').innerHTML = th;
      }
      var recent = entries.slice(-20).reverse();
      if (!recent.length) {
        $('uEntries').innerHTML =
          '<div class="em"><div class="em-s">No entries yet</div></div>';
      } else {
        var eh = '<div style="font-family:var(--m);font-size:10px">';
        recent.forEach(function (e) {
          eh +=
            '<div class="kv"><span style="flex:2;color:var(--t2)">' +
            ago(e.timestamp) +
            '</span><span style="flex:2;color:var(--t1)">' +
            esc(e.model) +
            '</span><span style="flex:1;text-align:right">' +
            (e.inputTokens || 0).toLocaleString() +
            '</span><span style="flex:1;text-align:right">' +
            (e.outputTokens || 0).toLocaleString() +
            '</span><span style="flex:1;text-align:right;color:var(--ok)">$' +
            (e.costUsd || 0).toFixed(4) +
            '</span></div>';
        });
        eh += '</div>';
        $('uEntries').innerHTML = eh;
      }
    })
    .catch(function () {
      $('uCards').innerHTML =
        '<div class="err-state"><div class="err-msg">Could not load usage data</div><button class="btn" onclick="lUsage()">Retry</button></div>';
    });
}

function uReset() {
  showConfirmModal('Reset all usage data?', function () {
    ap('/api/usage/reset', { method: 'POST' })
      .then(function () {
        lUsage();
      })
      .catch(function () {});
  });
}

var logEntries = [];

function addLog(msg) {
  logEntries.push({ t: new Date().toISOString(), m: msg });
  if (logEntries.length > 200) logEntries.shift();
  rLogs();
}

function rLogs() {
  var el = $('logOut');
  if (!el) return;
  el.innerHTML = logEntries
    .slice()
    .reverse()
    .map(function (e) {
      return (
        '<div style="padding:2px 0;border-bottom:1px solid var(--bd)"><span style="color:var(--t3)">' +
        e.t.slice(11, 19) +
        '</span> ' +
        esc(e.m) +
        '</div>'
      );
    })
    .join('');
}

function trapFocus(el) {
  if (!el) return;
  var focusable = el.querySelectorAll(
    'input,button,select,textarea,[tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  });
}

document.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    cpOpen();
    return;
  }
  if (e.key === 'Escape') {
    if ($('confirmModal').classList.contains('on')) {
      $('confirmModal').classList.remove('on');
      return;
    }
    if ($('formModal').classList.contains('on')) {
      $('formModal').classList.remove('on');
      return;
    }
    if ($('cpOv').classList.contains('on')) {
      cpClose();
      return;
    }
    if ($('jbModal').classList.contains('on')) {
      jbModalClose();
      return;
    }
    if ($('memModal').classList.contains('on')) {
      memModalClose();
      return;
    }
  }
});

var obStep = 0,
  obProv = '',
  obSelMod = '',
  obSelPre = 'general';

var obModels = {
  openai: ['gpt-4o', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4', 'claude-4', 'claude-haiku-4'],
  openrouter: [
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'google/gemini-2.5-flash',
    'meta-llama/llama-3-70b',
  ],
  custom: ['custom-model'],
};

var obPresets = [
  { id: 'general', name: 'General Assistant', desc: 'Balanced all-purpose agent' },
  { id: 'coder', name: 'Coding Assistant', desc: 'Optimized for development tasks' },
  { id: 'researcher', name: 'Researcher', desc: 'Deep research and analysis' },
  { id: 'creative', name: 'Creative Writer', desc: 'Writing and content creation' },
];

function obRenderDots() {
  var d = $('obDots');
  d.innerHTML = '';
  for (var i = 0; i < 6; i++) {
    d.innerHTML +=
      '<div class="ob-dot' +
      (i === obStep ? ' on' : '') +
      '" id="obd' +
      i +
      '"></div>';
  }
}

function obShow() {
  $('obOv').classList.add('on');
  obRenderDots();
  obUpdateNav();
}

function obSkip() {
  $('obOv').classList.remove('on');
  localStorage.setItem('cc_onboarded', '1');
}

function obUpdateNav() {
  $('obBack').style.display =
    obStep > 0 && obStep < 5 ? 'inline-flex' : 'none';
  $('obNext').style.display =
    obStep > 0 && obStep < 5 ? 'inline-flex' : 'none';
  $('obNext').textContent = obStep === 4 ? 'Finish' : 'Next';
}

function obSelProv(el) {
  document.querySelectorAll('.ob-pcard').forEach(function (c) {
    c.classList.remove('sel');
  });
  el.classList.add('sel');
  obProv = el.getAttribute('data-prov') || '';
  $('obUrl').value = el.getAttribute('data-url') || '';
  obRenderModels();
}

function obToggleKey() {
  var inp = $('obKey');
  if (inp.type === 'password') {
    inp.type = 'text';
    document.querySelector('.ob-key-toggle').textContent = 'hide';
  } else {
    inp.type = 'password';
    document.querySelector('.ob-key-toggle').textContent = 'show';
  }
}

function obTestConn() {
  var key = $('obKey').value.trim();
  var url = $('obUrl').value.trim();
  var res = $('obTestRes');
  if (!key) {
    res.className = 'ob-test-result er';
    res.textContent = 'Please enter an API key';
    return;
  }
  res.className = 'ob-test-result';
  res.style.display = 'block';
  res.innerHTML = '<span class="ob-spinner"></span> Testing...';
  fetch(B + '/api/config/provider/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiKey: key,
      baseUrl: url,
      provider: obProv,
    }),
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      if (d.ok) {
        res.className = 'ob-test-result ok';
        res.textContent = 'Connection successful!';
      } else {
        res.className = 'ob-test-result er';
        res.textContent = d.error || 'Connection failed';
      }
    })
    .catch(function (e) {
      res.className = 'ob-test-result er';
      res.textContent = 'Error: ' + (e.message || 'Network error');
    });
}

function obRenderModels() {
  var grid = $('obModGrid');
  var models = obModels[obProv] || [];
  grid.innerHTML = '';
  models.forEach(function (m) {
    var d = document.createElement('div');
    d.className = 'ob-mcard' + (m === obSelMod ? ' sel' : '');
    d.innerHTML = '<div class="ob-mcard-name">' + esc(m) + '</div>';
    d.onclick = function () {
      obSelMod = m;
      grid.querySelectorAll('.ob-mcard').forEach(function (c) {
        c.classList.remove('sel');
      });
      d.classList.add('sel');
    };
    grid.appendChild(d);
  });
}

function obRenderPresets() {
  var grid = $('obPreGrid');
  grid.innerHTML = '';
  obPresets.forEach(function (p) {
    var d = document.createElement('div');
    d.className = 'ob-prcard' + (p.id === obSelPre ? ' sel' : '');
    d.innerHTML =
      '<h4>' +
      esc(p.name) +
      '</h4><div class="ob-prcard-desc">' +
      esc(p.desc) +
      '</div>';
    d.onclick = function () {
      obSelPre = p.id;
      grid.querySelectorAll('.ob-prcard').forEach(function (c) {
        c.classList.remove('sel');
      });
      d.classList.add('sel');
    };
    grid.appendChild(d);
  });
}

function obFinish() {
  var key = $('obKey').value.trim();
  var url = $('obUrl').value.trim();
  ap('/api/config/provider', {
    method: 'POST',
    body: JSON.stringify({
      apiKey: key,
      baseUrl: url,
      model: obSelMod,
      provider: obProv,
      preset: obSelPre,
    }),
  }).catch(function () {});
  localStorage.setItem('cc_onboarded', '1');
  $('obOv').classList.remove('on');
  chk();
  lT();
}

function obNav(dir) {
  obStep += dir;
  if (obStep < 0) obStep = 0;
  if (obStep > 5) obStep = 5;
  if (obStep === 3) obRenderModels();
  if (obStep === 4) obRenderPresets();
  if (obStep === 5) {
    obFinish();
    return;
  }
  for (var i = 0; i < 6; i++) {
    $('obs' + i).classList.toggle('on', i === obStep);
  }
  obRenderDots();
  obUpdateNav();
}

var capData = null;

var capNavMap = {
  chat: 'chat',
  memory: 'memory',
  skills: 'skills',
  tools: 'tools',
  gateway: 'gateway',
  mcp: 'mcp',
  scheduler: 'scheduler',
};

function capClass(s) {
  if (s === 'live') return 'cap-live';
  if (s === 'simulated') return 'cap-sim';
  if (s === 'experimental') return 'cap-exp';
  return 'cap-disc';
}

function capLabel(s) {
  if (s === 'live') return 'Live';
  if (s === 'simulated') return 'Simulated';
  if (s === 'experimental') return 'Experimental';
  return 'Disconnected';
}

function lCap() {
  ap('/api/capabilities')
    .then(function (d) {
      capData = d;
      Object.keys(capNavMap).forEach(function (key) {
        var el = $('cb-' + key);
        if (el && d[key]) {
          el.className = 'cap-badge ' + capClass(d[key].status);
          el.title =
            capLabel(d[key].status) +
            (d[key].detail ? ' - ' + d[key].detail : '');
        }
        var pd = $('cpd-' + key);
        if (pd && d[key]) {
          pd.innerHTML =
            '<span class="cap-badge ' +
            capClass(d[key].status) +
            '"></span><span class="cap-label ' +
            d[key].status +
            '">' +
            esc(capLabel(d[key].status)) +
            '</span>' +
            (d[key].detail
              ? ' <span style="color:var(--t3)">' +
                esc(d[key].detail) +
                '</span>'
              : '');
        }
      });
    })
    .catch(function () {});
}

function lConnectStatus() {
  var h = '';
  Promise.all([
    ap('/api/capabilities').catch(function () {
      return {};
    }),
    ap('/api/mcp/presets/status').catch(function () {
      return { presets: [] };
    }),
    ap('/api/gateway/status').catch(function () {
      return { platforms: [] };
    }),
  ]).then(function (results) {
    var caps = results[0] || {};
    var mcpSt = results[1] || { presets: [] };
    var gwSt = results[2] || { platforms: [] };
    h = '';
    if (caps.provider) {
      var ps = caps.provider.status;
      h +=
        '<div class="status-row"><span class="status-dot ' +
        (ps === 'live' ? 'live' : ps === 'simulated' ? 'sim' : 'disc') +
        '"></span><span class="status-label">' +
        (caps.provider.detail || 'LLM Provider') +
        '</span><span class="status-detail">' +
        (ps === 'live' ? 'Primary provider' : 'Simulated') +
        '</span><button class="btn" onclick="goTo(&apos;providers&apos;)">Configure</button></div>';
    }
    if (caps.streaming) {
      h +=
        '<div class="status-row"><span class="status-dot ' +
        (caps.streaming.status === 'live' ? 'live' : 'disc') +
        '"></span><span class="status-label">Streaming</span><span class="status-detail">' +
        (caps.streaming.status === 'live' ? 'Active' : 'Inactive') +
        '</span></div>';
    }
    if (caps.mcp) {
      h +=
        '<div class="status-row"><span class="status-dot ' +
        (caps.mcp.status === 'live'
          ? 'live'
          : caps.mcp.status === 'simulated'
            ? 'sim'
            : 'disc') +
        '"></span><span class="status-label">MCP</span><span class="status-detail">' +
        (caps.mcp.detail || capLabel(caps.mcp.status)) +
        '</span><button class="btn" onclick="document.getElementById(&apos;v-mcp&apos;).scrollIntoView({behavior:&apos;smooth&apos;})">Details</button></div>';
    }
    if (caps.tools) {
      h +=
        '<div class="status-row"><span class="status-dot ' +
        (caps.tools.status === 'live' ? 'live' : 'disc') +
        '"></span><span class="status-label">Tools</span><span class="status-detail">' +
        (caps.tools.detail || capLabel(caps.tools.status)) +
        '</span></div>';
    }
    if (caps.gateway) {
      h +=
        '<div class="status-row"><span class="status-dot ' +
        (caps.gateway.status === 'live' ? 'live' : 'disc') +
        '"></span><span class="status-label">Gateway</span><span class="status-detail">' +
        (caps.gateway.detail || capLabel(caps.gateway.status)) +
        '</span><button class="btn" onclick="document.getElementById(&apos;v-gateway&apos;).scrollIntoView({behavior:&apos;smooth&apos;})">Configure</button></div>';
    }
    if (caps.memory) {
      h +=
        '<div class="status-row"><span class="status-dot ' +
        (caps.memory.status === 'live' ? 'live' : 'disc') +
        '"></span><span class="status-label">Memory</span><span class="status-detail">' +
        (caps.memory.detail || capLabel(caps.memory.status)) +
        '</span></div>';
    }
    if (!h)
      h =
        '<div class="em"><div class="em-s">No capabilities detected</div></div>';
    $('connectStatus').innerHTML = h;
  });
}

function initApp() {
  chk();
  lT();
  rSessList();
  lCfgState();
  connectSSE();
  lSessions();
  lCap();
  if (sid) rSessList();
  setInterval(chk, 10000);
  ap('/api/system/status')
    .then(function (d) {
      if (
        d.provider === 'none' &&
        !localStorage.getItem('cc_onboarded')
      ) {
        ap('/api/presets')
          .then(function (p) {
            aPre = p;
            obShow();
          })
          .catch(function () {
            obShow();
          });
      }
    })
    .catch(function () {});
}

var streamIter = 0,
  streamStart = 0,
  streamTokens = 0;

function sndStream(retryMsg) {
  var el = $('mIn'),
    t = retryMsg || el.value.trim();
  if (!t || !sid) return;
  if (!retryMsg) el.value = '';
  var c = $('cMs');
  if (c.querySelector('.em')) c.innerHTML = '';
  c.innerHTML += '<div class="mg u"><span class="rt">you</span>' + esc(t) + '</div>';
  var s = ss.find(function (x) {
    return x.id === sid;
  });
  if (s) {
    s.n = (s.n || 0) + 1;
    s.t = new Date().toISOString();
    if (!s.title) s.title = t.slice(0, 30);
    s.preview = t.slice(0, 60);
    rSessList();
  }
  streamIter = 0;
  streamStart = Date.now();
  streamTokens = 0;
  $('trIter').textContent = '0';
  $('trTool').textContent = '--';
  $('trTokens').textContent = '0';
  $('trElapsed').textContent = '0ms';
  $('trSteps').innerHTML = '';
  var bubble = document.createElement('div');
  bubble.className = 'mg as msg-streaming md';
  bubble.innerHTML = '<span class="cursor-blink"></span>';
  c.appendChild(bubble);
  c.scrollTop = c.scrollHeight;
  fetch(B + '/api/sessions/' + sid + '/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: authToken ? 'Bearer ' + authToken : '',
    },
    body: JSON.stringify({ message: t }),
  })
    .then(function (r) {
      if (!r.ok || !r.body) {
        bubble.remove();
        sndFallback(t);
        return;
      }
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump() {
        reader
          .read()
          .then(function (res) {
            if (res.done) {
              var cur = bubble.querySelector('.cursor-blink');
              if (cur) cur.remove();
              bubble.classList.remove('msg-streaming');
              $('trElapsed').textContent = (Date.now() - streamStart) + 'ms';
              return;
            }
            buf += dec.decode(res.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop() || '';
            lines.forEach(function (ln) {
              if (!ln.startsWith('data: ')) return;
              var payload = ln.slice(6).trim();
              if (payload === '[DONE]') return;
              try {
                var ev = JSON.parse(payload);
                handleStreamEvent(ev, bubble, c);
              } catch (e) {}
            });
            pump();
          })
          .catch(function () {
            var cur = bubble.querySelector('.cursor-blink');
            if (cur) cur.remove();
            bubble.classList.remove('msg-streaming');
          });
      }
      pump();
    })
    .catch(function () {
      bubble.remove();
      sndFallback(t);
    });
}

function getOrCreateStepFeed(c, iter) {
  var id = 'sf-' + iter;
  var el = $(id);
  if (el) return el;
  var feed = document.createElement('div');
  feed.className = 'step-feed';
  feed.id = id;
  feed.innerHTML = '<div class="sf-hdr">Step ' + (iter + 1) + '</div>';
  c.appendChild(feed);
  return feed;
}

function handleStreamEvent(ev, bubble, c) {
  if (ev.type === 'text-delta') {
    streamTokens++;
    $('trTokens').textContent = String(streamTokens);
    if (!bubble.parentNode) {
      c.appendChild(bubble);
    }
    var cur = bubble.querySelector('.cursor-blink');
    if (!cur) {
      cur = document.createElement('span');
      cur.className = 'cursor-blink';
      bubble.appendChild(cur);
    }
    var span = document.createElement('span');
    span.textContent = ev.content || '';
    bubble.insertBefore(span, cur);
    c.scrollTop = c.scrollHeight;
  } else if (ev.type === 'tool-start') {
    if (bubble.textContent.trim()) {
      var rawText = bubble.textContent || '';
      var cur = bubble.querySelector('.cursor-blink');
      if (cur) cur.remove();
      bubble.classList.remove('msg-streaming');
      bubble.innerHTML = '<div class="md">' + md(rawText) + '</div>';
      bubble = document.createElement('div');
      bubble.className = 'mg as msg-streaming md';
      bubble.innerHTML = '<span class="cursor-blink"></span>';
      window._streamBubble = bubble;
    }
    $('trTool').textContent = ev.toolName || '--';
    var feed = getOrCreateStepFeed(c, streamIter);
    var inputStr = ev.input ? JSON.stringify(ev.input) : '';
    var inputPreview = ev.input
      ? Object.values(ev.input)
          .filter(function (v) {
            return typeof v === 'string';
          })
          .join(', ')
          .slice(0, 60)
      : '';
    var rowId =
      'sr-' + (ev.toolCallId || Math.random().toString(36).slice(2, 7));
    var row = document.createElement('div');
    row.id = rowId;
    row.innerHTML =
      '<div class="sf-row" onclick="var d=this.nextElementSibling;if(d)d.style.display=d.style.display===&apos;none&apos;?&apos;block&apos;:&apos;none&apos;"><span class="sf-dot running"></span><span class="sf-name">' +
      esc(ev.toolName || 'tool') +
      '</span>' +
      (inputPreview
        ? '<span style="color:var(--t3);font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          esc(inputPreview) +
          '</span>'
        : '') +
      '<span class="sf-status" style="color:var(--wn)">running</span></div><div class="sf-detail" style="display:none">' +
      (inputStr
        ? '<div style="color:var(--info);margin-bottom:4px;font-weight:500">Input</div><div style="margin-bottom:6px;padding:4px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06)">' +
          esc(inputStr.slice(0, 400)) +
          '</div>'
        : '') +
      '<div style="color:var(--t2);font-weight:500">Output</div><div class="tb-out" style="margin-top:2px">waiting...</div></div>';
    feed.appendChild(row);
    c.scrollTop = c.scrollHeight;
    $('trSteps').innerHTML +=
      '<div class="tp-step"><span style="color:var(--wn)">&#9654;</span> ' +
      esc(ev.toolName || '') +
      '</div>';
  } else if (ev.type === 'tool-end') {
    var rowEl = $('sr-' + (ev.toolCallId || ''));
    if (rowEl) {
      var dot = rowEl.querySelector('.sf-dot');
      if (dot) {
        dot.className = 'sf-dot ' + (ev.ok ? 'ok' : 'er');
      }
      var st = rowEl.querySelector('.sf-status');
      if (st) {
        st.style.color = ev.ok ? 'var(--ok)' : 'var(--er)';
        st.textContent =
          (ev.ok ? 'done' : 'error') +
          (ev.durationMs ? ' ' + ev.durationMs + 'ms' : '');
      }
      var outEl = rowEl.querySelector('.tb-out');
      if (outEl) {
        outEl.textContent = (ev.result || '').slice(0, 500);
      }
    }
    $('trSteps').innerHTML +=
      '<div class="tp-step"><span style="color:' +
      (ev.ok ? 'var(--ok)' : 'var(--er)') +
      '">&#9632;</span> ' +
      esc(ev.toolName || '') +
      ' ' +
      (ev.ok ? 'done' : 'error') +
      (ev.durationMs ? ' ' + ev.durationMs + 'ms' : '') +
      '</div>';
  } else if (ev.type === 'iteration-start') {
    streamIter = ev.iteration || 0;
    $('trIter').textContent = String(streamIter);
    if (streamIter > 0) {
      var sep = document.createElement('div');
      sep.className = 'iter-sep';
      sep.textContent = 'ITERATION ' + streamIter;
      c.appendChild(sep);
    }
  } else if (ev.type === 'iteration-end') {
    $('trElapsed').textContent = (Date.now() - streamStart) + 'ms';
  } else if (ev.type === 'done') {
    if (window._streamBubble) bubble = window._streamBubble;
    var cur2 = bubble.querySelector('.cursor-blink');
    if (cur2) cur2.remove();
    bubble.classList.remove('msg-streaming');
    if (bubble.parentNode) {
      var rawText2 = bubble.textContent || '';
      if (rawText2.trim()) {
        bubble.innerHTML = '<div class="md">' + md(rawText2) + '</div>';
      } else {
        bubble.remove();
      }
    }
    c.scrollTop = c.scrollHeight;
    $('trElapsed').textContent = (Date.now() - streamStart) + 'ms';
    window._streamBubble = null;
    applyHljs();
  } else if (ev.type === 'error') {
    showToast(ev.error || 'Stream error', 'error');
    var cur3 = bubble.querySelector('.cursor-blink');
    if (cur3) cur3.remove();
    bubble.classList.remove('msg-streaming');
  }
}

function sndFallback(t) {
  var c = $('cMs');
  c.innerHTML +=
    '<div class="typ"><div class="td"></div><div class="td"></div><div class="td"></div></div>';
  c.scrollTop = c.scrollHeight;
  ap('/api/sessions/' + sid, {
    method: 'POST',
    body: JSON.stringify({ userMessage: t }),
  })
    .then(function (d) {
      var ind = c.querySelector('.typ');
      if (ind) ind.remove();
      if (d.toolResults && d.toolResults.length) {
        d.toolResults.forEach(function (tr) {
          c.innerHTML += tcc(tr.toolName, tr.ok, tr.output || '');
        });
      }
      lH();
    })
    .catch(function (e) {
      var ind = c.querySelector('.typ');
      if (ind) ind.remove();
      c.innerHTML +=
        '<div class="err-state"><div class="err-msg">Error: ' +
        (e.message || 'Unknown') +
        '</div><button class="btn" onclick="lH()">Retry</button></div>';
    });
}

function toggleTrace() {
  var p = $('trPanel');
  p.classList.toggle('on');
}

function showToast(msg, type) {
  var t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () {
    t.remove();
  }, 3500);
}

function showConfirmModal(msg, onConfirm) {
  $('confirmMsg').textContent = msg;
  window._confirmAction = onConfirm;
  $('confirmModal').classList.add('on');
}

function confirmOk() {
  var fn = window._confirmAction;
  $('confirmModal').classList.remove('on');
  window._confirmAction = null;
  if (fn) fn();
}

function showFormModal(title, fields, onSubmit) {
  $('formTitle').textContent = title;
  window._formSubmit = onSubmit;
  var h = '';
  fields.forEach(function (f) {
    h +=
      '<div style="margin-bottom:12px"><label class="form-label">' +
      esc(f.label) +
      '</label><input class="srch" id="ff_' +
      f.name +
      '" type="' +
      (f.type || 'text') +
      '" value="' +
      esc(f.value || '') +
      '" placeholder="' +
      (f.placeholder || '') +
      '"></div>';
  });
  $('formBody').innerHTML = h;
  $('formModal').classList.add('on');
  var first = $('ff_' + fields[0].name);
  if (first) first.focus();
}

function formSubmit() {
  var fn = window._formSubmit;
  if (!fn) return;
  var inputs = $('formBody').querySelectorAll('input');
  var data = {};
  inputs.forEach(function (inp) {
    data[inp.id.replace('ff_', '')] = inp.value;
  });
  $('formModal').classList.remove('on');
  fn(data);
}

function applyHljs() {
  if (window.hljs) {
    document
      .querySelectorAll('.md-pre code[class*="lang-"]')
      .forEach(function (el) {
        if (!el.dataset.hl) {
          hljs.highlightElement(el);
          el.dataset.hl = '1';
        }
      });
  }
}

function msgRetry(idx) {
  if (!sid) return;
  ap('/api/sessions/' + sid + '/history')
    .then(function (d) {
      var msgs = d.messages || [];
      var userMsg = null;
      for (var j = idx - 1; j >= 0; j--) {
        if (msgs[j] && msgs[j].role === 'user') {
          userMsg = msgs[j].content;
          break;
        }
      }
      if (!userMsg) {
        showToast('No user message found', 'error');
        return;
      }
      ap('/api/sessions/' + sid + '/truncate', {
        method: 'POST',
        body: JSON.stringify({ afterIndex: idx }),
      }).catch(function () {});
      rMs(msgs.slice(0, idx));
      sndStream(userMsg);
    })
    .catch(function (e) {
      showToast('Error: ' + e.message, 'error');
    });
}

function btnLoading(el) {
  el._ot = el.textContent;
  el.disabled = true;
  el.style.opacity = '0.5';
  el.textContent = '...';
}

function btnDone(el) {
  el.disabled = false;
  el.style.opacity = '';
  el.textContent = el._ot || 'Done';
}

var secData = null;

function lSec() {
  Promise.all([
    ap('/api/security/status'),
    ap('/api/security/events?limit=50'),
  ])
    .then(function (res) {
      secData = res[0];
      rSecCards(res[0]);
      rSecToggles(res[0]);
      rSecEvents(res[1].events || []);
    })
    .catch(function () {
      $('secCards').innerHTML =
        '<div class="err-state"><div class="err-msg">Failed to load security status</div></div>';
    });
}

function rSecCards(d) {
  var evts = d.stats || {};
  var total = evts.total || 0;
  var crit = (evts.bySeverity || {}).critical || 0;
  var h = '';
  h +=
    '<div class="card"><div class="kv-k" style="font-size:10px;margin-bottom:4px">Active Protections</div><div style="font-size:20px;font-weight:700">' +
    d.activeCount +
    ' / ' +
    d.totalCount +
    '</div></div>';
  h +=
    '<div class="card"><div class="kv-k" style="font-size:10px;margin-bottom:4px">Total Events</div><div style="font-size:20px;font-weight:700">' +
    total +
    '</div></div>';
  h +=
    '<div class="card"><div class="kv-k" style="font-size:10px;margin-bottom:4px">Critical Events</div><div style="font-size:20px;font-weight:700;color:' +
    (crit > 0 ? 'var(--er)' : 'var(--t0)') +
    '">' +
    crit +
    '</div></div>';
  $('secCards').innerHTML = h;
}

function rSecGrade(d) {
  var colors = {
    A: 'var(--ok)',
    B: '#2ecc71',
    C: 'var(--wn)',
    D: 'var(--er)',
    F: 'var(--er)',
  };
  var c = colors[d.grade] || 'var(--t3)';
  $('secGrade').innerHTML =
    '<div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border:2px solid ' +
    c +
    ';font-size:24px;font-weight:700;color:' +
    c +
    ';font-family:var(--m)">' +
    esc(d.grade) +
    '</div><span style="margin-left:10px;font-size:12px;color:var(--t2)">' +
    d.activeCount +
    ' of ' +
    d.totalCount +
    ' protections active</span>';
}

function rSecToggles(d) {
  var ps = d.protections || [];
  var h = '';
  var desc = {
    redactToolOutput:
      'Redacts credentials and PII from tool output',
    scanCommands:
      'Scans commands for dangerous patterns before execution',
    scanUserInput:
      'Scans user input for prompt injection attempts',
    blockDangerousCommands:
      'Blocks tool calls with critical command risks',
    ssrf: 'Prevents requests to private/internal network addresses',
    piiRedaction:
      'Redacts personally identifiable information from outputs',
  };
  ps.forEach(function (p) {
    var chk = p.enabled ? 'checked' : '';
    var dis = !p.configurable ? 'disabled' : '';
    var statusText = p.enabled ? 'ON' : 'OFF';
    h +=
      '<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;padding:12px 16px"><label class="sw"><input type="checkbox" ' +
      chk +
      ' ' +
      dis +
      ' onchange="secToggle(&apos;' +
      esc(p.key) +
      '&apos;,this.checked)"><span class="sw-sl"></span></label><div style="flex:1"><div style="font-size:12px;font-weight:600">' +
      esc(p.name) +
      '</div><div style="font-size:10px;color:var(--t3)">' +
      esc(desc[p.key] || '') +
      '</div></div><span class="tag ' +
      (p.enabled ? 'ok' : '') +
      '">' +
      statusText +
      '</span></div>';
  });
  $('secToggles').innerHTML = h;
}

function secToggle(key, val) {
  ap('/api/security/policy', {
    method: 'POST',
    body: JSON.stringify(Object.fromEntries([[key, val]])),
  })
    .then(function () {
      lSec();
    })
    .catch(function (e) {
      showToast('Failed to update: ' + e.message, 'error');
    });
}

function lSecEvents() {
  var type = $('secEvtType').value;
  var sev = $('secEvtSev').value;
  var params = '?limit=50';
  if (type) params += '&type=' + type;
  ap('/api/security/events' + params)
    .then(function (d) {
      var evts = d.events || [];
      if (sev)
        evts = evts.filter(function (e) {
          return e.severity === sev;
        });
      rSecEvents(evts);
    })
    .catch(function () {});
}

function rSecEvents(evts) {
  if (!evts.length) {
    $('secEvtList').innerHTML =
      '<div class="em"><div class="em-s">No security events recorded</div></div>';
    return;
  }
  var sevColors = {
    info: 'var(--t2)',
    warning: 'var(--wn)',
    critical: 'var(--er)',
  };
  var h =
    '<table style="width:100%;font-size:11px;border-collapse:collapse"><thead><tr style="border-bottom:1px solid var(--bd)"><th style="padding:6px 8px;text-align:left;color:var(--t3);font-weight:500">Time</th><th style="padding:6px 8px;text-align:left;color:var(--t3);font-weight:500">Type</th><th style="padding:6px 8px;text-align:left;color:var(--t3);font-weight:500">Severity</th><th style="padding:6px 8px;text-align:left;color:var(--t3);font-weight:500">Detail</th></tr></thead><tbody>';
  evts.forEach(function (e) {
    var sc = sevColors[e.severity] || 'var(--t2)';
    h +=
      '<tr style="border-bottom:1px solid var(--bd)"><td style="padding:6px 8px;font-family:var(--m);color:var(--t3)">' +
      ago(e.timestamp) +
      '</td><td style="padding:6px 8px"><span class="tag">' +
      esc(e.type) +
      '</span></td><td style="padding:6px 8px;color:' +
      sc +
      ';font-weight:500">' +
      esc(e.severity) +
      '</td><td style="padding:6px 8px;color:var(--t2)">' +
      esc(e.detail) +
      '</td></tr>';
  });
  h += '</tbody></table>';
  $('secEvtList').innerHTML = h;
}

function secClearEvents() {
  showConfirmModal('Clear all security events?', function () {
    ap('/api/security/events/clear', { method: 'POST' })
      .then(function () {
        lSec();
        showToast('Events cleared', 'success');
      })
      .catch(function (e) {
        showToast('Failed: ' + e.message, 'error');
      });
  });
}

checkAuth();
