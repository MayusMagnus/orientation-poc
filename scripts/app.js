// scripts/app.js
//
// Logique UI: charge les questions, gère l'état, parle à window.Agent, rend la mindmap.

(async function () {
  // --- DOM refs ---
  const chatlog = document.getElementById("chatlog");
  const input = document.getElementById("input");
  const btnSend = document.getElementById("btnSend");
  const btnSkip = document.getElementById("btnSkip");
  const btnFinish = document.getElementById("btnFinish");
  const btnExportSvg = document.getElementById("btnExportSvg");
  const btnReset = document.getElementById("btnReset");
  const btnSettings = document.getElementById("btnSettings");
  const progressBar = document.getElementById("progressBar");
  const summaryCards = document.getElementById("summaryCards");

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

  // --- State ---
  const state = {
    idx: 0,
    followupAsked: false,
    history: [],
    finished: false,
    summary: null,
    questions: [],
    // ✅ NOUVEAU :
    attempts: {},         // { [questionId]: number }
    unsatisfied: [],      // [{ id, questionText, missing_points?: string[], last_answers?: string[] }]
    phase: "main",        // "main" | "revisit" | "done"
    revisitQueue: [],     // array of question ids to revisit
    currentRevisit: null  // { id, text } reformulated question currently asked
  };

  function saveState() {
    sessionStorage.setItem("orientation_state", JSON.stringify({
      idx: state.idx,
      followupAsked: state.followupAsked,
      history: state.history,
      finished: state.finished,
      summary: state.summary,
      attempts: state.attempts,
      unsatisfied: state.unsatisfied,
      phase: state.phase,
      revisitQueue: state.revisitQueue,
      currentRevisit: state.currentRevisit
    }));
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem("orientation_state");
      if (raw) Object.assign(state, JSON.parse(raw));
    } catch {}
  }

  function setProgress() {
    const total = state.questions.length || 1;
    const basePct = Math.min(100, Math.round((state.idx / total) * 100));
    // En phase de reprise, on peut afficher une légère progression fixe :
    progressBar.style.width = (state.phase === "main" ? basePct : 100) + "%";
  }

  function currentQuestion() {
    return state.questions[state.idx];
  }

  function getQuestionById(id) {
    return state.questions.find(q => q.id === id);
  }

  function appendMsg(role, text) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.textContent = text;
    chatlog.appendChild(div);
    chatlog.scrollTop = chatlog.scrollHeight;
    state.history.push({ role, content: text });
    saveState();
  }

  function showCurrentQuestion() {
    const q = currentQuestion();
    if (!q) return;
    appendMsg("assistant", `Q${state.idx + 1}: ${q.text}`);
    setProgress();
  }

  function setComposerEnabled(on) {
    input.disabled = !on; btnSend.disabled = !on; btnSkip.disabled = !on; btnFinish.disabled = !on;
  }

  function showError(err) {
    const div = document.createElement("div");
    div.className = "msg assistant";
    div.innerHTML = `⚠️ <span class="error">${(err && err.message) ? err.message : err}</span>`;
    chatlog.appendChild(div);
    chatlog.scrollTop = chatlog.scrollHeight;
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

  // ---------- Phase de reprise (revisit) ----------

  function startRevisitPhase() {
    if (!state.unsatisfied.length) {
      return finalizeSummary(); // rien à reprendre
    }
    state.phase = "revisit";
    state.revisitQueue = state.unsatisfied.map(x => x.id);
    saveState();
    appendMsg("assistant", "🔁 Reprenons rapidement les questions restées sans réponse satisfaisante.");
    askNextRevisit();
  }

  async function askNextRevisit() {
    if (!state.revisitQueue.length) {
      state.phase = "done"; saveState();
      return finalizeSummary();
    }
    const qid = state.revisitQueue[0];
    const q = getQuestionById(qid);
    const meta = state.unsatisfied.find(x => x.id === qid) || {};
    // Reformulation par l'agent
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
      appendMsg("assistant", `🔁 ${reformulated}`);
    } catch (e) {
      // En cas d'échec, poser la question originale
      state.currentRevisit = { id: qid, text: q.text };
      saveState();
      appendMsg("assistant", `🔁 ${q.text}`);
    }
  }

  function completeCurrentRevisit() {
    // Retire l'élément en tête de queue et passe au suivant
    state.revisitQueue.shift();
    state.currentRevisit = null;
    saveState();
    return askNextRevisit();
  }

  async function finalizeSummary() {
    // Synthèse finale après la reprise
    try {
      const sum = await window.Agent.summarize({ history: state.history });
      state.summary = sum; saveState();
      fillSummaryCards(sum);
      await renderMindmap(sum);
      appendMsg("assistant", "Synthèse et mindmap générées ✅");
    } catch (e) {
      showError(e);
    } finally {
      setComposerEnabled(true);
    }
  }

  // ---------- Handlers ----------

  async function onSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendMsg("user", text);
    setComposerEnabled(false);

    try {
      if (state.phase === "revisit" && state.currentRevisit) {
        // En reprise, on pose UNE question reformulée et on juge sans follow-up
        const qText = state.currentRevisit.text;
        const res = await window.Agent.decideNext({
          history: state.history,
          question: qText,
          answer: text,
          hint_followup: "",              // pas de hint en phase finale
          followup_already_asked: true    // empêche les follow-ups
        });
        // On n'insiste pas : qu'elle soit answered true/false, on avance
        if (res?.answered === true) {
          appendMsg("assistant", "Merci, c’est clair. ✅");
        } else {
          appendMsg("assistant", "Merci, je note ta réponse. ✔️");
        }
        return completeCurrentRevisit();
      }

      // --- Phase principale ---
      const q = currentQuestion();
      const decision = await window.Agent.decideNext({
        history: state.history,
        question: q.text,
        answer: text,
        hint_followup: q.hint,
        followup_already_asked: state.followupAsked
      });

      const qid = q.id;
      const attempts = state.attempts[qid] || 0;

      if (decision.answered === true) {
        // Réponse satisfaisante → passer à la suivante
        state.attempts[qid] = 0;
        state.followupAsked = false;
        saveState();
        state.idx = Math.min(state.idx + 1, state.questions.length);
        if (state.idx < state.questions.length) {
          showCurrentQuestion();
        } else {
          await onFinish(); // fin du premier tour
        }
      } else {
        // Réponse insuffisante
        const nextAttempts = attempts + 1;
        state.attempts[qid] = nextAttempts;

        // Stocker un snapshot utile pour la reprise
        const lastUserAnswers = state.history.filter(t => t.role === "user").slice(-2).map(t => t.content);
        const missing = decision.missing_points || [];
        const existingIdx = state.unsatisfied.findIndex(x => x.id === qid);
        if (existingIdx === -1) {
          state.unsatisfied.push({ id: qid, questionText: q.text, last_answers: lastUserAnswers, missing_points: missing });
        } else {
          // mise à jour
          const entry = state.unsatisfied[existingIdx];
          entry.last_answers = lastUserAnswers;
          entry.missing_points = missing;
        }

        if (decision.next_action === "ask_followup" && !state.followupAsked && nextAttempts < 2) {
          // 1ère tentative insuffisante → poser UNE follow-up
          state.followupAsked = true; saveState();
          appendMsg("assistant", decision.followup_question || "Peux-tu préciser ?");
        } else {
          // Déjà une follow-up OU 2ème tentative insuffisante → marquer insatisfait et avancer
          state.followupAsked = false; saveState();
          state.idx = Math.min(state.idx + 1, state.questions.length);
          if (state.idx < state.questions.length) {
            appendMsg("assistant", "Merci, on passe à la question suivante.");
            showCurrentQuestion();
          } else {
            await onFinish();
          }
        }
      }
    } catch (e) {
      showError(e);
    } finally {
      setComposerEnabled(true);
    }
  }

  async function onSkip() {
    // Passage manuel → reset follow-up & tentatives pour la question courante
    const q = currentQuestion();
    if (q) {
      state.attempts[q.id] = 0;
      state.followupAsked = false;
      saveState();
    }
    state.idx = Math.min(state.idx + 1, state.questions.length);
    if (state.idx < state.questions.length) showCurrentQuestion();
    else await onFinish();
  }

  async function onFinish() {
    if (state.phase !== "main") {
      // Si déjà en reprise, laisser finalizeSummary gérer
      if (state.phase === "revisit" && !state.revisitQueue.length) {
        return finalizeSummary();
      }
      return;
    }
    // Fin du premier tour : basculer en reprise si nécessaire
    if (state.unsatisfied.length > 0) {
      setComposerEnabled(true); // on garde l'input actif
      return startRevisitPhase();
    }
    // Sinon synthèse directe
    return finalizeSummary();
  }

  // --- API modal / settings ---

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

  document.getElementById("apiSaveBtn")?.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    const base = apiBaseInput.value.trim() || "https://api.openai.com/v1";
    const model = apiModelInput.value.trim() || "gpt-4o-mini";
    if (!key.startsWith("sk-")) {
      alert("Clé invalide (doit commencer par sk-).");
      return;
    }
    window.Agent.configure({ apiKey: key, baseUrl: base, model });
    if (rememberKey.checked) sessionStorage.setItem("OPENAI_KEY", key);
    sessionStorage.setItem("OPENAI_BASE", base);
    sessionStorage.setItem("OPENAI_MODEL", model);
  });

  settingsSaveBtn.addEventListener("click", () => {
    const base = settingsApiBase.value.trim();
    const model = settingsApiModel.value.trim();
    window.Agent.configure({ baseUrl: base, model });
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
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } });
  btnSkip.addEventListener("click", onSkip);
  btnFinish.addEventListener("click", onFinish);
  btnExportSvg.addEventListener("click", exportSVG);

  // --- Bootstrap ---
  loadState();

  // Charger questions
  try {
    const res = await fetch("./data/questions.json");
    state.questions = await res.json();
  } catch {
    alert("Impossible de charger data/questions.json");
    return;
  }

  // Clé ?
  const key = sessionStorage.getItem("OPENAI_KEY");
  const base = sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
  const model = sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
  if (key) window.Agent.configure({ apiKey: key, baseUrl: base, model });

  if (!key) {
    // Demander la clé si absente
    if (typeof apiModal?.showModal === "function") apiModal.showModal();
  }

  // Restaurer interface
  if (state.history.length === 0) {
    showCurrentQuestion();
  } else {
    for (const t of state.history) appendMsg(t.role, t.content);
    setProgress();
    if (state.phase === "revisit" && state.currentRevisit) {
      appendMsg("assistant", `🔁 ${state.currentRevisit.text}`);
    }
    if (state.summary) { fillSummaryCards(state.summary); renderMindmap(state.summary); }
  }
})();
