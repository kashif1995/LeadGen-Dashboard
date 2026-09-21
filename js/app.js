/* ============================================================
   js/app.js — Northvale landing page
   Modules:
     SiteHeader    sticky/compact header state
     MobileNav     animated mobile navigation
     Reveal        scroll-reveal animations
     ServiceLinks  service grid → form pre-selection
     LeadStore     storage layer (swap for API later)
     LeadForm      validation + submission
     Success       post-submit state
     Modal         legal placeholder dialogs
   ============================================================ */
(() => {
  'use strict';

  /* ---------- Utilities ---------- */
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Configuration ---------- */
  const CONFIG = {
    leadStorageKey: 'northvale_leads_v1',
    // endpoint: 'https://api.example.com/leads'  ← set this when a backend exists
    descriptionMinChars: 30,
  };

  /* ============================================================
     MODULE: LeadStore
     Front-end persistence layer. Every lead is a structured
     record; replace submit() with a fetch() call when a real
     backend is available — nothing else needs to change.
     NOTE: localStorage is a prototype mechanism only. It is NOT
     a secure production database and must not hold sensitive
     data in a live deployment.
     ============================================================ */
  const LeadStore = {
    key: CONFIG.leadStorageKey,

    getAll() {
      try {
        return JSON.parse(localStorage.getItem(this.key)) || [];
      } catch {
        return [];
      }
    },

    persist(record) {
      const leads = this.getAll();
      leads.push(record);
      try {
        localStorage.setItem(this.key, JSON.stringify(leads));
      } catch (err) {
        console.warn('Lead could not be stored locally:', err);
      }
      return record;
    },

    /* Swap the body of this method for:
       return fetch(CONFIG.endpoint, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify(record),
       }).then(res => res.json());
    */
    submit(record) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(this.persist(record)), 450); // simulated latency
      });
    },
  };

  const createLeadRecord = (data) => ({
    id: 'NV-' + Date.now().toString(36).toUpperCase() + '-' +
        Math.random().toString(36).slice(2, 5).toUpperCase(),
    name: data.name.trim(),
    company: data.company.trim(),
    email: data.email.trim().toLowerCase(),
    phone: data.phone.trim(),
    country: data.country.trim(),
    service: data.service,
    shortRequirement: data.shortRequirement.trim(),
    description: data.description.trim(),
    date: new Date().toISOString(),
    status: 'New',
  });

  /* ============================================================
     MODULE: Success (defined before form so dependencies resolve)
     ============================================================ */
  const Success = {
    els: {},
    isShown: false,

    init() {
      this.els = {
        box:   $('#formSuccess'),
        ref:   $('#successRef'),
        title: $('#successTitle'),
        again: $('#submitAgain'),
        form:  $('#leadForm'),
      };
      this.els.again.addEventListener('click', () => this.reset(true));
    },

    show(refId) {
      const { box, ref, form, title } = this.els;
      form.hidden = true;
      box.hidden = false;
      ref.textContent = refId;
      this.isShown = true;
      requestAnimationFrame(() => box.classList.add('play'));
      title.focus({ preventScroll: false });
    },

    reset(focusForm) {
      const { box, form } = this.els;
      box.hidden = true;
      box.classList.remove('play');
      form.reset();
      form.hidden = false;
      this.isShown = false;
      LeadForm.clearAllErrors();
      LeadForm.updateCounter();
      if (focusForm) $('#f-name').focus();
    },
  };

  /* ============================================================
     MODULE: LeadForm — validation & submission
     ============================================================ */
  const LeadForm = {
    attempted: false,
    btn: null,
    btnLabel: null,

    init() {
      this.form = $('#leadForm');
      this.btn = $('#submitBtn');
      this.btnLabel = $('.btn-label', this.btn);
      this.desc = $('#f-desc');
      this.counter = $('#descCount');
      this.countWrap = $('.char-count');

      this.bindEvents();
      this.updateCounter();
    },

    bindEvents() {
      this.form.addEventListener('submit', (e) => this.handleSubmit(e));

      // After the first submit attempt, validate live as the user types/leaves fields
      this.form.addEventListener('input', (e) => {
        if (this.attempted && e.target.name) this.validateField(e.target.name, true);
        if (e.target === this.desc) this.updateCounter();
      });
      this.form.addEventListener('blur', (e) => {
        if (this.attempted && e.target.name) this.validateField(e.target.name, true);
      }, true);
    },

    /* ---- Validation rules (name → [isValid, message]) ---- */
    rules: {
      name: (v) =>
        [v.trim().length >= 2, 'Please enter your full name.'],
      email: (v) =>
        [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()), "That email address doesn't look right — please check it."],
      phone: (v) => {
        const digits = v.replace(/\D/g, '');
        return [digits.length >= 7 && digits.length <= 15, 'Please enter a valid phone number (7–15 digits).'];
      },
      service: (v) =>
        [v !== '', 'Please select the service you\u2019re interested in.'],
      description: (v) => {
        const n = v.trim().length;
        return [
          n >= CONFIG.descriptionMinChars,
          `Please add a bit more detail — ${n} of ${CONFIG.descriptionMinChars} characters so far.`,
        ];
      },
    },

    readForm() {
      const data = {};
      new FormData(this.form).forEach((value, key) => { data[key] = value; });
      return data;
    },

    validateField(name, quiet) {
      const rule = this.rules[name];
      if (!rule) return true; // optional fields
      const input = this.form.elements[name];
      const [ok, message] = rule(input.value);
      if (ok) this.clearError(name);
      else if (!quiet || this.attempted) this.setError(name, message);
      return ok;
    },

    validateAll() {
      let firstInvalid = null;
      Object.keys(this.rules).forEach((name) => {
        const ok = this.validateField(name, true);
        if (!ok && !firstInvalid) firstInvalid = this.form.elements[name];
      });
      return firstInvalid;
    },

    setError(name, message) {
      const wrap = $(`.field[data-field="${name}"]`, this.form);
      if (!wrap) return;
      wrap.classList.add('invalid');
      const errorEl = $('.field-error', wrap);
      if (errorEl) errorEl.textContent = message;
      this.form.elements[name].setAttribute('aria-invalid', 'true');
    },

    clearError(name) {
      const wrap = $(`.field[data-field="${name}"]`, this.form);
      if (!wrap) return;
      wrap.classList.remove('invalid');
      const errorEl = $('.field-error', wrap);
      if (errorEl) errorEl.textContent = '';
      this.form.elements[name].removeAttribute('aria-invalid');
    },

    clearAllErrors() {
      Object.keys(this.rules).forEach((name) => this.clearError(name));
      this.attempted = false;
    },

    updateCounter() {
      const n = this.desc.value.trim().length;
      this.counter.textContent = n;
      this.countWrap.classList.toggle('ok', n >= CONFIG.descriptionMinChars);
    },

    setSubmitting(isLoading) {
      this.btn.disabled = isLoading;
      this.btn.classList.toggle('is-loading', isLoading);
      this.btnLabel.textContent = isLoading ? 'Submitting…' : 'Submit Requirement';
    },

    async handleSubmit(e) {
      e.preventDefault();
      this.attempted = true;

      const firstInvalid = this.validateAll();
      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      // Prevent double submits while "sending"
      this.setSubmitting(true);
      try {
        const record = createLeadRecord(this.readForm());
        await LeadStore.submit(record);
        Success.show(record.id);
      } catch (err) {
        console.error('Submission failed:', err);
        this.setError('description', 'Something went wrong on our side — please try again.');
      } finally {
        this.setSubmitting(false);
      }
    },
  };

  /* ============================================================
     MODULE: SiteHeader — compact sticky state on scroll
     ============================================================ */
  const SiteHeader = {
    init() {
      this.el = $('#siteHeader');
      let ticking = false;
      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          this.el.classList.toggle('scrolled', window.scrollY > 10);
          ticking = false;
        });
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    },
  };

  /* ============================================================
     MODULE: MobileNav — overlay menu with staggered links
     ============================================================ */
  const MobileNav = {
    init() {
      this.toggle = $('#menuToggle');
      this.nav = $('#primaryNav');

      this.toggle.addEventListener('click', () =>
        this.isOpen ? this.close() : this.open()
      );
      $$('a', this.nav).forEach((a) =>
        a.addEventListener('click', () => this.close())
      );
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen) this.close();
      });
      window.addEventListener('resize', () => {
        if (window.innerWidth > 900 && this.isOpen) this.close();
      });
    },

    get isOpen() { return this.nav.classList.contains('open'); },

    open() {
      this.nav.classList.add('open');
      this.toggle.classList.add('active');
      this.toggle.setAttribute('aria-expanded', 'true');
      this.toggle.setAttribute('aria-label', 'Close menu');
      document.body.classList.add('no-scroll');
    },

    close() {
      this.nav.classList.remove('open');
      this.toggle.classList.remove('active');
      this.toggle.setAttribute('aria-expanded', 'false');
      this.toggle.setAttribute('aria-label', 'Open menu');
      document.body.classList.remove('no-scroll');
    },
  };

  /* ============================================================
     MODULE: Reveal — IntersectionObserver scroll animations
     ============================================================ */
  const Reveal = {
    init() {
      const els = $$('[data-reveal]');
      if (REDUCED_MOTION || !('IntersectionObserver' in window)) {
        els.forEach((el) => el.classList.add('in-view'));
        return;
      }
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('in-view');
              io.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
      );
      els.forEach((el) => io.observe(el));
    },
  };

  /* ============================================================
     MODULE: ServiceLinks — clicking a service cell pre-fills
     the form's service dropdown (small conversion detail)
     ============================================================ */
  const ServiceLinks = {
    flashTimer: null,

    init() {
      const select = $('#f-service');
      $$('.service-cell').forEach((cell) => {
        cell.addEventListener('click', () => {
          if (Success.isShown) Success.reset(false);
          select.value = cell.dataset.service;
          select.classList.add('flash');
          clearTimeout(this.flashTimer);
          this.flashTimer = setTimeout(() => select.classList.remove('flash'), 1600);
        });
      });
    },
  };

  /* ============================================================
     MODULE: Modal — placeholder legal dialogs
     ============================================================ */
  const LEGAL_CONTENT = {
    privacy: {
      title: 'Privacy Policy',
      body: `
        <p><strong>Placeholder content — replace with your organisation's privacy policy before launch.</strong></p>
        <p>We collect only the information you submit through this form, and use it solely to respond to your enquiry. We do not sell or share your details with third parties.</p>
        <h4>Data retention</h4>
        <p>Enquiry records are kept for as long as needed to handle your request, then deleted on request.</p>`,
    },
    terms: {
      title: 'Terms of Service',
      body: `
        <p><strong>Placeholder content — replace with your organisation's terms before launch.</strong></p>
        <p>Content on this website is provided for general information and does not constitute a formal offer or professional advice.</p>
        <h4>Engagements</h4>
        <p>All project work is governed by a separate written agreement between both parties.</p>`,
    },
  };

  const Modal = {
    lastFocus: null,

    init() {
      this.modal = $('#legalModal');
      this.titleEl = $('#modalTitle');
      this.bodyEl = $('#modalBody');
      this.closeBtn = $('#modalClose');

      $$('[data-modal]').forEach((btn) =>
        btn.addEventListener('click', () => this.open(btn.dataset.modal))
      );
      this.closeBtn.addEventListener('click', () => this.close());
      $('[data-close-modal]', this.modal).addEventListener('click', () => this.close());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.modal.hidden) this.close();
      });
    },

    open(key) {
      const content = LEGAL_CONTENT[key];
      if (!content) return;
      this.lastFocus = document.activeElement;
      this.titleEl.textContent = content.title;
      this.bodyEl.innerHTML = content.body;
      this.modal.hidden = false;
      document.body.classList.add('no-scroll');
      this.closeBtn.focus();
    },

    close() {
      this.modal.hidden = true;
      document.body.classList.remove('no-scroll');
      if (this.lastFocus) this.lastFocus.focus();
    },
  };

  /* ---------- Boot ---------- */
  const init = () => {
    SiteHeader.init();
    MobileNav.init();
    Reveal.init();
    Success.init();
    LeadForm.init();
    ServiceLinks.init();
    Modal.init();
    $('#year').textContent = new Date().getFullYear();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
