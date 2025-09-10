// scripts/agent.js
//
// Agent côté front (OpenAI via fetch).
// Règles générales appliquées dans les prompts :
// 1) Creuser à chaque question (au minimum 1 follow-up, sauf réponse déjà complète)
// 2) Allergique aux “je ne sais pas”/langage vague/secret → exiger des exemples concrets, chiffres, choix
// 3) Rien de secret : encourager à tout expliciter (et rassurer)
// 4) Si le tour est fait, passer à la question suivante
// 5) Max 5 follow-ups par question, puis passer et marquer comme “insatisfaisant” pour reprise

(function () {
  const Agent = {};
  let CONFIG = {
    apiKey: null,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  };

  Agent.configure = ({ apiKey, baseUrl, model }) => {
    if (apiKey) CONFIG.apiKey = apiKey;
    if (baseUrl) CONFIG.baseUrl = baseUrl;
    if (model) CONFIG.model = model;
  };

  function headers() {
    if (!CONFIG.apiKey) throw new Error("Code d’accès manquant.");
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.apiKey}`,
    };
  }

  async function chat(messages, { json = false, temperature = 0.3, max_tokens = 700 } = {}) {
    const body = {
      model: CONFIG.model,
      messages,
      temperature,
      max_tokens,
    };
    if (json) body.response_format = { type: "json_object" };

    const res = await fetch(`${CONFIG.baseUrl.replace(/\/+$/,'')}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || res.statusText || "Erreur OpenAI");
    }
    return (data.choices?.[0]?.message?.content || "").trim();
  }

  function compactHistory(history, maxTurns = 8) {
    if (!Array.isArray(history)) return "";
    const last = history.slice(-maxTurns);
    return last.map(t => `${t.role === "user" ? "Élève" : "Agent"}: ${t.content}`).join("\n");
  }

  function safeParseJSON(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  // ---- Decide next step for a single question ----
  Agent.decideNext = async ({ history = [], question, answer, hint_followup = "", followup_count = 0 }) => {
    const sys = [
      "Tu es un conseiller d’orientation exigeant et bienveillant pour un élève francophone.",
      "RÈGLES GÉNÉRALES:",
      "1) Creuse chaque question: pousse à la précision, aux exemples concrets, aux critères mesurables.",
      "2) Réponses vagues/« je ne sais pas »/secrètes → inacceptables: reformule, propose des options, checklists, échelles (1-5), exemples.",
      "3) Rien de secret: rappelle que l’élève doit tout dire pour bien l’orienter.",
      "4) Si la réponse couvre correctement la question (spécifique, exploitable), passe à la suivante.",
      "5) Ne dépasse jamais 5 sous-questions de suivi par question. Ensuite, indique qu’on avance et marque la question comme à reprendre plus tard.",
      "Réponds UNIQUEMENT en JSON valide."
    ].join("\n");

    const user = {
      question,
      student_answer: answer,
      history_excerpt: compactHistory(history),
      hint_followup,
      followup_count,
      max_followups: 5,
      wanted_output: {
        answered: "boolean (true si la question est suffisamment couverte)",
        next_action: "ask_followup | next_question",
        followup_question: "string (si ask_followup) — concise, ciblée, concrète, en français",
        missing_points: "string[] — points précis manquants",
        reason: "string — courte justification"
      },
      rules_reminder: [
        "Exiger la précision et des exemples",
        "Proposer des options/échelles si l’élève bloque",
        "Stop à 5 follow-ups max"
      ]
    };

    const out = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(user) }
      ],
      { json: true, temperature: 0.2, max_tokens: 500 }
    );

    const parsed = safeParseJSON(out) || {};
    // garde-fou si le modèle renvoie hors-format
    if (typeof parsed.answered !== "boolean") parsed.answered = false;
    if (!parsed.next_action) parsed.next_action = parsed.answered ? "next_question" : "ask_followup";
    if (parsed.next_action === "ask_followup" && !parsed.followup_question) {
      parsed.followup_question = "Peux-tu préciser avec des exemples concrets et des critères mesurables ?";
    }
    if (!Array.isArray(parsed.missing_points)) parsed.missing_points = [];
    if (!parsed.reason) parsed.reason = parsed.answered ? "Couverture suffisante." : "Besoin de précisions ciblées.";
    return parsed;
  };

  // ---- Reformulate for revisit phase ----
  Agent.reformulate = async ({ original_question, last_answers = [], missing_points = [] }) => {
    const sys = "Tu reformules une question d’orientation de manière ultra-ciblée et concrète en français.";
    const user = {
      original_question,
      last_answers,
      missing_points,
      instruction: "Produit UNE seule question courte, précise, actionnable. Pas d’intro ni d’explications."
    };
    const out = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(user) + "\nRéponds en JSON: {\"reformulated_question\":\"...\"}" }
      ],
      { json: true, temperature: 0.3, max_tokens: 200 }
    );
    const parsed = safeParseJSON(out) || {};
    return { reformulated_question: parsed.reformulated_question || original_question };
  };

  // ---- Summarize full dialogue into a structured object ----
  Agent.summarize = async ({ history = [] }) => {
    const sys = [
      "Tu es un assistant qui synthétise un entretien d’orientation en français.",
      "Sois factuel, positif et opérationnel. Ignore les 'je ne sais pas'.",
      "Respecte STRICTEMENT le schéma JSON demandé."
    ].join("\n");

    const schema = {
      objectifs: "string[]",
      priorites: "string[]",
      format_ideal: "string",
      langue: "string",
      niveau_actuel: "string",
      niveau_cible: "string",
      ambition_progression: "string",
      projet_phrase_ultra_positive: "string",
      meta: {
        pays_cibles: "string[]",
        depaysement_pref: "string",
        duree_pref: "string",
        bourse_interet: "string",
        inquietudes_top: "string[]"
      },
      confidence: "number (0..1)"
    };

    const user = {
      transcript_excerpt: compactHistory(history, 18),
      required_schema: schema
    };

    const out = await chat(
      [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(user) + "\nRéponds en JSON EXACTEMENT au schéma ci-dessus." }
      ],
      { json: true, temperature: 0.2, max_tokens: 900 }
    );
    const parsed = safeParseJSON(out) || {};
    // garde-fou
    parsed.objectifs ||= [];
    parsed.priorites ||= [];
    parsed.meta ||= {};
    parsed.meta.pays_cibles ||= [];
    parsed.meta.inquietudes_top ||= [];
    parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0.8)));
    return parsed;
  };

  window.Agent = Agent;
})();
