// scripts/app.js
//
// UI + encadrés + récap narratif (plus de mindmap).
// FICHE ÉLÈVE: mise à jour continue à chaque réponse (patch LLM) + exports.
// Anti-duplication stricte des sous-questions. max_followups/skip_revisit par question.
// LOGS: événements + timings, exports JSON & PNG/PDF du récap.

(async function () {
  // ---- DOM ----
  const questionText = document.getElementById("questionText");
  const questionCard = document.getElementById("questionCard");
  const progressBar = document.getElementById("progressBar");

  const input = document.getElementById("input");
  const btnSend = document.getElementById("btnSend");
  const btnSkip = document.getElementById("btnSkip");
  const btnFinish = document.getElementById("btnFinish");

  const btnExportFiche = document.getElementById("btnExportFiche");
  const btnExportConvRecap = document.getElementById("btnExportConvRecap");
  const btnExportRecapPng = document.getElementById("btnExportRecapPng");
  const btnExportRecapPdf = document.getElementById("btnExportRecapPdf");

  const btnReset = document.getElementById("btnReset");
  const btnSettings = document.getElementById("btnSettings"); // peut être null

  const apiModal = document.getElementById("apiModal");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const rememberKey = document.getElementById("rememberKey");
  const apiBaseInput = document.getElementById("apiBaseInput");
  const apiModelInput = document.getElementById("apiModelInput");
  const apiSaveBtn = document.getElementById("apiSaveBtn");

  const settingsModal = document.getElementById("settingsModal");
  const settingsApiBase = document.getElementById("settingsApiBase");
  const settingsApiModel = document.getElementById("settingsApiModel");
  const settingsSaveBtn = document.getElementById("settingsSaveBtn");

  const summaryStage = document.getElementById("summaryStage");
  const questionStage = document.getElementById("questionStage");
  const welcomeStage = document.getElementById("welcomeStage");
  const summaryCards = document.getElementById("summaryCards");
  const recapEl = document.getElementById("recap");

  // ---- State ----
  const state = {
    questions: [],
    idx: 0,
    history: [],
    summary: null,
    recap: null,
    fiche: null,              // NEW: fiche élève (objet)
    attempts: {},
    followups: {},
    unsatisfied: [],
    phase: "main",
    revisitQueue: [],
    currentRevisit: null,
    threadStart: 0,
    timers: { questionStartMs: null },
    logs: []
  };

  // Storage versionné
  const STORAGE_KEY = 'orientation_state_' + (window.APP_VERSION || 'dev');

  // ---- Helpers stockage ----
  function saveState() { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function loadState() { try { const raw = sessionStorage.getItem(STORAGE_KEY); if (raw) Object.assign(state, JSON.parse(raw)); } catch {} }

  // ---- Helpers dates/log ----
  const nowISO = () => new Date().toISOString();
  function logEvent(ev) { state.logs.push({ ts: nowISO(), ...ev }); saveState(); }

  // ---- Politique par question ----
  function getPolicyForQuestion(q) {
    return {
      max_followups: Number(q?.max_followups ?? 4),
      skip_revisit: Boolean(q?.skip_revisit)
    };
  }

  // ---- Helpers texte ----
  function setProgress() {
    const total = state.questions.length || 1;
    const pct = state.phase === "main" ? Math.min(100, Math.round((state.idx / total) * 100)) : 100;
    progressBar.style.width = pct + "%";
  }
  function currentQuestion() { return state.questions[state.idx]; }
  function lastAssistant() {
    for (let i = state.history.length - 1; i >= 0; i--) if (state.history[i].role === 'assistant') return state.history[i].content || "";
    return "";
  }
  function logAssistant(text){ state.history.push({ role:"assistant", content:text }); saveState(); }
  function logUser(text){ state.history.push({ role:"user", content:text }); saveState(); }
  function setComposerEnabled(on) { input.disabled = !on; btnSend.disabled = !on; btnSkip.disabled = !on; btnFinish.disabled = !on; }

  function swapQuestion(text) {
    return new Promise(resolve => {
      questionCard.classList.remove("fade-in");
      questionCard.classList.add("fade-out");
      questionCard.addEventListener("animationend", function handler() {
        questionCard.removeEventListener("animationend", handler);
        questionText.textContent = text;
        questionCard.classList.remove("fade-out");
        questionCard.classList.add("fade-in");
        resolve();
      }, { once:true });
    });
  }
  function showQuestionNow(text) {
    questionCard.classList.remove("fade-out");
    questionCard.classList.add("fade-in");
    questionText.textContent = text;
  }
  function questionLabel() {
    const q = currentQuestion();
    return `Q${state.idx + 1}: ${q.text}`;
  }

  // ---- Similarité (anti-duplication) ----
  function normalize(s) { return String(s||"").toLowerCase().replace(/[^\p{L}\p{N} ]/gu,' ').replace(/\s+/g,' ').trim(); }
  function jaccard(a, b) {
    const A = new Set(normalize(a).split(' ')); const B = new Set(normalize(b).split(' '));
    if (!A.size && !B.size) return 1;
    const inter = [...A].filter(x => B.has(x)).length; const union = new Set([...A, ...B]).size;
    return union ? inter/union : 0;
  }
  function isDuplicate(candidate, prevList, lastMsg, thresh=0.8) {
    const nC = normalize(candidate);
    if (lastMsg) { const nL = normalize(lastMsg); if (nL === nC || jaccard(nL, nC) > thresh) return true; }
    return (prevList || []).some(p => { const np = normalize(p); return np === nC || jaccard(np, nC) > thresh; });
  }
  function getLastAnswersSinceThreadStart(limit=3) {
    const start = state.threadStart || 0;
    return state.history.slice(start).filter(m => m.role === 'user').map(m => m.content).slice(-limit);
  }

  // ---- Gabarits (fallback follow-up) ----
  function fallbackFollowups(baseQuestion) {
    const q = baseQuestion || "";
    return [
      `Donne un EXEMPLE VÉCU précis lié à: "${q}" (où ? quand ? qui ? durée ?).`,
      `Chiffre ta réponse sur "${q}" (budget estimé, durée en semaines, niveau visé, dates cibles).`,
      `Décris un SCÉNARIO CONCRET pour "${q}" (étapes, acteurs, délais).`,
      `Priorise 3 critères pour "${q}" et explique pourquoi (ordre 1→3).`,
      `Quelle CONTRAINTE principale bloque "${q}" et comment la contourner ?`
    ];
  }

  async function ensureNonDuplicateFollowup(proposed, qText, qid) {
    const prev = state.followups[qid] || [];
    const last = lastAssistant();
    if (isDuplicate(proposed, prev, last, 0.78)) {
      try {
        const apiStart = performance.now();
        const alt = await window.Agent.rephraseFollowup({
          base_followup: proposed,
          previous_followups: prev,
          question: qText,
          last_answers: getLastAnswersSinceThreadStart(),
          last_assistant: last
        });
        const apiMs = Math.round(performance.now() - apiStart);
        logEvent({ event: "api_rephrase_followup", qid, api_ms: apiMs });
        if (alt?.question && !isDuplicate(alt.question, prev, last, 0.78)) return alt.question;
      } catch {}
      const pool = fallbackFollowups(qText);
      for (const cand of pool) if (!isDuplicate(cand, prev, last, 0.78)) return cand;
      return `Sois concret sur "${qText}": indique un lieu précis, une date cible et une durée estimée.`;
    }
    return proposed;
  }

  // ---- FICHE ÉLÈVE: merge & timestamps ----
  function deepMerge(target, patch) {
    if (patch === null || patch === undefined) return target;
    if (typeof patch !== 'object' || Array.isArray(patch)) return patch; // tableaux: remplacés
    const out = { ...(target || {}) };
    for (const k of Object.keys(patch)) {
      out[k] = deepMerge(out[k], patch[k]);
    }
    return out;
  }
  function touchFicheCreated() {
    if (!state.fiche?.meta) state.fiche = { meta: {} };
    if (!state.fiche.meta.created_at) state.fiche.meta.created_at = nowISO();
  }
  function touchFicheUpdated() {
    if (!state.fiche?.meta) state.fiche = { meta: {} };
    state.fiche.meta.updated_at = nowISO();
  }

  // ---- UI helpers ----
  async function showCurrentQuestion() {
    const q = currentQuestion(); const qid = q.id;
    const label = questionLabel();
    logAssistant(label);
    await swapQuestion(label);

    state.threadStart = state.history.length;
    if (!state.followups[qid]) state.followups[qid] = [];
    if (!state.followups[qid].includes(q.text)) state.followups[qid].push(q.text);

    state.timers.questionStartMs = Date.now();
    setProgress();
    logEvent({ event: "question_shown", qid, qindex: state.idx, text: q.text, policy: getPolicyForQuestion(q) });
  }

  async function transitionWelcomeToQuestion() {
    await new Promise(resolve => {
      welcomeStage.classList.add("fade-out");
      welcomeStage.addEventListener("animationend", function handler(){
        welcomeStage.removeEventListener("animationend", handler);
        welcomeStage.classList.add("hidden");
        welcomeStage.classList.remove("fade-out");
        resolve();
      }, { once:true });
    });
    questionStage.classList.remove("hidden");
    questionStage.classList.add("fade-in");
    setTimeout(() => questionStage.classList.remove("fade-in"), 400);

    const q = currentQuestion(); const qid = q.id;
    const label = questionLabel();
    logAssistant(label);
    showQuestionNow(label);

    state.threadStart = state.history.length;
    if (!state.followups[qid]) state.followups[qid] = [];
    if (!state.followups[qid].includes(q.text)) state.followups[qid].push(q.text);

    state.timers.questionStartMs = Date.now();
    setProgress();
    logEvent({ event: "question_shown", qid, qindex: state.idx, text: q.text, policy: getPolicyForQuestion(q) });
  }

  function fillSummaryCards(summary) {
    summaryCards.innerHTML = "";
    const blocks = [
      ["🎯 Objectifs", summary.objectifs || []],
      ["📋 Priorités", summary.priorites || []],
      ["🎓 Format idéal", [summary.format_ideal].filter(Boolean)],
      ["🗣️ Langue & niveau", [
        summary.langue,
        summary.niveau_actuel && `Niveau actuel: ${summary.niveau_actuel}`,
        summary.niveau_cible && `Niveau cible: ${summary.niveau_cible}`,
        summary.ambition_progression && `Ambition: ${summary.ambition_progression}`
      ].filter(Boolean)],
      ["✨ Mon projet", [summary.projet_phrase_ultra_positive].filter(Boolean)]
    ];
    for (const [title, items] of blocks) {
      const wrap = document.createElement("div");
      wrap.className = "card panel";
      const h = document.createElement("div"); h.className = "muted"; h.textContent = title; wrap.appendChild(h);
      const box = document.createElement("div");
      for (const it of items) { const pill = document.createElement("span"); pill.className = "pill"; pill.textContent = it; box.appendChild(pill); }
      wrap.appendChild(box);
      summaryCards.appendChild(wrap);
    }
  }

  function renderRecap(recap) {
    recapEl.innerHTML = "";
    const sections = [
      { key: "self_learning", title: "🌱 Connaissance de soi et apprentissage" },
      { key: "academic",      title: "🎓 Ambitions académiques" },
      { key: "environment",   title: "🌍 Cadre de vie et environnement" },
      { key: "social",        title: "🤝 Relations sociales et ouverture" }
    ];
    for (const s of sections) {
      const block = document.createElement("div");
      block.className = "card panel";
      const h3 = document.createElement("h3"); h3.className = "recap-title"; h3.textContent = s.title;
      const p = document.createElement("p");  p.className = "recap-text";   p.textContent = (recap && recap[s.key]) ? recap[s.key] : "";
      block.appendChild(h3); block.appendChild(p); recapEl.appendChild(block);
    }
  }

  // ---- Phase de reprise ----
  function startRevisitPhase() {
    if (!state.unsatisfied.length) return finalizeSummary();
    state.phase = "revisit";
    state.revisitQueue = state.unsatisfied
      .filter(item => {
        const q = state.questions.find(x => x.id === item.id);
        return q && !q.skip_revisit;
      })
      .map(x => x.id);
    saveState();
    logEvent({ event: "revisit_start", count: state.revisitQueue.length });
    askNextRevisit();
  }

  async function askNextRevisit() {
    if (!state.revisitQueue.length) { state.phase = "done"; saveState(); return finalizeSummary(); }
    const qid = state.revisitQueue[0];
    const q = state.questions.find(x => x.id === qid);
    const meta = state.unsatisfied.find(x => x.id === qid) || {};
    try {
      const last_answers = meta.last_answers || [];
      const missing_points = meta.missing_points || [];
      const apiStart = performance.now();
      const ref = await window.Agent.reformulate({ original_question: q.text, last_answers, missing_points });
      const apiMs = Math.round(performance.now() - apiStart);
      const reformulated = ref.reformulated_question || q.text;
      state.currentRevisit = { id: qid, text: reformulated }; saveState();
      await swapQuestion(`🔁 ${reformulated}`); logAssistant(`🔁 ${reformulated}`);
      logEvent({ event: "revisit_question_shown", qid, text: reformulated, api_ms: apiMs });
    } catch {
      state.currentRevisit = { id: qid, text: q.text }; saveState();
      await swapQuestion(`🔁 ${q.text}`); logAssistant(`🔁 ${q.text}`);
      logEvent({ event: "revisit_question_shown", qid, text: q.text, api_ms: null });
    }
  }

  function completeCurrentRevisit() {
    const doneId = state.revisitQueue.shift();
    state.currentRevisit = null;
    saveState();
    logEvent({ event: "revisit_question_done", qid: doneId });
    return askNextRevisit();
  }

  // ---- FINALISATION: encadrés + récap (avec fiche prioritaire) ----
  async function finalizeSummary() {
    try {
      const sumStart = performance.now();
      const sum = await window.Agent.summarize({ history: state.history });
      const sumMs = Math.round(performance.now() - sumStart);
      state.summary = sum; saveState();
      fillSummaryCards(sum);

      const recapStart = performance.now();
      const recap = await window.Agent.recap({ history: state.history, summary: state.summary, fiche: state.fiche });
      const recapMs = Math.round(performance.now() - recapStart);
      state.recap = recap; saveState();
      renderRecap(recap);

      questionStage.classList.add("hidden");
      welcomeStage.classList.add("hidden");
      summaryStage.classList.remove("hidden");

      logEvent({
        event: "summary_and_recap_generated",
        summarize_ms: sumMs,
        recap_ms: recapMs,
        recap_lengths: Object.fromEntries(Object.entries(recap || {}).map(([k, v]) => [k, (v || "").length]))
      });
    } catch (e) {
      alert(e.message || e);
      logEvent({ event: "error_finalizeSummary", message: String(e) });
    } finally {
      setComposerEnabled(true);
    }
  }

  // ---- EXPORTS ----
  function exportFicheJson() {
    const payload = state.fiche || {};
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `fiche-eleve-${stamp}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  function exportConversationRecapJson() {
    const payload = {
      app_version: window.APP_VERSION || "dev",
      exported_at: nowISO(),
      history: state.history,
      recap: state.recap
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `conversation-recap-${stamp}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  async function exportRecapPng() {
    const el = recapEl;
    if (!el) return alert("Récap introuvable.");
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: null, useCORS: true });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `recap-${stamp}.png`; a.click();
      URL.revokeObjectURL(url);
    });
  }

  async function exportRecapPdf() {
    const el = recapEl;
    if (!el) return alert("Récap introuvable.");
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth - 48; // marges
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let y = 24;
    if (imgHeight < pageHeight - 48) {
      pdf.addImage(imgData, "PNG", 24, y, imgWidth, imgHeight, undefined, "FAST");
    } else {
      // découpage multi-pages si nécessaire
      let remainHeight = imgHeight;
      const pageCanvas = document.createElement("canvas");
      const ctx = pageCanvas.getContext("2d");
      const a4ratio = imgWidth / (pageHeight - 48);
      pageCanvas.width = canvas.width;
      pageCanvas.height = Math.floor((pageCanvas.width / imgWidth) * (pageHeight - 48));

      let sY = 0;
      while (remainHeight > 0) {
        ctx.clearRect(0,0,pageCanvas.width,pageCanvas.height);
        ctx.drawImage(canvas, 0, sY, canvas.width, pageCanvas.height, 0, 0, pageCanvas.width, pageCanvas.height);
        const img = pageCanvas.toDataURL("image/png");
        pdf.addImage(img, "PNG", 24, 24, imgWidth, pageHeight - 48, undefined, "FAST");
        remainHeight -= (pageHeight - 48);
        sY += pageCanvas.height;
        if (remainHeight > 0) pdf.addPage();
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    pdf.save(`recap-${stamp}.pdf`);
  }

  // ---- Handlers ----
  async function onSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    const inRevisit = (state.phase === "revisit" && state.currentRevisit);
    const q = inRevisit
      ? { id: state.currentRevisit.id, text: state.currentRevisit.text }
      : currentQuestion();

    const responseMs = state.timers.questionStartMs ? (Date.now() - state.timers.questionStartMs) : null;
    logEvent({ event: "user_answer", qid: q?.id, qindex: state.idx, answer: text, response_ms: responseMs });

    logUser(text);
    setComposerEnabled(false);

    // --- NEW: mise à jour de la fiche à chaque réponse ---
    try {
      if (q?.id) {
        touchFicheCreated();
        const apiStart = performance.now();
        const res = await window.Agent.extractFicheUpdate({
          qid: q.id,
          question: q.text,
          answer: text,
          fiche: state.fiche
        });
        const apiMs = Math.round(performance.now() - apiStart);

        // merge patch
        const before = state.fiche;
        state.fiche = deepMerge(state.fiche || {}, res.patch || {});
        touchFicheUpdated(); saveState();

        logEvent({
          event: "fiche_updated",
          qid: q.id,
          api_ms: apiMs,
          patch_keys: Object.keys(res.patch || {}),
          alerts: res.alerts || []
        });

        // optionnel: enregistrer les alertes dans la fiche
        if (Array.isArray(res.alerts) && res.alerts.length) {
          const alerts = (state.fiche?.coherences?.alertes) || [];
          const updated = { ...(state.fiche || {}) };
          updated.coherences = updated.coherences || {};
          updated.coherences.alertes = [...alerts, ...res.alerts];
          state.fiche = updated; saveState();
        }
      }
    } catch (e) {
      logEvent({ event: "fiche_update_error", qid: q?.id, message: String(e) });
    }

    try {
      if (inRevisit) {
        const qText = state.currentRevisit.text;
        const apiStart = performance.now();
        const res = await window.Agent.decideNext({
          history: state.history, question: qText, answer: text,
          hint_followup: "", followup_count: 0,
          previous_followups: [], last_answers: getLastAnswersSinceThreadStart(),
          last_assistant: lastAssistant(),
          max_followups: 4, skip_revisit: false
        });
        const apiMs = Math.round(performance.now() - apiStart);

        logEvent({ event: "agent_decision", phase: "revisit", qid: state.currentRevisit.id, answered: res.answered, action: res.next_action, api_ms: apiMs, missing_points: res.missing_points });

        logAssistant(res?.answered === true ? "Merci, c’est clair. ✅" : "Merci, je note ta réponse. ✔️");
        return await completeCurrentRevisit();
      }

      // Phase principale
      const qid = q.id;
      const attempts = state.attempts[qid] || 0;
      const previous_followups = state.followups[qid] || [];
      const policy = getPolicyForQuestion(q);

      const apiStart = performance.now();
      const decision = await window.Agent.decideNext({
        history: state.history,
        question: q.text,
        answer: text,
        hint_followup: q.hint,
        followup_count: attempts,
        previous_followups,
        last_answers: getLastAnswersSinceThreadStart(),
        last_assistant: lastAssistant(),
        max_followups: policy.max_followups,
        skip_revisit: policy.skip_revisit
      });
      const apiMs = Math.round(performance.now() - apiStart);

      logEvent({
        event: "agent_decision",
        phase: "main",
        qid,
        attempts,
        answered: decision.answered,
        action: decision.next_action,
        api_ms: apiMs,
        missing_points: decision.missing_points
      });

      if (decision.answered === true) {
        state.attempts[qid] = 0; saveState();
        logEvent({ event: "next_question", from_qid: qid });
        state.idx = Math.min(state.idx + 1, state.questions.length);
        if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
      } else {
        const nextAttempts = attempts + 1;
        state.attempts[qid] = nextAttempts; saveState();

        // Unsatisfied (si autorisée à reprise)
        const lastUserAnswers = state.history.filter(t => t.role === "user").slice(-2).map(t => t.content);
        const missing = decision.missing_points || [];
        const existingIdx = state.unsatisfied.findIndex(x => x.id === qid);
        if (!policy.skip_revisit) {
          if (existingIdx === -1) state.unsatisfied.push({ id: qid, questionText: q.text, last_answers: lastUserAnswers, missing_points: missing });
          else { state.unsatisfied[existingIdx].last_answers = lastUserAnswers; state.unsatisfied[existingIdx].missing_points = missing; }
        }

        if (decision.next_action === "ask_followup" && nextAttempts < policy.max_followups) {
          let fup = await ensureNonDuplicateFollowup(decision.followup_question || "", q.text, qid);
          state.followups[qid] = [...previous_followups, fup]; saveState();
          logEvent({ event: "followup_asked", qid, attempt: nextAttempts, text: fup });
          await swapQuestion(fup); logAssistant(fup);
          state.timers.questionStartMs = Date.now();
        } else {
          state.attempts[qid] = 0; saveState();
          logEvent({ event: "advance_due_to_cap_or_model", qid, attempts: nextAttempts, cap: policy.max_followups });
          state.idx = Math.min(state.idx + 1, state.questions.length);
          if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
        }
      }
    } catch (e) {
      alert(e.message || e);
      logEvent({ event: "error_onSend", message: String(e) });
    } finally {
      setComposerEnabled(true);
    }
  }

  async function onSkip() {
    const q = currentQuestion();
    if (q) {
      logEvent({ event: "skip_question", qid: q.id, text: q.text });
      state.attempts[q.id] = 0; saveState();
    }
    state.idx = Math.min(state.idx + 1, state.questions.length);
    if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
  }

  async function onFinish() {
    logEvent({ event: "finish_clicked" });
    if (state.phase !== "main") {
      if (state.phase === "revisit" && !state.revisitQueue.length) return finalizeSummary();
      return;
    }
    if (state.unsatisfied.length > 0) return startRevisitPhase();
    return finalizeSummary();
  }

  // ---- Modales / réglages ----
  function openApiModal() {
    apiKeyInput.value = sessionStorage.getItem("OPENAI_KEY") || "";
    apiBaseInput.value = sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
    apiModelInput.value = sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
    apiModal.showModal();
  }
  function openSettings() {
    settingsApiBase.value = sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
    settingsApiModel.value = sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
    settingsModal.showModal();
  }

  apiSaveBtn.addEventListener("click", async () => {
    const key = apiKeyInput.value.trim();
    if (!key) { alert("Code requis."); return; }
    const base = (apiBaseInput?.value?.trim()) || sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
    const model = (apiModelInput?.value?.trim()) || sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
    window.Agent.configure({ apiKey:key, baseUrl:base, model });
    if (rememberKey.checked) sessionStorage.setItem("OPENAI_KEY", key);
    sessionStorage.setItem("OPENAI_BASE", base);
    sessionStorage.setItem("OPENAI_MODEL", model);
    logEvent({ event: "session_started", model, base_url: base });
    await transitionWelcomeToQuestion();
  });

  settingsSaveBtn.addEventListener("click", () => {
    const base = settingsApiBase.value.trim();
    const theModel = settingsApiModel.value.trim();
    const model = theModel || "gpt-4o-mini";
    window.Agent.configure({ baseUrl:base, model });
    sessionStorage.setItem("OPENAI_BASE", base);
    sessionStorage.setItem("OPENAI_MODEL", model);
    logEvent({ event: "settings_changed", model, base_url: base });
  });

  btnReset.addEventListener("click", () => {
    logEvent({ event: "reset_clicked" });
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem("OPENAI_KEY");
    sessionStorage.removeItem("OPENAI_BASE");
    sessionStorage.removeItem("OPENAI_MODEL");
    location.reload();
  });

  btnSettings?.addEventListener("click", openSettings);
  btnSend.addEventListener("click", onSend);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }});
  btnSkip.addEventListener("click", onSkip);
  btnFinish.addEventListener("click", onFinish);

  btnExportFiche?.addEventListener("click", exportFicheJson);
  btnExportConvRecap?.addEventListener("click", exportConversationRecapJson);
  btnExportRecapPng?.addEventListener("click", exportRecapPng);
  btnExportRecapPdf?.addEventListener("click", exportRecapPdf);

  // ---- Bootstrap ----
  loadState();

  try {
    const qsVersion = (window.APP_VERSION || Date.now());
    const res = await fetch(`./data/questions.json?v=${qsVersion}`);
    state.questions = await res.json();
  } catch { alert("Impossible de charger data/questions.json"); return; }

  // Charger la fiche vide si absente
  try {
    if (!state.fiche) {
      const v = (window.APP_VERSION || Date.now());
      const res = await fetch(`./data/fiche_eleve.empty.json?v=${v}`);
      state.fiche = await res.json();
      touchFicheCreated(); touchFicheUpdated(); saveState();
    }
  } catch { alert("Impossible de charger data/fiche_eleve.empty.json"); return; }

  // Nettoyer unsatisfied pour skip_revisit
  state.unsatisfied = (state.unsatisfied || []).filter(item => {
    const q = state.questions.find(x => x.id === item.id);
    return q && !Boolean(q.skip_revisit);
  });
  saveState();

  const key = sessionStorage.getItem("OPENAI_KEY");
  const base = sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
  const model = sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
  if (key) window.Agent.configure({ apiKey:key, baseUrl:base, model });

  if (state.history.length > 0 || key) {
    welcomeStage.classList.add("hidden");
    questionStage.classList.remove("hidden");
    if (state.summary) {
      questionStage.classList.add("hidden");
      summaryStage.classList.remove("hidden");
      if (state.recap) renderRecap(state.recap);
    } else if (state.phase === "revisit" && state.currentRevisit) {
      questionText.textContent = `🔁 ${state.currentRevisit.text}`;
    } else {
      const lastA = state.history.filter(h => h.role==="assistant").slice(-1)[0]?.content;
      questionText.textContent = lastA || questionLabel();
      setProgress();
    }
  } else {
    if (typeof apiModal?.showModal === "function") apiModal.showModal();
  }
})();
