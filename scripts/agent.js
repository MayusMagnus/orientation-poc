// scripts/agent.js
//
// Agent côté front : appels OpenAI et logique de décision.
// MAJ : mémoire 30 tours, anti-répétition (ne jamais répéter la question initiale ni le dernier message de l’agent).

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

  // === Decision: ask follow-up vs next question
  Agent.decideNext = async ({
    history = [], question, answer,
    hint_followup = "", followup_count = 0,
    previous_followups = [], last_answers = [],
    last_assistant = ""
  }) => {
    const sys = [
      "Tu es un conseiller d’orientation exigeant et bienveillant.",
      "RÈGLES:",
      "• Creuse chaque question jusqu’à obtenir des éléments concrets (exemples, critères mesurables, qui/quoi/où/quand/combien/comment) sauf pour la question de la bourse.",
      "• Réponses vagues ou « je ne sais pas » → inacceptables: propose options, échelles (1-5), exemples.",
      "• Rien de secret: rappelle qu’il faut tout expliciter.",
      "• NE JAMAIS répéter une sous-question déjà posée, ni reformuler exactement la question initiale, ni le DERNIER message de l’agent.",
      "• Pour éviter les répétitions, vérifie previous_followups et last_assistant et change d’angle.",
      "• Max 5 follow-ups par question. Ensuite, passer et marquer pour reprise.",
      "Réponds UNIQUEMENT en JSON valide."
    ].join("\n");

    const user = {
      question,
      student_answer: answer,
      hint_followup,
      followup_count,
      max_followups: 5,
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

  // === Reformulate a revisit question
  Agent.reformulate = async ({ original_question, last_answers = [], missing_points = [] }) => {
    const sys = "Reformule une question d’orientation de manière ultra-ciblée et concrète en français, sans intro.";
    const user = { original_question, last_answers, missing_points, instruction: "Produit UNE seule question courte, précise, actionnable. Réponds en JSON {\"reformulated_question\":\"...\"}." };
    const out = await chat(
      [{ role: "system", content: sys }, { role: "user", content: J(user) }],
      { json: true, temperature: 0.3, max_tokens: 200 }
    );
    const parsed = safeParseJSON(out) || {};
    return { reformulated_question: parsed.reformulated_question || original_question };
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

  window.Agent = Agent;
})();
