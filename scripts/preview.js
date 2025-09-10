// scripts/preview.js
// Page autonome pour prévisualiser la mindmap à partir d'un JSON collé ou d'un mock.
// Ajout : remplacement du nœud central "Mon projet" par une image (assets/globe.png) avec sizing auto.

(function () {
  const input = document.getElementById('jsonInput');
  const btnLoadMock = document.getElementById('btnLoadMock');
  const btnRender = document.getElementById('btnRender');
  const btnExportSvg = document.getElementById('btnExportSvg');
  const mindmapEl = document.getElementById('mindmap');

  function escapeMermaid(s) {
    return String(s || "").replace(/[{}<>]/g, m => ({'{':'\\u007B','}':'\\u007D','<':'\\u003C','>':'\\u003E'}[m]));
  }

  // === Post-traitement SVG : remplacer le root "Mon projet" par une image ===
  function replaceRootWithImage(containerEl, imageHref) {
    try {
      const svg = containerEl.querySelector('svg');
      if (!svg) return;

      const texts = Array.from(svg.querySelectorAll('text'));
      const rootText = texts.find(t => (t.textContent || '').trim().toLowerCase().includes('mon projet'));
      if (!rootText) return;

      const rootGroup = rootText.closest('g') || svg;
      const circle = rootGroup.querySelector('circle, ellipse');
      if (!circle) return;

      const isEllipse = circle.tagName.toLowerCase() === 'ellipse';
      let cx, cy, r, rx, ry;
      if (isEllipse) {
        cx = parseFloat(circle.getAttribute('cx') || '0');
        cy = parseFloat(circle.getAttribute('cy') || '0');
        rx = parseFloat(circle.getAttribute('rx') || '0');
        ry = parseFloat(circle.getAttribute('ry') || '0');
      } else {
        cx = parseFloat(circle.getAttribute('cx') || '0');
        cy = parseFloat(circle.getAttribute('cy') || '0');
        r  = parseFloat(circle.getAttribute('r')  || '0');
        rx = r; ry = r;
      }

      const size = Math.max(10, Math.min(rx, ry) * 2 * 0.96);
      const x = cx - size / 2;
      const y = cy - size / 2;

      rootText.style.display = 'none';
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', circle.getAttribute('stroke') || '#d1d5db');
      circle.setAttribute('stroke-width', circle.getAttribute('stroke-width') || '1.2');

      const defs = svg.querySelector('defs') || svg.insertBefore(document.createElementNS('http://www.w3.org/2000/svg', 'defs'), svg.firstChild);
      const clipId = 'rootClip-' + Math.random().toString(36).slice(2);
      const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
      clip.setAttribute('id', clipId);
      const clipCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      clipCircle.setAttribute('cx', String(cx));
      clipCircle.setAttribute('cy', String(cy));
      clipCircle.setAttribute('r',  String(Math.min(rx, ry)));
      clip.appendChild(clipCircle);
      defs.appendChild(clip);

      const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', imageHref);
      img.setAttribute('x', String(x));
      img.setAttribute('y', String(y));
      img.setAttribute('width',  String(size));
      img.setAttribute('height', String(size));
      img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      img.setAttribute('clip-path', `url(#${clipId})`);

      if (circle.nextSibling) {
        rootGroup.insertBefore(img, circle.nextSibling);
      } else {
        rootGroup.appendChild(img);
      }
    } catch (e) {
      console.warn('replaceRootWithImage error', e);
    }
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

    const { svg } = await mermaid.render("mindmap-preview", mm);
    mindmapEl.innerHTML = svg;

    // ⬇️ Remplace le root par le globe
    const imgUrl = `./assets/globe.png?v=${window.APP_VERSION || Date.now()}`;
    replaceRootWithImage(mindmapEl, imgUrl);
  }

  async function loadMock() {
    const qsVersion = (window.APP_VERSION || Date.now());
    const res = await fetch(`./data/mock_summary.json?v=${qsVersion}`);
    const json = await res.json();
    input.value = JSON.stringify(json, null, 2);
    await renderMindmap(json);
  }

  async function onRender() {
    let data;
    try {
      data = JSON.parse(input.value || "{}");
    } catch (e) {
      alert("JSON invalide.");
      return;
    }
    await renderMindmap(data);
  }

  function exportSVG() {
    const svg = document.querySelector("#mindmap svg");
    if (!svg) return alert("Rien à exporter.");
    const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mindmap.svg"; a.click();
    URL.revokeObjectURL(url);
  }

  // Params: ?src=URLjson (optionnel) | ?autoload=1 (charge mock auto)
  async function bootstrapFromParams() {
    const url = new URL(location.href);
    const src = url.searchParams.get("src");
    const autoload = url.searchParams.get("autoload");

    if (src) {
      try {
        const res = await fetch(src);
        const json = await res.json();
        input.value = JSON.stringify(json, null, 2);
        await renderMindmap(json);
        return;
      } catch (e) {
        console.warn("Impossible de charger src=", src, e);
      }
    }
    if (autoload === "1") {
      return loadMock();
    }
  }

  btnLoadMock.addEventListener("click", loadMock);
  btnRender.addEventListener("click", onRender);
  btnExportSvg.addEventListener("click", exportSVG);

  bootstrapFromParams();
})();
