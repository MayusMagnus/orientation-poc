// scripts/app.js
//
// UI + mindmap (root image). Anti-duplication stricte des sous-questions.
// Paramétrage par question : max_followups, skip_revisit.
// + LOGS : trace tous les événements (timestamps ISO, durées, décisions) et export JSON.

(async function () {
  // ---- DOM ----
  const questionText = document.getElementById("questionText");
  const questionCard = document.getElementById("questionCard");
  const progressBar = document.getElementById("progressBar");

  const input = document.getElementById("input");
  const btnSend = document.getElementById("btnSend");
  const btnSkip = document.getElementById("btnSkip");
  const btnFinish = document.getElementById("btnFinish");
  const btnExportSvg = document.getElementById("btnExportSvg");
  const btnExportLog = document.getElementById("btnExportLog"); // NEW
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

  // ---- State ----
  const state = {
    questions: [],
    idx: 0,
    history: [],
    summary: null,
    attempts: {},              // nb de follow-ups posés par question (key = qid)
    followups: {},             // follow-ups (et question de base) posés par question (key = qid) => string[]
    unsatisfied: [],
    phase: "main",
    revisitQueue: [],
    currentRevisit: null,
    threadStart: 0,            // index history au début de la question courante
    timers: {
      questionStartMs: null,   // Date.now() à l’affichage de la question
    },
    logs: []                   // NEW: événements
  };

  // Storage versionné (évite conflit si ordre/questions ont changé)
  const STORAGE_KEY = 'orientation_state_' + (window.APP_VERSION || 'dev');

  // ---- Helpers stockage ----
  function saveState() { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function loadState() { try { const raw = sessionStorage.getItem(STORAGE_KEY); if (raw) Object.assign(state, JSON.parse(raw)); } catch {} }

  // ---- Helpers dates/log ----
  const nowISO = () => new Date().toISOString();
  function logEvent(ev) {
    state.logs.push({ ts: nowISO(), ...ev });
    saveState();
  }

  // ---- Politique par question : cap & reprise ----
  function getPolicyForQuestion(q) {
    return {
      max_followups: Number(q?.max_followups ?? 5),
      skip_revisit: Boolean(q?.skip_revisit)
    };
  }

  // ---- Helpers logique ----
  function setProgress() {
    const total = state.questions.length || 1;
    const pct = state.phase === "main" ? Math.min(100, Math.round((state.idx / total) * 100)) : 100;
    progressBar.style.width = pct + "%";
  }
  function currentQuestion() { return state.questions[state.idx]; }
  function lastAssistant() {
    for (let i = state.history.length - 1; i >= 0; i--) {
      if (state.history[i].role === 'assistant') return state.history[i].content || "";
    }
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

  // Normalisation texte pour comparer
  function normalize(s) { return String(s||"").toLowerCase().replace(/[^\p{L}\p{N} ]/gu,' ').replace(/\s+/g,' ').trim(); }
  function jaccard(a, b) {
    const A = new Set(normalize(a).split(' '));
    const B = new Set(normalize(b).split(' '));
    if (!A.size && !B.size) return 1;
    const inter = [...A].filter(x => B.has(x)).length;
    const union = new Set([...A, ...B]).size;
    return union ? inter/union : 0;
  }
  function isDuplicate(candidate, prevList, lastMsg, thresh=0.8) {
    const nC = normalize(candidate);
    if (lastMsg) {
      const nL = normalize(lastMsg);
      if (nL === nC || jaccard(nL, nC) > thresh) return true;
    }
    return (prevList || []).some(p => {
      const np = normalize(p);
      return np === nC || jaccard(np, nC) > thresh;
    });
  }

  function getLastAnswersSinceThreadStart(limit=3) {
    const start = state.threadStart || 0;
    return state.history.slice(start).filter(m => m.role === 'user').map(m => m.content).slice(-limit);
  }

  // Gabarits de secours si le modèle persiste à répéter
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
    // 1) Si doublon → demander rephrase
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
        if (alt?.question && !isDuplicate(alt.question, prev, last, 0.78)) {
          return alt.question;
        }
      } catch {}
      // 2) Fallback gabarits
      const pool = fallbackFollowups(qText);
      for (const cand of pool) {
        if (!isDuplicate(cand, prev, last, 0.78)) return cand;
      }
      // 3) Dernier recours : ajoute une contrainte de chiffres
      return `Sois concret sur "${qText}": indique un lieu précis, une date cible et une durée estimée.`;
    }
    return proposed;
  }

  async function showCurrentQuestion() {
    const q = currentQuestion(); const qid = q.id;
    const label = questionLabel();
    logAssistant(label);
    await swapQuestion(label);

    // démarrer un "thread" pour cette question
    state.threadStart = state.history.length;
    if (!state.followups[qid]) state.followups[qid] = [];
    // mémoriser la question de base (sans le préfixe Qn:)
    if (!state.followups[qid].includes(q.text)) state.followups[qid].push(q.text);

    // timer question
    state.timers.questionStartMs = Date.now();

    setProgress();

    // LOG
    logEvent({
      event: "question_shown",
      qid,
      qindex: state.idx,
      text: q.text,
      policy: getPolicyForQuestion(q)
    });
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

    // LOG
    logEvent({
      event: "question_shown",
      qid,
      qindex: state.idx,
      text: q.text,
      policy: getPolicyForQuestion(q)
    });
  }

  function escapeMermaid(s) {
    return String(s).replace(/[{}<>]/g, m => ({'{':'\\u007B','}':'\\u007D','<':'\\u003C','>':'\\u003E'}[m]));
  }

  // === Root image dans la mindmap (globe) ===
  function replaceRootWithImage(containerEl) {
    try {
      const svg = containerEl.querySelector('svg'); if (!svg) return;
      const texts = Array.from(svg.querySelectorAll('text'));
      const rootText = texts.find(t => (t.textContent || '').trim().toLowerCase().includes('mon projet'));
      if (!rootText) return;
      const rootGroup = rootText.closest('g') || svg;
      const circle = rootGroup.querySelector('circle, ellipse'); if (!circle) return;
      const isEllipse = circle.tagName.toLowerCase() === 'ellipse';
      let cx, cy, r, rx, ry;
      if (isEllipse) { cx = parseFloat(circle.getAttribute('cx')||'0'); cy = parseFloat(circle.getAttribute('cy')||'0'); rx = parseFloat(circle.getAttribute('rx')||'0'); ry = parseFloat(circle.getAttribute('ry')||'0'); }
      else { cx = parseFloat(circle.getAttribute('cx')||'0'); cy = parseFloat(circle.getAttribute('cy')||'0'); r = parseFloat(circle.getAttribute('r')||'0'); rx=r; ry=r; }
      const size = Math.max(10, Math.min(rx, ry) * 2 * 0.96);
      const x = cx - size/2, y = cy - size/2;
      rootText.style.display = 'none';
      circle.setAttribute('fill','none'); circle.setAttribute('stroke', circle.getAttribute('stroke') || '#d1d5db'); circle.setAttribute('stroke-width', circle.getAttribute('stroke-width') || '1.2');
      const defs = svg.querySelector('defs') || svg.insertBefore(document.createElementNS('http://www.w3.org/2000/svg','defs'), svg.firstChild);
      const clipId = 'rootClip-' + Math.random().toString(36).slice(2);
      const clip = document.createElementNS('http://www.w3.org/2000/svg','clipPath'); clip.setAttribute('id', clipId);
      const clipCircle = document.createElementNS('http://www.w3.org/2000/svg','circle'); clipCircle.setAttribute('cx', String(cx)); clipCircle.setAttribute('cy', String(cy)); clipCircle.setAttribute('r', String(Math.min(rx,ry)));
      clip.appendChild(clipCircle); defs.appendChild(clip);
      const img = document.createElementNS('http://www.w3.org/2000/svg','image');
      img.setAttributeNS('http://www.w3.org/1999/xlink','href', `./assets/globe.png?v=${window.APP_VERSION || Date.now()}`);
      img.setAttribute('x', String(x)); img.setAttribute('y', String(y));
      img.setAttribute('width', String(size)); img.setAttribute('height', String(size));
      img.setAttribute('preserveAspectRatio','xMidYMid slice'); img.setAttribute('clip-path', `url(#${clipId})`);
      if (circle.nextSibling) rootGroup.insertBefore(img, circle.nextSibling); else rootGroup.appendChild(img);
    } catch (e) { console.warn('replaceRootWithImage error', e); }
  }

  async function renderMindmap(summary) {
    const mm = [
      "mindmap",
      "  root((Mon projet))",
      "    🎯 Objectifs",
      ... (summary.objectifs || []).map(v => `      - ${escapeMermaid(v)}`),
      "    📋 Priorités",
      ... (summary.priorites || []).map(v => `      - ${escapeMermaid(v)}`),
      "    🎓 Format idéal",
      summary.format_ideal ? `      - ${escapeMermaid(summary.format_ideal)}` : "",
      summary.meta && summary.meta.duree_pref ? `      - Durée: ${escapeMermaid(summary.meta.duree_pref)}` : "",
      "    🗣️ Langue & niveau",
      summary.langue ? `      - ${escapeMermaid(summary.langue)}` : "",
      summary.niveau_actuel ? `      - Niveau actuel: ${escapeMermaid(summary.niveau_actuel)}` : "",
      summary.niveau_cible ? `      - Niveau cible: ${escapeMermaid(summary.niveau_cible)}` : "",
      summary.ambition_progression ? `      - Ambition: ${escapeMermaid(summary.ambition_progression)}` : "",
      "    ✨ Mon projet",
      summary.projet_phrase_ultra_positive ? `      - ${escapeMermaid(summary.projet_phrase_ultra_positive)}` : ""
    ].filter(Boolean).join("\n");

    const el = document.getElementById("mindmap");
    const { svg } = await mermaid.render("mindmap-svg", mm);
    el.innerHTML = svg;
    replaceRootWithImage(el);
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

  async function finalizeSummary() {
    try {
      const apiStart = performance.now();
      const sum = await window.Agent.summarize({ history: state.history });
      const apiMs = Math.round(performance.now() - apiStart);

      state.summary = sum; saveState();
      fillSummaryCards(sum);
      await renderMindmap(sum);
      questionStage.classList.add("hidden");
      welcomeStage.classList.add("hidden");
      summaryStage.classList.remove("hidden");

      logEvent({ event: "summary_generated", api_ms: apiMs, objectives_count: (sum.objectifs||[]).length });
    } catch (e) { alert(e.message || e); }
    finally { setComposerEnabled(true); }
  }

  // ---- Export log ----
  function exportLog() {
    const payload = {
      app_version: window.APP_VERSION || "dev",
      exported_at: nowISO(),
      questions_meta: state.questions.map(q => ({
        id: q.id, text: q.text,
        max_followups: q.max_followups ?? 5,
        skip_revisit: Boolean(q.skip_revisit)
      })),
      logs: state.logs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `orientation-log-${stamp}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Handlers ----
  async function onSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    const q = (state.phase === "revisit" && state.currentRevisit)
      ? { id: state.currentRevisit.id, text: state.currentRevisit.text }
      : currentQuestion();

    // LOG réponse élève (+ temps de réponse à partir de l’affichage de la question)
    const responseMs = state.timers.questionStartMs ? (Date.now() - state.timers.questionStartMs) : null;
    logEvent({ event: "user_answer", qid: q?.id, qindex: state.idx, answer: text, response_ms: responseMs });

    logUser(text);
    setComposerEnabled(false);

    try {
      if (state.phase === "revisit" && state.currentRevisit) {
        const qText = state.currentRevisit.text;
        const apiStart = performance.now();
        const res = await window.Agent.decideNext({
          history: state.history, question: qText, answer: text,
          hint_followup: "", followup_count: 0,
          previous_followups: [], last_answers: getLastAnswersSinceThreadStart(),
          last_assistant: lastAssistant(),
          max_followups: 5, skip_revisit: false
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

        // passage à la question suivante
        logEvent({ event: "next_question", from_qid: qid });

        state.idx = Math.min(state.idx + 1, state.questions.length);
        if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
      } else {
        const nextAttempts = attempts + 1;
        state.attempts[qid] = nextAttempts; saveState();

        // Mémoriser points manquants pour la reprise (si autorisée)
        const lastUserAnswers = state.history.filter(t => t.role === "user").slice(-2).map(t => t.content);
        const missing = decision.missing_points || [];
        const existingIdx = state.unsatisfied.findIndex(x => x.id === qid);
        if (!policy.skip_revisit) {
          if (existingIdx === -1) state.unsatisfied.push({ id: qid, questionText: q.text, last_answers: lastUserAnswers, missing_points: missing });
          else { state.unsatisfied[existingIdx].last_answers = lastUserAnswers; state.unsatisfied[existingIdx].missing_points = missing; }
        }

        if (decision.next_action === "ask_followup" && nextAttempts < policy.max_followups) {
          // Anti-duplication stricte
          let fup = await ensureNonDuplicateFollowup(decision.followup_question || "", q.text, qid);
          // mémoriser et afficher
          state.followups[qid] = [...previous_followups, fup]; saveState();

          // LOG follow-up
          logEvent({ event: "followup_asked", qid, attempt: nextAttempts, text: fup });

          await swapQuestion(fup); logAssistant(fup);

          // Redémarrer le timer de réponse pour cette sous-question
          state.timers.questionStartMs = Date.now();
        } else {
          // cap atteint ou modèle propose de passer
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
      state.attempts[q.id] = 0;
      saveState();
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
  btnExportSvg?.addEventListener("click", () => {
    const svg = document.querySelector("#mindmap svg");
    if (!svg) return alert("Mindmap non disponible.");
    const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mindmap.svg"; a.click();
    URL.revokeObjectURL(url);
  });
  btnExportLog?.addEventListener("click", exportLog); // NEW

  // ---- Bootstrap ----
  loadState();

  try {
    const qsVersion = (window.APP_VERSION || Date.now());
    const res = await fetch(`./data/questions.json?v=${qsVersion}`);
    state.questions = await res.json();
  } catch { alert("Impossible de charger data/questions.json"); return; }

  // Nettoie les entrées "insatisfaites" pour les questions exclues de la reprise (sessions existantes)
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
