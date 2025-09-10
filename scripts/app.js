// scripts/app.js
//
// UI épurée + transitions + Mindmap (root image).
// Logique MAJ : on creuse jusqu’à 5 follow-ups max/question.

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
    // attempts = nb de follow-ups posés pour une question (clé = question.id)
    attempts: {},
    // liste de questions insuffisamment couvertes (pour reprise)
    unsatisfied: [],
    phase: "main",        // "main" | "revisit" | "done"
    revisitQueue: [],
    currentRevisit: null
  };

  // Storage versionné (évite conflit si ordre/questions ont changé)
  const STORAGE_KEY = 'orientation_state_' + (window.APP_VERSION || 'dev');

  function saveState() { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function loadState() {
    try { const raw = sessionStorage.getItem(STORAGE_KEY); if (raw) Object.assign(state, JSON.parse(raw)); } catch {}
  }

  function setProgress() {
    const total = state.questions.length || 1;
    const pct = state.phase === "main" ? Math.min(100, Math.round((state.idx / total) * 100)) : 100;
    progressBar.style.width = pct + "%";
  }

  function currentQuestion() { return state.questions[state.idx]; }

  function logAssistant(text){ state.history.push({ role:"assistant", content:text }); saveState(); }
  function logUser(text){ state.history.push({ role:"user", content:text }); saveState(); }

  function setComposerEnabled(on) {
    input.disabled = !on; btnSend.disabled = !on; btnSkip.disabled = !on; btnFinish.disabled = !on;
  }

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

  async function showCurrentQuestion() {
    const label = questionLabel();
    logAssistant(label);
    await swapQuestion(label);
    setProgress();
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

    const label = questionLabel();
    logAssistant(label);
    showQuestionNow(label);
    setProgress();
  }

  function escapeMermaid(s) {
    return String(s).replace(/[{}<>]/g, m => ({'{':'\\u007B','}':'\\u007D','<':'\\u003C','>':'\\u003E'}[m]));
  }

  // Remplacement root par une image (globe)
  function replaceRootWithImage(containerEl, imageHref) {
    try {
      const svg = containerEl.querySelector('svg');
      if (!svg) return;
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
      summary.niveau_actuel ? `      - ${escapeMermaid(summary.niveau_actuel)}` : "",
      summary.niveau_cible ? `      - ${escapeMermaid(summary.niveau_cible)}` : "",
      summary.ambition_progression ? `      - ${escapeMermaid(summary.ambition_progression)}` : "",
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
    state.revisitQueue = state.unsatisfied.map(x => x.id);
    saveState();
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
      const ref = await window.Agent.reformulate({ original_question: q.text, last_answers, missing_points });
      const reformulated = ref.reformulated_question || q.text;
      state.currentRevisit = { id: qid, text: reformulated }; saveState();
      await swapQuestion(`🔁 ${reformulated}`); logAssistant(`🔁 ${reformulated}`);
    } catch {
      state.currentRevisit = { id: qid, text: q.text }; saveState();
      await swapQuestion(`🔁 ${q.text}`); logAssistant(`🔁 ${q.text}`);
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
      questionStage.classList.add("hidden");
      welcomeStage.classList.add("hidden");
      summaryStage.classList.remove("hidden");
    } catch (e) { alert(e.message || e); }
    finally { setComposerEnabled(true); }
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
          hint_followup: "", followup_count: 0 // en reprise, on avance dès qu’on a une réponse
        });
        logAssistant(res?.answered === true ? "Merci, c’est clair. ✅" : "Merci, je note ta réponse. ✔️");
        return await completeCurrentRevisit();
      }

      // Phase principale
      const q = currentQuestion();
      const qid = q.id;
      const attempts = state.attempts[qid] || 0;

      const decision = await window.Agent.decideNext({
        history: state.history, question: q.text, answer: text,
        hint_followup: q.hint, followup_count: attempts
      });

      if (decision.answered === true) {
        // question couverte → reset compteur + next
        state.attempts[qid] = 0; saveState();
        state.idx = Math.min(state.idx + 1, state.questions.length);
        if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
      } else {
        const nextAttempts = (attempts + 1);
        state.attempts[qid] = nextAttempts; saveState();

        // marquer pour reprise (points manquants + dernières réponses)
        const lastUserAnswers = state.history.filter(t => t.role === "user").slice(-2).map(t => t.content);
        const missing = decision.missing_points || [];
        const existingIdx = state.unsatisfied.findIndex(x => x.id === qid);
        if (existingIdx === -1) state.unsatisfied.push({ id: qid, questionText: q.text, last_answers: lastUserAnswers, missing_points: missing });
        else { state.unsatisfied[existingIdx].last_answers = lastUserAnswers; state.unsatisfied[existingIdx].missing_points = missing; }

        // si modèle veut creuser ET qu’on n’a pas atteint 5 follow-ups → poser la follow-up
        if (decision.next_action === "ask_followup" && nextAttempts < 5) {
          await swapQuestion(decision.followup_question || "Peux-tu préciser ?");
          logAssistant(decision.followup_question || "Peux-tu préciser ?");
        } else {
          // sinon on avance (cap atteint ou modèle dit de passer)
          state.attempts[qid] = 0; saveState();
          state.idx = Math.min(state.idx + 1, state.questions.length);
          if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
        }
      }
    } catch (e) { alert(e.message || e); }
    finally { setComposerEnabled(true); }
  }

  async function onSkip() {
    const q = currentQuestion();
    if (q) { state.attempts[q.id] = 0; saveState(); }
    state.idx = Math.min(state.idx + 1, state.questions.length);
    if (state.idx < state.questions.length) await showCurrentQuestion(); else await onFinish();
  }

  async function onFinish() {
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
    await transitionWelcomeToQuestion();
  });

  settingsSaveBtn.addEventListener("click", () => {
    const base = settingsApiBase.value.trim();
    const model = settingsApiModel.value.trim();
    window.Agent.configure({ baseUrl:base, model });
    sessionStorage.setItem("OPENAI_BASE", base);
    sessionStorage.setItem("OPENAI_MODEL", model);
  });

  btnReset.addEventListener("click", () => {
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

  // ---- Bootstrap ----
  loadState();

  try {
    const qsVersion = (window.APP_VERSION || Date.now());
    const res = await fetch(`./data/questions.json?v=${qsVersion}`);
    state.questions = await res.json();
  } catch { alert("Impossible de charger data/questions.json"); return; }

  const key = sessionStorage.getItem("OPENAI_KEY");
  const base = sessionStorage.getItem("OPENAI_BASE") || "https://api.openai.com/v1";
  const model = sessionStorage.getItem("OPENAI_MODEL") || "gpt-4o-mini";
  if (key) window.Agent.configure({ apiKey:key, baseUrl:base, model });

  if (state.history.length > 0 || key) {
    welcomeStage.classList.add("hidden");
    questionStage.classList.remove("hidden");
    if (state.summary) { questionStage.classList.add("hidden"); summaryStage.classList.remove("hidden"); }
    else if (state.phase === "revisit" && state.currentRevisit) { questionText.textContent = `🔁 ${state.currentRevisit.text}`; }
    else { const lastAssistant = state.history.filter(h => h.role==="assistant").slice(-1)[0]?.content; questionText.textContent = lastAssistant || questionLabel(); setProgress(); }
  } else {
    if (typeof apiModal?.showModal === "function") apiModal.showModal();
  }
})();
