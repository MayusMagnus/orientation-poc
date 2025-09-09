// scripts/agent.js
//
// Agent "backend" exécuté dans le navigateur.
// Appelle Chat Completions avec response_format=json_object.
// La clé API et le modèle viennent d'une modale côté UI (app.js).

window.Agent = (function () {
  let OPENAI_API_KEY = null;
  let OPENAI_BASE_URL = "https://api.openai.com/v1";
  let OPENAI_MODEL = "gpt-4o-mini";

  function configure({ apiKey, baseUrl, model }) {
    OPENAI_API_KEY = apiKey || OPENAI_API_KEY;
    OPENAI_BASE_URL = baseUrl || OPENAI_BASE_URL;
    OPENAI_MODEL = model || OPENAI_MODEL;
  }

  function getConfig() {
    return { apiKey: OPENAI_API_KEY, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL };
  }

  function requireKey() {
    if (!OPENAI_API_KEY) throw new Error("Clé API OpenAI manquante.");
  }

  function condenseHistory(turns, maxChars = 1800) {
    const joined = (turns || []).map(t => `${t.role.toUpperCase()}: ${t.content}`).join("\n");
    return joined.length <= maxChars ? joined : "Historique condensé...\n" + joined.slice(-maxChars);
  }

  async function chatJSON({ system, user }) {
    requireKey();
    const body = {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Tu renvoies uniquement du JSON valide conforme au schéma." },
        { role: "user", content: `${system}\n---\n${user}` }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    };
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${txt}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content || "";
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Réponse modèle non-JSON.");
      return JSON.parse(m[0]);
    }
  }

  // ---------- Schémas JSON (guidage via prompt) ----------

  // Décision par étape (strict)
  const decisionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      answered: { type: "boolean", description: "true si l'élève a répondu au cœur de la question" },
      next_action: { enum: ["ask_followup", "next_question", "finish"] },
      followup_question: { type: "string" },
      missing_points: { type: "array", items: { type: "string" } },
      reason: { type: "string" }
    },
    required: ["answered", "next_action"]
  };

  const summarySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      objectifs: { type: "array", items: { type: "string" } },
      priorites: { type: "array", items: { type: "string" } },
      format_ideal: { type: "string" },
      langue: { type: "string" },
      niveau_actuel: { type: "string" },
      niveau_cible: { type: "string" },
      ambition_progression: { type: "string" },
      projet_phrase_ultra_positive: { type: "string" },
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          pays_cibles: { type: "array", items: { type: "string" } },
          depaysement_pref: { type: "string" },
          duree_pref: { type: "string" },
          bourse_interet: { type: "string" },
          inquietudes_top: { type: "array", items: { type: "string" } }
        }
      },
      confidence: { type: "number" }
    },
    required: ["objectifs","priorites","format_ideal","langue","projet_phrase_ultra_positive"]
  };

  // ✅ NOUVEAU : schéma pour reformuler une question insatisfaisante (phase de reprise)
  const reformulateSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      reformulated_question: { type: "string" },
      reason: { type: "string" }
    },
    required: ["reformulated_question"]
  };

  // ---------- Prompts ----------

  function decisionPrompt({ history, question, answer, hint_followup, followup_already_asked }) {
    const system = [
      "Tu es un conseiller d’orientation. Une seule question à la fois.",
      "Règle d'or: PAR DÉFAUT, passe à la question suivante.",
      "NE POSE une question d’approfondissement QUE si l’élève n’a PAS répondu au cœur de la question.",
      "Définition 'répondu' = l'élève donne un choix clair OU une info liée au point central (même succincte).",
      "Cas 'pas répondu' = vide, hors-sujet, 'je ne sais pas', généralités non actionnables, ou élément central manquant.",
      "Si 'répondu' → answered=true & next_question.",
      "Si 'pas répondu' → answered=false & ask_followup avec UNE question courte et ciblée.",
      "Max 1 follow-up par question. Garde un ton bref et bienveillant.",
      "Retourne STRICTEMENT du JSON conforme au schéma."
    ].join(" ");

    const condensed = condenseHistory(history);
    const rules = [
      "Utilise le hint uniquement si l'élément manque réellement.",
      `followup_already_asked=${!!followup_already_asked}`,
      `hint_followup="${hint_followup || ""}"`
    ].join("\n");

    const schemaText = JSON.stringify(decisionSchema);
    const user = [
      `Schéma: ${schemaText}`,
      `Contexte:\n${condensed}`,
      `Question courante: "${question}"`,
      `Réponse de l'élève: "${answer}"`,
      rules
    ].join("\n\n");

    return { system, user };
  }

  function summarizePrompt({ history }) {
    const system = [
      "Tu fais une synthèse positive et fidèle du projet de l'élève pour une mindmap.",
      "Retourne STRICTEMENT un JSON conforme au schéma fourni.",
      "« projet_phrase_ultra_positive »: courte, claire, enthousiaste et fidèle.",
      "N'invente rien."
    ].join(" ");

    const condensed = condenseHistory(history, 4000);
    const schemaText = JSON.stringify(summarySchema);
    const user = [`Schéma: ${schemaText}`, `Historique:\n${condensed}`].join("\n\n");
    return { system, user };
  }

  // ✅ NOUVEAU : prompt de reformulation finale (phase de reprise)
  function reformulatePrompt({ original_question, last_answers, missing_points }) {
    const system = [
      "Tu reformules UNE SEULE et même question, concise et claire, pour obtenir le point manquant.",
      "Cible précisément les éléments manquants. Ton but est d'aider l'élève à donner une réponse actionnable.",
      "Retourne STRICTEMENT un JSON conforme au schéma fourni."
    ].join(" ");

    const schemaText = JSON.stringify(reformulateSchema);
    const user = [
      `Schéma: ${schemaText}`,
      `Question initiale: "${original_question}"`,
      last_answers?.length ? `Dernières réponses de l'élève:\n- ${last_answers.join("\n- ")}` : "Dernières réponses de l'élève: (aucune)",
      (missing_points?.length ? `Points manquants identifiés:\n- ${missing_points.join("\n- ")}` : "Points manquants: (non précisés)")
    ].join("\n\n");

    return { system, user };
  }

  // ---------- API Agent ----------

  async function decideNext({ history, question, answer, hint_followup, followup_already_asked }) {
    const { system, user } = decisionPrompt({ history, question, answer, hint_followup, followup_already_asked });
    const res = await chatJSON({ system, user });

    // Garde-fous côté client:
    if (res?.answered === true) {
      return { answered: true, next_action: "next_question", reason: res?.reason };
    }
    if (res?.next_action === "ask_followup" && followup_already_asked) {
      return { answered: false, next_action: "next_question", reason: "Follow-up déjà posée (limite PoC)." };
    }
    if (res?.next_action === "ask_followup" && !res?.followup_question) {
      return { answered: false, next_action: "next_question", reason: "Pas de follow-up précise fournie par le modèle." };
    }
    return res;
  }

  async function summarize({ history }) {
    const { system, user } = summarizePrompt({ history });
    return chatJSON({ system, user });
  }

  // ✅ NOUVEAU : reformulation de question pour la phase de reprise
  async function reformulate({ original_question, last_answers, missing_points }) {
    const { system, user } = reformulatePrompt({ original_question, last_answers, missing_points });
    return chatJSON({ system, user }); // { reformulated_question, reason? }
  }

  return { configure, getConfig, decideNext, summarize, reformulate };
})();
