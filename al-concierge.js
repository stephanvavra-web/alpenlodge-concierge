/* Alpenlodge Concierge – Header Button (links oben) + Panel daneben
   - Single instance
   - Entfernt alte floating Widgets
   - Panel ist im <body> (kein Header-Clipping)
   - Mobile: Bottom-sheet + kein iOS Zoom (16px input)
   - Ruft /api/concierge.php (DE/EN) auf
*/
(() => {
  if (window.__AL_CONCIERGE_INIT__) return;
  window.__AL_CONCIERGE_INIT__ = true;

  const CFG = {
    // Default: Render backend (cross-domain). You can override at runtime by setting:
    // window.AL_CONCIERGE_API = 'https://...'
    api: (window.AL_CONCIERGE_API || "https://alpenlodge-concierge.onrender.com/api/concierge"),
    title: "Alpenlodge Concierge",
    subtitle: "Fragen? Ich helfe dir gerne.",
    placeholder: "Deine Frage …",
    send: "Senden",
    greetDE:
      "Hallo 👋 Ich bin dein Alpenlodge Concierge. Frag mich gern zu Apartments, Anreise, Check-in oder Aktivitäten rund um den Thiersee.",
    greetEN:
      "Hi 👋 I’m your Alpenlodge concierge. Ask me about apartments, arrival, check-in or activities around Thiersee."
  };

  // Persistent session id (enables list selections like "2" / "a2")
  const SESSION_KEY = "al_concierge_session_id";
  const getSessionId = () => {
    try {
      const existing = localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      const id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      localStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (e) {
      return (Date.now().toString(36) + Math.random().toString(36).slice(2));
    }
  };
  const sessionId = getSessionId();

  // Lightweight conversation memory (last messages only)
  const history = [];

  // ----- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const escapeHtml = (s) => String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const linkify = (s) => {
    const urlRe = /(https?:\/\/[^\s<]+[^\s<\.)])/g;
    return s.replace(urlRe, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  };

  const renderMsgHtml = (text) => {
    // 1) Escape HTML (prevents injection)
    // 2) Render minimal Markdown: **bold**
    // 3) Linkify http(s) + www
    let safe = escapeHtml(text).replace(/\n/g, "<br>");
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return linkify(safe);
  };


  // Render a list of source links returned by the backend.
  const renderLinks = (links, title) => {
    if (!Array.isArray(links) || links.length === 0) return "";

    const esc = (s) => String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const toObj = (x) => {
      if (!x) return null;
      if (typeof x === "string") return { label: x, url: x };
      if (typeof x === "object" && (x.url || x.href)) {
        return { label: x.label || x.title || x.url || x.href, url: x.url || x.href };
      }
      return null;
    };

    const items = links
      .map(toObj)
      .filter(Boolean)
      .slice(0, 8)
      .map(({ label, url }) => {
        const u = esc(url);
        const l = esc(label);
        let host = "";
        try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
        const small = host ? `<div class="al-links-url">${esc(host)}</div>` : "";
        return `<li><a href="${u}" target="_blank" rel="noopener noreferrer">${l}</a>${small}</li>`;
      })
      .join("");

    return `<div class="al-links"><div class="al-links-title">${esc(title || "Infos & Links")}</div><ul>${items}</ul></div>`;
  };

  // ----- remove legacy widgets to avoid duplicates
  const killLegacy = () => {
    const legacy = [
      ".al-concierge-fab",
      "#al-concierge-fallback",
      ".al-concierge-trigger",
      ".concierge-fab",
      "#al-concierge-fab",
      ".al-concierge-panel",
      "#al-concierge-panel",
      "#al-concierge-btn",
      "#al-concierge-header-slot",
      ".al-brand-wrap"
    ];
    legacy.forEach(sel => $$(sel).forEach(n => n.remove()));
  };

  // ----- inject minimal CSS so we don’t depend on an extra CSS patch
  const injectCSS = () => {
    if ($("#al-concierge-css")) return;
    const s = el("style");
    s.id = "al-concierge-css";
    s.textContent = `
:root{
  --al-accent: var(--accent, #17a2a0);
  --al-shadow: 0 14px 40px rgba(0,0,0,.18);
  --al-radius: 14px;
}
#al-concierge-btn{
  display:inline-flex; align-items:center; gap:10px;
  height:44px; padding:0 14px;
  border-radius:999px;
  border:1px solid rgba(0,0,0,.12);
  background:rgba(255,255,255,.92);
  box-shadow:0 8px 18px rgba(0,0,0,.10);
  cursor:pointer; user-select:none; white-space:nowrap;
}
#al-concierge-btn:hover{ transform: translateY(-1px); box-shadow:0 12px 24px rgba(0,0,0,.14); }
#al-concierge-btn .ico{
  width:26px; height:26px; display:grid; place-items:center;
  border-radius:999px;
  background: color-mix(in srgb, var(--al-accent) 14%, white);
}
#al-concierge-btn .lbl{ font-weight:700; font-size:14px; color:#1b1b1b; }

#al-concierge-panel{
  position:fixed;
  width:360px; max-width:min(92vw, 420px);
  background:#fff;
  border-radius:var(--al-radius);
  box-shadow:var(--al-shadow);
  border:1px solid rgba(0,0,0,.10);
  overflow:hidden;
  opacity:0; transform: translateY(-6px);
  pointer-events:none;
  transition: opacity .14s ease, transform .14s ease;
  z-index:99999;
}
#al-concierge-panel.open{ opacity:1; transform: translateY(0); pointer-events:auto; }

#al-concierge-panel .head{
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:12px 14px; background:var(--al-accent); color:#fff;
}
#al-concierge-panel .t1{ font-weight:800; font-size:14px; line-height:1.1; }
#al-concierge-panel .t2{ font-size:12px; opacity:.92; }
#al-concierge-panel .x{
  appearance:none; border:none; cursor:pointer;
  width:34px; height:34px; border-radius:12px;
  background: rgba(255,255,255,.18); color:#fff; font-size:18px; line-height:34px;
}
#al-concierge-panel .body{
  padding:12px 14px;
  max-height:360px; overflow:auto;
  display:flex; flex-direction:column; gap:10px;
}
#al-concierge-panel .msg{
  padding:10px 12px; border-radius:12px;
  font-size:13px; line-height:1.35; max-width:92%;
}
#al-concierge-panel .bot{ background:rgba(0,0,0,.04); color:#1b1b1b; align-self:flex-start; }
#al-concierge-panel .usr{ background: color-mix(in srgb, var(--al-accent) 16%, white); color:#1b1b1b; align-self:flex-end; }

#al-concierge-panel .al-links{ margin-top:8px; font-size:12px; }
#al-concierge-panel .al-links-title{ font-weight:800; margin:0 0 6px 0; }
#al-concierge-panel .al-links ul{ margin:0; padding-left:18px; }
#al-concierge-panel .al-links li{ margin:4px 0; word-break:break-word; }
#al-concierge-panel .al-links a{ color:var(--al-accent); text-decoration:underline; }
#al-concierge-panel .al-links-url{ font-size:11px; opacity:.8; margin-top:2px; word-break:break-word; }
#al-concierge-panel .foot{
  display:flex; flex-direction:column; gap:10px; padding:12px 14px;
  border-top:1px solid rgba(0,0,0,.08); background:rgba(255,255,255,.95);
}
#al-concierge-panel .quick{
  display:flex; gap:8px; flex-wrap:wrap;
  max-height:92px; overflow:auto;
}
#al-concierge-panel .quick button{
  height:32px;
  padding:0 12px;
  border-radius:999px;
  border:1px solid rgba(0,0,0,.14);
  background:#fff;
  cursor:pointer;
  font-size:12px;
  white-space:nowrap;
}
#al-concierge-panel .quick button.primary{
  border:none;
  background:var(--al-accent);
  color:#fff;
  font-weight:800;
}
#al-concierge-panel .compose{
  display:flex; gap:10px;
}
#al-concierge-panel input{
  flex:1; height:40px; border-radius:999px;
  border:1px solid rgba(0,0,0,.14);
  padding:0 12px; outline:none;
  font-size:16px; /* iOS: verhindert Zoom */
}
#al-concierge-panel button.send{
  height:40px; padding:0 16px; border-radius:999px;
  border:none; background:var(--al-accent); color:#fff; font-weight:800; cursor:pointer;
}

body.al-no-scroll{ overflow:hidden; }

@media (max-width: 520px){
  #al-concierge-btn .lbl{ display:none; }
  #al-concierge-btn{ padding:0 12px; }
  #al-concierge-panel{
    left:12px !important; right:12px !important;
    bottom:12px !important; top:auto !important;
    width:auto !important;
    max-height: calc(100dvh - 24px);
  }
  #al-concierge-panel .body{ max-height: calc(100dvh - 210px); }
}
`;
    document.head.appendChild(s);
  };

  // ----- find header logo container robustly
  const findLogoAnchor = () => {
    const headerInner =
      $(".header-inner") ||
      $("header .header-inner") ||
      $("header") ||
      $(".site-header") ||
      $(".topbar");

    if (!headerInner) return null;

    // Try common logo nodes
    const logo =
      headerInner.querySelector(".logo") ||
      headerInner.querySelector(".site-logo") ||
      headerInner.querySelector("a.logo") ||
      headerInner.querySelector("a[href='./']") ||
      headerInner.querySelector("a[href='/']") ||
      headerInner.querySelector("img[alt*='Alpenlodge']") ||
      headerInner.querySelector("img");

    if (!logo) return null;

    // Prefer an <a> wrapper if present
    return logo.closest("a") || logo;
  };

  // ----- mount button next to logo (inside a flex wrapper)
  const mountButton = () => {
    const logoNode = findLogoAnchor();
    if (!logoNode) return null;

    const parent = logoNode.parentElement;
    if (!parent) return null;

    // Create wrapper to keep logo + button aligned
    const wrap = el("div");
    wrap.className = "al-brand-wrap";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "12px";

    parent.insertBefore(wrap, logoNode);
    wrap.appendChild(logoNode);

    const btn = el("button");
    btn.id = "al-concierge-btn";
    btn.type = "button";
    btn.innerHTML = `<span class="ico">💬</span><span class="lbl">Concierge</span>`;
    wrap.appendChild(btn);

    return btn;
  };

  // ----- panel in body (no clipping), positioned near button
  const buildPanel = () => {
    const panel = el("div");
    panel.id = "al-concierge-panel";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <div class="head">
        <div class="titles">
          <div class="t1">${CFG.title}</div>
          <div class="t2">${CFG.subtitle}</div>
        </div>
        <button class="x" type="button" aria-label="Close">×</button>
      </div>
      <div class="body"></div>
      <div class="foot">
        <div class="quick" aria-label="Schnellwahl"></div>
        <div class="compose">
          <input type="text" placeholder="${CFG.placeholder}" />
          <button class="send" type="button">${CFG.send}</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    return panel;
  };

  const detectLang = () => {
    const htmlLang = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    if (htmlLang.startsWith("en")) return "en";
    // simple heuristic: /en/ in path
    if (location.pathname.toLowerCase().includes("/en")) return "en";
    return "de";
  };

  const positionPanelNearButton = (panel, btn) => {
    const r = btn.getBoundingClientRect();
    const pad = 10;

    // Mobile: CSS handles as bottom sheet
    if (window.innerWidth <= 520) {
      panel.style.left = "12px";
      panel.style.right = "12px";
      panel.style.bottom = "12px";
      panel.style.top = "auto";
      return;
    }

    // Desktop: place under button, left aligned, clamp to viewport
    const desiredTop = Math.round(r.bottom + pad);
    let desiredLeft = Math.round(r.left);

    // Clamp so it stays on screen
    const w = panel.offsetWidth || 360;
    const maxLeft = Math.max(8, window.innerWidth - w - 8);
    desiredLeft = Math.max(8, Math.min(desiredLeft, maxLeft));

    panel.style.top = `${desiredTop}px`;
    panel.style.left = `${desiredLeft}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  };

  const run = async () => {
    killLegacy();
    injectCSS();

    // Wait until DOM is really ready (prevents fallback)
    const btn = mountButton();

    // If header not found: fallback button bottom-right (but still works)
    let finalBtn = btn;
    if (!finalBtn) {
      finalBtn = el("button");
      finalBtn.id = "al-concierge-btn";
      finalBtn.type = "button";
      finalBtn.innerHTML = `<span class="ico">💬</span><span class="lbl">Concierge</span>`;
      finalBtn.style.position = "fixed";
      finalBtn.style.right = "16px";
      finalBtn.style.bottom = "16px";
      finalBtn.style.zIndex = "99999";
      document.body.appendChild(finalBtn);
    }

    const panel = buildPanel();
    const body = $(".body", panel);
    const input = $("input", panel);
    const sendBtn = $("button.send", panel);
    const closeBtn = $("button.x", panel);
    const quick = $(".quick", panel);

    const lang = detectLang();
    const greet = lang === "en" ? CFG.greetEN : CFG.greetDE;

    const START_ACTIONS = (lang === "en")
      ? [
          { type: "link", label: "Book", url: "/buchen/", kind: "primary" },
          { type: "postback", label: "Availability", message: "Check availability" },
          { type: "postback", label: "Prices", message: "Compare prices" },
          { type: "postback", label: "Apartments", message: "Apartments availability" },
          { type: "postback", label: "Suites", message: "Suites availability" },
          { type: "postback", label: "Premium Suites", message: "Premium Suites availability" }
        ]
      : [
          { type: "link", label: "Buchen", url: "/buchen/", kind: "primary" },
          { type: "postback", label: "Verfügbarkeit", message: "Verfügbarkeit prüfen" },
          { type: "postback", label: "Preise", message: "Preise vergleichen" },
          { type: "postback", label: "Apartments", message: "Apartments Verfügbarkeit" },
          { type: "postback", label: "Suiten", message: "Suiten Verfügbarkeit" },
          { type: "postback", label: "Premium", message: "Premium Suiten Verfügbarkeit" }
        ];


    function setQuickActions(actions) {
      if (!quick) return;
      const list = Array.isArray(actions) ? actions : [];
      quick.innerHTML = "";
      list.forEach((a) => {
        if (!a || !a.label) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = a.label;
        if (a.kind === "primary") btn.classList.add("primary");
        btn.addEventListener("click", () => {
          if (a.type === "link") {
            const url = a.url || a.href;
            if (!url) return;
            const target = a.target || (String(url).startsWith("http") ? "_blank" : "_self");
            window.open(url, target, "noopener");
            return;
          }
          // postback (send a message without typing)
          const msg = a.message || a.text;
          if (msg) submit(msg);
        });
        quick.appendChild(btn);
      });
    }


    const push = (text, who, opts = {}) => {
      const { rawHtml = false, storeInHistory = true } = opts || {};
      const html = rawHtml ? String(text || "") : renderMsgHtml(text);
      const m = el("div", `msg ${who}`, html);
      body.appendChild(m);
      body.scrollTop = body.scrollHeight;

      if (storeInHistory) {
        const role = who === "bot" ? "assistant" : "user";
        history.push({ role, content: String(text || "") });
        if (history.length > 20) history.splice(0, history.length - 20);
      }
    };


    push(greet, "bot");
    setQuickActions(START_ACTIONS);

    const open = () => {
      positionPanelNearButton(panel, finalBtn);
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");

      if (window.innerWidth <= 520) document.body.classList.add("al-no-scroll");
      setTimeout(() => input.focus(), 20);
    };

    const close = () => {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      document.body.classList.remove("al-no-scroll");
    };

    const toggle = () => (panel.classList.contains("open") ? close() : open());

    finalBtn.addEventListener("click", (e) => {
      e.preventDefault();
      toggle();
    });

    closeBtn.addEventListener("click", close);

    // Click outside closes
    document.addEventListener("click", (e) => {
      if (!panel.classList.contains("open")) return;
      if (panel.contains(e.target) || finalBtn.contains(e.target)) return;
      close();
    });

    // Reposition on resize/scroll when open
    window.addEventListener("resize", () => {
      if (panel.classList.contains("open")) positionPanelNearButton(panel, finalBtn);
    }, { passive: true });
    window.addEventListener("scroll", () => {
      if (panel.classList.contains("open") && window.innerWidth > 520) positionPanelNearButton(panel, finalBtn);
    }, { passive: true });

    async function submit(qOverride) {
      const q = (qOverride !== undefined ? String(qOverride) : (input.value || "")).trim();
      if (!q) return;
      input.value = "";
      push(q, "usr");

      try {
        const payload = {
          lang,
          question: q,
          page: location.pathname || "start",
          sessionId,
          history: history.slice(-10)
        };

        // Render free tier can be slow on cold start. Give it time and fail gracefully.
        const controller = new AbortController();
        const timeoutMs = 65000;
        const to = setTimeout(() => controller.abort(), timeoutMs);

        let res;
        try {
          res = await fetch(CFG.api, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
        } finally {
          clearTimeout(to);
        }

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        let data = null;
        let text = "";

        if (ct.includes("application/json")) {
          data = await res.json().catch(() => null);
        } else {
          text = await res.text().catch(() => "");
        }

        if (!res.ok) {
          const msg = (data && (data.hint || data.error || data.message))
            || (text ? text.replace(/\s+/g, " ").slice(0, 160) : `HTTP ${res.status}`);
          push(lang === "en" ? `Error: ${msg}` : `Fehler: ${msg}`, "bot");
          return;
        }

        const reply = data && (data.reply || data.answer);
        if (reply) {
          // Show assistant reply
          push(reply, "bot");

          // Quick action buttons (above the input)
          const actions = data && data.actions;
          setQuickActions(Array.isArray(actions) && actions.length ? actions : START_ACTIONS);

          // Show sources as a separate block (clickable), if provided.
          const links = data && data.links;
          const linksHtml = renderLinks(links, lang === "en" ? "Info & Links" : "Infos & Links");
          if (linksHtml) push(linksHtml, "bot", { rawHtml: true, storeInHistory: false });
          return;
        }

        // If we get here, the server returned something unexpected (HTML or empty JSON).
        console.warn("Concierge unexpected response", { status: res.status, contentType: ct, data, text });
        push(
          lang === "en"
            ? "Sorry — the server returned an unexpected response."
            : "Sorry — der Server hat unerwartet geantwortet (kein Text).",
          "bot"
        );
      } catch (err) {
        const aborted = (err && (err.name === "AbortError"));
        push(
          lang === "en"
            ? (aborted ? "The concierge is starting up — please try again in a moment." : "Network error. Please try again.")
            : (aborted ? "Concierge startet gerade — bitte in einem Moment nochmal versuchen." : "Netzwerkfehler. Bitte nochmal versuchen."),
          "bot"
        );
      }
    }

    const ask = () => submit();

    sendBtn.addEventListener("click", ask);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ask();
      if (e.key === "Escape") close();
    });
  };

  // Ensure we run after DOM is there (prevents bottom-right fallback)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();