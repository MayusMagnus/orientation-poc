// scripts/agent.js
//
// Agent côté front : appels OpenAI et logique.
// - decideNext : cap 4, pas de reprise
// - summarize / recap : encadrés + narratif (synthèse priorise la FICHE)
// - extractFicheUpdate : patch q1..q10
// - findFicheGaps : sélectionne jusqu’à N variables vides et génère des questions
// - fillFicheFromAnswer : retourne une valeur à écrire à un path donné, sans toucher le reste

(function () {
  const Agent = {};
  let CONFIG = { apiKey: null, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };

  Agent.configure = ({ apiKey, baseUrl, model }) => {
    if (apiKey) CONFIG.apiKey = apiKey;
    if (baseUrl) CONFIG.baseUrl = baseUrl;
    if (model) CONFIG.model = model;
  };

  function headers() {
    if (!CONFIG.apiKey) throw new Error("Code d’accès manquant.");
    return { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.apiKey}` };
  }

  async function chat(messages, { json = false, temperature = 0.3, max_tokens = 700 } = {}) {
    const body = { model: CONFIG.model, messages, temperature, max_tokens };
    if (json) body.response_format = { type: "json_object" };
    const res = await fetch(`${CONFIG.baseUrl.replace(/\/+$/,'')}/chat/completions`, {
      method: "POST", headers: headers(), body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText || "Erreur OpenAI");
    return (data.choices?.[0]?.message?.content || "").trim();
  }

  function compactHistory(history, maxTurns = 30) {
    if (!Array.isArray(history)) return "";
    const last = history.slice(-maxTurns);
    return last.map(t => `${t.role === "user" ? "Élève" : "Agent"}: ${t.content}`).join("\n");
  }

  const J = (x) => JSON.stringify(x);
  const safeParseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // --- Helpers "fiche -> seed de synthèse" ---
  function cecrOrder(level) {
    const map = { A1:1, A2:2, B1:3, B2:4, C1:5, C2:6 };
    return map[level] || 0;
  }
  function mapTypeSejourLabel(t) {
    const m = {
      etudes: "Études",
      stage: "Stage",
      volontariat: "Volontariat",
      job: "Job",
      sejour_linguistique: "Séjour linguistique",
      cesure: "Année de césure"
    };
    return m[t] || "";
  }

  /**
   * Construit un "seed" de synthèse à partir de la fiche (source prioritaire).
   * On ne met QUE des infos dont on est sûr côté fiche (sinon on laisse vide).
   */
  function deriveSummaryFromFiche(fiche = {}) {
    const seed = {
      objectifs: [],
      priorites: [],
      format_ideal: "",
      langue: "",
      niveau_actuel: "",
      niveau_cible: "",
      ambition_progression: "",
      projet_phrase_ultra_positive: ""
    };

    // Objectifs / priorité globale
    if (fiche.priorite_globale && fiche.priorite_globale !== "je_ne_sais_pas") {
      const map = {
        academique: "Réussite académique",
        professionnel: "Carrière/Expérience pro",
        personnel: "Ouverture personnelle"
      };
      const lab = map[fiche.priorite_globale] || "";
      if (lab) seed.objectifs.push(lab);
    }
    if (fiche.raison_depart) seed.objectifs.push(fiche.raison_depart);

    // Priorités apprentissages Top 3
    if (Array.isArray(fiche.priorites_apprentissages) && fiche.priorites_apprentissages.length) {
      const top = [...fiche.priorites_apprentissages]
        .sort((a,b) => (a.rang||99) - (b.rang||99))
        .slice(0,3)
        .map(p => p.axe).filter(Boolean);
      if (top.length) seed.priorites = top;
    }

    // Format idéal
    if (fiche.type_sejour) {
      seed.format_ideal = mapTypeSejourLabel(fiche.type_sejour);
    } else if (fiche.contexte_ideal) {
      seed.format_ideal = fiche.contexte_ideal;
    }

    // Langue + niveaux depuis langues_cibles[0]
    if (Array.isArray(fiche.langues_cibles) && fiche.langues_cibles.length) {
      const L0 = fiche.langues_cibles[0];
      if (L0?.langue) seed.langue = L0.langue;
      if (L0?.niveau_actuel_CECR) seed.niveau_actuel = L0.niveau_actuel_CECR;
      if (L0?.niveau_vise_CECR) seed.niveau_cible = L0.niveau_vise_CECR;

      const d = cecrOrder(L0?.niveau_vise_CECR) - cecrOrder(L0?.niveau_actuel_CECR);
      if (d >= 2) seed.ambition_progression = "forte";
      else if (d === 1) seed.ambition_progression = "modérée";
      else if (d <= 0 && (L0?.niveau_actuel_CECR || L0?.niveau_vise_CECR)) seed.ambition_progression = "stabilisation";
    }

    // Projet
    if (fiche.projet_phrase) {
      seed.projet_phrase_ultra_positive = fiche.projet_phrase;
    } else if (fiche.projet_structure) {
      const { lieu, duree_semaines, objectif } = fiche.projet_structure;
      const parts = [];
      if (lieu) parts.push(lieu);
      if (duree_semaines) parts.push(`${duree_semaines} semaines`);
      if (objectif) parts.push(objectif);
      if (parts.length) seed.projet_phrase_ultra_positive = parts.join(" · ");
    }

    seed.objectifs = [...new Set(seed.objectifs.filter(Boolean))];
    seed.priorites = [...new Set(seed.priorites.filter(Boolean))];
    return seed;
  }

  // === Decision: ask follow-up vs next question
  Agent.decideNext = async ({
    history = [], question, answer,
    hint_followup = "", followup_count = 0,
    previous_followups = [], last_answers = [],
    last_assistant = "",
    max_followups = 4,
    skip_revisit = false // compat
  }) => {
    const sys = [
      "Tu es un conseiller d’orientation exigeant et bienveillant. Tu t'adresses à un(e) lycéen(ne) français(e) qui veut partir à l'étranger. Ton objectif est de l’aider à clarifier son projet en posant des questions. Le séjour ne peut pas être inférieur à 6 mois",
      "RÈGLES:",
      "• Creuse chaque question (exemples, critères mesurables, qui/quoi/où/quand/combien/comment). Evite quand même les questions trop compliquées, il s'agit d'un lycéen.",
      "• Réponses vagues ou « je ne sais pas » → pas satisfaisant: reformule, propose des options, échelles (1-5), exemples. Au bout de 2 'je ne sais pas', passe à la question suivante.",
      "• NE JAMAIS répéter une sous-question déjà posée, ni reformuler exactement la question initiale, ni le DERNIER message de l’agent.",
      "• Pour éviter les répétitions, vérifie previous_followups et last_assistant et change d’angle.",
      "• Max 4 follow-ups par question. Ensuite, passe à la question suivante. Ne mémorise pas pour une reprise ultérieure.",
      "• Respecte strictement la limite max de sous-questions transmise.",
      "Réponds UNIQUEMENT en JSON valide."
    ].join("\n");

    const user = {
      question,
      student_answer: answer,
      hint_followup,
      followup_count,
      max_followups,
      previous_followups,
      last_assistant,
      last_answers,
      history_excerpt: compactHistory(history, 30),
      wanted_output: {
        answered: "boolean",
        next_action: "ask_followup | next_question",
        followup_question: "string",
        missing_points: "string[]",
        reason: "string"
      }
    };

    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.2, max_tokens: 550 }
    );

    const parsed = safeParseJSON(out) || {};
    if (typeof parsed.answered !== "boolean") parsed.answered = false;
    if (!parsed.next_action) parsed.next_action = parsed.answered ? "next_question" : "ask_followup";
    if (!Array.isArray(parsed.missing_points)) parsed.missing_points = [];
    if (parsed.next_action === "ask_followup" && !parsed.followup_question) {
      parsed.followup_question = "Précise avec un exemple concret (où, quand, durée, acteurs, budget).";
    }
    if (!parsed.reason) parsed.reason = parsed.answered ? "Couverture suffisante." : "Besoin de précisions ciblées.";
    return parsed;
  };

  // === Rephrase a follow-up to avoid duplication
  Agent.rephraseFollowup = async ({ base_followup, previous_followups = [], question, last_answers = [], last_assistant = "" }) => {
    const sys = "Tu proposes une variante de sous-question, courte, concrète, différente des formulations précédentes et du dernier message de l’agent. Pas d’intro.";
    const user = {
      base_followup, previous_followups, last_assistant, question, last_answers,
      constraints: [
        "Doit être significativement différente des previous_followups ET de last_assistant",
        "Changer d’angle: quand/où/combien/qui/comment mesurer/exemple chiffré"
      ],
      wanted_output: { question: "string" }
    };
    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) + '\nRéponds en JSON {"question":"..."}' }],
      { json: true, temperature: 0.4, max_tokens: 150 }
    );
    const parsed = safeParseJSON(out) || {};
    return { question: parsed.question || base_followup };
  };

  // === Summarize (FICHE = source prioritaire)
  Agent.summarize = async ({ history = [], fiche = {} }) => {
    const seed = deriveSummaryFromFiche(fiche);

    const sys = [
      "Tu produis une synthèse structurée à partir d'un dialogue ET d'un seed issu d'une fiche élève.",
      "LA FICHE (seed) EST LA SOURCE PRIORITAIRE: en cas de contradiction, tu conserves le seed.",
      "Tu peux compléter UNIQUEMENT les champs vides du seed avec des éléments du dialogue.",
      "Clés attendues (JSON strict):",
      "objectifs:string[], priorites:string[], format_ideal:string, langue:string, niveau_actuel:string, niveau_cible:string, ambition_progression:string, projet_phrase_ultra_positive:string, meta:object"
    ].join("\n");

    const user = {
      history_excerpt: compactHistory(history, 40),
      seed_from_fiche: seed,
      rules: [
        "Ne contredis pas seed_from_fiche.",
        "Si seed_from_fiche.langue/niveaux sont renseignés, NE LES MODIFIE PAS.",
        "Tu peux reformuler projet_phrase_ultra_positive pour le rendre plus positif, sans altérer les faits (lieu, durée, objectif).",
        "Réponds uniquement en JSON."
      ]
    };

    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.25, max_tokens: 700 }
    );
    const parsed = safeParseJSON(out) || {};

    // Typage minimal
    parsed.objectifs = Array.isArray(parsed.objectifs) ? parsed.objectifs : [];
    parsed.priorites = Array.isArray(parsed.priorites) ? parsed.priorites : [];
    parsed.meta = typeof parsed.meta === "object" && parsed.meta !== null ? parsed.meta : {};

    // Fusion finale: le SEED (fiche) écrase tout si présent
    const final = {
      objectifs: (seed.objectifs && seed.objectifs.length) ? seed.objectifs : parsed.objectifs || [],
      priorites: (seed.priorites && seed.priorites.length) ? seed.priorites : parsed.priorites || [],
      format_ideal: seed.format_ideal || parsed.format_ideal || "",
      langue: seed.langue || parsed.langue || "",
      niveau_actuel: seed.niveau_actuel || parsed.niveau_actuel || "",
      niveau_cible: seed.niveau_cible || parsed.niveau_cible || "",
      ambition_progression: seed.ambition_progression || parsed.ambition_progression || "",
      // On autorise l'LLM à polir la phrase ; si vide, on garde le seed
      projet_phrase_ultra_positive: parsed.projet_phrase_ultra_positive || seed.projet_phrase_ultra_positive || "",
      meta: parsed.meta || {}
    };

    final.objectifs = [...new Set(final.objectifs.filter(Boolean))];
    final.priorites = [...new Set(final.priorites.filter(Boolean))];
    return final;
  };

  // === Extraction fiche (par Q*)
  Agent.extractFicheUpdate = async ({ qid, question, answer, fiche }) => {
    const sys = [
      "Tu es un extracteur strict qui met à jour une fiche élève JSON selon une question/réponse.",
      "Ne déduis pas au-delà du raisonnable. Si l’info n’est pas explicite, laisse vide ou 'inconnu'.",
      "Les niveaux de langue sont CECR: A1,A2,B1,B2,C1,C2 ou 'inconnu'.",
      "Pour les langues cibles, N'INCLUS QUE les langues que l'élève souhaite pratiquer/améliorer.",
      "Réponds UNIQUEMENT en JSON avec: {\"patch\":{...}, \"alerts\": string[] }.",
      "Le 'patch' doit être un sous-ensemble valide du schéma de la fiche (mêmes clés/structures)."
    ].join("\n");

    const mapping = {
      q1: "Remplir: raison_depart (string), priorite_globale (academique|professionnel|personnel|je_ne_sais_pas), exemple_priorite (string).",
      q2: "Remplir: priorites_apprentissages[] (Top 3 triés par rang; axe in [langue,culture,autonomie,métier]; pourquoi_prioritaire pour rang=1).",
      q3: "Remplir: destinations_souhaitees[] (label, raison, attracteurs[]), criteres_environnement[] (liste courte), reve_absolu si expression explicite d'un rêve.",
      q4: "Remplir: langues_cibles[] (une entrée par langue souhaitée, niveaux CECR, taches_ok/difficiles), mini_tests_langue[] si tu poses/évalues une mini-situation.",
      q5: "Remplir: preference_culturelle.proximite (proche|depaysement), justification (string), fibre_aventure (1-5), attaches_familiales (1-5).",
      q6: "Remplir: type_sejour (etudes|stage|volontariat|job|sejour_linguistique|cesure), duree_preferee_semaines (number), contexte_ideal (string), flexibilites[].",
      q7: "Remplir: bourse.interet (oui|non|incertain), bourse.programmes_connus[] si cités, bourse.objectif_financement (partiel|total|indetermine).",
      q8: "Remplir: inquietudes[] (categorie, priorite 1|2, details, pistes_mitigation[]).",
      q9: "Remplir: experiences_passees[] (lieu, quand, cadre, duree_semaines, aime, pas_aime, lecons), experiences_non_depart_raison si pertinent.",
      q10:"Remplir: projet_phrase (string) et projet_structure (lieu, duree_semaines, objectif)."
    };

    const user = {
      qid, question, answer,
      fiche_excerpt: fiche,
      mapping_for_qid: mapping[qid] || "Ne rien remplir hors schéma."
    };

    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.2, max_tokens: 600 }
    );
    const parsed = safeParseJSON(out) || {};
    if (!parsed.patch || typeof parsed.patch !== "object") parsed.patch = {};
    if (!Array.isArray(parsed.alerts)) parsed.alerts = [];
    return parsed;
  };

  // === NEW: sélection des variables vides (jusqu'à N), génération de questions
  Agent.findFicheGaps = async ({ fiche, candidates = [], max_questions = 3, history = [] }) => {
    const sys = [
      "Tu dois choisir jusqu'à N variables VIDES de la fiche et générer une question simple et concrète pour chacune.",
      "NE PROPOSE QUE des 'path' présents dans la liste 'candidates'.",
      "Objectif: obtenir l'info minimale utile pour orienter. Pas de double question.",
      "Réponds UNIQUEMENT en JSON: { targets: [ { path, question, why } ] }."
    ].join("\n");

    const user = {
      fiche_excerpt: fiche,
      candidates,            // [{path, type, note}]
      max_questions,
      history_excerpt: compactHistory(history, 30)
    };

    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.3, max_tokens: 400 }
    );
    const parsed = safeParseJSON(out) || {};
    const arr = Array.isArray(parsed.targets) ? parsed.targets : [];
    const allowed = new Set((candidates || []).map(c => c.path));
    const clean = arr
      .filter(t => t && allowed.has(t.path) && typeof t.question === "string" && t.question.trim().length > 0)
      .slice(0, Math.max(0, Math.min(3, max_questions)));
    return clean;
  };

  // === NEW: produire une valeur pour un path donné (sans toucher le reste)
  Agent.fillFicheFromAnswer = async ({ path, question, answer, fiche }) => {
    const sys = [
      "Tu fournis une VALEUR à écrire dans la fiche pour un 'path' précis.",
      "NE PROPOSE RIEN pour d'autres champs. NE MODIFIE PAS les champs non visés.",
      "Si l'information n'est pas explicite, renvoie ok=false.",
      "Réponds UNIQUEMENT en JSON: { ok:boolean, path:string, value:any, note?:string }",
      "Contraintes types:",
      "- Strings: texte court, clair.",
      "- Numbers: valeur entière raisonnable (ex: semaines).",
      "- Enums: priorite_globale ∈ {academique, professionnel, personnel}; type_sejour ∈ {etudes, stage, volontariat, job, sejour_linguistique, cesure}; bourse.interet ∈ {oui, non, incertain}; bourse.objectif_financement ∈ {partiel, total, indetermine}.",
      "- projet_structure.*: 'lieu'(string), 'duree_semaines'(number), 'objectif'(string)."
    ].join("\n");

    const user = {
      path, question, student_answer: answer,
      fiche_excerpt: fiche,
      examples: [
        { path: "priorite_globale", answer: "Plutôt académique", value: "academique" },
        { path: "type_sejour", answer: "un stage en entreprise", value: "stage" },
        { path: "projet_structure.duree_semaines", answer: "environ 10 semaines", value: 10 }
      ]
    };

    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.2, max_tokens: 300 }
    );
    const parsed = safeParseJSON(out) || {};
    if (parsed && parsed.path === path && typeof parsed.ok === "boolean") {
      return parsed;
    }
    return { ok: false, path };
  };

  // === Recap (priorise la fiche)
  Agent.recap = async ({ history = [], summary = {}, fiche = {} }) => {
    const defaults = {
      self_learning:
        "Si tu te reconnais dans ces questions, c’est que tu es curieux(se), que tu aimes explorer de nouvelles expériences et apprendre en participant activement. Tu auras sans doute besoin d’un environnement où l’on valorise l’échange, la discussion et l’initiative. Si ce n’est pas vraiment ton cas, tu pourrais préférer des contextes plus structurés, avec des repères clairs et un cadre rassurant. Cela ne t’empêche pas de réussir à l’étranger, mais il sera important que tu puisses avancer à ton rythme et trouver du soutien autour de toi.",
      academic:
        "Si tu attaches beaucoup d’importance à ces questions, c’est que la réussite académique et la réputation de l’établissement comptent pour toi. Tu pourrais rechercher une université exigeante, reconnue et motivante, où tu pourras relever des défis intellectuels. Si tu t’y retrouves moins, c’est peut-être que tu vois ton départ surtout comme une expérience de vie. Dans ce cas, l’ouverture culturelle, la découverte personnelle ou les relations que tu vas créer compteront autant, voire plus, que le prestige académique.",
      environment:
        "Si tu accordes du poids à ces éléments, c’est que le lieu où tu vas vivre joue un rôle important dans ton bien-être. Le climat, la proximité de la nature, la possibilité d’avoir ton indépendance ou de trouver un équilibre entre solitude et vie sociale peuvent être essentiels pour toi. Si ce n’est pas une priorité, cela veut dire que tu es sans doute plus adaptable. Ton choix d’université pourra alors se faire davantage en fonction des opportunités académiques ou sociales, sans que l’environnement soit un critère décisif.",
      social:
        "Si tu t’identifies à ces questions, c’est que tu as envie de t’intégrer, de participer à la vie collective et de rencontrer des personnes différentes, qu’elles soient créatives, ambitieuses ou venues d’autres pays. Un campus vivant et multiculturel sera alors très stimulant pour toi. Si tu t’y retrouves moins, c’est que tu privilégies probablement la qualité de tes relations à leur quantité. Tu pourras alors t’épanouir dans un cadre plus calme, où les liens que tu tisseras seront peut-être moins nombreux mais plus profonds."
    };

    const sys = [
      "Rédige un récapitulatif narratif en français (4 paragraphes) pour un(e) lycéen(ne).",
      "Écris à la DEUXIÈME personne du singulier (« tu », « ton/ta/tes ») : tu t'adresses directement au(à la) lycéen(ne).",
      "PRIORISE les informations de la 'fiche_eleve' quand elles contredisent la conversation ou la synthèse.",
      "Pour les langues, considère 'langues_cibles' de la fiche comme source de vérité sur les langues visées.",
      "Réponds UNIQUEMENT en JSON strict avec les clés: self_learning, academic, environment, social."
    ].join("\n");

    const user = {
      fiche_eleve: fiche,
      summary,
      history_excerpt: compactHistory(history, 40),
      mapping_titles: {
        self_learning: "🌱 Connaissance de soi et apprentissage",
        academic: "🎓 Ambitions académiques",
        environment: "🌍 Cadre de vie et environnement",
        social: "🤝 Relations sociales et ouverture"
      },
      style_constraints: {
        approx_word_count_each: "120-180",
        tone: "bienveillant, clair, nuancé",
        audience: "lycéen(ne) français(e)",
        person: "2e personne du singulier (tu)"
      }
    };

    try {
      const out = await chat(
        [{ role: "system", content: sys }, { role: "user", content: J(user) }],
        { json: true, temperature: 0.5, max_tokens: 900 }
      );
      const parsed = safeParseJSON(out);
      if (!parsed || typeof parsed !== "object") return defaults;
      const keys = ["self_learning", "academic", "environment", "social"];
      for (const k of keys) if (typeof parsed[k] !== "string" || !parsed[k].trim()) parsed[k] = defaults[k];
      return parsed;
    } catch {
      return defaults;
    }
  };

  window.Agent = Agent;
})();
