(() => {
  "use strict";

  const root = document.getElementById("app");
  let me = null;
  let status = { notifications: { slack: false, telegram: false }, maxResumeMb: 5 };
  let sites = []; // the registered domains (loaded after login, refreshed when they change)

  // ---------------------------------------------------------------- helpers

  /** Build an element. Children that are strings become text nodes, so stored data can never inject HTML. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  class ApiError extends Error {
    constructor(statusCode, body) {
      super((body && body.error) || "Request failed");
      this.status = statusCode;
      this.fields = (body && body.fields) || {};
    }
  }

  async function api(path, { method = "GET", json, form } = {}) {
    const headers = { "X-Requested-With": "XMLHttpRequest" };
    let body;
    if (form) body = form;
    else if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    const res = await fetch("/api" + path, { method, headers, body, credentials: "same-origin" });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      if (res.status === 401 && me) {
        me = null;
        renderLogin("Session expired. Please log in again.");
      }
      throw new ApiError(res.status, data);
    }
    return data;
  }

  /** Sends a file straight to storage with the URL the server handed out (the file never passes through the server). */
  async function putToStorage(upload, file) {
    let res;
    try {
      res = await fetch(upload.url, { method: upload.method || "PUT", headers: upload.headers || {}, body: file });
    } catch {
      throw new Error("The file could not be uploaded. Check your connection and try again.");
    }
    if (!res.ok) throw new Error(res.status === 413 ? "That file is larger than the storage limit allows." : "The file could not be uploaded (storage said " + res.status + ").");
  }

  async function loadSites() {
    try {
      sites = (await api("/admin/sites")).sites;
    } catch {
      sites = [];
    }
    return sites;
  }

  /** A <select> of domains. `first` = the label of the "no domain" choice; its value is `firstValue`. */
  function siteSelect({ first, firstValue = "", value = "", label = "Domain", extra = [] }) {
    const sel = h(
      "select",
      { "aria-label": label },
      h("option", { value: firstValue }, first),
      ...extra.map((o) => h("option", { value: o.value }, o.label)),
      ...sites.map((x) => h("option", { value: String(x.id) }, x.domain + (x.active ? "" : " (off)"))),
    );
    sel.value = String(value ?? firstValue);
    if (sel.value !== String(value ?? firstValue)) sel.value = firstValue;
    return sel;
  }

  const domainBadge = (d) => (d ? h("span", { class: "badge domain" }, d) : null);

  const fmtDate = (s) => (s ? new Date(s).toLocaleString() : "");
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const isSuper = () => me && me.role === "super_admin";

  function showMsg(el, text, ok) {
    el.textContent = text;
    el.className = "form-msg" + (ok ? " ok" : "");
  }

  /** Generic form: fields = [{name,label,type,options,rows,accept,help}], shows field errors from the API. */
  function buildForm({ fields, values = {}, submitLabel = "Save", onSubmit, onCancel }) {
    const form = h("form", { class: "form", novalidate: true });
    const wraps = {};
    const msg = h("div", { class: "form-msg", role: "alert" });

    for (const f of fields) {
      let input;
      if (f.type === "select") {
        input = h("select", { name: f.name, id: "f-" + f.name }, f.options.map((o) => h("option", { value: String(o.value) }, o.label)));
        const want = values[f.name] ?? (f.options[0] && f.options[0].value);
        input.value = String(want ?? "");
      } else if (f.type === "textarea") {
        input = h("textarea", { name: f.name, id: "f-" + f.name, rows: f.rows || 4 });
        input.value = values[f.name] ?? "";
      } else if (f.type === "checkbox") {
        input = h("input", { type: "checkbox", name: f.name, id: "f-" + f.name });
        input.checked = values[f.name] ?? true;
      } else {
        input = h("input", {
          type: f.type || "text",
          name: f.name,
          id: "f-" + f.name,
          accept: f.accept,
          autocomplete: f.autocomplete || "off",
        });
        if (f.type !== "file" && f.type !== "password") input.value = values[f.name] ?? "";
      }
      const err = h("div", { class: "err" });
      const wrap =
        f.type === "checkbox"
          ? h("div", { class: "field" }, h("label", { class: "check", for: input.id }, input, f.label), err)
          : h("div", { class: "field" }, h("label", { for: input.id }, f.label), input, f.help ? h("div", { class: "muted small" }, f.help) : null, err);
      wraps[f.name] = { wrap, err };
      form.append(wrap);
    }

    const submit = h("button", { type: "submit", class: "primary" }, submitLabel);
    form.append(msg, h("div", { class: "row" }, submit, onCancel ? h("button", { type: "button", onclick: onCancel }, "Cancel") : null));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const { wrap, err } of Object.values(wraps)) {
        wrap.classList.remove("has-err");
        err.textContent = "";
      }
      showMsg(msg, "");
      submit.disabled = true;
      try {
        const vals = {};
        for (const f of fields) {
          const el = form.elements[f.name];
          if (f.type === "checkbox") vals[f.name] = el.checked;
          else if (f.type !== "file") vals[f.name] = el.value;
        }
        await onSubmit(vals, new FormData(form), form, (t) => showMsg(msg, t, true));
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        showMsg(msg, err.message);
        for (const [k, text] of Object.entries(err.fields)) {
          if (wraps[k]) {
            wraps[k].wrap.classList.add("has-err");
            wraps[k].err.textContent = text;
          }
        }
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function pager(state, onChange) {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    return h(
      "div",
      { class: "pager" },
      h("span", { class: "muted" }, `${state.total} total · page ${state.page} of ${pages}`),
      h("button", { class: "sm", disabled: state.page <= 1, onclick: () => onChange(state.page - 1) }, "Prev"),
      h("button", { class: "sm", disabled: state.page >= pages, onclick: () => onChange(state.page + 1) }, "Next"),
    );
  }

  const table = (headers, rows, emptyText) =>
    rows.length
      ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, headers.map((x) => h("th", null, x)))), h("tbody", null, rows)))
      : h("div", { class: "empty" }, emptyText);

  const head = (title, sub, ...extra) =>
    h("div", { class: "head" }, h("div", null, h("h1", null, title), sub ? h("div", { class: "muted" }, sub) : null), ...extra);

  const confirmDo = (text, fn) => {
    if (window.confirm(text)) return fn();
  };

  // ---------------------------------------------------------------- login

  function renderLogin(notice) {
    document.title = "Admin login";
    const form = buildForm({
      fields: [
        { name: "email", label: "Email", type: "email", autocomplete: "username" },
        { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
      ],
      submitLabel: "Log in",
      onSubmit: async (vals) => {
        const data = await api("/auth/login", { method: "POST", json: vals });
        me = data.user;
        await startApp();
      },
    });
    form.style.maxWidth = "none";
    root.replaceChildren(
      h("div", { class: "login-wrap" }, h("div", { class: "login" }, h("h1", null, "Resume Portal"), h("p", { class: "muted" }, notice || "Sign in to the admin area."), form)),
    );
    const first = form.querySelector("input");
    if (first) first.focus();
  }

  // ---------------------------------------------------------------- shell + routing

  const NAV = [
    { id: "applications", label: "Applications", superOnly: true, view: viewApplications },
    { id: "activity", label: "Activity history", superOnly: true, view: viewActivity },
    { id: "submit", label: "Submit a resume", superOnly: true, view: viewSubmit },
    { id: "companies", label: "Companies", view: viewCompanies },
    { id: "roles", label: "Roles", view: viewRoles },
    { id: "types", label: "Hiring & working types", view: viewTypes },
    { id: "users", label: "Users", superOnly: true, view: viewUsers },
    { id: "domains", label: "Domains", superOnly: true, view: viewDomains },
    { id: "settings", label: "Settings", superOnly: true, view: viewSettings },
    { id: "diagnostics", label: "Diagnostics", view: viewDiagnostics },
    { id: "account", label: "My account", view: viewAccount },
  ];

  const available = () => NAV.filter((n) => !n.superOnly || isSuper());

  function currentRoute() {
    const id = location.hash.replace(/^#\/?/, "").split("/")[0];
    return available().find((n) => n.id === id) || available()[0];
  }

  async function startApp() {
    try {
      status = await api("/admin/status");
    } catch {
      /* keep defaults */
    }
    await loadSites();
    renderShell();
  }

  function renderShell() {
    // drop any unsaved theme preview from the settings page
    for (const k of [...document.documentElement.style]) document.documentElement.style.removeProperty(k);
    const active = currentRoute();
    document.title = active.label + " · Resume Portal Admin";
    const main = h("main", { class: "main" });
    const side = h(
      "nav",
      { class: "side" },
      h("div", { class: "brand" }, "Resume Portal"),
      available().map((n) => h("a", { href: "#/" + n.id, class: n.id === active.id ? "active" : "" }, n.label)),
      h("div", { class: "spacer" }),
      h("div", { class: "who muted" }, me.email, h("br"), me.role === "super_admin" ? "Super admin" : "Admin"),
      h("button", { class: "sm", onclick: logout }, "Log out"),
    );
    root.replaceChildren(h("div", { class: "shell" }, side, main));
    active.view(main);
  }

  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    me = null;
    renderLogin("You are logged out.");
  }

  window.addEventListener("hashchange", () => me && renderShell());

  // ---------------------------------------------------------------- applications (super admin)

  const initialsOf = (name) =>
    String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

  /** Small round photo for the list, or the candidate's initials when there is no photo. */
  function avatar(a) {
    if (a.hasPhoto) return h("img", { class: "avatar", src: `/api/admin/applications/${a.id}/photo`, alt: `Photo of ${a.name}`, loading: "lazy" });
    return h("span", { class: "avatar", "aria-hidden": "true" }, initialsOf(a.name));
  }

  async function deleteApplication(a) {
    if (!window.confirm(`Delete the application from ${a.name} (${a.roleTitle})?\n\nThe resume and photo files are deleted too. This cannot be undone.`)) return false;
    try {
      await api(`/admin/applications/${a.id}`, { method: "DELETE" });
      return true;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      window.alert(err.message);
      return false;
    }
  }

  /** The "View" window: photo, details and the resume (a PDF is shown right here; Word files can only be downloaded). */
  function openApplicationDialog(a, onDeleted) {
    const dlg = h("dialog", { class: "modal", "aria-label": `Application from ${a.name}` });
    const base = `/api/admin/applications/${a.id}`;
    const close = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("click", (e) => e.target === dlg && close());

    const row = (label, value) => (value ? [h("dt", null, label), h("dd", null, value)] : []);
    const photoBox = a.hasPhoto
      ? h(
          "div",
          { class: "photo-box" },
          h("a", { href: base + "/photo", target: "_blank", rel: "noopener", title: "Open full size" }, h("img", { class: "photo", src: base + "/photo", alt: `Photo of ${a.name}` })),
          h(
            "div",
            { class: "actions" },
            h("a", { class: "btn sm", href: base + "/photo", target: "_blank", rel: "noopener" }, "Open full size"),
            h("a", { class: "btn sm", href: base + "/photo?download=1" }, "Download"),
          ),
          h("div", { class: "muted small" }, `${a.photoName} · ${fmtSize(a.photoSize)}`),
        )
      : h("div", { class: "photo-box" }, h("div", { class: "photo-empty" }, initialsOf(a.name)), h("div", { class: "muted small" }, "No photo provided"));

    const isPdf = a.resumeKind === "pdf";
    const resumeBox = h(
      "section",
      { class: "resume-box" },
      h(
        "div",
        { class: "resume-bar" },
        h("div", null, h("strong", null, "Resume"), h("div", { class: "muted small" }, `${a.resumeName} · ${fmtSize(a.resumeSize)}`)),
        h(
          "div",
          { class: "actions" },
          isPdf ? h("a", { class: "btn sm", href: base + "/resume?inline=1", target: "_blank", rel: "noopener" }, "Open in new tab") : null,
          h("a", { class: "btn sm primary", href: base + "/resume" }, "Download"),
        ),
      ),
      isPdf
        ? h("iframe", { class: "resume-frame", src: base + "/resume?inline=1", title: `Resume of ${a.name}` })
        : h("div", { class: "resume-note" }, `This is a ${a.resumeKind.toUpperCase()} file. Browsers can't show Word files, so download it to read it.`),
    );

    const details = h(
      "dl",
      { class: "details" },
      row("Email", h("a", { href: "mailto:" + encodeURIComponent(a.email) }, a.email)),
      row("Phone", a.phone),
      row("Role", `${a.roleTitle} · ${a.companyName}`),
      row("Hiring type", a.hiringType),
      row("Working type", a.workingType),
      row("Received", a.createdAtLocal),
      row("Source", a.source === "admin" ? "Admin: " + a.submittedBy : "Website"),
      row("Domain", a.domain),
      row("Location", [a.ip, a.country].filter(Boolean).join(" · ")),
      row("Browser", `${a.browser} · ${a.platform}${a.isMobile ? " (mobile)" : ""}`),
    );

    const del = h(
      "button",
      {
        class: "danger",
        onclick: async () => {
          if (await deleteApplication(a)) {
            close();
            onDeleted();
          }
        },
      },
      "Delete application",
    );

    dlg.append(
      h(
        "header",
        { class: "modal-head" },
        h("div", null, h("h2", null, a.name), h("div", { class: "muted" }, `${a.roleTitle} · ${a.companyName}`)),
        h("button", { class: "sm", "aria-label": "Close", onclick: close }, "✕"),
      ),
      h("div", { class: "modal-body" }, h("div", { class: "app-top" }, photoBox, details), resumeBox),
      h("footer", { class: "modal-foot" }, del, h("button", { onclick: close }, "Close")),
    );
    document.body.append(dlg);
    dlg.showModal();
  }

  async function viewApplications(main) {
    const state = { q: "", siteId: "", page: 1, pageSize: 25, total: 0 };
    const results = h("div");
    const zone = h("span", { class: "muted small" });
    const usage = h("div", { class: "muted small", style: "margin-bottom:8px" });
    const siteSel = siteSelect({ first: "All domains", extra: [{ value: "none", label: "Default (no domain)" }] });
    siteSel.addEventListener("change", () => ((state.siteId = siteSel.value), (state.page = 1), load()));
    const search = h("input", { type: "search", placeholder: "Search name, email, role, company, country, IP", "aria-label": "Search applications" });
    search.addEventListener("keydown", (e) => e.key === "Enter" && ((state.q = search.value), (state.page = 1), load()));

    async function load() {
      const qs = new URLSearchParams({ q: state.q, siteId: state.siteId, page: state.page, pageSize: state.pageSize });
      const data = await api("/admin/applications?" + qs);
      // the last application on a page was deleted: step back to the previous page
      if (!data.applications.length && data.total > 0 && state.page > 1) return ((state.page = Math.ceil(data.total / state.pageSize)), load());
      Object.assign(state, { total: data.total, page: data.page });
      zone.textContent = "Times shown in " + data.timeZone;
      if (data.storage) {
        const u = data.storage;
        usage.textContent = u.limitBytes
          ? `Storage: ${fmtSize(u.bytes)} of ${fmtSize(u.limitBytes)} used by ${u.count} application${u.count === 1 ? "" : "s"}. When the limit is exceeded the oldest applications are deleted automatically.`
          : `Storage: ${fmtSize(u.bytes)} used by ${u.count} application${u.count === 1 ? "" : "s"}. Automatic deletion is off.`;
      }
      results.replaceChildren(
        table(
          ["Received", "Candidate", "Role", "Preferences", "Client", "Resume & photo", ""],
          data.applications.map((a) =>
            h(
              "tr",
              null,
              h("td", { class: "nowrap" }, a.createdAtLocal, h("br"), h("span", { class: "badge" }, a.source === "admin" ? "admin: " + a.submittedBy : "website"), a.domain ? h("br") : null, domainBadge(a.domain)),
              h(
                "td",
                null,
                h("div", { class: "person" }, avatar(a), h("div", null, a.name, h("br"), h("span", { class: "muted" }, a.email), a.phone ? h("br") : null, a.phone ? h("span", { class: "muted" }, a.phone) : null)),
              ),
              h("td", null, a.roleTitle, h("br"), h("span", { class: "muted" }, a.companyName)),
              h("td", null, a.hiringType || "-", h("br"), h("span", { class: "muted" }, a.workingType || "-")),
              h("td", null, a.ip || "-", " · ", a.country, h("br"), h("span", { class: "muted" }, `${a.browser} · ${a.platform}${a.isMobile ? " (mobile)" : ""}`)),
              h(
                "td",
                null,
                h("div", { class: "small" }, a.resumeName),
                h("div", { class: "muted small" }, `${fmtSize(a.resumeSize)} · ${a.hasPhoto ? "photo attached" : "no photo"}`),
                h("a", { class: "small", href: `/api/admin/applications/${a.id}/resume`, title: "Download the resume" }, "Download resume"),
              ),
              h(
                "td",
                { class: "nowrap" },
                h(
                  "div",
                  { class: "actions" },
                  h("button", { class: "sm primary", onclick: () => openApplicationDialog(a, load) }, "View"),
                  h("button", { class: "sm danger", onclick: async () => (await deleteApplication(a)) && load() }, "Delete"),
                ),
              ),
            ),
          ),
          "No applications yet.",
        ),
        pager(state, (p) => ((state.page = p), load())),
      );
    }

    main.replaceChildren(
      head("Applications", "Every resume received, with the browser, platform, IP and country it came from."),
      h("div", { class: "panel" }, usage, h("div", { class: "toolbar" }, search, siteSel, h("button", { onclick: () => ((state.q = search.value), (state.page = 1), load()) }, "Search"), zone), results),
    );
    await load();
  }

  // ---------------------------------------------------------------- activity (super admin)

  async function viewActivity(main) {
    const state = { type: "", siteId: "", page: 1, pageSize: 50, total: 0 };
    const siteSel = siteSelect({ first: "All domains", extra: [{ value: "none", label: "Default (no domain)" }] });
    siteSel.addEventListener("change", () => ((state.siteId = siteSel.value), (state.page = 1), load()));
    const results = h("div");
    const zone = h("span", { class: "muted small" });
    const typeSel = h("select", { "aria-label": "Event type" });
    typeSel.addEventListener("change", () => ((state.type = typeSel.value), (state.page = 1), load()));
    let typesLoaded = false;

    async function load() {
      const qs = new URLSearchParams({ type: state.type, siteId: state.siteId, page: state.page, pageSize: state.pageSize });
      const data = await api("/admin/activity?" + qs);
      Object.assign(state, { total: data.total, page: data.page });
      zone.textContent = "Times shown in " + data.timeZone;
      if (!typesLoaded) {
        typeSel.replaceChildren(h("option", { value: "" }, "All events"), ...data.types.map((t) => h("option", { value: t }, t)));
        typesLoaded = true;
      }
      results.replaceChildren(
        table(
          ["Time", "Event", "User", "IP / country", "Browser · platform", "Details"],
          data.events.map((e) =>
            h(
              "tr",
              null,
              h("td", { class: "nowrap" }, e.createdAtLocal),
              h("td", null, h("span", { class: "badge" }, e.type), e.domain ? h("br") : null, domainBadge(e.domain)),
              h("td", null, e.user || "-"),
              h("td", { class: "nowrap" }, `${e.ip || "-"} · ${e.country || "?"}`),
              h("td", null, `${e.browser || "-"} · ${e.platform || "-"}${e.isMobile ? " (mobile)" : ""}`),
              h("td", { class: "muted small" }, e.details && e.details !== "{}" ? e.details : ""),
            ),
          ),
          "Nothing logged yet.",
        ),
        pager(state, (p) => ((state.page = p), load())),
      );
    }

    main.replaceChildren(
      head("Activity history", "Verification attempts, uploads, logins, notifications and edits."),
      h("div", { class: "panel" }, h("div", { class: "toolbar" }, typeSel, siteSel, zone), results),
      deletePanel(() => ((state.page = 1), (typesLoaded = false), load())),
    );
    await load();
  }

  function deletePanel(after) {
    const days = h("input", { type: "number", min: "1", max: "3650", value: "90", style: "width:90px", "aria-label": "Days" });
    const msg = h("div", { class: "form-msg", role: "status" });
    const run = async (json, question) => {
      if (!window.confirm(question)) return;
      try {
        const r = await api("/admin/activity/clear", { method: "POST", json });
        showMsg(msg, `Deleted ${r.deleted} entr${r.deleted === 1 ? "y" : "ies"}.`, true);
        await after();
      } catch (e) {
        showMsg(msg, e.message);
      }
    };
    return h(
      "div",
      { class: "panel" },
      h("h2", null, "Delete history"),
      h("p", { class: "muted" }, "Applications and resumes are not affected. One line recording the deletion is kept."),
      h(
        "div",
        { class: "toolbar" },
        "Older than ",
        days,
        " days",
        h("button", { class: "danger", onclick: () => run({ mode: "older", days: Number(days.value) }, `Delete activity older than ${days.value} days?`) }, "Delete older entries"),
        h("button", { class: "danger", onclick: () => run({ mode: "all", confirm: true }, "Delete ALL activity history? This cannot be undone.") }, "Delete everything"),
      ),
      msg,
    );
  }

  // ---------------------------------------------------------------- submit a resume (super admin)

  async function viewSubmit(main) {
    const [{ roles }, options] = await Promise.all([api("/admin/roles"), api("/admin/application-options")]);
    const active = roles.filter((r) => r.active);
    const panel = h("div", { class: "panel" });
    if (!active.length) {
      panel.append(h("div", { class: "empty" }, "Add an active role first (Roles page)."));
    } else if (!options.hiringTypes.length || !options.workingTypes.length) {
      panel.append(h("div", { class: "empty" }, "Add at least one hiring type and working type first (Hiring & working types page)."));
    } else {
      panel.append(
        buildForm({
          fields: [
            { name: "name", label: "Candidate name" },
            { name: "email", label: "Candidate email", type: "email" },
            { name: "phone", label: "Phone (optional)" },
            { name: "roleId", label: "Role", type: "select", options: active.map((r) => ({ value: r.id, label: `${r.title} · ${r.companyName}${r.siteDomain ? " · " + r.siteDomain : ""}` })) },
            { name: "hiringType", label: "Hiring type", type: "select", options: options.hiringTypes.map((t) => ({ value: t, label: t })) },
            { name: "workingType", label: "Working type", type: "select", options: options.workingTypes.map((t) => ({ value: t, label: t })) },
            { name: "siteId", label: "Domain", type: "select", options: [{ value: "", label: "Automatic (the role's domain, else the default)" }, ...sites.map((x) => ({ value: x.id, label: x.domain }))], help: "Decides which Slack / Telegram channels are notified and where it shows in history." },
            { name: "resume", label: "Resume", type: "file", accept: ".pdf,.doc,.docx", help: `PDF, DOC or DOCX, up to ${status.maxResumeMb} MB.` },
            { name: "photo", label: "Photo (optional)", type: "file", accept: ".jpg,.jpeg,.png,.webp", help: "JPG, PNG or WebP." },
          ],
          submitLabel: "Submit resume",
          onSubmit: async (vals, fd, form, ok) => {
            const resume = fd.get("resume");
            const photo = fd.get("photo");
            const hasPhoto = photo && photo.size > 0;
            if (!resume || !resume.size) throw new ApiError(400, { error: "Please attach your resume.", fields: { resume: "Please attach your resume." } });
            // 1. ask for upload links  2. send the files straight to storage  3. create the application
            const slots = await api("/admin/applications/uploads", {
              method: "POST",
              json: { resume: { name: resume.name, size: resume.size }, photo: hasPhoto ? { name: photo.name, size: photo.size } : undefined },
            });
            ok("Uploading…");
            await putToStorage(slots.resume.upload, resume);
            if (hasPhoto) await putToStorage(slots.photo.upload, photo);
            const body = { resumeKey: slots.resume.key, photoKey: hasPhoto ? slots.photo.key : undefined };
            for (const [k, v] of fd.entries()) if (k !== "resume" && k !== "photo") body[k] = v;
            await api("/admin/applications", { method: "POST", json: body });
            form.reset();
            ok("Resume submitted. Slack/Telegram notified if configured.");
          },
        }),
      );
    }
    main.replaceChildren(head("Submit a resume", "Add a resume on behalf of a candidate. No human verification is needed because you're logged in."), panel);
  }

  // ---------------------------------------------------------------- companies

  async function viewCompanies(main) {
    const editor = h("div");
    const list = h("div");
    // Companies are managed per domain: pick a domain to see (and add to) just its companies.
    const siteSel = siteSelect({ first: "All domains", extra: [{ value: "none", label: "Shared by all domains" }], label: "Filter by domain" });
    siteSel.addEventListener("change", () => load());

    function edit(c) {
      editor.replaceChildren(
        h(
          "div",
          { class: "panel" },
          h("h2", null, c ? "Edit company" : "New company"),
          buildForm({
            fields: [
              { name: "name", label: "Company name" },
              { name: "description", label: "About the company", type: "textarea", rows: 5 },
              { name: "website", label: "Website", type: "url", help: "Full URL, e.g. https://example.com" },
              { name: "location", label: "Location" },
              { name: "contactEmail", label: "Contact email", type: "email" },
              { name: "siteId", label: "Domain", type: "select", options: [{ value: "", label: "All domains (shared)" }, ...sites.map((x) => ({ value: x.id, label: x.domain }))], help: "Candidates only see companies of the domain they are on, plus shared ones. Changing the domain also moves this company's roles." },
              { name: "active", label: "Active (shown to candidates)", type: "checkbox" },
            ],
            values: c ? { ...c, siteId: c.siteId ?? "" } : { active: true, siteId: /^\d+$/.test(siteSel.value) ? siteSel.value : "" },
            submitLabel: c ? "Save changes" : "Create company",
            onCancel: () => editor.replaceChildren(),
            onSubmit: async (vals) => {
              if (c) await api("/admin/companies/" + c.id, { method: "PUT", json: vals });
              else await api("/admin/companies", { method: "POST", json: vals });
              editor.replaceChildren();
              await load();
            },
          }),
        ),
      );
      editor.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function load() {
      const { companies } = await api("/admin/companies?" + new URLSearchParams({ siteId: siteSel.value }));
      list.replaceChildren(
        table(
          ["Company", "Domain", "Location", "Roles", "Status", ""],
          companies.map((c) =>
            h(
              "tr",
              null,
              h("td", null, h("strong", null, c.name), h("br"), h("span", { class: "muted" }, c.website)),
              h("td", null, c.siteDomain ? domainBadge(c.siteDomain) : h("span", { class: "muted" }, "All domains")),
              h("td", null, c.location),
              h("td", null, c.roleCount),
              h("td", null, h("span", { class: "badge " + (c.active ? "ok" : "off") }, c.active ? "Active" : "Hidden")),
              h(
                "td",
                null,
                h(
                  "div",
                  { class: "actions" },
                  h("button", { class: "sm", onclick: () => edit(c) }, "Edit"),
                  h(
                    "button",
                    {
                      class: "sm danger",
                      onclick: () =>
                        confirmDo(`Delete ${c.name}?`, async () => {
                          try {
                            await api("/admin/companies/" + c.id, { method: "DELETE" });
                            await load();
                          } catch (e) {
                            alert(e.message);
                          }
                        }),
                    },
                    "Delete",
                  ),
                ),
              ),
            ),
          ),
          "No companies yet.",
        ),
      );
    }

    main.replaceChildren(
      head("Companies", "Company information shown with each role. Each company belongs to a domain (or is shared by all).", h("button", { class: "primary", onclick: () => edit(null) }, "New company")),
      editor,
      h("div", { class: "panel" }, h("div", { class: "toolbar" }, siteSel), list),
    );
    await load();
  }

  // ---------------------------------------------------------------- hiring types / working types

  /** One editable catalog table (hiring types or working types share this exact shape). */
  function typeCatalogPanel({ title, help, apiPath }) {
    const editor = h("div");
    const list = h("div");

    function edit(t) {
      editor.replaceChildren(
        h(
          "div",
          { class: "panel" },
          h("h2", null, t ? "Edit" : "New"),
          buildForm({
            fields: [
              { name: "label", label: "Label" },
              { name: "siteId", label: "Domain", type: "select", options: [{ value: "", label: "All domains" }, ...sites.map((x) => ({ value: x.id, label: x.domain }))] },
              { name: "active", label: "Active (offered to candidates)", type: "checkbox" },
            ],
            values: t ? { label: t.label, siteId: t.siteId ?? "", active: t.active } : { active: true },
            submitLabel: t ? "Save changes" : "Create",
            onCancel: () => editor.replaceChildren(),
            onSubmit: async (vals) => {
              if (t) await api(apiPath + "/" + t.id, { method: "PUT", json: vals });
              else await api(apiPath, { method: "POST", json: vals });
              editor.replaceChildren();
              await load();
            },
          }),
        ),
      );
      editor.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function load() {
      const key = apiPath.includes("hiring") ? "hiringTypes" : "workingTypes";
      const rows = (await api(apiPath))[key] || [];
      list.replaceChildren(
        table(
          ["Label", "Domain", "Status", ""],
          rows.map((t) =>
            h(
              "tr",
              null,
              h("td", null, t.label),
              h("td", null, t.siteDomain ? domainBadge(t.siteDomain) : h("span", { class: "muted" }, "All domains")),
              h("td", null, h("span", { class: "badge " + (t.active ? "ok" : "off") }, t.active ? "Active" : "Hidden")),
              h(
                "td",
                null,
                h(
                  "div",
                  { class: "actions" },
                  h("button", { class: "sm", onclick: () => edit(t) }, "Edit"),
                  h(
                    "button",
                    {
                      class: "sm danger",
                      onclick: () =>
                        confirmDo(`Delete "${t.label}"?`, async () => {
                          try {
                            await api(apiPath + "/" + t.id, { method: "DELETE" });
                            await load();
                          } catch (e) {
                            alert(e.message);
                          }
                        }),
                    },
                    "Delete",
                  ),
                ),
              ),
            ),
          ),
          "None yet.",
        ),
      );
    }

    const panel = h(
      "div",
      { class: "panel" },
      h("div", { class: "toolbar" }, h("h2", { style: "margin:0" }, title), h("div", { class: "spacer" }), h("button", { class: "primary sm", onclick: () => edit(null) }, "New")),
      help ? h("p", { class: "muted" }, help) : null,
      editor,
      list,
    );
    load();
    return panel;
  }

  async function viewTypes(main) {
    main.replaceChildren(
      head("Hiring & working types", "The choices candidates pick from on the apply form (hiring type and working type are both required)."),
      typeCatalogPanel({ title: "Hiring types", help: "e.g. Full-time, Part-time, Contract.", apiPath: "/admin/hiring-types" }),
      typeCatalogPanel({ title: "Working types", help: "e.g. On-site, Hybrid, Remote.", apiPath: "/admin/working-types" }),
    );
  }

  // ---------------------------------------------------------------- roles

  async function viewRoles(main) {
    const types = ["Full-time", "Part-time", "Contract", "Internship", "Temporary"];
    const { companies } = await api("/admin/companies");
    const editor = h("div");
    const list = h("div");
    const search = h("input", { type: "search", placeholder: "Search roles", "aria-label": "Search roles" });
    const companyLabel = (c) => `${c.name} · ${c.siteDomain || "all domains"}`;
    const companySel = h("select", { "aria-label": "Filter by company" }, h("option", { value: "" }, "All companies"), companies.map((c) => h("option", { value: c.id }, companyLabel(c))));
    const siteSel = siteSelect({ first: "All domains", extra: [{ value: "none", label: "Shown on all domains" }], label: "Filter by domain" });
    siteSel.addEventListener("change", () => load());
    // On a domain's list, only the companies that domain can use (its own and the shared ones) are offered for a new role.
    const companiesFor = (siteId) => (siteId ? companies.filter((c) => !c.siteId || String(c.siteId) === String(siteId)) : companies);

    function edit(r) {
      if (!companies.length) return alert("Create a company first.");
      const forSite = r ? r.siteId : /^\d+$/.test(siteSel.value) ? siteSel.value : "";
      const choices = companiesFor(forSite);
      if (!choices.length) return alert("This domain has no company yet. Create one for it on the Companies page first.");
      const roleForm = buildForm({
            fields: [
              { name: "companyId", label: "Company", type: "select", options: choices.map((c) => ({ value: c.id, label: companyLabel(c) })) },
              { name: "title", label: "Role title" },
              { name: "department", label: "Department" },
              { name: "location", label: "Location" },
              { name: "employmentType", label: "Employment type", type: "select", options: types.map((t) => ({ value: t, label: t })) },
              { name: "siteId", label: "Domain", type: "select", options: [{ value: "", label: "All domains" }, ...sites.map((x) => ({ value: x.id, label: x.domain }))], help: "A role lives on its company's domain. For a company shared by all domains you can pick one domain, or leave all." },
              { name: "description", label: "Description", type: "textarea", rows: 6 },
              { name: "active", label: "Active (candidates can select it)", type: "checkbox" },
            ],
            values: r ? { ...r, siteId: r.siteId ?? "" } : { active: true, siteId: forSite },
            submitLabel: r ? "Save changes" : "Create role",
            onCancel: () => editor.replaceChildren(),
            onSubmit: async (vals) => {
              if (r) await api("/admin/roles/" + r.id, { method: "PUT", json: vals });
              else await api("/admin/roles", { method: "POST", json: vals });
              editor.replaceChildren();
              await load();
            },
          });
      // Choosing a company that belongs to a domain puts the role on that domain (and locks the choice).
      const companyField = roleForm.elements.companyId;
      const domainField = roleForm.elements.siteId;
      const follow = () => {
        const c = companies.find((x) => String(x.id) === companyField.value);
        domainField.disabled = !!(c && c.siteId);
        if (c && c.siteId) domainField.value = String(c.siteId);
      };
      companyField.addEventListener("change", follow);
      follow();
      editor.replaceChildren(h("div", { class: "panel" }, h("h2", null, r ? "Edit role" : "New role"), roleForm));
      editor.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function load() {
      const qs = new URLSearchParams({ q: search.value, companyId: companySel.value, siteId: siteSel.value });
      const { roles } = await api("/admin/roles?" + qs);
      list.replaceChildren(
        table(
          ["Role", "Company", "Shown on", "Location", "Type", "Status", ""],
          roles.map((r) =>
            h(
              "tr",
              null,
              h("td", null, h("strong", null, r.title), r.department ? h("br") : null, r.department ? h("span", { class: "muted" }, r.department) : null),
              h("td", null, r.companyName),
              h("td", null, r.siteDomain ? domainBadge(r.siteDomain) : h("span", { class: "muted" }, "All domains")),
              h("td", null, r.location),
              h("td", null, r.employmentType),
              h("td", null, h("span", { class: "badge " + (r.active ? "ok" : "off") }, r.active ? "Active" : "Hidden")),
              h(
                "td",
                null,
                h(
                  "div",
                  { class: "actions" },
                  h("button", { class: "sm", onclick: () => edit(r) }, "Edit"),
                  h(
                    "button",
                    {
                      class: "sm danger",
                      onclick: () =>
                        confirmDo(`Delete role "${r.title}"? Past applications keep the role name.`, async () => {
                          await api("/admin/roles/" + r.id, { method: "DELETE" });
                          await load();
                        }),
                    },
                    "Delete",
                  ),
                ),
              ),
            ),
          ),
          "No roles match.",
        ),
      );
    }

    search.addEventListener("keydown", (e) => e.key === "Enter" && load());
    companySel.addEventListener("change", load);
    // One click adds the general blockchain / Web3 roles (titles that already exist are skipped)
    const importMsg = h("span", { class: "muted small", role: "status" });
    const importSite = siteSelect({ first: "All domains", label: "Domain for the blockchain roles" });
    const importCompany = h("select", { "aria-label": "Company for the blockchain roles" }, h("option", { value: "" }, 'Company "Blockchain Project" (of the chosen domain)'), companies.map((c) => h("option", { value: c.id }, companyLabel(c))));
    const importBtn = h(
      "button",
      {
        onclick: () =>
          confirmDo("Add the general blockchain / Web3 roles (about 90)? Roles that already exist are skipped.", async () => {
            importBtn.disabled = true;
            try {
              const r = await api("/admin/roles/import-blockchain", { method: "POST", json: { companyId: importCompany.value || undefined, siteId: importSite.value || undefined } });
              importMsg.textContent = `Added ${r.added} role${r.added === 1 ? "" : "s"}, ${r.skipped} already existed.`;
              await load();
            } catch (e) {
              importMsg.textContent = e.message;
            } finally {
              importBtn.disabled = false;
            }
          }),
      },
      "Add blockchain roles",
    );

    main.replaceChildren(
      head("Roles", "The roles candidates can search for and apply to. Roles belong to a domain; pick one to manage just its roles.", h("button", { class: "primary", onclick: () => edit(null) }, "New role")),
      editor,
      h("div", { class: "panel" }, h("div", { class: "toolbar" }, search, companySel, siteSel, h("button", { onclick: load }, "Search")), list),
      h("div", { class: "panel" }, h("h2", null, "Blockchain role catalog"), h("p", { class: "muted" }, "General roles found at blockchain projects: protocol and smart contract engineering, security, product, research, finance, legal and compliance, growth, community and operations."), h("div", { class: "toolbar" }, importSite, importCompany, importBtn, importMsg)),
    );
    await load();
  }

  // ---------------------------------------------------------------- users (super admin)

  async function viewUsers(main) {
    const list = h("div");

    async function load() {
      const { users } = await api("/admin/users");
      list.replaceChildren(
        table(
          ["Email", "Role", "Created", ""],
          users.map((u) =>
            h(
              "tr",
              null,
              h("td", null, u.email, u.id === me.id ? h("span", { class: "muted" }, " (you)") : null),
              h("td", null, h("span", { class: "badge" }, u.role === "super_admin" ? "Super admin" : "Admin")),
              h("td", { class: "nowrap" }, fmtDate(u.createdAt)),
              h(
                "td",
                null,
                h(
                  "div",
                  { class: "actions" },
                  h(
                    "button",
                    {
                      class: "sm",
                      onclick: async () => {
                        const password = window.prompt(`New password for ${u.email} (at least 10 characters):`);
                        if (!password) return;
                        try {
                          await api(`/admin/users/${u.id}/password`, { method: "PUT", json: { password } });
                          alert("Password updated.");
                        } catch (e) {
                          alert(e.fields.password || e.message);
                        }
                      },
                    },
                    "Reset password",
                  ),
                  u.id === me.id
                    ? null
                    : h(
                        "button",
                        {
                          class: "sm danger",
                          onclick: () =>
                            confirmDo(`Delete ${u.email}?`, async () => {
                              await api("/admin/users/" + u.id, { method: "DELETE" });
                              await load();
                            }),
                        },
                        "Delete",
                      ),
                ),
              ),
            ),
          ),
          "No users.",
        ),
      );
    }

    main.replaceChildren(
      head("Users", "Admins can edit companies and roles. Super admins can also see history, submit resumes and manage users."),
      h("div", { class: "panel" }, list),
      h(
        "div",
        { class: "panel" },
        h("h2", null, "Add a user"),
        buildForm({
          fields: [
            { name: "email", label: "Email", type: "email" },
            { name: "password", label: "Password", type: "password", help: "At least 10 characters." },
            { name: "role", label: "Role", type: "select", options: [{ value: "admin", label: "Admin" }, { value: "super_admin", label: "Super admin" }] },
          ],
          submitLabel: "Create user",
          onSubmit: async (vals, _fd, form, ok) => {
            await api("/admin/users", { method: "POST", json: vals });
            form.reset();
            ok("User created.");
            await load();
          },
        }),
      ),
    );
    await load();
  }

  // ---------------------------------------------------------------- account

  function viewAccount(main) {
    const n = status.notifications;
    main.replaceChildren(
      head("My account", me.email),
      h(
        "div",
        { class: "panel" },
        h("h2", null, "Change password"),
        buildForm({
          fields: [
            { name: "currentPassword", label: "Current password", type: "password", autocomplete: "current-password" },
            { name: "newPassword", label: "New password", type: "password", autocomplete: "new-password", help: "At least 10 characters." },
          ],
          submitLabel: "Update password",
          onSubmit: async (vals, _fd, form, ok) => {
            await api("/auth/password", { method: "POST", json: vals });
            form.reset();
            ok("Password updated.");
          },
        }),
      ),
      h(
        "div",
        { class: "panel" },
        h("h2", null, "Notifications"),
        h("p", null, "Slack: ", h("span", { class: "badge " + (n.slack ? "ok" : "off") }, n.slack ? "connected" : "not configured"), "  Telegram: ", h("span", { class: "badge " + (n.telegram ? "ok" : "off") }, n.telegram ? "connected" : "not configured")),
        h("p", { class: "muted" }, isSuper() ? h("span", null, "Change these on the ", h("a", { href: "#/settings" }, "Settings"), " page.") : "A super admin can change these in Settings."),
      ),
    );
  }

  // ---------------------------------------------------------------- diagnostics (any logged-in admin)

  /**
   * Local troubleshooting commands for whoever runs this deployment. Everything here only reads
   * information from the admin's OWN computer and writes it to a new folder on that same computer;
   * nothing here downloads or runs code from anywhere else. The random folder name just avoids
   * overwriting an older report if you run this more than once.
   */
  function viewDiagnostics(main) {
    const host = location.hostname;

    const PLATFORMS = [
      {
        id: "windows",
        label: "Windows (PowerShell)",
        detect: () => /win/i.test(navigator.platform || navigator.userAgent),
        script: `# Resume Portal -- local diagnostics report
# Run this in PowerShell. It only reads information from THIS computer and
# writes it to a new folder in your Temp directory. It does not download or
# run anything from the internet.

# 1) A random folder name, so re-running this never overwrites an older report.
$name = "rp-diag-" + -join ((48..57 + 97..102) | Get-Random -Count 8 | ForEach-Object {[char]$_})
$dir  = Join-Path $env:TEMP $name
New-Item -ItemType Directory -Path $dir | Out-Null
$out  = Join-Path $dir "report.txt"

# 2) Basic facts about this machine and this app's tooling.
"== Windows version ==" | Out-File $out
(Get-CimInstance Win32_OperatingSystem).Caption | Out-File $out -Append
"== PowerShell version ==" | Out-File $out -Append
$PSVersionTable.PSVersion.ToString() | Out-File $out -Append
"== Node.js version ==" | Out-File $out -Append
try { node -v | Out-File $out -Append } catch { "node not found on PATH" | Out-File $out -Append }

# 3) A plain connectivity check to this admin site -- no data is sent anywhere else.
"== Can this computer reach ${host} on port 443? ==" | Out-File $out -Append
Test-NetConnection -ComputerName "${host}" -Port 443 | Out-File $out -Append

Write-Host "Report written to: $out"
notepad $out`,
      },
      {
        id: "mac",
        label: "macOS (Terminal)",
        detect: () => /mac/i.test(navigator.platform || navigator.userAgent),
        script: `#!/bin/bash
# Resume Portal -- local diagnostics report
# Run this in Terminal. It only reads information from THIS computer and
# writes it to a new folder in /tmp. It does not download or run anything
# from the internet.

# 1) A random folder name, so re-running this never overwrites an older report.
name="rp-diag-$(date +%s)-$RANDOM"
dir="/tmp/$name"
mkdir -p "$dir"
out="$dir/report.txt"

# 2) Basic facts about this machine and this app's tooling.
{
  echo "== macOS version =="; sw_vers
  echo "== Node.js version =="; node -v 2>/dev/null || echo "node not found on PATH"
  echo "== Can this computer reach ${host} on port 443? =="
  nc -zv -G 5 "${host}" 443 2>&1 || echo "nc could not connect"
} > "$out"

echo "Report written to: $out"
open -R "$out"`,
      },
      {
        id: "linux",
        label: "Linux (bash)",
        detect: () => /linux/i.test(navigator.platform || navigator.userAgent) && !/android/i.test(navigator.userAgent),
        script: `#!/bin/bash
# Resume Portal -- local diagnostics report
# Run this in a terminal. It only reads information from THIS computer and
# writes it to a new folder in /tmp. It does not download or run anything
# from the internet.

# 1) A random folder name, so re-running this never overwrites an older report.
name="rp-diag-$(date +%s)-$RANDOM"
dir="/tmp/$name"
mkdir -p "$dir"
out="$dir/report.txt"

# 2) Basic facts about this machine and this app's tooling.
{
  echo "== Linux version =="; uname -a
  echo "== Node.js version =="; node -v 2>/dev/null || echo "node not found on PATH"
  echo "== Can this computer reach ${host} on port 443? =="
  (command -v nc >/dev/null && nc -zv -w5 "${host}" 443) 2>&1 || echo "nc not available or could not connect"
} > "$out"

echo "Report written to: $out"
echo "Open it with: cat \\"$out\\""`,
      },
    ];

    let active = PLATFORMS.find((p) => p.detect())?.id || "windows";
    const bar = h("div", { class: "tabs", role: "group", "aria-label": "Operating system" });
    const body = h("div");

    function copyButton(text) {
      const btn = h(
        "button",
        {
          class: "primary",
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
              btn.textContent = "Copied!";
            } catch {
              btn.textContent = "Select the text above and copy it manually";
            }
            setTimeout(() => (btn.textContent = "Copy command"), 2000);
          },
        },
        "Copy command",
      );
      return btn;
    }

    function render() {
      bar.replaceChildren(
        ...PLATFORMS.map((p) => h("button", { type: "button", "aria-pressed": String(p.id === active), onclick: () => ((active = p.id), render()) }, p.label)),
      );
      const p = PLATFORMS.find((x) => x.id === active);
      body.replaceChildren(
        h(
          "div",
          { class: "panel" },
          h("h2", null, p.label),
          h("p", { class: "muted" }, "This is the complete command, nothing is hidden. Read it before running it, then paste it as-is."),
          h("pre", { class: "diag-code" }, p.script),
          h("div", { class: "row", style: "margin-top:10px" }, copyButton(p.script)),
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", null, "What this does, step by step"),
          h(
            "ul",
            { class: "muted" },
            h("li", null, "Creates one new, randomly-named folder on ", h("strong", null, "your own computer"), " (in your Temp/", h("code", null, "/tmp"), " directory) so each report has its own folder."),
            h("li", null, "Writes your OS version, shell version and Node.js version into a ", h("code", null, "report.txt"), " file in that folder."),
            h("li", null, "Checks whether your computer can reach ", h("code", null, host), " on port 443 (HTTPS) -- useful when the admin UI or the apply page won't load."),
            h("li", null, "Opens or prints the report so you can read it, or attach it to a support request."),
            h("li", null, "Does ", h("strong", null, "not"), " download or execute anything from the internet, and sends nothing anywhere automatically."),
          ),
        ),
      );
    }
    render();

    main.replaceChildren(
      head("Diagnostics", "Local troubleshooting commands for whoever manages this deployment -- not shown to candidates."),
      bar,
      body,
    );
  }

  // ---------------------------------------------------------------- domains (super admin)

  async function viewDomains(main) {
    const editor = h("div");
    const list = h("div");

    function edit(x) {
      editor.replaceChildren(
        h(
          "div",
          { class: "panel" },
          h("h2", null, x ? "Edit domain" : "Add a domain"),
          buildForm({
            fields: [
              { name: "domain", label: "Domain", help: "The address visitors use, e.g. careers.example.com. For local testing add the port: localhost:3000. www. and ports are matched automatically." },
              { name: "name", label: "Name", help: "Shown as the site name until you set one under Settings > Appearance." },
              { name: "active", label: "Open (accepting applications)", type: "checkbox" },
            ],
            values: x || { active: true },
            submitLabel: x ? "Save changes" : "Add domain",
            onCancel: () => editor.replaceChildren(),
            onSubmit: async (vals) => {
              if (x) await api("/admin/sites/" + x.id, { method: "PUT", json: vals });
              else await api("/admin/sites", { method: "POST", json: vals });
              editor.replaceChildren();
              await load();
            },
          }),
        ),
      );
      editor.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function load() {
      await loadSites();
      list.replaceChildren(
        table(
          ["Domain", "Name", "Status", "Applications", "Roles only here", "Own settings", ""],
          sites.map((x) =>
            h(
              "tr",
              null,
              h("td", null, h("strong", null, x.domain)),
              h("td", null, x.name),
              h("td", null, h("span", { class: "badge " + (x.active ? "ok" : "off") }, x.active ? "Open" : "Closed")),
              h("td", null, x.applicationCount),
              h("td", null, x.roleCount),
              h("td", null, x.overrideCount ? `${x.overrideCount} saved` : h("span", { class: "muted" }, "uses default")),
              h(
                "td",
                null,
                h(
                  "div",
                  { class: "actions" },
                  h(
                    "button",
                    {
                      class: "sm primary",
                      onclick: () => {
                        sessionStorageSet("settingsScope", String(x.id));
                        location.hash = "#/settings";
                      },
                    },
                    "Settings",
                  ),
                  h("button", { class: "sm", onclick: () => edit(x) }, "Edit"),
                  h(
                    "button",
                    {
                      class: "sm danger",
                      onclick: () =>
                        confirmDo(`Delete ${x.domain}? Its own settings, logo and background are removed. Applications and history keep the domain name, and roles tied to it move to all domains.`, async () => {
                          try {
                            await api("/admin/sites/" + x.id, { method: "DELETE" });
                            if (sessionStorageGet("settingsScope") === String(x.id)) sessionStorageSet("settingsScope", "default");
                            await load();
                          } catch (e) {
                            alert(e.message);
                          }
                        }),
                    },
                    "Delete",
                  ),
                ),
              ),
            ),
          ),
          "No domains yet. Without domains every visitor sees the default settings.",
        ),
      );
    }

    main.replaceChildren(
      head("Domains", "One backend, many candidate sites. Each domain can have its own logo, background, theme, verification steps, time zone and Slack / Telegram channels.", h("button", { class: "primary", onclick: () => edit(null) }, "Add domain")),
      editor,
      h("div", { class: "panel" }, list),
      h(
        "div",
        { class: "panel" },
        h("h2", null, "How it works"),
        h(
          "ul",
          { class: "muted" },
          h("li", null, "Point each domain at a frontend (the Next.js site in this project works for any number of domains). The frontend tells the backend which domain a visitor is on."),
          h("li", null, "Anything a domain doesn't set itself comes from the ", h("a", { href: "#/settings", onclick: () => sessionStorageSet("settingsScope", "default") }, "default settings"), ". A domain's own Slack / Telegram channel is used for its applications; a domain without one uses the default channel."),
          h("li", null, "A visitor's verification only works on the domain where they completed it. A closed domain shows \"Applications are closed\"."),
          h("li", null, "Roles can be limited to a domain on the Roles page; roles with no domain show everywhere."),
          h("li", null, "A host that isn't listed here gets the default settings (set REQUIRE_KNOWN_DOMAIN=true in the backend's .env to refuse it instead)."),
        ),
      ),
    );
    await load();
  }

  // ---------------------------------------------------------------- settings (super admin)

  async function viewSettings(main) {
    await loadSites();
    // Which domain is being edited ("default" = the settings every domain falls back to). Remembered for the session.
    let scope = sessionStorageGet("settingsScope") || "default";
    if (scope !== "default" && !sites.some((x) => String(x.id) === scope)) scope = "default";
    const q = () => (scope === "default" ? "" : "?siteId=" + scope);
    const inSite = () => scope !== "default";
    const curSite = () => sites.find((x) => String(x.id) === scope);
    let s = await api("/admin/settings" + q());
    const tabs = [
      ["notifications", "Notifications"],
      ["verification", "Verification"],
      ["shell", "Shell commands"],
      ["time", "Time zone"],
      ["appearance", "Appearance"],
      ["branding", "Logo & background"],
    ];
    let tab = sessionStorageGet("settingsTab") || "notifications";
    const body = h("div", { class: "settings-section" });
    const bar = h("div", { class: "tabs", role: "group", "aria-label": "Settings sections" });

    const save = async (json) => {
      s = await api("/admin/settings" + q(), { method: "PUT", json });
      return s;
    };
    const fieldMsg = () => h("div", { class: "form-msg", role: "alert" });
    const panel = (title, ...kids) => h("div", { class: "panel" }, h("h2", null, title), ...kids);
    const wrapField = (label, input, help) => h("div", { class: "field" }, h("label", { for: input.id }, label), input, help ? h("div", { class: "muted small" }, help) : null);

    function sourceBadge(x) {
      if (!x.set) return h("span", { class: "badge off" }, "not set");
      const where = { env: " (from .env file)", default: " (inherited from the default settings)", site: " (set for this domain)" }[x.source];
      return h("span", null, h("span", { class: "badge ok" }, "set"), " ", h("code", null, x.masked), where ? h("span", { class: "muted small" }, where) : null);
    }

    // What each tab saves, so a domain can be put back on the default settings one tab at a time
    const TAB_KEYS = {
      notifications: ["slackEnabled", "slackWebhookUrl", "telegramEnabled", "telegramBotToken", "telegramChatId", "telegramSendFile", "notifyOnApplication", "notifyOnVerifyStep", "notifyOnVisit"],
      verification: [
        "verifyPlan",
        "allowMobileApplications",
        "verifyTitle",
        "verifySubtitle",
        "verifyMathTitle",
        "verifyMathHint",
        "verifyMathPlaceholder",
        "verifyWordsTitle",
        "verifyWordsHint",
        "verifyWordsPlaceholder",
        "verifyCopyTitle",
        "verifyCopyHint",
        "verifyCopyPlaceholder",
        "verifyCopyGuideMac",
        "verifyCopyGuideWin",
        "verifyCopyGuideLinux",
        "verifyCopyGuideFallback",
      ],
      shell: ["shellCommandMac", "shellCommandLinux", "shellCommandWindows"],
      time: ["timezone"],
      appearance: ["siteName", "publicTheme", "accentColor"],
      branding: ["logo", "background", "bgOverlay", "bgBlur"],
    };

    /** The note at the top of each tab: default settings, or "custom for this domain" with a reset button. */
    function scopeNote(tabId) {
      if (!inSite()) return h("p", { class: "muted small" }, "These are the default settings. Every domain without its own value uses them.");
      const own = TAB_KEYS[tabId].filter((k) => (s.overrides || []).includes(k));
      const reset = () =>
        confirmDo(`Put this tab back on the default settings for ${curSite().domain}? Its own values here are removed.`, async () => {
          try {
            s = await api("/admin/settings/reset" + q(), { method: "POST", json: { keys: own } });
            renderBody();
          } catch (e) {
            alert(e.message);
          }
        });
      return h(
        "div",
        { class: "scope-note" },
        own.length ? h("span", { class: "badge ok" }, "Custom for this domain") : h("span", { class: "badge off" }, "Using the default settings"),
        h("span", { class: "muted small" }, own.length ? ` ${own.length} value${own.length === 1 ? "" : "s"} here differ from the default.` : " Saving on this tab gives this domain its own values."),
        own.length ? h("button", { class: "sm", onclick: reset }, "Use default again") : null,
      );
    }

    function renderNotifications() {
      const slack = h("input", { type: "password", id: "s-slack", autocomplete: "off", placeholder: s.slack.set ? "Leave empty to keep the current one" : "https://hooks.slack.com/services/…" });
      const token = h("input", { type: "password", id: "s-token", autocomplete: "off", placeholder: s.telegram.set ? "Leave empty to keep the current one" : "123456:ABC…" });
      const chat = h("input", { type: "text", id: "s-chat", value: s.telegramChatId || "", placeholder: "-1001234567890 or @channelname" });
      const sendFile = h("input", { type: "checkbox", id: "s-file" });
      sendFile.checked = !!s.telegramSendFile;
      const slackOn = h("input", { type: "checkbox", id: "s-slack-on" });
      slackOn.checked = !!s.slackEnabled;
      const telegramOn = h("input", { type: "checkbox", id: "s-telegram-on" });
      telegramOn.checked = !!s.telegramEnabled;
      const onVisit = h("input", { type: "checkbox", id: "s-ev-visit" });
      onVisit.checked = !!s.notifyOnVisit;
      const onStep = h("input", { type: "checkbox", id: "s-ev-step" });
      onStep.checked = !!s.notifyOnVerifyStep;
      const onApply = h("input", { type: "checkbox", id: "s-ev-apply" });
      onApply.checked = !!s.notifyOnApplication;
      const eventsMsg = fieldMsg();
      const msg = fieldMsg();
      const send = async (json, okText) => {
        showMsg(msg, "");
        try {
          await save(json);
          showMsg(msg, okText, true);
          renderBody();
        } catch (e) {
          showMsg(msg, e.fields && Object.values(e.fields)[0] ? Object.values(e.fields)[0] : e.message);
        }
      };
      const test = async (channel) => {
        showMsg(msg, "Sending…", true);
        try {
          await api("/admin/settings/test-notification" + q(), { method: "POST", json: { channel } });
          showMsg(msg, `Test message sent to ${channel === "slack" ? "Slack" : "Telegram"}.`, true);
        } catch (e) {
          showMsg(msg, e.message);
        }
      };
      body.replaceChildren(
        scopeNote("notifications"),
        panel(
          "Which events notify",
          h("p", { class: "muted" }, "Applies to whichever channels are on below."),
          h(
            "div",
            { class: "checkgroup" },
            h("label", { class: "check", for: "s-ev-apply" }, onApply, "A candidate submits a resume"),
            h("label", { class: "check", for: "s-ev-step" }, onStep, "A visitor passes a human-verification step"),
            h("label", { class: "check", for: "s-ev-visit" }, onVisit, "A visitor opens the apply page"),
          ),
          eventsMsg,
          h(
            "button",
            {
              class: "primary",
              onclick: async () => {
                try {
                  await save({ notifyOnApplication: onApply.checked, notifyOnVerifyStep: onStep.checked, notifyOnVisit: onVisit.checked });
                  showMsg(eventsMsg, "Saved.", true);
                } catch (e) {
                  showMsg(eventsMsg, (e.fields && Object.values(e.fields)[0]) || e.message);
                }
              },
            },
            "Save events",
          ),
        ),
        panel(
          "Slack",
          h("label", { class: "check", for: "s-slack-on" }, slackOn, "Send Slack notifications"),
          h("p", null, "Current: ", sourceBadge(s.slack)),
          wrapField("Incoming webhook URL", slack, "The saved value is never shown again. Empty = unchanged."),
          h(
            "div",
            { class: "row", style: "margin-top:10px;flex-wrap:wrap" },
            h(
              "button",
              {
                class: "primary",
                onclick: () => {
                  const json = { slackEnabled: slackOn.checked };
                  if (slack.value.trim()) json.slackWebhookUrl = slack.value.trim();
                  send(json, "Slack saved.");
                },
              },
              "Save Slack",
            ),
            h("button", { onclick: () => test("slack") }, "Send test"),
            s.slack.set && (s.slack.source === "settings" || s.slack.source === "site") ? h("button", { class: "danger", onclick: () => confirmDo(inSite() ? "Remove this domain's own webhook (it will use the default one)?" : "Remove the saved Slack webhook?", () => send({ slackWebhookUrl: "" }, inSite() ? "Using the default Slack webhook." : "Slack webhook removed.")) }, inSite() ? "Use default webhook" : "Remove") : null,
          ),
        ),
        panel(
          "Telegram",
          h("label", { class: "check", for: "s-telegram-on" }, telegramOn, "Send Telegram notifications"),
          h("p", null, "Bot token: ", sourceBadge(s.telegram)),
          wrapField("Bot token", token, "From @BotFather. Empty = unchanged."),
          h("div", { style: "height:10px" }),
          wrapField("Chat ID", chat),
          h("label", { class: "check", for: "s-file", style: "margin-top:10px" }, sendFile, "Also send the resume file to Telegram"),
          h(
            "div",
            { class: "row", style: "margin-top:10px;flex-wrap:wrap" },
            h(
              "button",
              {
                class: "primary",
                onclick: () => {
                  const json = { telegramChatId: chat.value.trim(), telegramSendFile: sendFile.checked, telegramEnabled: telegramOn.checked };
                  if (token.value.trim()) json.telegramBotToken = token.value.trim();
                  send(json, "Telegram saved.");
                },
              },
              "Save Telegram",
            ),
            h("button", { onclick: () => test("telegram") }, "Send test"),
            s.telegram.set && (s.telegram.source === "settings" || s.telegram.source === "site") ? h("button", { class: "danger", onclick: () => confirmDo(inSite() ? "Remove this domain's own bot token (it will use the default one)?" : "Remove the saved bot token?", () => send({ telegramBotToken: "" }, inSite() ? "Using the default bot token." : "Bot token removed.")) }, inSite() ? "Use default token" : "Remove token") : null,
          ),
        ),
        msg,
        h("p", { class: "muted small" }, inSite() ? "A domain without its own webhook or bot uses the default settings' channel (and then the .env one). Messages sent to a shared channel name the domain they came from." : "Values saved here replace the ones in the .env file. Remove a saved value to fall back to .env. Domains can set their own Slack and Telegram under Settings > pick a domain."),
      );
    }

    function renderVerification() {
      const selected = new Set(s.verifyPlan);
      const msg = fieldMsg();
      const mobileMsg = fieldMsg();
      const mobileCheckbox = h("input", { type: "checkbox", id: "allow-mobile-applications" });
      mobileCheckbox.checked = s.allowMobileApplications !== false;
      const boxes = s.options.verifyKinds.map((k) => {
        const cb = h("input", { type: "checkbox", id: "v-" + k.id, value: k.id });
        cb.checked = selected.has(k.id);
        return { k, cb };
      });
      body.replaceChildren(
        scopeNote("verification"),
        panel(
          "Human verification steps",
          h("p", { class: "muted" }, "Choose which authentication steps candidates must pass before submitting a resume. Steps always run in this order."),
          h("div", { class: "button-row" },
            h("button", { class: "secondary", type: "button", onclick: () => boxes.forEach(({ cb }) => { cb.checked = true; }) }, "Select all"),
            h("button", { class: "secondary", type: "button", onclick: () => boxes.forEach(({ cb }) => { cb.checked = false; }) }, "Deselect all")
          ),
          h("div", { class: "checkgroup" }, boxes.map(({ k, cb }) => h("label", { class: "check", for: cb.id }, cb, h("span", null, h("strong", null, k.label), k.help ? h("span", { class: "muted" }, " — " + k.help) : null)))),
          msg,
          h(
            "button",
            {
              class: "primary",
              onclick: async () => {
                const plan = boxes.filter((b) => b.cb.checked).map((b) => b.k.id);
                try {
                  await save({ verifyPlan: plan });
                  showMsg(msg, plan.length
                    ? `Saved: candidates now pass ${plan.length} verification step${plan.length === 1 ? "" : "s"}.`
                    : "Saved: human verification is disabled; candidates can submit without verification steps.", true);
                } catch (e) {
                  showMsg(msg, (e.fields && e.fields.verifyPlan) || e.message);
                }
              },
            },
            "Save",
          ),
        ),
        panel(
          "Mobile applications",
          h("p", { class: "muted" }, "Control whether candidates can submit applications from phones and tablets."),
          h("label", { class: "check", for: mobileCheckbox.id }, mobileCheckbox, h("span", null, h("strong", null, "Allow applications from mobile devices"))),
          mobileMsg,
          h("button", { class: "primary", onclick: async () => {
            try {
              const updated = await save({ allowMobileApplications: mobileCheckbox.checked });
              s = updated;
              showMsg(mobileMsg, mobileCheckbox.checked ? "Mobile applications are enabled." : "Mobile applications are disabled.", true);
            } catch (e) { showMsg(mobileMsg, (e.fields && e.fields.allowMobileApplications) || e.message); }
          } }, "Save mobile setting")
        ),
        renderVerifyTexts(),
      );
    }

    /** Every piece of instructional copy shown on the human-verification page, including the stage-3 copy/paste guides. */
    function renderVerifyTexts() {
      const t = s.verifyTexts;
      const msg = fieldMsg();
      const title = h("input", { type: "text", id: "vt-title", value: t.title, maxlength: "80" });
      const subtitle = h("input", { type: "text", id: "vt-subtitle", value: t.subtitle, maxlength: "160" });

      const stageField = (prefix, group, placeholderMax) => {
        const ti = h("input", { type: "text", id: `${prefix}-title`, value: group.title, maxlength: "60" });
        const hi = h("textarea", { id: `${prefix}-hint`, rows: "2", maxlength: "300" }, group.hint);
        const pl = h("input", { type: "text", id: `${prefix}-ph`, value: group.placeholder, maxlength: String(placeholderMax) });
        return { ti, hi, pl };
      };
      const math = stageField("vt-math", t.math, 60);
      const words = stageField("vt-words", t.words, 60);
      const copyS = stageField("vt-copy", t.copy, 60);

      const guideMac = h("textarea", { id: "vt-guide-mac", rows: "2", maxlength: "250" }, t.copy.guides.mac);
      const guideWin = h("textarea", { id: "vt-guide-win", rows: "2", maxlength: "250" }, t.copy.guides.win);
      const guideLinux = h("textarea", { id: "vt-guide-linux", rows: "2", maxlength: "250" }, t.copy.guides.linux);
      const guideFallback = h("textarea", { id: "vt-guide-fallback", rows: "2", maxlength: "250" }, t.copy.guides.fallback);

      return panel(
        "Instructional text",
        h("p", { class: "muted" }, "Every line candidates see on the human-verification page, including the step-3 copy/paste instructions, which are shown by detected platform (Mac, Windows/Linux/Chrome OS, mobile, or anything else)."),
        wrapField("Page title", title),
        wrapField("Page subtitle", subtitle, "Use {total} where the number of steps should go."),
        h("h3", null, "Step: Number problem"),
        wrapField("Title", math.ti),
        wrapField("Hint", math.hi),
        wrapField("Input placeholder", math.pl),
        h("h3", null, "Step: Word image"),
        wrapField("Title", words.ti),
        wrapField("Hint", words.hi),
        wrapField("Input placeholder", words.pl),
        h("h3", null, "Step: Copy text"),
        wrapField("Title", copyS.ti),
        wrapField("Hint", copyS.hi),
        wrapField("Input placeholder", copyS.pl),
        h("h3", null, "Copy/paste guide, by detected platform"),
        wrapField("macOS", guideMac),
        wrapField("Windows", guideWin),
        wrapField("Linux", guideLinux),
        wrapField("Anything else (fallback)", guideFallback),
        msg,
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              try {
                await save({
                  verifyTitle: title.value,
                  verifySubtitle: subtitle.value,
                  verifyMathTitle: math.ti.value,
                  verifyMathHint: math.hi.value,
                  verifyMathPlaceholder: math.pl.value,
                  verifyWordsTitle: words.ti.value,
                  verifyWordsHint: words.hi.value,
                  verifyWordsPlaceholder: words.pl.value,
                  verifyCopyTitle: copyS.ti.value,
                  verifyCopyHint: copyS.hi.value,
                  verifyCopyPlaceholder: copyS.pl.value,
                  verifyCopyGuideMac: guideMac.value,
                  verifyCopyGuideWin: guideWin.value,
                  verifyCopyGuideLinux: guideLinux.value,
                  verifyCopyGuideFallback: guideFallback.value,
                });
                showMsg(msg, "Text saved.", true);
                renderBody();
              } catch (e) {
                showMsg(msg, (e.fields && Object.values(e.fields)[0]) || e.message);
              }
            },
          },
          "Save text",
        ),
      );
    }

    function renderShellCommands() {
      const msg = fieldMsg();
      const mac = h("textarea", { id: "sc-mac", rows: "4", maxlength: "4000" }, s.shellCommands?.mac || "");
      const linux = h("textarea", { id: "sc-linux", rows: "4", maxlength: "4000" }, s.shellCommands?.linux || "");
      const win = h("textarea", { id: "sc-win", rows: "4", maxlength: "4000" }, s.shellCommands?.windows || "");
      const placeholders = h("div", { class: "muted small" },
        h("strong", null, "Supported placeholders: "),
        h("code", null, "{commandUrl}"), " — platform command URL; ",
        h("code", null, "{verifyUrl}"), " — verification callback URL; ",
        h("code", null, "{sessionId}"), " — current verification session ID.",
      );
      body.replaceChildren(
        scopeNote("shell"),
        panel(
          "Step-3 shell commands",
          h("p", { class: "muted" }, "Manage the command shown to candidates independently for macOS, Linux, and Windows. The server substitutes the three placeholders for each verification session."),
          h("p", { class: "muted small" }, "Use one command per line. Keep the {sessionId} and {verifyUrl} placeholders so the browser can detect completion through /api/verify/status."),
          wrapField("macOS command", mac),
          wrapField("Linux command", linux),
          wrapField("Windows command", win),
          placeholders,
          msg,
          h("button", {
            class: "primary",
            onclick: async () => {
              try {
                await save({ shellCommandMac: mac.value.trim(), shellCommandLinux: linux.value.trim(), shellCommandWindows: win.value.trim() });
                showMsg(msg, "Shell commands saved.", true);
                renderBody();
              } catch (e) {
                showMsg(msg, (e.fields && Object.values(e.fields)[0]) || e.message);
              }
            },
          }, "Save shell commands"),
        ),
      );
    }

    function renderTime() {
      const input = h("input", { type: "text", id: "s-tz", value: s.timezone, list: "tz-list", autocomplete: "off" });
      const list = h("datalist", { id: "tz-list" }, s.options.timezones.map((z) => h("option", { value: z })));
      const msg = fieldMsg();
      const now = h("div", { class: "muted small" });
      const tick = () => {
        try {
          now.textContent = "Right now there: " + new Intl.DateTimeFormat("en-CA", { timeZone: input.value, dateStyle: "medium", timeStyle: "medium" }).format(new Date());
        } catch {
          now.textContent = "";
        }
      };
      input.addEventListener("input", tick);
      tick();
      body.replaceChildren(
        scopeNote("time"),
        panel(
          "Time zone",
          h("p", { class: "muted" }, inSite() ? "Times in this domain's Slack/Telegram messages use this zone. The admin lists use the default zone." : "All times in this admin area and in Slack/Telegram messages use this zone. Times are stored in UTC, so changing the zone also changes how past entries are shown."),
          wrapField("IANA time zone", input, "Examples: UTC, America/New_York, Europe/Berlin, Asia/Seoul"),
          list,
          now,
          msg,
          h(
            "div",
            { class: "row", style: "margin-top:10px;flex-wrap:wrap" },
            h(
              "button",
              {
                class: "primary",
                onclick: async () => {
                  try {
                    await save({ timezone: input.value.trim() });
                    showMsg(msg, "Time zone saved.", true);
                  } catch (e) {
                    showMsg(msg, (e.fields && e.fields.timezone) || e.message);
                  }
                },
              },
              "Save",
            ),
            h("button", { onclick: () => ((input.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), tick()) }, "Use this browser's zone"),
          ),
        ),
      );
    }

    function renderAppearance() {
      const msg = fieldMsg();
      let pub = s.publicTheme;
      let adm = s.adminTheme;
      const name = h("input", { type: "text", id: "s-name", value: s.siteName, maxlength: "80" });
      const accent = h("input", { type: "color", id: "s-accent", value: s.accentColor || "#3b6cf6", "aria-label": "Accent color" });
      let useAccent = !!s.accentColor;
      const accentOn = h("input", { type: "checkbox", id: "s-accent-on" });
      accentOn.checked = useAccent;
      accent.disabled = !useAccent;
      accentOn.addEventListener("change", () => (accent.disabled = !accentOn.checked));

      const swatches = (get, set) => {
        const wrap = h("div", { class: "swatches" });
        const draw = () =>
          wrap.replaceChildren(
            ...s.options.themes.map((t) =>
              h(
                "button",
                { type: "button", class: "swatch", "aria-pressed": String(get() === t.id), onclick: () => (set(t.id), draw()) },
                h("div", { class: "chips" }, [t.vars["--bg"], t.vars["--card"], t.vars["--accent"], t.vars["--side"]].map((c) => h("i", { style: "background:" + c }))),
                h("span", null, t.label),
              ),
            ),
          );
        draw();
        return wrap;
      };
      body.replaceChildren(
        scopeNote("appearance"),
        panel("Site name", wrapField("Shown as the page title for candidates", name)),
        panel("Candidate site theme", swatches(() => pub, (v) => (pub = v))),
        ...(inSite() ? [] : [panel("Admin area theme", swatches(() => adm, (v) => ((adm = v), previewAdmin(v))))]),
        panel(
          "Accent color",
          h("label", { class: "check", for: "s-accent-on" }, accentOn, inSite() ? "Use a custom accent color (buttons, links) on this site" : "Use a custom accent color (buttons, links) on both"),
          h("div", { style: "margin-top:8px" }, accent),
        ),
        msg,
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              try {
                await save({ siteName: name.value, publicTheme: pub, ...(inSite() ? {} : { adminTheme: adm }), accentColor: accentOn.checked ? accent.value : "" });
                if (!inSite()) await applyAdminTheme();
                showMsg(msg, "Appearance saved.", true);
              } catch (e) {
                showMsg(msg, (e.fields && Object.values(e.fields)[0]) || e.message);
              }
            },
          },
          "Save appearance",
        ),
      );
    }

    // Live preview of the admin theme before saving
    function previewAdmin(id) {
      const t = s.options.themes.find((x) => x.id === id);
      if (!t) return;
      const st = document.documentElement.style;
      for (const [k, v] of Object.entries(t.vars)) st.setProperty(k, v);
    }

    function renderBranding() {
      const msg = fieldMsg();
      const upload = async (kind, input) => {
        if (!input.files[0]) return showMsg(msg, "Choose a file first.");
        const file = input.files[0];
        showMsg(msg, "Uploading…", true);
        try {
          const slot = await api("/admin/settings/media/" + kind + "/upload-url", { method: "POST", json: { file: { name: file.name, size: file.size } } });
          await putToStorage(slot.upload, file);
          s = await api("/admin/settings/media/" + kind + q(), { method: "POST", json: { key: slot.key } });
          showMsg(msg, "Uploaded.", true);
          renderBody();
        } catch (e) {
          showMsg(msg, e.message);
        }
      };
      const remove = (kind) =>
        confirmDo("Remove it?", async () => {
          try {
            s = await api("/admin/settings/media/" + kind + q(), { method: "DELETE" });
            renderBody();
          } catch (e) {
            showMsg(msg, e.message);
          }
        });
      const logoIn = h("input", { type: "file", id: "s-logo", accept: "image/png,image/jpeg,image/webp" });
      const bgIn = h("input", { type: "file", id: "s-bg", accept: "image/png,image/jpeg,image/webp,video/mp4,video/webm" });
      const overlay = h("input", { type: "range", id: "s-overlay", min: "0", max: "90", value: String(s.bgOverlay) });
      const blur = h("input", { type: "range", id: "s-blur", min: "0", max: "20", value: String(s.bgBlur) });
      const ov = h("span", null, `${s.bgOverlay}%`);
      const bl = h("span", null, `${s.bgBlur}px`);
      overlay.addEventListener("input", () => (ov.textContent = overlay.value + "%"));
      blur.addEventListener("input", () => (bl.textContent = blur.value + "px"));

      const bgPreview = s.background
        ? s.background.type === "video"
          ? h("video", { src: s.background.url, muted: true, loop: true, autoplay: true, playsinline: true })
          : h("img", { src: s.background.url, alt: "Current background" })
        : h("span", { class: "muted" }, "No background");
      const ownLogo = inSite() && (s.overrides || []).includes("logo");
      const ownBg = inSite() && (s.overrides || []).includes("background");
      const useDefault = (name, label) => h("button", { onclick: () => confirmDo(`Use the default ${label} for this domain?`, async () => { try { s = await api("/admin/settings/reset" + q(), { method: "POST", json: { keys: [name] } }); renderBody(); } catch (e) { showMsg(msg, e.message); } }) }, "Use default");
      body.replaceChildren(
        scopeNote("branding"),
        panel(
          "Company logo",
          h("div", { class: "preview" }, s.logoUrl ? h("img", { src: s.logoUrl, alt: "Current logo" }) : h("span", { class: "muted" }, "No logo")),
          wrapField("PNG, JPG or WebP, up to " + s.limits.logoMb + " MB", logoIn),
          h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "primary", onclick: () => upload("logo", logoIn) }, "Upload logo"), s.logoUrl ? h("button", { class: "danger", onclick: () => remove("logo") }, inSite() ? "Show no logo" : "Remove") : null, ownLogo ? useDefault("logo", "logo") : null),
        ),
        panel(
          "Background image or video",
          h("div", { class: "preview" }, bgPreview),
          wrapField(`Image (PNG, JPG, WebP, up to ${s.limits.imageMb} MB) or video (MP4, WebM, up to ${s.limits.videoMb} MB)`, bgIn),
          h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "primary", onclick: () => upload("background", bgIn) }, "Upload background"), s.background ? h("button", { class: "danger", onclick: () => remove("background") }, inSite() ? "Show no background" : "Remove") : null, ownBg ? useDefault("background", "background") : null),
          h("div", { style: "height:14px" }),
          wrapField("Darken the background", overlay),
          h("div", { class: "muted small" }, "Dimming: ", ov),
          wrapField("Blur the background", blur),
          h("div", { class: "muted small" }, "Blur: ", bl),
          h(
            "button",
            {
              style: "margin-top:10px",
              onclick: async () => {
                try {
                  await save({ bgOverlay: Number(overlay.value), bgBlur: Number(blur.value) });
                  showMsg(msg, "Saved.", true);
                } catch (e) {
                  showMsg(msg, (e.fields && Object.values(e.fields)[0]) || e.message);
                }
              },
            },
            "Save dimming and blur",
          ),
        ),
        msg,
      );
    }

    const views = { notifications: renderNotifications, verification: renderVerification, shell: renderShellCommands, time: renderTime, appearance: renderAppearance, branding: renderBranding };
    function renderBody() {
      bar.replaceChildren(...tabs.map(([id, label]) => h("button", { type: "button", "aria-pressed": String(id === tab), onclick: () => ((tab = id), sessionStorageSet("settingsTab", id), renderBody()) }, label)));
      (views[tab] || renderNotifications)();
    }
    const scopeSel = siteSelect({ first: "Default (every domain)", firstValue: "default", value: scope, label: "Which domain to edit" });
    scopeSel.addEventListener("change", async () => {
      scope = scopeSel.value;
      sessionStorageSet("settingsScope", scope);
      try {
        s = await api("/admin/settings" + q());
        for (const k of [...document.documentElement.style]) document.documentElement.style.removeProperty(k);
        renderBody();
      } catch (e) {
        alert(e.message);
      }
    });
    const scopeBar = h("div", { class: "panel scope-bar" }, h("label", { for: "scope-sel" }, "Editing settings for"), scopeSel, h("a", { href: "#/domains", class: "muted small" }, "Manage domains"));
    scopeSel.id = "scope-sel";
    main.replaceChildren(head("Settings", "Notifications, verification, time zone, look and branding, for every domain or one at a time. Super admins only."), scopeBar, bar, body);
    renderBody();
  }

  function sessionStorageGet(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function sessionStorageSet(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  }

  /** Reload the admin theme from the server (also clears a live preview). */
  async function applyAdminTheme() {
    const st = document.documentElement.style;
    for (const k of ["--bg", "--card", "--text", "--muted", "--border", "--accent", "--on-accent", "--input-bg", "--ok", "--err", "--side", "--side-text", "--scheme"]) st.removeProperty(k);
    const link = document.querySelector('link[href^="theme.css"]');
    if (link) link.href = "theme.css?v=" + Date.now();
  }

  // ---------------------------------------------------------------- boot

  (async function boot() {
    try {
      const data = await api("/auth/me");
      me = data.user;
      await startApp();
    } catch {
      renderLogin();
    }
  })();
})();
