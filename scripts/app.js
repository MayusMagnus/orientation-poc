// scripts/app.js
//
// UI épurée : une seule question à l'écran, transitions en fondu, toast de bienvenue.

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
  const btnReset = document.getElementById("btnReset");
  const btnSettings = document.getElementById("btnSettings");

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
  const summaryCards = document.getElementById("summaryCards");
  const welcomeToast = document.getElementById("welcomeToast");

  // ---- State ----
  const state = {
    questions: [],
    idx: 0,
    followupAsked: false,
    // historique invisible (pour l'agent)
    history: [],
    // synthèse
    summary: null,
    // logique tentatives et reprise (déjà implémentée précédemment)
    attempts: {},
    unsatisfied: [],
    phase: "main",        // "main" | "revisit" | "done"
    revisitQueue: [],
    currentRevisit: null
  };

  // ---- Helpers ----
  function saveState() {
    sessionStorage.setItem("orientation_state", JSON.stringify(state));
  }
  function loadState() {
    try {
      const raw = sessionStorage.getItem("orientation_state");
      if (raw) Object.assign(state, JSON.parse(raw));
    } catch {}
  }

  function setProgress() {
    const total = state.questions.length || 1;
    const pct = state.phase === "main"
      ? Math.min(100, Math.round((state.idx / total) * 100))
      : 100;
    progressBar.style.width = pct + "%";
  }

  function currentQuestion() {
    return state.questions[state.idx];
  }

  // Historique interne (non affiché)
  function logAssistant(text){ state.history.push({ role:"assistant", content:text }); saveState(); }
  function logUser(text){ state.history.push({ role:"user", content:text }); saveState(); }

  function setComposerEnabled(on) {
    input.disabled = !on; btnSend.disabled = !on; btnSkip.disabled = !on; btnFinish.disabled = !on;
  }

  // Fondu sortant → maj → fondu entrant
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

  function showCurrentQuestion() {
    const q = currentQuestion();
    if (!q) return;
    const label = `Q${state.idx + 1}: ${q.text}`;
    logAssistant(label);
    return swapQuestion(label).then(() => setProgress());
  }

  function showRevisitQuestion(text) {
    const label = `🔁 ${text}`;
    logAssistant(label);
    return swapQuestion(label);
  }

  function showToast() {
    welcomeToast.classList.remove("hidden");
    welcomeToast.classList.add("show");
    setTimeout(() => {
      welcomeToast.classList.remove("show");
      setTimeout(() => welcomeToast.classList.add("hidden"), 2000);
    }, 2600);
  }

  function escapeMermaid(s) {
    return String(s).replace(/[{}<>]/g, m => ({'{':'\\u007B','}':'\\u007D','<':'\\u003C','>':'\\u003E'}[m]));
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

  function exportSVG() {
    const svg = document.querySelector("#mindmap svg");
    if (!svg) return alert("Mindmap non disponible.");
    const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mindmap.svg"; a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Phase de reprise (inchangée fonctionnellement) ----
  function startRevisitPhase() {
    if (!state.unsatisfied.length) {
      return finalizeSummary();
    }
    state.phase = "revisit";
    state.revisitQueue = state.unsatisfied.map(x => x.id);
    saveState();
    // Pas d'historique affiché, juste la prochaine question reformulée
    askNextRevisit();
  }

  async function askNextRevisit() {
    if (!state.revisitQueue.length) {
      state.phase = "done"; saveState();
      return finalizeSummary();
    }
    const qid = state.revisitQueue[0];
    const q = state.questions.find(x => x.id === qid);
    const meta = state.unsatisfied.find(x => x.id === qid) || {};
    try {
      const last_answers = meta.last_answers || [];
      const missing_points = meta.missing_points || [];
      const ref = await window.Agent.reformulate({
        original_question: q.text,
        last_answers,
        missing_points
      });
      const reformulated = ref.reformulated_question || q.text;
      state.currentRevisit = { id: qid, text: reformulated };
      saveState();
      await showRevisitQuestion(reformulated);
    } catch {
      state.currentRevisit = { id: qid, text: q.text };
      saveState();
      await showRevisitQuestion(q.text);
    }
  }

  function completeCurrentRevisit() {
    state.revisitQueue.shift();
    state.currentRevisit = null;
    saveState();
    return askNextRevisit();
  }

  async function finalizeSummary() {
    try {
      const sum = await window.Agent.summarize({ history: state.history });
      state.summary = sum; saveState();
      fillSummaryCards(sum);
      await renderMindmap(sum);
      // Afficher la section synthèse, masquer la question
      questionStage.classList.add("hidden");
      summaryStage.classList.remove("hidden");
    } catch (e) {
      alert(e.message || e);
    } finally {
      setComposerEnabled(true);
    }
  }

  // ---- Handlers ----
  async function onSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    logUser(text);
    setComposerEnabled(false);

    try {
      if (state.phase === "revisit" && state.currentRevisit) {
        const qText = state.currentRevisit.text;
        const res = await window.Agent.decideNext({
          history: state.history, question: qText, answer: text,
          hint_followup: "", followup_already_asked: true
        });
        // Avance sans s'attarder
        logAssistant(res?.answered === true ? "Merci, c’est clair. ✅" : "Merci, je note ta réponse. ✔️");
        return await completeCurrentRevisit();
      }

      // Phase principale
      const q = currentQuestion();
      const decision = await window.Agent.decideNext({
        history: state.history, question: q.text, answer: text,
        hint_followup: q.hint, followup_already_asked: state.followupAsked
      });

      const qid = q.id;
      const attempts = state.attempts[qid] || 0;

      if (decision.answered === true) {
        state.attempts[qid] = 0;
        state.followupAsked = false;
        saveState();
        state.idx = Math.min(state.idx + 1, state.questions.length);
        if (state.idx < state.questions.length) {
          await showCurrentQuestion();
        } else {
          await onFinish();
        }
      } else {
        const nextAttempts = attempts + 1;
        state.attempts[qid] = nextAttempts;

        // stock pour reprise
        const lastUserAnswers = state.history.filter(t => t.role === "user").slice(-2).map(t => t.content);
        const missing = decision.missing_points || [];
        const existingIdx = state.unsatisfied.findIndex(x => x.id === qid);
        if (existingIdx === -1) {
          state.unsatisfied.push({ id: qid, questionText: q.text, last_answers: lastUserAnswers, missing_points: missing });
        } else {
          state.unsatisfied[existingIdx].last_answers = lastUserAnswers;
          state.unsatisfied[existingIdx].missing_points = missing;
        }

        if (decision.next_action === "ask_followup" && !state.followupAsked && nextAttempts < 2) {
          state.followupAsked = true; saveState();
          await swapQuestion(decision.followup_question || "Peux-tu préciser ?");
          logAssistant(decision.followup_question || "Peux-tu préciser ?");
        } else {
          state.followupAsked = false; saveState();
          state.idx = Math.min(state.idx + 1, state.questions.length);
          if (state.idx < state.questions.length) {
            await showCurrentQuestion();
          } else {
            await onFinish();
          }
        }
      }
    } catch (e) {
      alert(e.message || e);
    } finally {
      setComposerEnabled(true);
    }
  }

  async function onSkip() {
    const q = currentQuestion();
    if (q) {
      state.attempts[q.id] = 0;
      state.followupAsked = false;
      saveState();
    }
    state.idx = Math.min(state.idx + 1, state.questions.length);
    if (state.idx < state.questions.length) {
      await showCurrentQuestion();
    } else {
      await onFinish();
    }
  }

  async function onFinish() {
    if (state.phase !== "main") {
      if (state.phase === "revisit" && !state.revisitQueue.length) {
        return finalizeSummary();
      }
      return;
    }
    if (state.unsatisfied.length > 0) {
      return startRevisitPhase();
    }
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

  apiSaveBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    if (!key) { alert("Code requis."); return; }
    const base = (apiBaseInput?.value?.trim()) || sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
    const model = (apiModelInput?.value?.trim()) || sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
    window.Agent.configure({ apiKey:key, baseUrl:base, model });
    if (rememberKey.checked) sessionStorage.setItem("OPENAI_KEY", key);
    sessionStorage.setItem("OPENAI_BASE", base);
    sessionStorage.setItem("OPENAI_MODEL", model);
    // Toast de bienvenue
    showToast();
  });

  settingsSaveBtn.addEventListener("click", () => {
    const base = settingsApiBase.value.trim();
    const model = settingsApiModel.value.trim();
    window.Agent.configure({ baseUrl:base, model });
    sessionStorage.setItem("OPENAI_BASE", base);
    sessionStorage.setItem("OPENAI_MODEL", model);
  });

  btnReset.addEventListener("click", () => {
    sessionStorage.removeItem("orientation_state");
    sessionStorage.removeItem("OPENAI_KEY");
    sessionStorage.removeItem("OPENAI_BASE");
    sessionStorage.removeItem("OPENAI_MODEL");
    location.reload();
  });

  btnSettings.addEventListener("click", openSettings);
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

  // ---- Bootstrap ----
  loadState();

  // Charger questions (avec cache-busting)
  try {
    const qsVersion = (window.APP_VERSION || Date.now());
    const res = await fetch(`./data/questions.json?v=${qsVersion}`);
    state.questions = await res.json();
  } catch {
    alert("Impossible de charger data/questions.json");
    return;
  }

  // Config clé
  const key = sessionStorage.getItem("OPENAI_KEY");
  const base = sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
  const model = sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
  if (key) window.Agent.configure({ apiKey:key, baseUrl:base, model });
  if (!key && typeof apiModal?.showModal === "function") apiModal.showModal();

  // Afficher la question actuelle
  if (state.phase === "revisit" && state.currentRevisit) {
    await showRevisitQuestion(state.currentRevisit.text);
  } else if (state.questions.length) {
    if (state.history.length === 0) {
      showQuestionNow(`Q${state.idx + 1}: ${state.questions[state.idx].text}`);
      logAssistant(`Q${state.idx + 1}: ${state.questions[state.idx].text}`);
      setProgress();
    } else {
      // Si historique, montrer la question actuelle sans rejouer tout
      showQuestionNow(state.history.filter(h => h.role==="assistant").slice(-1)[0]?.content || `Q${state.idx + 1}: ${state.questions[state.idx].text}`);
      setProgress();
    }
  }
})();
