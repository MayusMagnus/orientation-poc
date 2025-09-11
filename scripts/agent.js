// scripts/agent.js
//
// Agent côté front : appels OpenAI et logique.
// - decideNext : prompt mis à jour (cap 4, pas de reprise)
// - summarize : idem (pour encadrés)
// - extractFicheUpdate : produit un "patch" à fusionner dans la fiche élève
// - recap : prend en compte la fiche comme source prioritaire

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

  // === Decision: ask follow-up vs next question (PAS de reprise)
  Agent.decideNext = async ({
    history = [], question, answer,
    hint_followup = "", followup_count = 0,
    previous_followups = [], last_answers = [],
    last_assistant = "",
    max_followups = 4,
    skip_revisit = false // conservé pour compat, non utilisé
  }) => {
    const sys = [
      "Tu es un conseiller d’orientation exigeant et bienveillant. Tu t'adresses à un(e) lycéen(ne) français(e).",
      "RÈGLES:",
      "• Creuse chaque question jusqu’à obtenir des éléments concrets (exemples, critères mesurables, qui/quoi/où/quand/combien/comment) sauf sur la question de la bourse.",
      "• Réponses vagues ou « je ne sais pas » → pas satisfaisant: propose options, échelles (1-5), exemples.",
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
        followup_question: "string (si ask_followup, formulation NOUVELLE, courte et concrète, différente de previous_followups et de last_assistant)",
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

  // === Summarize (structuré pour encadrés)
  Agent.summarize = async ({ history = [] }) => {
    const sys = [
      "Tu analyses le dialogue pour produire une synthèse structurée et concise.",
      "Réponds UNIQUEMENT en JSON avec les clés:",
      "objectifs:string[], priorites:string[], format_ideal:string, langue:string, niveau_actuel:string, niveau_cible:string, ambition_progression:string, projet_phrase_ultra_positive:string, meta:object"
    ].join("\n");

    const user = { history_excerpt: compactHistory(history, 50) };
    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.3, max_tokens: 700 }
    );
    const parsed = safeParseJSON(out) || {};
    parsed.objectifs = Array.isArray(parsed.objectifs) ? parsed.objectifs : [];
    parsed.priorites = Array.isArray(parsed.priorites) ? parsed.priorites : [];
    parsed.meta = typeof parsed.meta === "object" && parsed.meta !== null ? parsed.meta : {};
    return parsed;
  };

  // === NEW: extraction/patch de fiche élève à chaque réponse
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
      fiche_excerpt: fiche, // état courant
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
        audience: "lycéen(ne) français(e)"
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
