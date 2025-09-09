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
    questions: []
  };

  function saveState() {
    sessionStorage.setItem("orientation_state", JSON.stringify({
      idx: state.idx,
      followupAsked: state.followupAsked,
      history: state.history,
      finished: state.finished,
      summary: state.summary
    }));
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem("orientation_state");
      if (raw) Object.assign(state, JSON.parse(raw));
    } catch {}
  }

  function setProgress() {
    const pct = Math.min(100, Math.round((state.idx / state.questions.length) * 100));
    progressBar.style.width = pct + "%";
  }

  function currentQuestion() {
    return state.questions[state.idx];
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

  // --- Handlers ---

  async function onSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendMsg("user", text);
    setComposerEnabled(false);
    try {
      const q = currentQuestion();
      const decision = await window.Agent.decideNext({
        history: state.history,
        question: q.text,
        answer: text,
        hint_followup: q.hint,
        followup_already_asked: state.followupAsked
      });
      if (decision.next_action === "ask_followup" && !state.followupAsked) {
        appendMsg("assistant", decision.followup_question || "Peux-tu préciser ?");
        state.followupAsked = true;
        saveState();
      } else if (decision.next_action === "next_question") {
        state.idx = Math.min(state.idx + 1, state.questions.length);
        state.followupAsked = false;
        saveState();
        if (state.idx < state.questions.length) showCurrentQuestion();
        else await onFinish();
      } else if (decision.next_action === "finish") {
        await onFinish();
      } else {
        state.idx = Math.min(state.idx + 1, state.questions.length);
        state.followupAsked = false;
        saveState();
        if (state.idx < state.questions.length) showCurrentQuestion();
        else await onFinish();
      }
    } catch (e) {
      showError(e);
    } finally {
      setComposerEnabled(true);
    }
  }

  async function onSkip() {
    state.idx = Math.min(state.idx + 1, state.questions.length);
    state.followupAsked = false;
    saveState();
    if (state.idx < state.questions.length) showCurrentQuestion();
    else await onFinish();
  }

  async function onFinish() {
    if (state.finished) return;
    state.finished = true; saveState();
    setComposerEnabled(false);
    appendMsg("assistant", "Merci ! Je prépare une synthèse positive de ton projet…");
    try {
      const sum = await window.Agent.summarize({ history: state.history });
      state.summary = sum; saveState();
      fillSummaryCards(sum);
      await renderMindmap(sum);
      appendMsg("assistant", "Synthèse et mindmap générées ✅");
    } catch (e) {
      showError(e);
    }
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

  apiSaveBtn.addEventListener("click", () => {
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
  btnExportSvg.addEventListener("click", () => {
    const svg = document.querySelector("#mindmap svg");
    if (!svg) return alert("Mindmap non disponible.");
    const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mindmap.svg"; a.click();
    URL.revokeObjectURL(url);
  });

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

  if (!key) openApiModal();

  // Restaurer interface
  if (state.history.length === 0) {
    showCurrentQuestion();
  } else {
    for (const t of state.history) appendMsg(t.role, t.content);
    setProgress();
    if (state.summary) { fillSummaryCards(state.summary); renderMindmap(state.summary); }
  }
})();
