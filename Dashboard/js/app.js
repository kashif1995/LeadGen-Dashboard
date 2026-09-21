/* ============================================================
   js/dashboard.js — Northvale Lead Dashboard

   MODULES
     LeadStore   isolated data layer (same key/shape as landing)
     Toast       lightweight feedback
     ScrollLock  shared body lock for drawer/modal/sidebar
     Sidebar     navigation + mobile drawer
     Views       Dashboard (recent) vs Leads (all)
     Stats       counts computed from stored leads
     Filters     search / status / dynamic service filter
     Render      table rows, mobile cards, empty states
     StatusMenu  popover to change a lead's status
     Drawer      full lead detail panel
     Confirm     delete confirmation (no native confirm())
     Exporter    CSV download via Blob

   ┌─────────────────────────────────────────────────────────┐
   │ PROTOTYPE / SECURITY NOTE (developer comment)           │
   │                                                         │
   │ This is a front-end prototype. localStorage is          │
   │ per-browser, unencrypted, and shared by anyone with     │
   │ access to this browser profile. It is NOT a database    │
   │ and provides no authentication, access control or       │
   │ multi-user support.                                     │
   │                                                         │
   │ For production: replace the LeadStore module with       │
   │ authenticated API endpoints backed by a real database,  │
   │ add server-side validation/authorisation, and gate      │
   │ this page behind real authentication. No credentials    │
   │ are handled anywhere in this file.                      │
   └─────────────────────────────────────────────────────────┘
   ============================================================ */
(() => {
  'use strict';

  /* ---------- Configuration ---------- */
  const CONFIG = {
    // MUST match the landing page's LeadStore key (js/app.js) so both
    // pages read/write the same data. Rename in BOTH files if you
    // prefer a generic key such as 'project_leads'.
    leadsKey: 'northvale_leads_v1',
    searchDebounceMs: 120,
    recentLimit: 6, // leads shown in the Dashboard view
  };

  /* ---------- Tiny utilities ---------- */
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Escape user-provided values before injecting into innerHTML
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const fmtShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtFull  = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const formatDate = (iso, long = false) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : (long ? fmtFull : fmtShort).format(d);
  };

  const initialsOf = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    return ((parts[0][0] || '') + (parts[1]?.[0] || '')).toUpperCase();
  };

  const telHref = (phone) => 'tel:' + String(phone || '').replace(/[^\d+]/g, '');

  /* Status vocabulary — must match the landing page exactly */
  const STATUSES = ['New', 'Contacted', 'Closed'];
  const badgeClass = { New: 'badge--new', Contacted: 'badge--contacted', Closed: 'badge--closed' };
  const dotClass   = { New: 'dot--new',   Contacted: 'dot--contacted',   Closed: 'dot--closed' };

  /* ============================================================
     MODULE: LeadStore — isolated data layer
     Same record shape and key as the landing page. To move to a
     real backend, replace this object's methods with fetch()
     calls — nothing else in this file needs to change.
     ============================================================ */
  const LeadStore = {
    key: CONFIG.leadsKey,

    getAll() {
      try {
        const raw = JSON.parse(localStorage.getItem(this.key));
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    },

    getById(id) {
      return this.getAll().find((l) => l.id === id) || null;
    },

    save(leads) {
      localStorage.setItem(this.key, JSON.stringify(leads));
    },

    updateStatus(id, status) {
      const leads = this.getAll();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return null;
      lead.status = status;
      this.save(leads);
      return lead;
    },

    remove(id) {
      const leads = this.getAll();
      const next = leads.filter((l) => l.id !== id);
      this.save(next);
      return next.length !== leads.length;
    },
  };

  /* ---------- App state ---------- */
  const state = {
    view: 'dashboard',   // 'dashboard' | 'leads'
    query: '',
    status: 'all',
    service: 'all',
    pendingDeleteId: null,
  };

  /* ---------- Focus trap for drawer & modal ---------- */
  function trapTab(container, e) {
    const focusables = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', container)
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ============================================================
     MODULE: Toast
     ============================================================ */
  const Toast = {
    el: null, icon: null, msg: null, timer: null,

    init() {
      this.el = $('#toast');
      this.icon = $('#toastIcon');
      this.msg = $('#toastMsg');
    },

    show(message, kind = 'success') {
      this.icon.innerHTML = `<use href="${kind === 'info' ? '#i-info' : '#i-check'}"/>`;
      this.el.classList.toggle('toast--info', kind === 'info');
      this.msg.textContent = message;
      this.el.classList.remove('show');
      void this.el.offsetWidth; // restart transition
      this.el.classList.add('show');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.el.classList.remove('show'), 2600);
    },
  };

  /* ---------- Shared body scroll lock ---------- */
  const ScrollLock = {
    update() {
      const locked = Sidebar.isOpen
        || !$('#drawerRoot').hidden
        || !$('#confirmModal').hidden;
      document.body.classList.toggle('no-scroll', locked);
    },
  };

  /* ============================================================
     MODULE: Sidebar — nav + mobile drawer
     ============================================================ */
  const Sidebar = {
    el: null, toggle: null, backdrop: null,

    get isOpen() { return this.el.classList.contains('open'); },

    init() {
      this.el = $('#sidebar');
      this.toggle = $('#navToggle');
      this.backdrop = $('#sidebarBackdrop');

      this.toggle.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
      this.backdrop.addEventListener('click', () => this.close());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen) this.close();
      });
      window.addEventListener('resize', () => {
        if (window.innerWidth > 768 && this.isOpen) this.close();
      });
    },

    open() {
      this.el.classList.add('open');
      this.backdrop.hidden = false;
      requestAnimationFrame(() => this.backdrop.classList.add('open'));
      this.toggle.classList.add('active');
      this.toggle.setAttribute('aria-expanded', 'true');
      ScrollLock.update();
    },

    close() {
      this.el.classList.remove('open');
      this.backdrop.classList.remove('open');
      this.toggle.classList.remove('active');
      this.toggle.setAttribute('aria-expanded', 'false');
      setTimeout(() => { this.backdrop.hidden = true; }, 220);
      ScrollLock.update();
    },
  };

  /* ============================================================
     MODULE: Views — Dashboard (recent leads) vs Leads (all)
     ============================================================ */
  const Views = {
    current: 'dashboard',

    init() {
      $$('.nav-item[data-view]').forEach((btn) =>
        btn.addEventListener('click', () => this.show(btn.dataset.view))
      );
    },

    show(name) {
      if (name === this.current) { Sidebar.close(); return; }
      this.current = name;
      state.view = name;

      $$('.nav-item[data-view]').forEach((btn) => {
        const active = btn.dataset.view === name;
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });

      $('#panelTitle').textContent = name === 'dashboard' ? 'Recent Leads' : 'All Leads';
      Sidebar.close();
      Render.refresh();
      window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    },
  };

  /* ============================================================
     MODULE: Stats — always computed from real stored leads
     ============================================================ */
  const Stats = {
    els: {},

    init() {
      this.els = {
        total: $('#statTotal'),
        new: $('#statNew'),
        contacted: $('#statContacted'),
        closed: $('#statClosed'),
      };
    },

    render(leads) {
      const counts = { New: 0, Contacted: 0, Closed: 0 };
      leads.forEach((l) => { if (counts[l.status] !== undefined) counts[l.status] += 1; });
      this.set(this.els.total, leads.length);
      this.set(this.els.new, counts.New);
      this.set(this.els.contacted, counts.Contacted);
      this.set(this.els.closed, counts.Closed);
    },

    set(el, target) {
      const from = Number(el.dataset.v || 0);
      el.dataset.v = String(target);
      if (from === target || REDUCED_MOTION) { el.textContent = target; return; }
      const duration = 380;
      const t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (target - from) * eased);
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  };

  /* ============================================================
     MODULE: Filters — search, status, dynamic services
     ============================================================ */
  const Filters = {
    search: null, statusSel: null, serviceSel: null, serviceSig: '',

    init() {
      this.search = $('#searchInput');
      this.statusSel = $('#statusFilter');
      this.serviceSel = $('#serviceFilter');

      this.search.addEventListener('input', debounce(() => {
        state.query = this.search.value;
        Render.refresh();
      }, CONFIG.searchDebounceMs));

      this.statusSel.addEventListener('change', () => {
        state.status = this.statusSel.value;
        Render.refresh();
      });

      this.serviceSel.addEventListener('change', () => {
        state.service = this.serviceSel.value;
        Render.refresh();
      });

      $('#clearFilters').addEventListener('click', () => this.clear());
    },

    clear() {
      state.query = '';
      state.status = 'all';
      state.service = 'all';
      this.search.value = '';
      this.statusSel.value = 'all';
      this.serviceSel.value = 'all';
      Render.refresh();
      this.search.focus();
    },

    // Rebuild service options from values actually present in the data
    buildServiceOptions(leads) {
      const services = [...new Set(leads.map((l) => (l.service || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      const sig = services.join('|');
      if (sig === this.serviceSig) return;
      this.serviceSig = sig;
      this.serviceSel.innerHTML = '<option value="all">All services</option>' +
        services.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      if (!services.includes(state.service)) state.service = 'all';
      this.serviceSel.value = state.service;
    },

    apply(leads) {
      const q = state.query.trim().toLowerCase();
      return leads.filter((l) => {
        // Search scope per spec: name, company, email, phone
        const hay = `${l.name || ''} ${l.company || ''} ${l.email || ''} ${l.phone || ''}`.toLowerCase();
        if (q && !hay.includes(q)) return false;
        if (state.status !== 'all' && l.status !== state.status) return false;
        if (state.service !== 'all' && (l.service || '').trim() !== state.service) return false;
        return true;
      });
    },
  };

  /* ============================================================
     MODULE: Render — one pipeline feeds table, cards & stats
     ============================================================ */
  const Render = {
    tbody: null, cards: null, meta: null, foot: null,
    tableWrap: null, leadsData: null,
    emptyAll: null, emptyFiltered: null,

    init() {
      this.tbody = $('#tableBody');
      this.cards = $('#leadCards');
      this.meta = $('#panelMeta');
      this.foot = $('#panelFoot');
      this.tableWrap = $('#tableWrap');
      this.leadsData = $('#leadsData');
      this.emptyAll = $('#emptyAll');
      this.emptyFiltered = $('#emptyFiltered');

      $('#viewAllBtn').addEventListener('click', () => Views.show('leads'));

      // Event delegation for row/card actions
      const route = (e) => this.handleAction(e);
      this.tbody.addEventListener('click', route);
      this.cards.addEventListener('click', route);
    },

    handleAction(e) {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const wrapper = e.target.closest('[data-id]');
      if (!wrapper) return;
      const id = wrapper.dataset.id;

      if (actionEl.dataset.action === 'view') Drawer.open(id);
      else if (actionEl.dataset.action === 'status') StatusMenu.open(actionEl, id);
      else if (actionEl.dataset.action === 'delete') Confirm.open(id);
    },

    refresh() {
      const all = LeadStore.getAll()
        .slice()
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

      Filters.buildServiceOptions(all);
      Stats.render(all);
      this.renderNavBadge(all);

      const filtered = Filters.apply(all);
      const limited = state.view === 'dashboard' && filtered.length > CONFIG.recentLimit;
      const visible = limited ? filtered.slice(0, CONFIG.recentLimit) : filtered;

      this.tbody.innerHTML = visible.map((l) => this.rowHTML(l)).join('');
      this.cards.innerHTML = visible.map((l) => this.cardHTML(l)).join('');

      // Meta line + "view all" footer
      const noneAtAll = all.length === 0;
      const noneAfterFilter = !noneAtAll && filtered.length === 0;
      this.meta.textContent = noneAtAll
        ? 'No leads yet'
        : limited
          ? `Showing ${visible.length} of ${filtered.length} leads`
          : `${filtered.length} ${filtered.length === 1 ? 'lead' : 'leads'}`;
      this.foot.hidden = !limited;

      // Empty-state handling
      this.leadsData.hidden = noneAtAll;
      this.tableWrap.hidden = noneAfterFilter;
      this.cards.hidden = noneAfterFilter;
      this.emptyAll.hidden = !noneAtAll;
      this.emptyFiltered.hidden = !noneAfterFilter;
    },

    renderNavBadge(leads) {
      const n = leads.filter((l) => l.status === 'New').length;
      const badge = $('#navBadge');
      badge.hidden = n === 0;
      badge.textContent = n;
    },

    rowHTML(l) {
      const name = l.name || 'Unnamed lead';
      return `
        <tr data-id="${esc(l.id)}">
          <td>
            <div class="cell-name">
              <span class="disc" aria-hidden="true">${esc(initialsOf(name))}</span>
              <span class="name">${esc(name)}</span>
            </div>
          </td>
          <td class="cell-company">${l.company ? esc(l.company) : '<span class="is-empty">—</span>'}</td>
          <td class="col-email">
            ${l.email
              ? `<a class="email-link" href="mailto:${esc(l.email)}" title="${esc(l.email)}">${esc(l.email)}</a>`
              : '<span class="is-empty">—</span>'}
          </td>
          <td class="col-phone">
            ${l.phone
              ? `<a class="email-link" href="${esc(telHref(l.phone))}">${esc(l.phone)}</a>`
              : '<span class="is-empty">—</span>'}
          </td>
          <td>${l.service ? `<span class="tag">${esc(l.service)}</span>` : '<span class="is-empty">—</span>'}</td>
          <td class="date-cell" title="${esc(formatDate(l.date, true))}">${esc(formatDate(l.date))}</td>
          <td><span class="badge ${badgeClass[l.status] || ''}">${esc(l.status || 'New')}</span></td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" data-action="view" aria-label="View lead" title="View">
                <svg class="icon" aria-hidden="true"><use href="#i-eye"/></svg>
              </button>
              <button class="icon-btn" data-action="status" aria-label="Change status" title="Change status">
                <svg class="icon" aria-hidden="true"><use href="#i-swap"/></svg>
              </button>
              <button class="icon-btn icon-btn--danger" data-action="delete" aria-label="Delete lead" title="Delete">
                <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
    },

    cardHTML(l) {
      const name = l.name || 'Unnamed lead';
      return `
        <article class="lead-card" data-id="${esc(l.id)}" data-action="view">
          <div class="card-top">
            <span class="disc" aria-hidden="true">${esc(initialsOf(name))}</span>
            <div class="card-person">
              <p class="card-name">${esc(name)}</p>
              <p class="card-company">${l.company ? esc(l.company) : 'No company provided'}</p>
            </div>
            <span class="badge ${badgeClass[l.status] || ''}">${esc(l.status || 'New')}</span>
          </div>
          <div class="card-tags">
            ${l.service ? `<span class="tag">${esc(l.service)}</span>` : '<span></span>'}
            <span class="card-date">${esc(formatDate(l.date))}</span>
          </div>
          <div class="card-actions">
            <button class="icon-btn" data-action="view" aria-label="View lead">
              <svg class="icon" aria-hidden="true"><use href="#i-eye"/></svg>
            </button>
            <button class="icon-btn" data-action="status" aria-label="Change status">
              <svg class="icon" aria-hidden="true"><use href="#i-swap"/></svg>
            </button>
            <button class="icon-btn icon-btn--danger" data-action="delete" aria-label="Delete lead">
              <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
            </button>
          </div>
        </article>`;
    },
  };

  /* ============================================================
     MODULE: StatusMenu — small popover for status changes
     ============================================================ */
  const StatusMenu = {
    el: null, anchor: null, leadId: null,

    init() {
      this.el = $('#statusMenu');

      this.el.addEventListener('click', (e) => {
        const opt = e.target.closest('[data-status]');
        if (!opt || !this.leadId) return;
        const lead = LeadStore.updateStatus(this.leadId, opt.dataset.status);
        this.close();
        if (lead) {
          Render.refresh();
          Drawer.sync(lead);
          Toast.show(`Status updated to “${opt.dataset.status}”.`);
        }
      });

      document.addEventListener('mousedown', (e) => {
        if (!this.el.classList.contains('open')) return;
        if (!this.el.contains(e.target) && !this.anchor?.contains(e.target)) this.close();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.el.classList.contains('open')) this.close();
      });
      window.addEventListener('resize', () => this.close());
      window.addEventListener('scroll', () => this.close(), { passive: true });
    },

    open(anchor, id) {
      // Toggle when clicking the same trigger twice
      if (this.anchor === anchor && this.el.classList.contains('open')) { this.close(); return; }
      const lead = LeadStore.getById(id);
      if (!lead) return;

      this.anchor = anchor;
      this.leadId = id;
      this.el.innerHTML =
        '<p class="menu-label">Change status</p>' +
        STATUSES.map((s) => `
          <button class="menu-opt ${lead.status === s ? 'current' : ''}" data-status="${s}" role="menuitem">
            <span class="dot ${dotClass[s]}" aria-hidden="true"></span>${s}
            <svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>
          </button>`).join('');

      this.el.classList.add('open'); // make measurable before positioning

      const r = anchor.getBoundingClientRect();
      const mw = this.el.offsetWidth;
      const mh = this.el.offsetHeight;
      let top = r.bottom + 6;
      if (top + mh > window.innerHeight - 12) top = r.top - mh - 6;
      let left = r.right - mw;
      if (left < 12) left = 12;
      if (left + mw > window.innerWidth - 12) left = window.innerWidth - mw - 12;
      this.el.style.top = `${top}px`;
      this.el.style.left = `${left}px`;

      $('.menu-opt.current', this.el)?.focus();
    },

    close() {
      this.el.classList.remove('open');
      this.anchor = null;
      this.leadId = null;
    },
  };

  /* ============================================================
     MODULE: Drawer — full lead detail panel
     ============================================================ */
  const Drawer = {
    root: null, lastFocus: null, currentId: null,

    init() {
      this.root = $('#drawerRoot');
      $('#drawerClose').addEventListener('click', () => this.close());
      $('[data-close-drawer]', this.root).addEventListener('click', () => this.close());
      $('#markContacted').addEventListener('click', () => this.mark('Contacted'));
      $('#markClosed').addEventListener('click', () => this.mark('Closed'));
      $('#drawerDelete').addEventListener('click', () => Confirm.open(this.currentId));

      document.addEventListener('keydown', (e) => {
        if (this.root.hidden || !$('#confirmModal').hidden) return; // confirm sits on top
        if (e.key === 'Escape') this.close();
        if (e.key === 'Tab') trapTab(this.root, e);
      });
    },

    open(id) {
      const lead = LeadStore.getById(id);
      if (!lead) return;
      this.lastFocus = document.activeElement;
      this.currentId = lead.id;
      this.root.hidden = false;
      requestAnimationFrame(() => this.root.classList.add('open'));
      this.render(lead);
      ScrollLock.update();
      $('#drawerClose').focus();
    },

    render(lead) {
      $('#drawerTitle').textContent = lead.name || 'Unnamed lead';
      $('#drawerSub').textContent = lead.company || 'No company provided';

      const rows = [
        ['Full Name', lead.name || '—', null],
        ['Company / Organisation', lead.company || '—', null],
        ['Email', lead.email || '—', lead.email ? `mailto:${lead.email}` : null],
        ['Phone / WhatsApp', lead.phone || '—', lead.phone ? telHref(lead.phone) : null],
        ['Country', lead.country || '—', null],
        ['Service Interested In', lead.service || '—', null],
        ['Short Project / Requirement', lead.shortRequirement || '—', null],
        ['Submission Date', formatDate(lead.date, true), null],
      ];

      $('#detailList').innerHTML = rows.map(([label, value, href]) => `
        <div class="detail-row">
          <dt>${esc(label)}</dt>
          <dd>${href ? `<a href="${esc(href)}">${esc(value)}</a>` : esc(value)}</dd>
        </div>`).join('');

      $('#drawerDesc').textContent = lead.description || 'No description provided.';
      this.sync(lead);
    },

    // Live-update the drawer if the same lead changes elsewhere
    sync(lead) {
      if (this.root.hidden || !this.currentId || lead.id !== this.currentId) return;
      const badge = $('#drawerStatus');
      badge.textContent = lead.status || 'New';
      badge.className = `badge ${badgeClass[lead.status] || ''}`;
      $('#markContacted').disabled = lead.status === 'Contacted';
      $('#markClosed').disabled = lead.status === 'Closed';
    },

    mark(status) {
      const lead = LeadStore.updateStatus(this.currentId, status);
      if (!lead) return;
      this.sync(lead);
      Render.refresh();
      Toast.show(`Status updated to “${status}”.`);
    },

    close() {
      this.root.classList.remove('open');
      setTimeout(() => { this.root.hidden = true; }, 240);
      ScrollLock.update();
      if (this.lastFocus?.isConnected) this.lastFocus.focus();
      this.currentId = null;
    },

    closeIf(id) {
      if (!this.root.hidden && this.currentId === id) this.close();
    },
  };

  /* ============================================================
     MODULE: Confirm — delete confirmation (no native confirm())
     ============================================================ */
  const Confirm = {
    root: null, lastFocus: null,

    init() {
      this.root = $('#confirmModal');
      $('#cancelDelete').addEventListener('click', () => this.close());
      $('[data-cancel-delete]', this.root).addEventListener('click', () => this.close());
      $('#confirmDelete').addEventListener('click', () => this.confirm());

      document.addEventListener('keydown', (e) => {
        if (this.root.hidden) return;
        if (e.key === 'Escape') this.close();
        if (e.key === 'Tab') trapTab(this.root, e);
      });
    },

    open(id) {
      const lead = LeadStore.getById(id);
      if (!lead) return;
      this.lastFocus = document.activeElement;
      state.pendingDeleteId = id;
      $('#confirmName').textContent = lead.name || 'this lead';
      this.root.hidden = false;
      ScrollLock.update();
      $('#cancelDelete').focus();
    },

    close() {
      this.root.hidden = true;
      state.pendingDeleteId = null;
      ScrollLock.update();
      if (!Drawer.root.hidden) $('#drawerDelete').focus();
      else if (this.lastFocus?.isConnected) this.lastFocus.focus();
    },

    confirm() {
      const id = state.pendingDeleteId;
      if (!id) return;
      LeadStore.remove(id);
      this.root.hidden = true;
      state.pendingDeleteId = null;
      Drawer.closeIf(id);
      Render.refresh();
      ScrollLock.update();
      Toast.show('Lead deleted.');
      if (this.lastFocus?.isConnected) this.lastFocus.focus();
    },
  };

  /* ============================================================
     MODULE: Exporter — CSV download (Blob, zero dependencies)
     Exports ALL stored leads, independent of active filters.
     ============================================================ */
  const Exporter = {
    init() {
      $('#exportBtn').addEventListener('click', () => this.exportCSV());
    },

    exportCSV() {
      const leads = LeadStore.getAll();
      const headers = ['Name', 'Company', 'Email', 'Phone', 'Country', 'Service',
                       'Short Requirement', 'Description', 'Date', 'Status'];
      const cell = (v) => `"${String(v ?? '').replace(/\r?\n/g, '\n').replace(/"/g, '""')}"`;
      const rows = leads.map((l) => [
        l.name, l.company, l.email, l.phone, l.country,
        l.service, l.shortRequirement, l.description, l.date, l.status,
      ].map(cell).join(','));

      // \uFEFF BOM keeps Excel happy with UTF-8
      const csv = '\uFEFF' + [headers.map(cell).join(','), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `northvale-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      Toast.show(leads.length
        ? `Exported ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} to CSV.`
        : 'No leads to export yet.', leads.length ? 'success' : 'info');
    },
  };

  /* ============================================================
     Honest stubs — Settings / Logout are not fake-functional.
     The dashboard deliberately does NOT pretend localStorage
     provides authentication.
     ============================================================ */
  function initStubs() {
    const messages = {
      settings: 'Settings aren\u2019t part of this prototype yet.',
      logout: 'Authentication isn\u2019t connected in this local prototype.',
    };
    $$('[data-stub]').forEach((btn) =>
      btn.addEventListener('click', () => {
        Toast.show(messages[btn.dataset.stub] || 'Not available in this prototype.', 'info');
        if (Sidebar.isOpen) Sidebar.close();
      })
    );
  }

  /* ============================================================
     Cross-tab sync — submit a lead on the landing page in
     another tab and it appears here immediately.
     ============================================================ */
  function initStorageSync() {
    window.addEventListener('storage', (e) => {
      if (e.key === LeadStore.key) Render.refresh();
    });
  }

  /* ---------- Boot ---------- */
  function init() {
    // Top header date
    const now = new Date();
    const timeEl = $('#todayDate');
    timeEl.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(now);
    timeEl.setAttribute('datetime', now.toISOString().slice(0, 10));

    Toast.init();
    Sidebar.init();
    Views.init();
    Stats.init();
    Filters.init();
    Render.init();
    StatusMenu.init();
    Drawer.init();
    Confirm.init();
    Exporter.init();
    initStubs();
    initStorageSync();

    Render.refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();