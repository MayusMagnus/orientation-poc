// scripts/agent.js
//
// Agent "backend" exécuté dans le navigateur.
// Appelle Chat Completions avec response_format=json_object.
// La clé API et le modèle viennent du module state ci-dessous.

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

  // --- Schémas (guidage via prompt) ---
  const decisionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      next_action: { enum: ["ask_followup", "next_question", "finish"] },
      followup_question: { type: "string" },
      reason: { type: "string" }
    },
    required: ["next_action"]
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

  // --- Prompts ---

  function decisionPrompt({ history, question, answer, hint_followup, followup_already_asked }) {
    const system = [
      "Tu es un conseiller d’orientation. Une seule question à la fois.",
      "Si la réponse de l’élève est ambiguë, pose UNE follow-up courte et ciblée; sinon passe à la question suivante.",
      "Ne collecte pas de données sensibles. Reste concret, bienveillant et bref.",
      "IMPORTANT: Réponds STRICTEMENT en JSON valide conforme au schéma fourni."
    ].join(" ");

    const condensed = condenseHistory(history);
    const rules = [
      "Règles PoC:",
      "- Max 1 follow-up par question.",
      `- followup_already_asked=${!!followup_already_asked}.`,
      `- hint_followup="${hint_followup || ""}".`,
      "- Si la réponse est claire → next_question. finish seulement en fin de parcours ou si demandé."
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
    const user = [
      `Schéma: ${schemaText}`,
      `Historique:\n${condensed}`
    ].join("\n\n");
    return { system, user };
  }

  // --- API agent ---

  async function decideNext({ history, question, answer, hint_followup, followup_already_asked }) {
    const { system, user } = decisionPrompt({ history, question, answer, hint_followup, followup_already_asked });
    const res = await chatJSON({ system, user });
    if (res?.next_action === "ask_followup" && followup_already_asked) {
      // garde-fou côté client
      return { next_action: "next_question", reason: "Follow-up déjà posée (limite PoC)." };
    }
    return res;
  }

  async function summarize({ history }) {
    const { system, user } = summarizePrompt({ history });
    return chatJSON({ system, user });
  }

  return { configure, getConfig, decideNext, summarize };
})();
